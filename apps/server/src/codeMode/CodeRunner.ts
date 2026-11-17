import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { CODE_RUNNER_SCRIPT } from "./codeRunnerScript.ts";

export const CodeRunOutput = Schema.Struct({
  result: Schema.NullOr(Schema.Json),
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  /** How many `t3.<tool>()` calls the evaluation made. */
  t3Calls: Schema.Number,
});
export type CodeRunOutput = typeof CodeRunOutput.Type;

export class CodeRunStartError extends Schema.TaggedError<CodeRunStartError>()(
  "CodeRunStartError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to start the code runner.";
  }
}

/** Why one `t3.<tool>()` call failed; the script receives it as a thrown error. */
export class CodeToolCallError extends Schema.TaggedError<CodeToolCallError>()(
  "CodeToolCallError",
  { reason: Schema.String, code: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface CodeSessionInput {
  /** Relative paths in scripts resolve against it. */
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface EvaluateInput {
  readonly code: string;
  /** The names this evaluation can call as `t3.<name>(args)`. */
  readonly tools: ReadonlyArray<string>;
  /** Answers this evaluation's `t3.<tool>(args)` calls. */
  readonly call: (tool: string, args: Schema.Json) => Effect.Effect<Schema.Json, CodeToolCallError>;
}

export interface CodeSession {
  /** Runs one evaluation at a time. A second call while one runs dies. */
  readonly evaluate: (input: EvaluateInput) => Effect.Effect<CodeRunOutput>;
  /** Kills the session's process group; a running evaluation returns `reason` as its error. */
  readonly end: (reason: string) => Effect.Effect<void>;
  /** Succeeds with why, once the session's process has exited. */
  readonly ended: Effect.Effect<string>;
  readonly hasEnded: Effect.Effect<boolean>;
}

export class CodeRunner extends Context.Service<
  CodeRunner,
  {
    readonly start: (
      input: CodeSessionInput,
    ) => Effect.Effect<CodeSession, CodeRunStartError, Scope.Scope>;
  }
>()("t3/codeMode/CodeRunner") {}

export const RUN_TIMEOUT = Duration.minutes(10);
/** How long output may keep arriving once an evaluation returns or its process is stopped. */
export const PIPE_GRACE = Duration.seconds(2);
const PIPES_HELD =
  "Output was cut off because a background process the script started kept its output open.";
export const RESPONSE_LIMIT_BYTES = 64 * 1024;
/** Room left in the response for what Code Mode adds around an evaluation's output. */
const ENVELOPE_BYTES = 1024;
/** Each `t3` request and each result sent back to the script. */
const CALL_LIMIT_BYTES = 64 * 1024;
const CALLS_IN_FLIGHT = 8;
/** V8's old-generation cap for each session, in MiB. */
const SESSION_HEAP_MIB = 256;
// A result line holds at most 64K characters of JSON, which escaping can grow several times over.
const CHANNEL_LINE_LIMIT = 1024 * 1024;
const TRUNCATED_MARKER = "\n[truncated]";
// The child writes these keys first, so a call too long to hold can be refused before it ends.
const CALL_HEAD = /^\{"type":"call","evaluation":"[^"\\]*","callId":(\d+),"tool":"([\w-]+)"/u;

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The longest prefix of `text` whose JSON encoding, marker included, fits in `maxBytes`. */
const cutToFit = (text: string, maxBytes: number): string => {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(text.slice(0, middle) + TRUNCATED_MARKER) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const prefix = /[\uD800-\uDBFF]$/u.test(text.slice(0, low))
    ? text.slice(0, low - 1)
    : text.slice(0, low);
  return jsonBytes(prefix + TRUNCATED_MARKER) <= maxBytes ? prefix + TRUNCATED_MARKER : "";
};

interface Collected {
  readonly text: string;
  readonly truncated: boolean;
}

const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * Error first, then the result, then output, each counted at its full JSON size so the
 * response stays under the limit. A result that does not fit becomes the start of its JSON text.
 */
const fitResponse = (input: {
  readonly resultJson: string | null;
  readonly resultCut: boolean;
  readonly error: string | null;
  readonly stdout: Collected;
  readonly stderr: Collected;
  /** A `$` command's output was cut to its end. */
  readonly shellTruncated: boolean;
  readonly t3Calls: number;
}): CodeRunOutput => {
  let remaining =
    RESPONSE_LIMIT_BYTES -
    ENVELOPE_BYTES -
    jsonBytes({
      result: null,
      stdout: "",
      stderr: "",
      truncated: false,
      error: null,
      t3Calls: input.t3Calls,
    });
  let truncated =
    input.resultCut || input.stdout.truncated || input.stderr.truncated || input.shellTruncated;
  const take = (text: string, alreadyCut: boolean) => {
    const whole = alreadyCut ? text + TRUNCATED_MARKER : text;
    if (jsonBytes(whole) <= remaining) {
      remaining -= jsonBytes(whole);
      return whole;
    }
    truncated = true;
    const cut = cutToFit(text, remaining);
    remaining -= jsonBytes(cut);
    return cut;
  };
  const error = input.error === null ? null : take(input.error, false);
  const decoded =
    input.resultJson === null || input.resultCut || Buffer.byteLength(input.resultJson) > remaining
      ? Option.none()
      : decodeResult(input.resultJson);
  if (Option.isSome(decoded)) remaining -= Buffer.byteLength(input.resultJson ?? "");
  const result = Option.isSome(decoded)
    ? decoded.value
    : input.resultJson === null
      ? null
      : take(input.resultJson, input.resultCut);
  return {
    result,
    error,
    stdout: take(input.stdout.text, input.stdout.truncated),
    stderr: take(input.stderr.text, input.stderr.truncated),
    truncated,
    t3Calls: input.t3Calls,
  };
};

// The same prefixes the terminal keeps from shells, plus the MCP credentials.
const isServerOnlyVariable = (name: string) => {
  const upper = name.toUpperCase();
  return (
    upper === "ELECTRON_RUN_AS_NODE" ||
    ["T3_MCP_", "T3CODE_", "VITE_"].some((prefix) => upper.startsWith(prefix))
  );
};

const ChildMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("result"),
    id: Schema.String,
    json: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
    cut: Schema.Boolean,
    shellTruncated: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("call"),
    evaluation: Schema.String,
    callId: Schema.Number,
    tool: Schema.String,
    args: Schema.Json,
  }),
]);
const decodeChildMessage = Schema.decodeUnknownOption(Schema.fromJsonString(ChildMessage));
type CallMessage = Extract<typeof ChildMessage.Type, { readonly type: "call" }>;

const ToChild = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("evaluate"),
    id: Schema.String,
    code: Schema.String,
    marker: Schema.String,
    tools: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("reply"),
    callId: Schema.Number,
    ok: Schema.Literal(true),
    value: Schema.Json,
  }),
  Schema.Struct({
    type: Schema.Literal("reply"),
    callId: Schema.Number,
    ok: Schema.Literal(false),
    message: Schema.String,
    code: Schema.optional(Schema.String),
  }),
]);
const encodeToChildJson = Schema.encodeEffect(Schema.fromJsonString(ToChild));
// Every value here is already JSON, so encoding cannot fail.
const encodeToChild = (message: typeof ToChild.Type) =>
  encodeToChildJson(message).pipe(Effect.orDie);

interface Settled {
  readonly resultJson: string | null;
  readonly error: string | null;
  readonly cut: boolean;
  readonly shellTruncated: boolean;
}

/** Output kept so far, at most `RESPONSE_LIMIT_BYTES` of it. */
interface Kept {
  text: string;
  bytes: number;
  truncated: boolean;
}

/** One evaluation's share of stdout or stderr: what arrived before its marker. */
interface Capture extends Kept {
  readonly marker: string;
  readonly seen: Deferred.Deferred<void>;
}

interface Running {
  readonly id: string;
  readonly call: EvaluateInput["call"];
  readonly settled: Deferred.Deferred<Settled>;
  readonly stdout: Capture;
  readonly stderr: Capture;
  /** Holds its `t3` calls, which end with it. */
  readonly callScope: Scope.Closeable;
  inFlight: number;
  calls: number;
}

const append = (kept: Kept, text: string) => {
  if (kept.truncated || text === "") return;
  const bytes = Buffer.from(text);
  const room = RESPONSE_LIMIT_BYTES - kept.bytes;
  if (bytes.length > room) {
    kept.text += bytes.subarray(0, room).toString("utf8");
    kept.bytes = RESPONSE_LIMIT_BYTES;
    kept.truncated = true;
    return;
  }
  kept.text += text;
  kept.bytes += bytes.length;
};

/**
 * Hands each running evaluation what its process writes before the evaluation's marker.
 * What arrives between evaluations is kept for the next one when `keepsUnowned` is set,
 * and dropped otherwise.
 * @internal Exported for tests.
 */
export const makeOutput = (keepsUnowned: boolean) => {
  const decoder = new TextDecoder();
  let capture: Capture | undefined;
  let carry = "";
  const unowned: Kept = { text: "", bytes: 0, truncated: false };
  const keep = (text: string) => {
    if (keepsUnowned) append(unowned, text);
  };
  /** Moves what arrived with no evaluation to own it onto the end of `into`. */
  const claim = (into: Kept) => {
    append(into, unowned.text);
    if (unowned.truncated) into.truncated = true;
    Object.assign(unowned, { text: "", bytes: 0, truncated: false });
  };
  return {
    install: (next: Capture) => {
      capture = next;
      carry = "";
      claim(next);
    },
    feed: (chunk: Uint8Array) => {
      const text = carry + decoder.decode(chunk, { stream: true });
      carry = "";
      const owner = capture;
      if (owner === undefined) return keep(text);
      const at = text.indexOf(owner.marker);
      if (at !== -1) {
        append(owner, text.slice(0, at));
        capture = undefined;
        Deferred.doneUnsafe(owner.seen, Effect.void);
        return keep(text.slice(at + owner.marker.length));
      }
      // Holds back what could be the start of a marker split across chunks.
      const held = Math.min(text.length, owner.marker.length - 1);
      append(owner, text.slice(0, text.length - held));
      carry = text.slice(text.length - held);
    },
    /** Hands over what was held back, once no marker can follow it. */
    flush: () => {
      const rest = carry + decoder.decode();
      carry = "";
      if (capture !== undefined) append(capture, rest);
      else keep(rest);
    },
    claim,
  };
};
type Output = ReturnType<typeof makeOutput>;

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executablePath = yield* HostProcess.ExecutablePath;

  const start = Effect.fn("CodeRunner.start")(function* (input: CodeSessionInput) {
    const sessionScope = yield* Scope.Scope;
    const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
    for (const [name, value] of Object.entries(input.environment)) {
      if (!isServerOnlyVariable(name)) environment[name] = value;
    }
    const toChild = yield* Queue.unbounded<string>();
    const encoder = new TextEncoder();
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          executablePath,
          [`--max-old-space-size=${SESSION_HEAP_MIB}`, "-e", CODE_RUNNER_SCRIPT],
          {
            cwd: input.cwd,
            env: environment,
            extendEnv: false,
            killSignal: "SIGKILL",
            stdin: "ignore",
            additionalFds: {
              fd3: { type: "output" },
              fd4: {
                type: "input",
                stream: Stream.fromQueue(toChild).pipe(
                  Stream.map((line) => encoder.encode(`${line}\n`)),
                ),
              },
            },
          },
        ),
      )
      .pipe(
        Effect.mapError((cause) => new CodeRunStartError({ cause })),
        Effect.catchDefect((cause) => Effect.fail(new CodeRunStartError({ cause }))),
      );

    let endReason: string | undefined;
    let current: Running | undefined;
    const exited = yield* Deferred.make<string>();
    const stdout = makeOutput(false);
    // An error a callback throws between evaluations is worth showing the next one.
    const stderr = makeOutput(true);
    const stdoutClosed = yield* Deferred.make<void>();
    const stderrClosed = yield* Deferred.make<void>();
    const send = (message: typeof ToChild.Type) =>
      encodeToChild(message).pipe(
        Effect.flatMap((line) => Queue.offer(toChild, line)),
        Effect.asVoid,
      );

    const end = (reason: string) =>
      Effect.suspend(() => {
        endReason ??= reason;
        return handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
      });

    const drain = (
      stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
      output: Output,
      closed: Deferred.Deferred<void>,
    ) =>
      stream.pipe(
        Stream.runForEach((chunk) => Effect.sync(() => output.feed(chunk))),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(output.flush).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
        ),
        Effect.forkScoped,
      );

    const refusal = (callId: number, message: string): typeof ToChild.Type => ({
      type: "reply",
      callId,
      ok: false,
      message,
    });

    // Untraced: it runs once per t3 call, inside the session's own span.
    const answer = Effect.fnUntraced(function* (running: Running, call: CallMessage) {
      const outcome = yield* running.call(call.tool, call.args).pipe(
        Effect.map((value): typeof ToChild.Type => ({
          type: "reply",
          callId: call.callId,
          ok: true,
          value,
        })),
        Effect.catchTags({
          CodeToolCallError: (error) =>
            Effect.succeed<typeof ToChild.Type>({
              ...refusal(call.callId, error.reason),
              ...(error.code === undefined ? {} : { code: error.code }),
            }),
        }),
      );
      const line = yield* encodeToChild(outcome);
      yield* Buffer.byteLength(line) > CALL_LIMIT_BYTES
        ? send(refusal(call.callId, `The result of t3.${call.tool} is larger than 64 KiB.`))
        : Queue.offer(toChild, line);
    });

    // Untraced: it runs once per t3 call, inside the session's own span.
    const onCall = Effect.fnUntraced(function* (call: CallMessage) {
      const running = current;
      if (running === undefined || running.id !== call.evaluation) {
        return yield* send(
          refusal(
            call.callId,
            `t3.${call.tool} was called by an evaluation that has already finished.`,
          ),
        );
      }
      if (running.inFlight >= CALLS_IN_FLIGHT) {
        return yield* send(
          refusal(
            call.callId,
            `t3.${call.tool}: at most ${CALLS_IN_FLIGHT} t3 calls can run at once in one evaluation.`,
          ),
        );
      }
      running.inFlight += 1;
      running.calls += 1;
      yield* answer(running, call).pipe(
        // Interrupted when its evaluation ends; the reply settles the script's promise.
        Effect.onInterrupt(() =>
          send(
            refusal(
              call.callId,
              `t3.${call.tool} was stopped: the evaluation that called it has finished.`,
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => (running.inFlight -= 1))),
        Effect.forkIn(running.callScope, { startImmediately: true }),
      );
    });

    const tooLarge = (callId: number, tool: string) =>
      send(refusal(callId, `t3.${tool}: the request is larger than 64 KiB.`));
    const refuseOversized = (line: string) => {
      const head = CALL_HEAD.exec(line.slice(0, 1024));
      return head === null
        ? Effect.succeed(false)
        : tooLarge(Number(head[1]), head[2]!).pipe(Effect.as(true));
    };

    const unreadable = "The session wrote a message T3 could not read, so it was stopped.";
    let pending = "";
    /** Set while the rest of a refused call's line is skipped. */
    let skipping = false;
    const channelDecoder = new TextDecoder();
    // Untraced: it runs once per chunk the session writes to its channel.
    const onChannel = Effect.fnUntraced(function* (chunk: Uint8Array) {
      let text = channelDecoder.decode(chunk, { stream: true });
      if (skipping) {
        const lineEnd = text.indexOf("\n");
        if (lineEnd === -1) return;
        skipping = false;
        text = text.slice(lineEnd + 1);
      }
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        const message = decodeChildMessage(line);
        if (Option.isNone(message)) return yield* end(unreadable);
        if (message.value.type === "call") {
          yield* Buffer.byteLength(line) > CALL_LIMIT_BYTES
            ? tooLarge(message.value.callId, message.value.tool)
            : onCall(message.value);
          continue;
        }
        const result = message.value;
        if (current?.id === result.id) {
          yield* Deferred.succeed(current.settled, {
            resultJson: result.json ?? null,
            error: result.error ?? null,
            cut: result.cut,
            shellTruncated: result.shellTruncated,
          });
        }
      }
      if (pending.length > CALL_LIMIT_BYTES && (yield* refuseOversized(pending))) {
        pending = "";
        skipping = true;
      } else if (pending.length > CHANNEL_LINE_LIMIT) {
        yield* end(unreadable);
      }
    });

    yield* drain(handle.stdout, stdout, stdoutClosed);
    yield* drain(handle.stderr, stderr, stderrClosed);
    yield* handle
      .getOutputFd(3)
      .pipe(Stream.runForEach(onChannel), Effect.ignore, Effect.forkScoped);
    yield* handle.exitCode.pipe(
      Effect.option,
      Effect.flatMap((code) =>
        Deferred.succeed(
          exited,
          endReason ??
            `The session's process exited${Option.match(code, {
              onNone: () => "",
              onSome: (exitCode) => ` with code ${exitCode}`,
            })}.`,
        ),
      ),
      Effect.forkScoped,
    );

    const graceOver = <A>(effect: Effect.Effect<A>) =>
      effect.pipe(Effect.timeoutOption(PIPE_GRACE), Effect.map(Option.isNone));

    // Untraced: it is the body of CodeSession.evaluate, which holds the span.
    const outcomeOf = Effect.fnUntraced(function* (running: Running, evaluation: EvaluateInput) {
      yield* send({
        type: "evaluate",
        id: running.id,
        code: evaluation.code,
        marker: running.stdout.marker,
        tools: evaluation.tools,
      });
      const outcome = yield* Deferred.await(running.settled).pipe(
        Effect.asSome,
        Effect.raceFirst(Deferred.await(exited).pipe(Effect.as(Option.none<Settled>()))),
        Effect.timeoutOption(RUN_TIMEOUT),
      );
      const pipesClosed = graceOver(
        Effect.all([Deferred.await(stdoutClosed), Deferred.await(stderrClosed)]),
      );
      // Armed before the kill, which waits on the process: a detached descendant outside its
      // group can hold the pipes open for as long as it runs.
      const timedOutGrace = Option.isNone(outcome)
        ? yield* pipesClosed.pipe(Effect.forkChild({ startImmediately: true }))
        : undefined;
      if (timedOutGrace !== undefined) {
        yield* end(
          `The script ran longer than ${Duration.toMinutes(RUN_TIMEOUT)} minutes and was stopped.`,
        );
      }
      const settled = Option.flatten(outcome);
      let error: string | null;
      let heldOpen = false;
      let unmarked = false;
      if (Option.isSome(settled)) {
        unmarked = yield* graceOver(
          Effect.all([Deferred.await(running.stdout.seen), Deferred.await(running.stderr.seen)]),
        );
        error = settled.value.error;
      } else {
        heldOpen =
          timedOutGrace === undefined ? yield* pipesClosed : yield* Fiber.join(timedOutGrace);
        const reason = yield* Deferred.await(exited);
        error = heldOpen ? `${reason}\n${PIPES_HELD}` : reason;
      }
      if (heldOpen || unmarked || Option.isNone(settled)) {
        stdout.flush();
        stderr.flush();
      }
      // Written after its marker, such as why the runner failed, but before its process died.
      if (Option.isNone(settled)) stderr.claim(running.stderr);
      return fitResponse({
        resultJson: Option.isSome(settled) ? settled.value.resultJson : null,
        resultCut: Option.isSome(settled) && settled.value.cut && settled.value.resultJson !== null,
        error,
        stdout: {
          text: running.stdout.text,
          truncated: running.stdout.truncated || heldOpen || unmarked,
        },
        stderr: { text: running.stderr.text, truncated: running.stderr.truncated || heldOpen },
        shellTruncated: Option.isSome(settled) && settled.value.shellTruncated,
        t3Calls: running.calls,
      });
    });

    const evaluate = Effect.fn("CodeSession.evaluate")(function* (evaluation: EvaluateInput) {
      if (current !== undefined) return yield* Effect.die("A code session runs one evaluation.");
      const capture = () => ({
        marker: `\u0000t3-evaluation-end:${id}\u0000`,
        text: "",
        bytes: 0,
        truncated: false,
        seen: Deferred.makeUnsafe<void>(),
      });
      const id = yield* randomUuidV4;
      const running: Running = {
        id,
        call: evaluation.call,
        settled: yield* Deferred.make<Settled>(),
        stdout: capture(),
        stderr: capture(),
        callScope: yield* Scope.fork(sessionScope),
        inFlight: 0,
        calls: 0,
      };
      current = running;
      stdout.install(running.stdout);
      stderr.install(running.stderr);
      // A t3 call the script did not await stops here, before anyone reads the output.
      return yield* outcomeOf(running, evaluation).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            current = undefined;
            return Scope.close(running.callScope, Exit.void);
          }),
        ),
      );
    });

    return {
      evaluate,
      end,
      ended: Deferred.await(exited),
      hasEnded: Deferred.isDone(exited),
    } satisfies CodeSession;
  });

  return CodeRunner.of({ start });
});

export const layer = Layer.effect(CodeRunner, make);

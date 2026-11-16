import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { CODE_RUNNER_SCRIPT } from "./codeRunnerScript.ts";

export const CodeRunOutput = Schema.Struct({
  result: Schema.NullOr(Schema.Json),
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
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

export interface CodeRunInput {
  readonly code: string;
  /** Relative paths in the script resolve against it. */
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export class CodeRunner extends Context.Service<
  CodeRunner,
  { readonly run: (input: CodeRunInput) => Effect.Effect<CodeRunOutput, CodeRunStartError> }
>()("t3/codeMode/CodeRunner") {}

export const RUN_TIMEOUT = Duration.minutes(10);
export const RESPONSE_LIMIT_BYTES = 64 * 1024;
const TRUNCATED_MARKER = "\n[truncated]";

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

const decodeChannel = (channel: Collected) => {
  const kind = channel.text.slice(0, 1);
  const body = channel.text.slice(1);
  return kind === "R"
    ? { resultJson: body, error: null, cut: channel.truncated }
    : kind === "E"
      ? { resultJson: null, error: body, cut: channel.truncated }
      : undefined;
};

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
}): CodeRunOutput => {
  let remaining =
    RESPONSE_LIMIT_BYTES -
    jsonBytes({ result: null, stdout: "", stderr: "", truncated: false, error: null });
  let truncated = input.resultCut || input.stdout.truncated || input.stderr.truncated;
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
  };
};

const empty: Collected = { text: "", truncated: false };

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executablePath = yield* HostProcess.ExecutablePath;

  // Every stream drains to its end even past the cap, or the runner would block on a full pipe.
  const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
    collectUint8StreamText({ stream, maxBytes: RESPONSE_LIMIT_BYTES }).pipe(
      Effect.orElseSucceed(() => empty),
    );

  const run = Effect.fn("CodeRunner.run")(function* (input: CodeRunInput) {
    const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
    for (const [name, value] of Object.entries(input.environment)) {
      if (!name.startsWith("T3_MCP_") && name !== "ELECTRON_RUN_AS_NODE") environment[name] = value;
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(executablePath, ["-e", CODE_RUNNER_SCRIPT], {
              cwd: input.cwd,
              env: environment,
              extendEnv: false,
              killSignal: "SIGKILL",
              additionalFds: { fd3: { type: "output" } },
            }),
          )
          .pipe(
            Effect.mapError((cause) => new CodeRunStartError({ cause })),
            Effect.catchDefect((cause) => Effect.fail(new CodeRunStartError({ cause }))),
          );
        const outputs = yield* Effect.all(
          [collect(handle.stdout), collect(handle.stderr), collect(handle.getOutputFd(3))],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkScoped);
        yield* Stream.run(Stream.encodeText(Stream.make(input.code)), handle.stdin).pipe(
          Effect.ignore,
        );
        const exitCode = yield* handle.exitCode.pipe(
          Effect.option,
          Effect.timeoutOption(RUN_TIMEOUT),
        );
        // Descendants still holding the pipes would keep the collectors open.
        yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
        const [stdout, stderr, channel] = yield* Fiber.join(outputs);
        const message = decodeChannel(channel);
        const error = Option.isNone(exitCode)
          ? `The script ran longer than ${Duration.toMinutes(RUN_TIMEOUT)} minutes and was stopped.`
          : message === undefined
            ? `The script exited${Option.match(exitCode.value, {
                onNone: () => "",
                onSome: (code) => ` with code ${code}`,
              })} before returning.`
            : message.error;
        return fitResponse({
          resultJson: Option.isNone(exitCode) ? null : (message?.resultJson ?? null),
          resultCut: message?.cut === true && message.resultJson !== null,
          error,
          stdout,
          stderr,
        });
      }),
    );
  });

  return CodeRunner.of({ run });
});

export const layer = Layer.effect(CodeRunner, make);

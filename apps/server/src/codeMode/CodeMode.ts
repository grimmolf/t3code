import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
  type ProviderApprovalOption,
  type RunId,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { providerRuntimeMode } from "../orchestration-v2/RuntimePolicy.ts";
import { t3OwnedRuntimeRequestId } from "../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { codeModeDecision } from "./CodeModePolicy.ts";
import * as CodeRunner from "./CodeRunner.ts";

export class CodeModeOffError extends Schema.TaggedError<CodeModeOffError>()(
  "CodeModeOffError",
  {},
) {
  override get message(): string {
    return "Code Mode is off on this machine, so t3_code_run cannot run scripts. Use your other tools.";
  }
}

export class CodeModeRefusedError extends Schema.TaggedError<CodeModeRefusedError>()(
  "CodeModeRefusedError",
  {},
) {
  override get message(): string {
    return "Scripts cannot run while this thread is in Plan mode. Continue with your other tools, or ask the user to leave Plan mode.";
  }
}

export class CodeModeTurnEndedError extends Schema.TaggedError<CodeModeTurnEndedError>()(
  "CodeModeTurnEndedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `The turn that called t3_code_run in thread ${this.threadId} is no longer running, so the script did not run.`;
  }
}

export class CodeModeNoWorkspaceError extends Schema.TaggedError<CodeModeNoWorkspaceError>()(
  "CodeModeNoWorkspaceError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no workspace to run the script in.`;
  }
}

export class CodeModeAskError extends Schema.TaggedError<CodeModeAskError>()("CodeModeAskError", {
  threadId: ThreadId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not ask the user to approve the script in thread ${this.threadId}, so it did not run.`;
  }
}

// With the 10-minute run, under the 65-minute MCP tool timeout T3 sets for Claude, Codex and OpenCode.
const ASK_TIMEOUT = Duration.minutes(50);

export class CodeModeNotApprovedError extends Schema.TaggedError<CodeModeNotApprovedError>()(
  "CodeModeNotApprovedError",
  { outcome: Schema.Literals(["declined", "closed", "timed_out"]) },
) {
  override get message(): string {
    switch (this.outcome) {
      case "declined":
        return "The user declined this script, so it did not run.";
      case "closed":
        return "The approval request closed before the user answered, so the script did not run.";
      case "timed_out":
        return `No approval came within ${Duration.toMinutes(ASK_TIMEOUT)} minutes, so the script did not run.`;
    }
  }
}

export class CodeModeBusyError extends Schema.TaggedError<CodeModeBusyError>()(
  "CodeModeBusyError",
  { handle: Schema.String },
) {
  override get message(): string {
    return `${this.handle} is still running: poll it or call t3_code_reset.`;
  }
}

export class CodeModeUnknownHandleError extends Schema.TaggedError<CodeModeUnknownHandleError>()(
  "CodeModeUnknownHandleError",
  { handle: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Evaluation ${this.handle} is gone: ${this.reason}`;
  }
}

/** Returned once an evaluation finishes within the wait, else only its handle and `running`. */
export const CodeRunResult = Schema.Struct({
  handle: Schema.String,
  status: Schema.Literals(["running", "done"]),
  result: Schema.optionalKey(CodeRunner.CodeRunOutput.fields.result),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(CodeRunner.CodeRunOutput.fields.error),
  t3Calls: Schema.optionalKey(Schema.Number),
  /** The evaluation ran in a new session, so no earlier globalThis values exist. */
  sessionStarted: Schema.optionalKey(Schema.Literal(true)),
  /** Why the thread's previous session ended. */
  notice: Schema.optionalKey(Schema.String),
});
export type CodeRunResult = typeof CodeRunResult.Type;

/** How long `t3_code_run` and `t3_code_poll` wait before they return a running evaluation. */
export const YIELD_AFTER = Duration.seconds(20);
export const IDLE_TIMEOUT = Duration.minutes(10);
export const SESSION_LIMIT = 16;
// Reasons kept for threads whose session ended, so their next call can say why.
const NOTICE_LIMIT = 4 * SESSION_LIMIT;

const ENDED_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const ENDED = {
  reset: "t3_code_reset ended the previous session.",
  idle: `The previous session ended after ${Duration.toMinutes(IDLE_TIMEOUT)} idle minutes.`,
  evicted: `The previous session was stopped to make room: at most ${SESSION_LIMIT} sessions run at once.`,
  credential: "A new provider session took over this thread, so its previous session ended.",
  revoked: "The provider session that started the previous session ended.",
  moved: "The thread's workspace changed, so its previous session ended.",
  archived: "The thread was archived, so its session ended.",
  deleted: "The thread was deleted, so its session ended.",
  off: "Code Mode was turned off, so every session ended.",
  unwatched: "T3 lost track of thread changes, so every session ended.",
  cancelled: (handle: string) =>
    `The t3_code_run call that started ${handle} was cancelled, so its session was stopped.`,
  turnEnded: (handle: string) =>
    `The turn that started ${handle} ended, so its session was stopped.`,
  modeChanged: (handle: string) =>
    `The thread's mode changed while ${handle} ran, so its session was stopped.`,
};

export interface CodeModeCaller {
  readonly threadId: ThreadId;
  /** The MCP credential calling; a different one replaces the thread's session. */
  readonly providerSessionId: string;
}

/** The T3 tools an evaluation reaches as `t3.<tool>(args)`. */
export interface CodeModeBindings {
  readonly tools: ReadonlyArray<string>;
  /** Calls a tool with the authority of the `t3_code_run` call that started the evaluation. */
  readonly call: CodeRunner.EvaluateInput["call"];
}

export const CODE_RUN_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Allow for this thread" },
  { decision: "decline", label: "Decline" },
];

const CODE_RUN_REQUEST_PREFIX = t3OwnedRuntimeRequestId("code-run:");

export class CodeMode extends Context.Service<
  CodeMode,
  {
    /** Whether this environment offers `t3_code_run` to its threads. */
    readonly offered: Effect.Effect<boolean>;
    /** Evaluates `code` in the thread's session, starting one if it has none. */
    readonly run: (
      input: CodeModeCaller & { readonly code: string; readonly bindings: CodeModeBindings },
    ) => Effect.Effect<
      CodeRunResult,
      | CodeModeOffError
      | CodeModeRefusedError
      | CodeModeTurnEndedError
      | CodeModeNoWorkspaceError
      | CodeModeAskError
      | CodeModeNotApprovedError
      | CodeModeBusyError
      | CodeRunner.CodeRunStartError
    >;
    /** Waits up to `wait`, at most `YIELD_AFTER`, for an evaluation `run` returned as running. */
    readonly poll: (
      input: CodeModeCaller & { readonly handle: string; readonly wait: Duration.Duration },
    ) => Effect.Effect<CodeRunResult, CodeModeUnknownHandleError>;
    /** Ends the thread's session, killing what it runs; whether it had one. */
    readonly reset: (caller: CodeModeCaller) => Effect.Effect<{ readonly ended: boolean }>;
  }
>()("t3/codeMode/CodeMode") {}

interface Evaluation {
  readonly handle: string;
  /** The run that started it; the evaluation lives only while that run does. */
  readonly runId: RunId;
  readonly sessionStarted: boolean;
  readonly notice: string | undefined;
  readonly done: Deferred.Deferred<CodeRunner.CodeRunOutput>;
}

interface Session {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly cwd: string;
  readonly code: CodeRunner.CodeSession;
  readonly scope: Scope.Closeable;
  /** Set until its first evaluation starts, with why the thread's previous session ended. */
  fresh: { readonly notice: string | undefined } | undefined;
  /** The latest evaluation, running or done. */
  evaluation: Evaluation | undefined;
  idle: Fiber.Fiber<void> | undefined;
}

const isRunning = (evaluation: Evaluation | undefined): evaluation is Evaluation =>
  evaluation !== undefined && !Deferred.isDoneUnsafe(evaluation.done);

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const runner = yield* CodeRunner.CodeRunner;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  // One card at a time per thread, so "Allow for this thread" covers calls made in parallel.
  const askLocks = yield* KeyedLock.make<ThreadId>();
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const layerScope = yield* Scope.Scope;
  // A session outlives the call that starts it, so it runs on the layer's services, not the request's.
  const layerContext = yield* Effect.context<never>();
  /** One per thread, least recently used first. */
  const sessions = new Map<ThreadId, Session>();
  const notices = new Map<ThreadId, string>();
  const sessionLocks = yield* KeyedLock.make<ThreadId>();

  // Read per call, so turning the setting off refuses the next call.
  const offered =
    platform === "win32"
      ? Effect.succeed(false)
      : settings.getSettings.pipe(
          Effect.map((current) => current.codeModeEnabled),
          Effect.orElseSucceed(() => false),
        );

  // The answered request is the grant, so "Allow for this thread" survives a restart.
  const allowedForThread = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runtimeRequests"], { runtimeRequestStatuses: ["resolved"] })
      .pipe(
        Effect.map((records) =>
          records.runtimeRequests.some(
            (request) =>
              request.id.startsWith(CODE_RUN_REQUEST_PREFIX) &&
              request.decision === "acceptForSession",
          ),
        ),
        Effect.orElseSucceed(() => false),
      );

  const awaitAnswer = (threadId: ThreadId, requestId: RuntimeRequestId, afterSequence: number) =>
    threads
      .streamStoredEventsFrom({ threadId, afterSequence, eventType: "runtime-request.updated" })
      .pipe(
        Stream.filterMap((stored) =>
          stored.event.type === "runtime-request.updated" &&
          stored.event.payload.id === requestId &&
          stored.event.payload.status !== "pending"
            ? Result.succeed(stored.event.payload)
            : Result.failVoid,
        ),
        Stream.runHead,
      );

  const ask = Effect.fn("CodeMode.ask")(function* (threadId: ThreadId, code: string) {
    if (yield* allowedForThread(threadId)) return;
    const requestId = t3OwnedRuntimeRequestId(`code-run:${yield* randomUuidV4}`);
    const askError = (cause: unknown) => new CodeModeAskError({ threadId, cause });
    const close = threads
      .dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`command:${requestId}:close`),
        threadId,
        requestId,
        decision: "cancel",
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not close a Code Mode approval request", {
            error: error.message,
          }),
        ),
      );
    // A pending card must not outlive this call. The open is uninterruptible, so a call
    // cancelled while it commits still closes the card.
    const answer = yield* Effect.acquireUseRelease(
      threads.dispatch({
        type: "runtime-request.open",
        commandId: CommandId.make(`command:${requestId}:open`),
        threadId,
        requestId,
        requestKind: "command",
        prompt: code,
        options: CODE_RUN_APPROVAL_OPTIONS,
      }),
      (opened) =>
        awaitAnswer(threadId, requestId, opened.sequence).pipe(
          Effect.timeoutOption(ASK_TIMEOUT),
          Effect.map(Option.flatten),
        ),
      (_opened, exit) => (Exit.isSuccess(exit) && Option.isSome(exit.value) ? Effect.void : close),
    ).pipe(Effect.mapError(askError));
    if (Option.isNone(answer)) return yield* new CodeModeNotApprovedError({ outcome: "timed_out" });
    const { status, decision } = answer.value;
    if (status === "resolved" && (decision === "accept" || decision === "acceptForSession")) return;
    return yield* new CodeModeNotApprovedError({
      outcome: status === "resolved" && decision === "decline" ? "declined" : "closed",
    });
  });

  /** What the thread allows now, judged by the provider its running turn is on. */
  const permit = Effect.fn("CodeMode.permit")(function* (threadId: ThreadId) {
    if (!(yield* offered)) return yield* new CodeModeOffError();
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return yield* new CodeModeNoWorkspaceError({ threadId });
    const running = yield* threads
      .getThreadRecords(threadId, ["runs"], { runStatuses: ["running"] })
      .pipe(
        Effect.map(({ runs }) => runs.toSorted((a, b) => a.ordinal - b.ordinal)[0]),
        Effect.orElseSucceed(() => undefined),
      );
    if (running === undefined) return yield* new CodeModeTurnEndedError({ threadId });
    const instance = yield* providerInstances.getInstance(running.providerInstanceId);
    // A provider T3 cannot read may not run the thread's mode, so it asks.
    const runtimeMode =
      instance === undefined
        ? "approval-required"
        : providerRuntimeMode(
            shell.runtimeMode,
            (yield* instance.snapshot.getSnapshot).supportedRuntimeModes,
          );
    const decision = codeModeDecision({ runtimeMode, interactionMode: shell.interactionMode });
    if (decision === "refuse") return yield* new CodeModeRefusedError();
    return { shell, runId: running.id, decision };
  });

  /** Drops the session at once, so the next call starts another, and keeps why it ended. */
  const forget = (session: Session, reason: string) => {
    if (sessions.get(session.threadId) !== session) return;
    sessions.delete(session.threadId);
    notices.delete(session.threadId);
    notices.set(session.threadId, reason);
    const oldest = notices.keys().next();
    if (notices.size > NOTICE_LIMIT && !oldest.done) notices.delete(oldest.value);
  };

  // Every way a session ends comes here; `open` closes its scope once the process has exited.
  // Uninterruptible: a forgotten session whose kill was cut short would keep its process.
  const end = (session: Session, reason: string) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        forget(session, reason);
        return session.code.end(reason);
      }),
    );

  const endAll = (reason: string) =>
    Effect.forEach(Array.from(sessions.values()), (session) => end(session, reason), {
      discard: true,
    });

  const touch = (session: Session) => {
    if (sessions.get(session.threadId) !== session) return;
    sessions.delete(session.threadId);
    sessions.set(session.threadId, session);
  };

  const armIdle = (session: Session) =>
    Effect.suspend(() =>
      sessions.get(session.threadId) !== session || isRunning(session.evaluation)
        ? Effect.void
        : Effect.sleep(IDLE_TIMEOUT).pipe(
            Effect.andThen(end(session, ENDED.idle)),
            Effect.forkIn(session.scope),
            Effect.map((fiber) => {
              session.idle = fiber;
            }),
          ),
    );

  const open = Effect.fn("CodeMode.open")(function* (caller: CodeModeCaller, cwd: string) {
    const oldest = sessions.values().next();
    if (sessions.size >= SESSION_LIMIT && !oldest.done) yield* end(oldest.value, ENDED.evicted);
    const scope = yield* Scope.fork(layerScope);
    const code = yield* runner.start({ cwd, environment }).pipe(
      Scope.provide(scope),
      Effect.provideContext(layerContext),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const session: Session = {
      threadId: caller.threadId,
      providerSessionId: caller.providerSessionId,
      cwd,
      code,
      scope,
      fresh: { notice: notices.get(caller.threadId) },
      evaluation: undefined,
      idle: undefined,
    };
    notices.delete(caller.threadId);
    sessions.set(caller.threadId, session);
    // The scope also holds the evaluation's t3 calls, so it closes only once the evaluation has settled.
    yield* code.ended.pipe(
      Effect.flatMap((reason) => {
        forget(session, reason);
        const evaluation = session.evaluation;
        return evaluation === undefined
          ? Effect.void
          : Effect.exit(Deferred.await(evaluation.done));
      }),
      Effect.andThen(Scope.close(scope, Exit.void)),
      Effect.forkIn(layerScope),
    );
    return session;
  });

  const runIsLive = (threadId: ThreadId, runId: RunId) =>
    threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
      Effect.map(({ runs }) =>
        runs.some((run) => run.id === runId && !ENDED_RUN_STATUSES.has(run.status)),
      ),
      Effect.orElseSucceed(() => false),
    );

  const ownedBy =
    (threadId: ThreadId, runId: RunId, call: CodeModeBindings["call"]): CodeModeBindings["call"] =>
    (tool, args) =>
      Effect.flatMap(runIsLive(threadId, runId), (live) =>
        live
          ? call(tool, args)
          : Effect.fail(
              new CodeRunner.CodeToolCallError({
                reason: `t3.${tool} was refused: the turn that started this evaluation has ended.`,
              }),
            ),
      );

  /** Registers an evaluation, not yet started, in the thread's session. */
  const reserve = Effect.fn("CodeMode.reserve")(function* (
    input: CodeModeCaller & { readonly bindings: CodeModeBindings },
    runId: RunId,
    cwd: string,
  ) {
    return yield* sessionLocks.withLock(
      input.threadId,
      Effect.gen(function* () {
        const idle = sessions.get(input.threadId)?.idle;
        if (idle !== undefined) yield* Fiber.interrupt(idle);
        let session = sessions.get(input.threadId);
        // Its process may have exited before `open` heard of it.
        if (session !== undefined && (yield* session.code.hasEnded)) {
          forget(session, yield* session.code.ended);
          session = undefined;
        } else if (session !== undefined && session.providerSessionId !== input.providerSessionId) {
          yield* end(session, ENDED.credential);
          session = undefined;
        } else if (session !== undefined && session.cwd !== cwd) {
          yield* end(session, ENDED.moved);
          session = undefined;
        }
        const previous = session?.evaluation;
        if (isRunning(previous)) return yield* new CodeModeBusyError({ handle: previous.handle });
        const target = session ?? (yield* open(input, cwd));
        target.idle = undefined;
        const evaluation: Evaluation = {
          handle: yield* randomUuidV4,
          runId,
          sessionStarted: target.fresh !== undefined,
          notice: target.fresh?.notice,
          done: yield* Deferred.make<CodeRunner.CodeRunOutput>(),
        };
        target.evaluation = evaluation;
        touch(target);
        return { session: target, evaluation };
      }),
    );
  });

  const cancel = (session: Session, evaluation: Evaluation) =>
    Effect.suspend(() => {
      if (session.evaluation !== evaluation) return Effect.void;
      session.evaluation = undefined;
      return armIdle(session);
    });

  const begin = (
    session: Session,
    evaluation: Evaluation,
    input: { readonly code: string; readonly bindings: CodeModeBindings },
  ) =>
    Effect.suspend(() => {
      session.fresh = undefined;
      return session.code
        .evaluate({
          code: input.code,
          tools: input.bindings.tools,
          call: ownedBy(session.threadId, evaluation.runId, input.bindings.call),
        })
        .pipe(
          Effect.onExit((exit) => Deferred.done(evaluation.done, exit)),
          Effect.andThen(armIdle(session)),
          Effect.forkIn(session.scope),
        );
    });

  const settle = (evaluation: Evaluation, wait: Duration.Duration) =>
    Deferred.await(evaluation.done).pipe(
      Effect.timeoutOption(wait),
      Effect.map((output): CodeRunResult => ({
        handle: evaluation.handle,
        ...(Option.isSome(output)
          ? { status: "done" as const, ...output.value }
          : { status: "running" as const }),
        ...(evaluation.sessionStarted ? { sessionStarted: true as const } : {}),
        ...(evaluation.notice === undefined ? {} : { notice: evaluation.notice }),
      })),
    );

  const run = Effect.fn("CodeMode.run")(function* (
    input: CodeModeCaller & { readonly code: string; readonly bindings: CodeModeBindings },
  ) {
    const { threadId } = input;
    const { runId } = yield* permit(threadId);
    // Refused before any approval card, which would ask about a script that cannot run.
    const existing = sessions.get(threadId);
    if (existing?.providerSessionId === input.providerSessionId && isRunning(existing.evaluation)) {
      return yield* new CodeModeBusyError({ handle: existing.evaluation.handle });
    }
    // One deadline for the whole call: queueing behind other cards and waiting for this one.
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(ASK_TIMEOUT);
    // The setting, the thread's mode and the turn can all change while a call waits.
    const current = permit(threadId).pipe(
      Effect.filterOrFail(
        (permitted) => permitted.runId === runId,
        () => new CodeModeTurnEndedError({ threadId }),
      ),
    );
    let approved = false;
    while (true) {
      const { shell, decision } = yield* current;
      if (decision === "run" || approved) {
        const cwd =
          shell.worktreePath ??
          Option.getOrUndefined(
            yield* projects
              .getById(shell.projectId)
              .pipe(Effect.orElseSucceed(() => Option.none())),
          )?.workspaceRoot;
        if (cwd === undefined) return yield* new CodeModeNoWorkspaceError({ threadId });
        const started = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const { session, evaluation } = yield* reserve(input, runId, cwd);
            // Registered first, so a change after this check ends the session instead.
            const recheck = yield* current.pipe(Effect.onError(() => cancel(session, evaluation)));
            if (recheck.decision !== "run" && !approved) {
              yield* cancel(session, evaluation);
              return Option.none<CodeRunResult>();
            }
            yield* begin(session, evaluation, input);
            return Option.some(
              yield* restore(settle(evaluation, YIELD_AFTER)).pipe(
                Effect.onInterrupt(() => end(session, ENDED.cancelled(evaluation.handle))),
              ),
            );
          }),
        );
        if (Option.isSome(started)) return started.value;
        continue;
      }
      const remaining = Duration.millis(Math.max(0, deadline - (yield* Clock.currentTimeMillis)));
      const asked = yield* askLocks
        .withLock(
          threadId,
          Effect.gen(function* () {
            if ((yield* current).decision !== "ask") return false;
            yield* ask(threadId, input.code);
            return true;
          }),
        )
        .pipe(Effect.timeoutOption(remaining));
      if (Option.isNone(asked)) {
        return yield* new CodeModeNotApprovedError({ outcome: "timed_out" });
      }
      approved = asked.value;
    }
  });

  /** The thread's session, ended first when another credential started it. */
  const sessionOf = (caller: CodeModeCaller) =>
    Effect.suspend(() => {
      const session = sessions.get(caller.threadId);
      return session === undefined || session.providerSessionId === caller.providerSessionId
        ? Effect.succeed(session)
        : end(session, ENDED.credential).pipe(Effect.as(undefined));
    });

  const poll = Effect.fn("CodeMode.poll")(function* (
    input: CodeModeCaller & { readonly handle: string; readonly wait: Duration.Duration },
  ) {
    const session = yield* sessionOf(input);
    const evaluation = session?.evaluation;
    if (session === undefined || evaluation?.handle !== input.handle) {
      const notice = notices.get(input.threadId);
      return yield* new CodeModeUnknownHandleError({
        handle: input.handle,
        reason:
          session !== undefined
            ? "a later t3_code_run replaced it."
            : `the session restarted, so its globalThis values are gone too.${notice === undefined ? "" : ` ${notice}`}`,
      });
    }
    touch(session);
    return yield* settle(evaluation, Duration.min(input.wait, YIELD_AFTER));
  });

  const reset = Effect.fn("CodeMode.reset")(function* (caller: CodeModeCaller) {
    const session = sessions.get(caller.threadId);
    if (session === undefined) return { ended: false };
    yield* end(session, ENDED.reset);
    return { ended: true };
  });

  // Plain, not Effect.fn: it runs for every domain event in the environment.
  const onEvent = (event: OrchestrationV2DomainEvent) =>
    Effect.suspend(() => {
      const session = sessions.get(event.threadId);
      if (session === undefined) return Effect.void;
      const running = isRunning(session.evaluation) ? session.evaluation : undefined;
      switch (event.type) {
        case "run.updated":
          return running?.runId === event.payload.id && ENDED_RUN_STATUSES.has(event.payload.status)
            ? end(session, ENDED.turnEnded(running.handle))
            : Effect.void;
        case "thread.runtime-mode-updated":
        case "thread.interaction-mode-updated":
          return running === undefined
            ? Effect.void
            : end(session, ENDED.modeChanged(running.handle));
        case "thread.archived":
          return end(session, ENDED.archived);
        case "thread.deleted":
          return end(session, ENDED.deleted);
        default:
          return Effect.void;
      }
    });

  yield* Stream.runForEach(threads.streamDomainEvents, onEvent).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Code Mode lost the thread event stream", { error: error.message }).pipe(
        Effect.andThen(endAll(ENDED.unwatched)),
      ),
    ),
    Effect.retry(Schedule.spaced(Duration.seconds(1))),
    Effect.forkScoped,
  );
  const revocations = yield* registry.subscribeRevocations;
  yield* Stream.runForEach(revocations, (caller) =>
    Effect.suspend(() => {
      const session = sessions.get(caller.threadId);
      return session !== undefined && session.providerSessionId === caller.providerSessionId
        ? end(session, ENDED.revoked)
        : Effect.void;
    }),
  ).pipe(Effect.forkScoped);
  const settingChanges = yield* settings.subscribeChanges;
  yield* Stream.runForEach(settingChanges, (next) =>
    next.codeModeEnabled ? Effect.void : endAll(ENDED.off),
  ).pipe(Effect.forkScoped);

  return CodeMode.of({ offered, run, poll, reset });
});

export const layer = Layer.effect(CodeMode, make);

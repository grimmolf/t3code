import {
  CommandId,
  type ProviderApprovalOption,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { providerRuntimeMode } from "../orchestration-v2/RuntimePolicy.ts";
import { t3OwnedRuntimeRequestId } from "../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
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
        return `No one answered the approval request within ${Duration.toMinutes(ASK_TIMEOUT)} minutes, so the script did not run.`;
    }
  }
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
    readonly run: (
      threadId: ThreadId,
      code: string,
    ) => Effect.Effect<
      CodeRunner.CodeRunOutput,
      | CodeModeOffError
      | CodeModeRefusedError
      | CodeModeTurnEndedError
      | CodeModeNoWorkspaceError
      | CodeModeAskError
      | CodeModeNotApprovedError
      | CodeRunner.CodeRunStartError
    >;
  }
>()("t3/codeMode/CodeMode") {}

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

  const run = Effect.fn("CodeMode.run")(function* (threadId: ThreadId, code: string) {
    const { runId } = yield* permit(threadId);
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
        return yield* runner.run({ code, cwd, environment });
      }
      // One deadline covers queueing behind another call's card and waiting for this one.
      const asked = yield* askLocks
        .withLock(
          threadId,
          Effect.gen(function* () {
            if ((yield* current).decision !== "ask") return false;
            yield* ask(threadId, code);
            return true;
          }),
        )
        .pipe(Effect.timeoutOption(ASK_TIMEOUT));
      if (Option.isNone(asked)) {
        return yield* new CodeModeNotApprovedError({ outcome: "timed_out" });
      }
      approved = asked.value;
    }
  });

  return CodeMode.of({ offered, run });
});

export const layer = Layer.effect(CodeMode, make);

import {
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { codeModeDecision } from "./CodeModePolicy.ts";
import * as CodeRunner from "./CodeRunner.ts";

export class CodeModeOffError extends Schema.TaggedError<CodeModeOffError>()("CodeModeOffError", {
  providerInstanceId: ProviderInstanceId,
}) {
  override get message(): string {
    return `Code Mode is off for provider instance ${this.providerInstanceId}. Only Claude instances offer it, in their provider settings.`;
  }
}

export class CodeModeRefusedError extends Schema.TaggedError<CodeModeRefusedError>()(
  "CodeModeRefusedError",
  { runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode },
) {
  override get message(): string {
    return `Scripts cannot run while this thread is in ${this.interactionMode === "plan" ? "Plan mode" : `${this.runtimeMode} mode`}.`;
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

interface CodeModeCaller {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export class CodeMode extends Context.Service<
  CodeMode,
  {
    /** Whether the caller's provider instance offers `t3_code_run`. */
    readonly offered: (providerInstanceId: ProviderInstanceId) => Effect.Effect<boolean>;
    readonly run: (
      caller: CodeModeCaller,
      code: string,
    ) => Effect.Effect<
      CodeRunner.CodeRunOutput,
      | CodeModeOffError
      | CodeModeRefusedError
      | CodeModeNoWorkspaceError
      | CodeRunner.CodeRunStartError
    >;
  }
>()("t3/codeMode/CodeMode") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const runner = yield* CodeRunner.CodeRunner;

  // Read per call, so turning the setting off refuses the next call.
  const codeRunOf = (providerInstanceId: ProviderInstanceId) =>
    registry.getInstance(providerInstanceId).pipe(Effect.map((instance) => instance?.codeRun));

  const offered = Effect.fn("CodeMode.offered")(function* (providerInstanceId: ProviderInstanceId) {
    return (yield* codeRunOf(providerInstanceId)) !== undefined;
  });

  const run = Effect.fn("CodeMode.run")(function* (caller: CodeModeCaller, code: string) {
    const codeRun = yield* codeRunOf(caller.providerInstanceId);
    if (codeRun === undefined) {
      return yield* new CodeModeOffError({ providerInstanceId: caller.providerInstanceId });
    }
    const shell = yield* threads
      .getThreadShell(caller.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return yield* new CodeModeNoWorkspaceError({ threadId: caller.threadId });
    if (codeModeDecision(shell) === "refuse") {
      return yield* new CodeModeRefusedError({
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
      });
    }
    const cwd =
      shell.worktreePath ??
      Option.getOrUndefined(
        yield* projects.getById(shell.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
      )?.workspaceRoot;
    if (cwd === undefined)
      return yield* new CodeModeNoWorkspaceError({ threadId: caller.threadId });
    return yield* runner.run({ code, cwd, environment: codeRun.environment });
  });

  return CodeMode.of({ offered, run });
});

export const layer = Layer.effect(CodeMode, make);

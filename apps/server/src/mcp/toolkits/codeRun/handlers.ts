import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as CodeMode from "../../../codeMode/CodeMode.ts";
import { CodeToolCallError } from "../../../codeMode/CodeRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CodeRunToolkit } from "./tools.ts";

const failure = (code: OrchestratorMcpFailure["code"]) => (error: { readonly message: string }) =>
  Effect.fail(new OrchestratorMcpFailure({ code, message: error.message }));

const threadCaller = (operation: string) =>
  McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, operation)),
  );

const noBindings: CodeMode.CodeModeBindings = {
  tools: [],
  call: (tool) =>
    Effect.fail(new CodeToolCallError({ reason: `t3.${tool} is not available to scripts.` })),
};

const handlers = {
  t3_code_run: McpToolAccess.actsAsCaller(({ code }) =>
    Effect.gen(function* () {
      const { thread } = yield* threadCaller("t3_code_run");
      const codeMode = yield* CodeMode.CodeMode;
      return yield* codeMode.run({
        threadId: thread.threadId,
        providerSessionId: thread.providerSessionId,
        code,
        bindings: noBindings,
      });
    }).pipe(
      Effect.catchTags({
        CodeModeOffError: failure("capability_denied"),
        CodeModeRefusedError: failure("interaction_mode_escalation_denied"),
        CodeModeTurnEndedError: failure("run_not_found"),
        CodeModeNoWorkspaceError: failure("thread_not_found"),
        CodeModeAskError: failure("orchestration_error"),
        CodeModeNotApprovedError: failure("capability_denied"),
        CodeModeBusyError: failure("invalid_request"),
        CodeRunStartError: failure("orchestration_error"),
      }),
    ),
  ),
  t3_code_poll: McpToolAccess.readsAsCaller(({ handle, waitSeconds }) =>
    Effect.gen(function* () {
      const { thread } = yield* threadCaller("t3_code_poll");
      const codeMode = yield* CodeMode.CodeMode;
      return yield* codeMode.poll({
        threadId: thread.threadId,
        providerSessionId: thread.providerSessionId,
        handle,
        wait: waitSeconds === undefined ? CodeMode.YIELD_AFTER : Duration.seconds(waitSeconds),
      });
    }).pipe(Effect.catchTags({ CodeModeUnknownHandleError: failure("invalid_request") })),
  ),
  t3_code_reset: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const { thread } = yield* threadCaller("t3_code_reset");
      const codeMode = yield* CodeMode.CodeMode;
      return yield* codeMode.reset({
        threadId: thread.threadId,
        providerSessionId: thread.providerSessionId,
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CodeRunToolkit.tools>;

export const layer = McpToolAccess.toLayer(CodeRunToolkit, handlers);

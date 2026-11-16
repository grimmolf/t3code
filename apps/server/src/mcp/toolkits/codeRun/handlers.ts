import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CodeMode from "../../../codeMode/CodeMode.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CodeRunToolkit } from "./tools.ts";

const failure = (code: OrchestratorMcpFailure["code"]) => (error: { readonly message: string }) =>
  Effect.fail(new OrchestratorMcpFailure({ code, message: error.message }));

const handlers = {
  t3_code_run: McpToolAccess.actsAsCaller(({ code }) =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "t3_code_run")),
      Effect.flatMap(({ thread }) =>
        Effect.flatMap(CodeMode.CodeMode, (codeMode) => codeMode.run(thread, code)),
      ),
      Effect.catchTags({
        CodeModeOffError: failure("capability_denied"),
        CodeModeRefusedError: failure("interaction_mode_escalation_denied"),
        CodeModeNoWorkspaceError: failure("thread_not_found"),
        CodeRunStartError: failure("orchestration_error"),
      }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof CodeRunToolkit.tools>;

export const layer = McpToolAccess.toLayer(CodeRunToolkit, handlers);

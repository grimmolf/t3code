import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { Toolkit } from "effect/ai";

import type { CodeToolCallError } from "../../../codeMode/CodeRunner.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HtmlRenderToolkit } from "../html/tools.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import { ProjectToolkit } from "../project/tools.ts";
import { ThreadToolkit } from "../thread/tools.ts";

/**
 * What a script calls as `t3.<tool>(args)`: thread and orchestration reads, sends, and launches
 * that never wait. `delegate_task` runs only in its async mode.
 */
export const CodeRunBindingToolkit = Toolkit.make(
  OrchestratorToolkit.tools.t3_thread_list,
  OrchestratorToolkit.tools.t3_thread_read,
  ThreadToolkit.tools.t3_thread_search,
  OrchestratorToolkit.tools.t3_thread_send,
  OrchestratorToolkit.tools.delegate_task,
  OrchestratorToolkit.tools.task_status,
  ProjectToolkit.tools.t3_project_list,
  ProjectToolkit.tools.t3_project_read,
  OrchestratorToolkit.tools.orchestrator_capabilities,
  HtmlRenderToolkit.tools.html_render,
);

export class CodeRunBindings extends Context.Service<
  CodeRunBindings,
  {
    readonly tools: ReadonlyArray<string>;
    /** Calls `tool` as `scope` would call it directly: the same decoding, checks and failures. */
    readonly call: (
      scope: McpInvocationContext.McpThreadInvocationScope,
      tool: string,
      args: Schema.Json,
    ) => Effect.Effect<Schema.Json, CodeToolCallError>;
  }
>()("t3/mcp/toolkits/codeRun/bindings/CodeRunBindings") {}

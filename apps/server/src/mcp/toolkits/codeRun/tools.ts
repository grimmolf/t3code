import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  T3_CODE_POLL_TOOL_NAME,
  T3_CODE_RESET_TOOL_NAME,
  T3_CODE_RUN_TOOL_NAME,
} from "@t3tools/shared/t3McpToolPresentation";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as CodeMode from "../../../codeMode/CodeMode.ts";
import { RESPONSE_LIMIT_BYTES, RUN_TIMEOUT } from "../../../codeMode/CodeRunner.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as CodeRunBindings from "./bindings.ts";

// The script becomes the approval card's prompt, which every client receives.
const CODE_LIMIT_BYTES = 64 * 1024;
const yieldSeconds = Duration.toSeconds(CodeMode.YIELD_AFTER);
const bindingNames = Object.keys(CodeRunBindings.CodeRunBindingToolkit.tools).join(", ");

// actsAsCaller loads the calling thread through ThreadManagementService.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CodeMode.CodeMode,
];

const CodeRunTool = Tool.make(T3_CODE_RUN_TOOL_NAME, {
  description: [
    "Run JavaScript in this thread's JavaScript session, which lasts across calls; only what it returns comes back. Use it for a change repeated across many files, for search output to filter before you read it, for independent commands to run together with Promise.all, or to chain T3 tool calls whose intermediate results you do not need to read. For a single read or edit, use your own file tools instead.",
    "`code` is the body of an async function. Only `globalThis.name = value` persists to later calls; `var`, `let`, `const` and functions stay local to one call. In scope: $`cmd` runs a shell command with /bin/sh, quotes each ${} value, and resolves to { stdout, stderr, exitCode, truncated }, keeping the last 8 MiB of each stream; it throws on a nonzero exit unless you add .nothrow(), and .text() gives stdout. edit(path, oldText, newText) replaces text that occurs exactly once, else throws. require is Node's, and fs is Node's fs with promise-returning async calls (await fs.readFile) beside the usual sync ones. Relative paths resolve against the workspace.",
    `await t3.<tool>(args) calls a T3 tool and returns its result, or throws its error: ${bindingNames}. t3.tools() lists them. delegate_task runs only with mode "async". A call the script does not await stops when the script returns.`,
    "Prefer JavaScript string and file APIs to sed or perl one-liners, which differ between platforms. After a script changes a file, read it again before you edit it with another tool.",
    `\`return\` a JSON value. Within ${yieldSeconds} s you get { status: "done", result, stdout, stderr, error, truncated }; past that, { status: "running", handle }, and t3_code_poll returns the rest. One evaluation runs at a time. It stops after ${Duration.toMinutes(RUN_TIMEOUT)} minutes, or when your turn ends. A change to the thread's mode ends the session; until then, timers a script leaves behind keep running. \`sessionStarted: true\` means a new session without earlier globalThis values, and \`notice\` says why. The response, with console output, is capped at ${RESPONSE_LIMIT_BYTES / 1024} KiB; \`truncated\` says when something was cut.`,
  ].join("\n\n"),
  parameters: Schema.Struct({
    code: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(CODE_LIMIT_BYTES),
      Schema.makeFilter((code: string) => Buffer.byteLength(code) <= CODE_LIMIT_BYTES, {
        expected: `at most ${CODE_LIMIT_BYTES / 1024} KiB of UTF-8`,
      }),
    ).annotate({ description: "The body of an async function." }),
    title: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120)).annotate({
        description: "A short title for the transcript, such as `Rename fetchUser in src`.",
      }),
    ),
  }),
  success: CodeMode.CodeRunResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...dependencies, CodeRunBindings.CodeRunBindings],
})
  .annotate(Tool.Title, "Run JavaScript")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
  // Opt-in, so worth its context: a deferred tool's description never reaches the model.
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

const CodePollTool = Tool.make(T3_CODE_POLL_TOOL_NAME, {
  description: `Wait for a JavaScript evaluation t3_code_run returned as running, and return its output once it is done. Waits up to waitSeconds, at most and by default ${yieldSeconds}; while it still runs, you get { status: "running" } again.`,
  parameters: Schema.Struct({
    handle: Schema.String.annotate({ description: "The handle t3_code_run returned." }),
    waitSeconds: Schema.optional(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: `How long to wait, at most ${yieldSeconds}.`,
      }),
    ),
  }),
  success: CodeMode.CodeRunResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Check JavaScript")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

const CodeResetTool = Tool.make(T3_CODE_RESET_TOOL_NAME, {
  description:
    "End this thread's JavaScript session: stop what it runs and drop its globalThis values. The next t3_code_run starts a new one.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ ended: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Reset JavaScript")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const CodeRunToolkit = Toolkit.make(CodeRunTool, CodePollTool, CodeResetTool);

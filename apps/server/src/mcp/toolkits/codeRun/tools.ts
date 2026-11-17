import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { T3_CODE_RUN_TOOL_NAME } from "@t3tools/shared/t3McpToolPresentation";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as CodeMode from "../../../codeMode/CodeMode.ts";
import { RESPONSE_LIMIT_BYTES, RUN_TIMEOUT } from "../../../codeMode/CodeRunner.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// The script becomes the approval card's prompt, which every client receives.
const CODE_LIMIT_BYTES = 64 * 1024;

const CodeRunTool = Tool.make(T3_CODE_RUN_TOOL_NAME, {
  description: [
    "Run one JavaScript program in this thread's workspace; only what it returns comes back. Use it for a change repeated across many files, for search output to filter before you read it, or for independent commands to run together with Promise.all. For a single read or edit, use your own file tools instead.",
    "`code` is the body of an async function. In scope: $`cmd` runs a shell command with /bin/sh, quotes each ${} value, and resolves to { stdout, stderr, exitCode }; it throws on a nonzero exit unless you add .nothrow(), and .text() gives stdout. edit(path, oldText, newText) replaces text that occurs exactly once, else throws. require is Node's, and fs is Node's fs with promise-returning async calls (await fs.readFile) beside the usual sync ones. Relative paths resolve against the workspace.",
    "Prefer JavaScript string and file APIs to sed or perl one-liners, which differ between platforms. After a script changes a file, read it again before you edit it with another tool.",
    `\`return\` a JSON value. The response, with console output, is capped at ${RESPONSE_LIMIT_BYTES / 1024} KiB; \`truncated\` says when something was cut. A script stops after ${Duration.toMinutes(RUN_TIMEOUT)} minutes.`,
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
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    // actsAsCaller loads the calling thread through it.
    ThreadManagementService.ThreadManagementService,
    CodeMode.CodeMode,
  ],
})
  .annotate(Tool.Title, "Run JavaScript")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
  // Opt-in, so worth its context: a deferred tool's description never reaches the model.
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const CodeRunToolkit = Toolkit.make(CodeRunTool);

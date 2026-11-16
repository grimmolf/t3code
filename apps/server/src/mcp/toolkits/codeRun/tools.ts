import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { T3_CODE_RUN_TOOL_NAME } from "@t3tools/shared/toolActivity";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as CodeMode from "../../../codeMode/CodeMode.ts";
import { CodeRunOutput, RESPONSE_LIMIT_BYTES, RUN_TIMEOUT } from "../../../codeMode/CodeRunner.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const CodeRunTool = Tool.make(T3_CODE_RUN_TOOL_NAME, {
  description: [
    "Run one JavaScript program in this thread's workspace; only what it returns comes back. Use it for a change repeated across many files, for search output to filter before you read it, or for independent commands to run together with Promise.all. For a single read or edit, use your Read or Edit tool instead.",
    "`code` is the body of an async function. In scope: $`cmd` runs a shell command (/bin/sh; PowerShell on Windows), quotes each ${} value, and resolves to { stdout, stderr, exitCode }; it throws on a nonzero exit unless you add .nothrow(), and .text() gives stdout. edit(path, oldText, newText) replaces text that occurs exactly once, else throws. require and fs are Node's. Relative paths resolve against the workspace.",
    "Prefer JavaScript string and file APIs to sed or perl one-liners, which differ between platforms. After a script changes a file, Read it again before you use Edit on it.",
    `\`return\` a JSON value. The response, with console output, is capped at ${RESPONSE_LIMIT_BYTES / 1024} KiB; \`truncated\` says when something was cut. A script stops after ${Duration.toMinutes(RUN_TIMEOUT)} minutes.`,
  ].join("\n\n"),
  parameters: Schema.Struct({
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)).annotate({
      description: "The body of an async function.",
    }),
    title: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120)).annotate({
        description: "A short title for the transcript, such as `Rename fetchUser in src`.",
      }),
    ),
  }),
  success: CodeRunOutput,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
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

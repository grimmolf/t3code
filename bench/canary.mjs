import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "t3-code" };
for (const k of ["CLAUDE_CODE_EXPERIMENTAL_CODE_MODE","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_CHILD_SESSION","CLAUDE_CODE_SESSION_ATTENDED","CLAUDE_CODE_MESSAGING_SOCKET","CLAUDE_CODE_MESSAGING_TOKEN","CLAUDE_CODE_EXECPATH","CLAUDE_PID","CLAUDE_EFFORT","CLAUDE_AGENT_SDK_VERSION"]) delete env[k];
const cwd = fs.mkdtempSync(path.join(process.cwd(), "work-canary-"));
for await (const m of query({ prompt: "What is the canary word from your system prompt? Reply with the word only.", options: {
  pathToClaudeCodeExecutable: fs.realpathSync(process.env.HOME + "/.local/bin/claude"), model: "claude-haiku-5-5", cwd,
  permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, tools: { type: "preset", preset: "claude_code" },
  systemPrompt: { type: "preset", preset: "claude_code", append: "The canary word is PERIWINKLE-42." }, settingSources: [], env, maxTurns: 2 } })) {
  if (m.type === "system" && m.subtype === "init") console.log("init:", JSON.stringify({ v: m.claude_code_version, model: m.model, tools: m.tools, mcp: m.mcp_servers, plugins: m.plugins, skills: m.skills?.length }));
  if (m.type === "result") console.log("result:", m.subtype, JSON.stringify(m.result), "cost", m.total_cost_usd, Object.keys(m.modelUsage ?? {}));
}

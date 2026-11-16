// Usage: node probe-entrypoint.mjs <env|settings|settings-user> [debug]
// Init-only: aborts at the system/init message, before any model output.
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
const mode = process.argv[2];
const debug = process.argv[3] === "debug";
const exe = fs.realpathSync(path.join(process.env.HOME, ".local/bin/claude"));
const PAIR = { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" };
const env = { ...process.env };
for (const k of ["CLAUDE_CODE_EXPERIMENTAL_CODE_MODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION"])  delete env[k];
if (mode === "env") Object.assign(env, PAIR);
const ac = new AbortController();
const stderr = [];
const opts = {
  model: "claude-haiku-5-5", maxTurns: 1, env, abortController: ac, cwd: process.cwd(),
  pathToClaudeCodeExecutable: exe,
  settingSources: mode === "settings-user" ? ["user", "project", "local"] : [],
  stderr: (d) => stderr.push(String(d)),
};
if (mode !== "env") opts.settings = { env: PAIR };
if (debug) opts.extraArgs = { "debug-to-stderr": null };
let out;
try {
  for await (const m of query({ prompt: "say hi", options: opts })) {
    if (m.type === "system" && m.subtype === "init") {
      out = { mode, exe, claude_code_version: m.claude_code_version, hasREPL: m.tools.includes("REPL"), nTools: m.tools.length, tools: m.tools };
      ac.abort();
      break;
    }
  }
} catch (e) { if (!ac.signal.aborted) out = { mode, error: String(e?.message ?? e) }; }
const err = stderr.join("");
if (debug) fs.writeFileSync(`results/r2-probe/${mode}-debug.stderr`, err);
const hits = err.split("\n").filter((l) => /repl|code.?mode|entrypoint|warn/i.test(l)).slice(0, 40);
console.log(JSON.stringify({ ...out, stderrBytes: err.length, stderrHits: hits }, null, 1));

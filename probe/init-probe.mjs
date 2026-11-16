import { query } from "@anthropic-ai/claude-agent-sdk";
const [codeMode, exe] = [process.argv[2] === "1", process.argv[3]];
const env = { ...process.env };
delete env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE;
if (codeMode) env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = "1";
const ac = new AbortController();
const opts = { model: "claude-haiku-5-5", maxTurns: 1, env, abortController: ac, settingSources: [], cwd: process.cwd(),
  stderr: (d) => process.stderr.write("[stderr] " + d) };
if (exe) opts.pathToClaudeCodeExecutable = exe;
const t0 = Date.now(); let sawAssistant = false;
try {
  for await (const m of query({ prompt: "say hi", options: opts })) {
    if (m.type === "system" && m.subtype === "init") {
      console.log(JSON.stringify({ codeMode, exe: exe ?? "(sdk bundled)", claude_code_version: m.claude_code_version,
        hasREPL: m.tools.includes("REPL"), tools: m.tools, ms: Date.now() - t0, sawAssistantBeforeInit: sawAssistant }));
      ac.abort(); break;
    }
    if (m.type === "assistant") sawAssistant = true;
    console.log("pre-init msg:", m.type, m.subtype ?? "");
  }
} catch (e) { if (!ac.signal.aborted) console.log("ERROR:", e?.message ?? e); }

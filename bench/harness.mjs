// Usage: node harness.mjs --model claude-haiku-5-5 --tasks A,B,C --arms off,instructions,tool --n 5 [--nC 3] [--tag main] [--concurrency 3] [--budget 25]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { TASKS } from "./fixtures.mjs";
import { runCode } from "./coderun.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const MODEL = args.model ?? "claude-haiku-5-5";
const TASK_IDS = (args.tasks ?? "A").split(",");
const ARMS = (args.arms ?? "off,instructions,tool").split(",");
const N = Number(args.n ?? 1);
const N_C = Number(args.nC ?? N);
const TAG = args.tag ?? "main";
const CONCURRENCY = Number(args.concurrency ?? 3);
const BUDGET = Number(args.budget ?? 25);
const CLAUDE_EXE = fs.realpathSync(path.join(process.env.HOME, ".local/bin/claude"));
const RESULTS = path.join(HERE, "results");
const SUMMARY = path.join(RESULTS, "summary.jsonl");

const POLICY_TAIL =
  "Use ordinary tool calls for a single read or edit. After a script edits a file, Read it again before using Edit on it.";
const POLICY_HEAD =
  "When a task repeats the same change across many files, needs search output filtered before you read it, or has several independent commands, ";
const APPEND = {
  off: "",
  instructions:
    POLICY_HEAD +
    "do it in one Bash call: write a short Node script as a heredoc (`node <<'EOF' ... EOF`) that does the work and prints only a compact summary. " +
    POLICY_TAIL,
  tool:
    POLICY_HEAD +
    "do it in one `mcp__t3-code__code_run` call: write a short JavaScript program using `$` and `edit` that does the work and returns only a compact summary. " +
    POLICY_TAIL,
};

APPEND.bashchain =
  APPEND.instructions +
  "\n\nWhen a task needs a search followed by edits and a test run, do it in one Bash call: chain the search, the edit, and the test (for example `grep -rl ... | xargs perl -pi -e ... && node --test`) and print only a compact summary. Use ordinary tool calls for a single read or edit.";

const CODE_RUN_DESCRIPTION =
  "Run a JavaScript program in a Node child process whose cwd is the project root. `code` is the body of an async function, so use `await` and `return`. " +
  "In scope: $`cmd` runs cmd with /bin/sh -c and resolves {stdout, stderr, exitCode} without throwing on a nonzero exit; " +
  "edit(path, oldText, newText) replaces oldText with newText and throws unless oldText occurs exactly once. " +
  "`require` is also in scope (e.g. require('node:fs')). The return value is JSON-encoded and sent back (capped at 32 KiB), with the tails of console output. Times out after 120 s.";

const priorSpend = () =>
  fs.existsSync(SUMMARY)
    ? fs.readFileSync(SUMMARY, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (JSON.parse(l).cost ?? 0), 0)
    : 0;

function childEnv() {
  const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "t3-code" };
  for (const k of [
    "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_AGENT_SDK_VERSION",
  ])
    delete env[k];
  return env;
}

const NODE_HEREDOC = /\bnode\b[^\n]*<<-?\s*['"]?\w+/;
const OTHER_SCRIPT = /\bnode\s+(-e|--eval)\b|\bpython3?\s+(-c\b|<<|-\s)|\bperl\s+-\w*[pi]|\bsed\s+-i|\bfor\s+\w+\s+in\b|\bxargs\b|-exec\b|\bwhile\s+read\b|\bawk\b/;

async function runSample({ task, arm, idx }) {
  const id = `${task}-${arm}-${idx}`;
  const outDir = path.join(RESULTS, TAG, MODEL);
  const work = path.join(HERE, "work", TAG, MODEL, randomBytes(6).toString("hex"));
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  TASKS[task].make(work);

  const options = {
    pathToClaudeCodeExecutable: CLAUDE_EXE,
    model: MODEL,
    cwd: work,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: { type: "preset", preset: "claude_code" },
    systemPrompt: { type: "preset", preset: "claude_code", append: APPEND[arm] },
    settingSources: [],
    env: childEnv(),
    maxTurns: 40,
    abortController: new AbortController(),
    stderr: (d) => fs.appendFileSync(path.join(outDir, `${id}.stderr`), d),
  };
  if (arm === "tool") {
    let calls = 0;
    options.mcpServers = {
      "t3-code": createSdkMcpServer({
        name: "t3-code",
        version: "0.0.1",
        alwaysLoad: true,
        timeout: 130_000,
        tools: [
          tool("code_run", CODE_RUN_DESCRIPTION, { code: z.string(), title: z.string().optional() }, async ({ code }) => {
            calls++;
            const r = await runCode(code, work);
            return { content: [{ type: "text", text: r.text }], isError: r.isError };
          }),
        ],
      }),
    };
  }
  const killTimer = setTimeout(() => options.abortController.abort(), 15 * 60_000);
  const jsonl = path.join(outDir, `${id}.jsonl`);
  fs.writeFileSync(jsonl, "");
  const toolUses = new Map();
  const errorsByTool = {};
  const bash = { nodeHeredoc: 0, otherScript: 0, plain: 0 };
  let toolErrors = 0;
  let result;
  let init;
  let error;
  const t0 = Date.now();
  try {
    for await (const m of query({ prompt: args.prompt ?? TASKS[task].prompt, options })) {
      fs.appendFileSync(jsonl, JSON.stringify(m) + "\n");
      if (m.type === "system" && m.subtype === "init") init = m;
      if (m.type === "assistant")
        for (const b of m.message.content)
          if (b.type === "tool_use" && !toolUses.has(b.id)) {
            toolUses.set(b.id, b.name);
            if (b.name === "Bash") {
              const c = String(b.input?.command ?? "");
              if (NODE_HEREDOC.test(c)) bash.nodeHeredoc++;
              else if (OTHER_SCRIPT.test(c)) bash.otherScript++;
              else bash.plain++;
            }
          }
      if (m.type === "user" && Array.isArray(m.message?.content))
        for (const b of m.message.content)
          if (b.type === "tool_result" && b.is_error) {
            toolErrors++;
            const n = toolUses.get(b.tool_use_id) ?? "?";
            errorsByTool[n] = (errorsByTool[n] ?? 0) + 1;
          }
      if (m.type === "result") result = m;
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }
  clearTimeout(killTimer);
  const byTool = {};
  for (const n of toolUses.values()) byTool[n] = (byTool[n] ?? 0) + 1;
  let check;
  try {
    check = TASKS[task].check(work, result?.result);
  } catch (e) {
    check = { ok: false, error: String(e) };
  }
  const u = result?.usage ?? {};
  const row = {
    tag: TAG,
    model: MODEL,
    task,
    arm,
    idx,
    subtype: result?.subtype ?? "none",
    is_error: result?.is_error,
    num_turns: result?.num_turns,
    cost: result?.total_cost_usd ?? 0,
    duration_ms: result?.duration_ms ?? Date.now() - t0,
    usage: {
      input: u.input_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      cache_creation: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    },
    modelUsage: result?.modelUsage,
    tools: byTool,
    bash,
    codeRun: byTool["mcp__t3-code__code_run"] ?? 0,
    toolErrors,
    errorsByTool,
    initTools: init?.tools,
    mcpServers: init?.mcp_servers,
    hasCodeRunTool: init?.tools?.includes("mcp__t3-code__code_run") ?? false,
    claudeCodeVersion: init?.claude_code_version,
    check,
    error,
    work,
    jsonl,
  };
  fs.appendFileSync(SUMMARY, JSON.stringify(row) + "\n");
  console.log(
    `${MODEL} ${id}: ${row.subtype} turns=${row.num_turns} cost=$${row.cost.toFixed(4)} ok=${check.ok} tools=${JSON.stringify(byTool)} bash=${JSON.stringify(bash)}${error ? " ERROR " + error : ""}`,
  );
  return row;
}

const done = new Set(
  fs.existsSync(SUMMARY)
    ? fs.readFileSync(SUMMARY, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => `${r.tag}|${r.model}|${r.task}|${r.arm}|${r.idx}`)
    : [],
);
const queue = [];
for (const task of TASK_IDS)
  for (let i = 0; i < (task === "C" ? N_C : N); i++)
    for (const arm of ARMS) if (!done.has(`${TAG}|${MODEL}|${task}|${arm}|${i}`)) queue.push({ task, arm, idx: i });

let spent = priorSpend();
console.log(`claude=${CLAUDE_EXE} sdk=${JSON.parse(fs.readFileSync(path.join(HERE, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"))).version} node=${process.version} prior spend=$${spent.toFixed(2)} queue=${queue.length}`);
try {
  console.log(`git ${execFileSync("git", ["--version"]).toString().trim()}`);
} catch {}
let stopped = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      if (spent >= BUDGET) {
        stopped = queue.length;
        queue.length = 0;
        break;
      }
      const row = await runSample(queue.shift());
      spent += row.cost;
      if (/authenticate/i.test(row.error ?? "")) {
        console.log("auth failure, stopping queue");
        stopped = queue.length;
        queue.length = 0;
      }
    }
  }),
);
console.log(`done. total spend so far=$${spent.toFixed(2)}${stopped ? `; budget stop left ${stopped} samples unrun` : ""}`);

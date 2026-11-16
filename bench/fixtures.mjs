import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const w = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const git = (root, ...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
const initGit = (root) => {
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "fixture");
};
const listFiles = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name))
    : [];

// ---------- Task A: repeated edit ----------
const A_MODULES = [
  (n) => `import { retryPolicy } from "./retry.js";\n\nexport const policy = retryPolicy({ maxAttempts: 3, baseDelayMs: ${n * 10} });\n\nexport function describe() {\n  return \`m${n}: \${policy.maxAttempts} attempts\`;\n}\n`,
  (n) => `import { retryPolicy } from "./retry.js";\n\nconst DEFAULT_TIMEOUT = 2500;\n\n// fetches a page of records; retryPolicy controls backoff between attempts\nexport const policy = retryPolicy({\n  maxAttempts: 3,\n  baseDelayMs: ${n * 25},\n});\n\nexport async function fetchPage(client, cursor) {\n  return client.get("/records", { cursor, timeout: DEFAULT_TIMEOUT });\n}\n`,
  (n) => `import { retryPolicy } from "./retry.js";\n\nexport function makeQueueWorker(queue) {\n  const local = retryPolicy({ maxAttempts: 3, baseDelayMs: ${n * 5}, jitter: false });\n  return { queue, local };\n}\n\nexport const policy = makeQueueWorker("jobs-${n}").local;\n`,
  (n) => `import { retryPolicy } from "./retry.js";\n\nconst LIMITS = { maxBatch: 50, maxAttemptsPerBatch: 7 };\n\nexport const policy = retryPolicy({ baseDelayMs: ${100 + n}, maxAttempts: 3 });\n\nexport function limits() {\n  return LIMITS;\n}\n`,
];

export function makeA(root) {
  w(root, "package.json", `{\n  "name": "fixture-a",\n  "type": "module",\n  "private": true\n}\n`);
  w(
    root,
    "src/retry.js",
    `export function retryPolicy(opts = {}) {\n  const { maxAttempts = 1, baseDelayMs = 100, jitter = true } = opts;\n  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");\n  return {\n    maxAttempts,\n    baseDelayMs,\n    jitter,\n    delayFor(attempt) {\n      if (attempt >= maxAttempts) return null;\n      return baseDelayMs * 2 ** attempt;\n    },\n  };\n}\n`,
  );
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, "0");
    w(root, `src/m${n}.js`, A_MODULES[(i - 1) % A_MODULES.length](i));
  }
  w(
    root,
    "test/retry.test.js",
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { retryPolicy } from "../src/retry.js";\n\ntest("delay doubles per attempt", () => {\n  const p = retryPolicy({ maxAttempts: 4, baseDelayMs: 10 });\n  assert.deepEqual([0, 1, 2, 3, 4].map((a) => p.delayFor(a)), [10, 20, 40, 80, null]);\n});\n\ntest("rejects zero attempts", () => {\n  assert.throws(() => retryPolicy({ maxAttempts: 0 }));\n});\n`,
  );
  const imports = Array.from({ length: 12 }, (_, i) => `  import("../src/m${String(i + 1).padStart(2, "0")}.js"),`).join("\n");
  w(
    root,
    "test/modules.test.js",
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { retryPolicy } from "../src/retry.js";\n\ntest("every module exposes a usable policy", async () => {\n  const mods = await Promise.all([\n${imports}\n  ]);\n  for (const m of mods) {\n    assert.equal(typeof m.policy.delayFor, "function");\n    assert.equal(m.policy.delayFor(m.policy.maxAttempts), null);\n  }\n  assert.equal(typeof retryPolicy, "function");\n});\n`,
  );
  w(root, "README.md", `# fixture-a\n\nRun tests with \`node --test\`.\n`);
  initGit(root);
}

export function checkA(root) {
  const files = [...listFiles(path.join(root, "src")), ...listFiles(path.join(root, "test"))];
  let retryLeft = 0;
  let five = 0;
  let three = 0;
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    retryLeft += (t.match(/retryPolicy/g) ?? []).length;
    five += (t.match(/maxAttempts: 5\b/g) ?? []).length;
    three += (t.match(/maxAttempts: 3\b/g) ?? []).length;
  }
  const backoffExported = /export function backoffPolicy\b/.test(fs.readFileSync(path.join(root, "src/retry.js"), "utf8"));
  const t = spawnSync("node", ["--test"], { cwd: root, encoding: "utf8", timeout: 60000 });
  const ok = retryLeft === 0 && five === 12 && three === 0 && backoffExported && t.status === 0;
  return { ok, retryLeft, five, three, backoffExported, testExit: t.status };
}

// ---------- Task B: filtered search ----------
// Counts per src file. Top three are 17, 15, 13. src/core/scheduler.js has 12 `TODO:` plus 4 bare `TODO` lines,
// so a grep for "TODO" without the colon ranks it wrong.
const B_TOP = { "src/net/http-client.js": 17, "src/db/migrations.js": 15, "src/ui/table-view.js": 13 };
const B_DISTRACT = "src/core/scheduler.js";
const B_DIRS = ["core", "db", "net", "ui", "util"];
const B_NAMES = ["cache", "parser", "router", "store", "worker", "events", "format", "auth"];

const bFiles = () => {
  const files = [];
  for (const d of B_DIRS) for (const n of B_NAMES) files.push(`src/${d}/${n}.js`);
  // 40 base names; swap four of them for the seeded names so the total stays 40
  files.splice(0, 1, "src/core/scheduler.js");
  files.splice(10, 1, "src/db/migrations.js");
  files.splice(20, 1, "src/net/http-client.js");
  files.splice(30, 1, "src/ui/table-view.js");
  return files;
};

const bCount = (rel, i) => B_TOP[rel] ?? (rel === B_DISTRACT ? 12 : (i * 7) % 11);

export function makeB(root, noise = "") {
  w(root, "package.json", `{\n  "name": "fixture-b",\n  "type": "module",\n  "private": true\n}\n`);
  bFiles().forEach((rel, i) => {
    const todos = bCount(rel, i);
    const lines = [`// ${rel}`, `export const name = ${JSON.stringify(rel)};`];
    for (let k = 0; k < 40; k++) {
      if (k < todos) lines.push(`  // TODO: handle case ${k} in ${path.basename(rel, ".js")}`);
      lines.push(`export function fn${k}(x) { return x + ${k}; }`);
    }
    if (rel === B_DISTRACT) for (let k = 0; k < 4; k++) lines.push(`// TODO revisit batching ${k}`);
    lines.push(`const TODO_LIMIT = ${i}; // not a todo`);
    w(root, rel, lines.join("\n") + "\n");
  });
  for (let v = 0; v < 60; v++) {
    const body = Array.from({ length: 30 }, (_, k) => `  // TODO: vendored upstream issue #${v * 100 + k} — ${"x".repeat(60)}`).join("\n");
    w(root, `${noise}vendor/pkg${String(v).padStart(2, "0")}/index.js`, `module.exports = {};\n${body}\n`);
  }
  const log = Array.from({ length: 1200 }, (_, k) => `2026-11-0${(k % 9) + 1}T10:${String(k % 60).padStart(2, "0")}:00Z WARN worker-${k % 7} TODO: retry queue item ${k} payload=${"y".repeat(80)}`).join("\n");
  w(root, `${noise}logs/app.log`, log + "\n");
  initGit(root);
}

export function checkB(_root, answer) {
  const found = {};
  for (const line of String(answer ?? "").split("\n")) {
    const m = line.match(/((?:\.\/)?src\/[\w./-]+\.js)\W*[:=-]\s*\**\s*(\d+)/);
    if (m) found[m[1].replace(/^\.\//, "")] = Number(m[2]);
  }
  const want = Object.entries(B_TOP);
  const hits = want.filter(([p, c]) => found[p] === c).length;
  const extra = Object.keys(found).filter((p) => !(p in B_TOP));
  return { ok: hits === 3 && extra.length === 0, hits, found, extra };
}

// ---------- Task C: control ----------
export function makeC(root) {
  w(root, "package.json", `{\n  "name": "fixture-c",\n  "type": "module",\n  "private": true\n}\n`);
  w(root, "src/config.js", `export const config = {\n  host: "0.0.0.0",\n  port: 3000,\n  requestTimeoutMs: 3000,\n  logLevel: "info",\n};\n`);
  w(root, "src/server.js", `import { config } from "./config.js";\n\nexport function listen(app) {\n  return app.listen(config.port, config.host);\n}\n`);
  w(root, "README.md", `# fixture-c\n\nThe server listens on port 3000 by default.\n`);
  initGit(root);
}

export function checkC(root) {
  const t = fs.readFileSync(path.join(root, "src/config.js"), "utf8");
  const status = git(root, "status", "--porcelain").trim().split("\n").filter(Boolean);
  const diff = git(root, "diff", "-U0", "--", "src/config.js");
  const changedLines = diff.split("\n").filter((l) => /^[+-][^+-]/.test(l));
  const ok =
    /port: 4000,/.test(t) &&
    /requestTimeoutMs: 3000,/.test(t) &&
    status.length === 1 &&
    status[0] === "M src/config.js" &&
    changedLines.length === 2;
  return { ok, status, changedLines };
}

export const TASKS = {
  A: {
    make: makeA,
    check: checkA,
    prompt:
      "Rename the function retryPolicy to backoffPolicy everywhere in src/ and test/, change every `maxAttempts: 3` to `maxAttempts: 5`, then run the tests with `node --test` and tell me the result.",
  },
  B: {
    make: makeB,
    check: checkB,
    prompt:
      "Which three files under src/ contain the most `TODO:` comments, and how many does each have? Ignore vendor/ and logs. Answer as `path: count` lines.",
  },
  B2: {
    make: (root) => makeB(root, "src/"),
    check: checkB,
    prompt:
      "Which three files under src/ contain the most `TODO:` comments, and how many does each have? Ignore src/vendor/ and src/logs/. Answer as `path: count` lines.",
  },
  C: { make: makeC, check: checkC, prompt: "In src/config.js change the default port from 3000 to 4000." },
};

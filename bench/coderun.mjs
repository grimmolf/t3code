// Prototype of a T3-hosted code tool. Imported by harness.mjs for the handler; run directly as the child process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const VALUE_CAP = 32 * 1024;
const TAIL_CAP = 16 * 1024;
const TIMEOUT_MS = 120_000;
const SELF = fileURLToPath(import.meta.url);

const tail = (s) => (s.length > TAIL_CAP ? `…[${s.length - TAIL_CAP} bytes cut]\n` + s.slice(-TAIL_CAP) : s);

export function runCode(code, cwd) {
  const outFile = path.join(os.tmpdir(), `coderun-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, "--child", outFile], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, TIMEOUT_MS);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      let result = { ok: false, error: timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : `process exited ${exitCode} without a result` };
      try {
        result = JSON.parse(fs.readFileSync(outFile, "utf8"));
        fs.rmSync(outFile);
      } catch {}
      let value = result.value;
      if (value !== undefined && value.length > VALUE_CAP) value = value.slice(0, VALUE_CAP) + `…[truncated, ${value.length} bytes total]`;
      const parts = [result.ok ? `returned: ${value ?? "undefined"}` : `error: ${result.error}`];
      if (stdout) parts.push(`stdout:\n${tail(stdout)}`);
      if (stderr) parts.push(`stderr:\n${tail(stderr)}`);
      resolve({ text: parts.join("\n\n"), isError: !result.ok });
    });
    child.stdin.end(code);
  });
}

async function childMain(outFile) {
  const { spawn: sp } = await import("node:child_process");
  let code = "";
  for await (const chunk of process.stdin) code += chunk;
  const $ = (strings, ...vals) => {
    const cmd = strings.reduce((acc, s, i) => acc + s + (i < vals.length ? String(vals[i]) : ""), "");
    return new Promise((res) => {
      const p = sp("/bin/sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (exitCode) => res({ stdout, stderr, exitCode }));
    });
  };
  const edit = (file, oldText, newText) => {
    const t = fs.readFileSync(file, "utf8");
    const n = t.split(oldText).length - 1;
    if (n !== 1) throw new Error(`edit(${file}): oldText occurs ${n} times, expected exactly 1`);
    fs.writeFileSync(file, t.replace(oldText, () => newText));
    return true;
  };
  let result;
  try {
    const AsyncFunction = (async () => {}).constructor;
    const value = await new AsyncFunction("$", "edit", "require", code)($, edit, createRequire(path.join(process.cwd(), "index.js")));
    result = { ok: true, value: JSON.stringify(value) };
  } catch (e) {
    result = { ok: false, error: e?.stack ?? String(e) };
  }
  fs.writeFileSync(outFile, JSON.stringify(result));
  process.exit(0);
}

if (process.argv[2] === "--child") await childMain(process.argv[3]);

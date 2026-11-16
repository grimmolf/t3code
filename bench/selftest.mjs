import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { TASKS } from "./fixtures.mjs";
import { runCode } from "./coderun.mjs";

const base = path.join(path.dirname(new URL(import.meta.url).pathname), "work", "selftest");
fs.rmSync(base, { recursive: true, force: true });
const fresh = (task, name) => {
  const d = path.join(base, `${task}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  TASKS[task].make(d);
  return d;
};
const sh = (cwd, cmd) => execSync(cmd, { cwd, encoding: "utf8", shell: "/bin/sh" });
const expect = (label, got, want) => {
  console.log(`${got.ok === want ? "PASS" : "FAIL"} ${label}: ok=${got.ok} ${JSON.stringify({ ...got, found: undefined })}`);
  if (got.ok !== want) process.exitCode = 1;
};

let d = fresh("A", "untouched");
expect("A untouched fails", TASKS.A.check(d), false);
d = fresh("A", "correct");
sh(d, `grep -rl retryPolicy src test | xargs sed -i '' 's/retryPolicy/backoffPolicy/g'; grep -rl 'maxAttempts: 3' src | xargs sed -i '' 's/maxAttempts: 3/maxAttempts: 5/g'`);
expect("A correct passes", TASKS.A.check(d), true);
d = fresh("A", "missed-one");
sh(d, `grep -rl retryPolicy src test | xargs sed -i '' 's/retryPolicy/backoffPolicy/g'; grep -rl 'maxAttempts: 3' src | grep -v m07 | xargs sed -i '' 's/maxAttempts: 3/maxAttempts: 5/g'`);
expect("A one missed fails", TASKS.A.check(d), false);
d = fresh("A", "src-only-rename");
sh(d, `grep -rl retryPolicy src | xargs sed -i '' 's/retryPolicy/backoffPolicy/g'; grep -rl 'maxAttempts: 3' src | xargs sed -i '' 's/maxAttempts: 3/maxAttempts: 5/g'`);
expect("A tests not renamed fails", TASKS.A.check(d), false);

d = fresh("B", "x");
const truth = sh(d, `grep -c 'TODO:' $(find src -name '*.js') | sort -t: -k2 -nr | head -4`);
console.log("B ground truth (top 4):\n" + truth);
const naive = sh(d, `grep -rc 'TODO' src | sort -t: -k2 -nr | head -3`);
console.log("B naive bare-TODO grep top 3:\n" + naive);
console.log("B whole-repo `grep -rn TODO: .` lines:", sh(d, `grep -rn 'TODO:' . | wc -l`).trim());
expect("B correct answer", TASKS.B.check(d, "src/net/http-client.js: 17\nsrc/db/migrations.js: 15\n- `src/ui/table-view.js`: 13"), true);
expect("B naive answer fails", TASKS.B.check(d, naive), false);
expect("B with vendor fails", TASKS.B.check(d, "vendor/pkg01/index.js: 30\nsrc/net/http-client.js: 17\nsrc/db/migrations.js: 15"), false);
expect("B wrong count fails", TASKS.B.check(d, "src/net/http-client.js: 17\nsrc/db/migrations.js: 15\nsrc/ui/table-view.js: 12"), false);

d = fresh("C", "correct");
sh(d, `sed -i '' 's/port: 3000/port: 4000/' src/config.js`);
expect("C correct passes", TASKS.C.check(d), true);
d = fresh("C", "overreach");
sh(d, `sed -i '' 's/3000/4000/g' src/config.js README.md`);
expect("C overreach fails", TASKS.C.check(d), false);

d = fresh("A", "coderun");
let r = await runCode(
  `const { stdout } = await $\`grep -rl retryPolicy src test\`; const files = stdout.trim().split("\\n"); console.log("files", files.length); edit("src/m01.js", "maxAttempts: 3", "maxAttempts: 5"); return { files: files.length };`,
  d,
);
console.log("coderun ok:", r);
r = await runCode(`edit("src/m01.js", "retryPolicy", "x");`, d);
console.log("coderun edit-ambiguous:", r.isError, r.text.split("\n")[0]);
r = await runCode(`return (await $\`node --test\`).exitCode;`, d);
console.log("coderun node --test exit:", r.text);

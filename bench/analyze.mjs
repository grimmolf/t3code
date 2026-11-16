// Usage: node analyze.mjs [tags=main,r2]
// Pools rows from the given tags. Each (model, task, arm) cell must come from one tag.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TAGS = (process.argv[2] ?? "main,r2").split(",");
const ARMS = ["off", "instructions", "tool", "bashchain"];
const TASKS = ["A", "B", "B2", "C"];
// Comparison family: every pair below, in every (model, task) cell where both arms have >= 2 samples,
// on the two metrics below. Bonferroni divides alpha by the number of p-values this script prints.
const PAIRS = [
  ["tool", "off"],
  ["tool", "instructions"],
  ["instructions", "off"],
  ["bashchain", "off"],
  ["bashchain", "instructions"],
  ["bashchain", "tool"],
];
const METRICS = [
  ["cost", (r) => r.cost],
  ["turns", (r) => r.num_turns ?? 0],
];
const ALPHA = 0.05;

const rows = fs
  .readFileSync(path.join(HERE, "results/summary.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const all = rows.filter((r) => TAGS.includes(r.tag));
const cumIn = (r) => r.usage.input + r.usage.cache_read + r.usage.cache_creation;
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const fmt = (xs, f = (x) => x) => (xs.length ? `${f(med(xs))} (${f(Math.min(...xs))}–${f(Math.max(...xs))})` : "-");
const batched = (r) =>
  r.arm === "tool"
    ? r.codeRun > 0
    : r.arm === "instructions"
      ? r.bash.nodeHeredoc > 0
      : r.bash.nodeHeredoc + r.bash.otherScript > 0;
const choose = (n, k) => {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
};

// Exact two-sided rank-sum (Mann-Whitney) test by full enumeration, midranks for ties.
// Also returns the smallest p this tie structure can produce (the most extreme split).
function rankSum(a, b) {
  const xs = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((p, q) => p[0] - q[0]);
  const ranks = new Array(xs.length);
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1][0] === xs[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const n = a.length;
  const N = xs.length;
  const obs = ranks.filter((_, i) => xs[i][1] === 0).reduce((s, r) => s + r, 0);
  const mu = (n * (N + 1)) / 2;
  const devObs = Math.abs(obs - mu) - 1e-9;
  const devs = [];
  const rec = (start, k, sum) => {
    if (k === n) return void devs.push(Math.abs(sum - mu));
    for (let i = start; i <= N - (n - k); i++) rec(i + 1, k + 1, sum + ranks[i]);
  };
  rec(0, 0, 0);
  const maxDev = devs.reduce((m, d) => (d > m ? d : m), 0) - 1e-9;
  return {
    p: devs.filter((d) => d >= devObs).length / devs.length,
    floorTies: devs.filter((d) => d >= maxDev).length / devs.length,
  };
}

const out = [];
const tests = [];
const models = [...new Set(all.map((r) => r.model))];
for (const model of models) {
  out.push(`\n## ${model}\n`);
  out.push(
    "| task | arm | tag | n | ok | batched | turns med (range) | cost $ med (range) | cost $ mean | cumulative input incl. cache reads, med (range) | cache writes med | prefix-write samples | duration s med | tool errors |",
  );
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const task of TASKS)
    for (const arm of ARMS) {
      const g = all.filter((r) => r.model === model && r.task === task && r.arm === arm);
      if (!g.length) continue;
      const tags = [...new Set(g.map((r) => r.tag))];
      if (tags.length > 1) throw new Error(`${model} ${task} ${arm} mixes tags ${tags}`);
      const cw = g.map((r) => r.usage.cache_creation);
      // A sample that wrote >10k more cache than its cell median paid for a new prompt prefix.
      const prefixWrites = g.filter((r) => r.usage.cache_creation > med(cw) + 10_000).length;
      out.push(
        `| ${task} | ${arm} | ${tags[0]} | ${g.length} | ${g.filter((r) => r.check.ok).length}/${g.length} | ${g.filter(batched).length}/${g.length} | ${fmt(g.map((r) => r.num_turns ?? 0))} | ${fmt(g.map((r) => r.cost), (x) => x.toFixed(4))} | ${mean(g.map((r) => r.cost)).toFixed(4)} | ${fmt(g.map(cumIn), (x) => Math.round(x / 1000) + "k")} | ${Math.round(med(cw) / 1000)}k | ${prefixWrites} | ${med(g.map((r) => r.duration_ms / 1000)).toFixed(0)} | ${g.reduce((s, r) => s + r.toolErrors, 0)} |`,
      );
    }
  for (const task of TASKS) {
    const g = (arm) => all.filter((r) => r.model === model && r.task === task && r.arm === arm);
    for (const [x, y] of PAIRS) {
      const a = g(x);
      const b = g(y);
      if (a.length < 2 || b.length < 2) continue;
      if (a.length + b.length > 20) throw new Error(`exact enumeration too large for ${model} ${task} ${x}/${y}`);
      for (const [metric, f] of METRICS) {
        const r = rankSum(a.map(f), b.map(f));
        tests.push({
          model, task, x, y, metric, na: a.length, nb: b.length, ...r,
          diff: med(a.map(f)) - med(b.map(f)),
          floorNoTies: 2 / choose(a.length + b.length, a.length),
        });
      }
    }
  }
}

const threshold = ALPHA / tests.length;
out.push(`\n## Rank-sum tests\n`);
out.push(
  `Family: ${tests.length} p-values (pairs ${PAIRS.map((p) => p.join("/")).join(", ")}; metrics ${METRICS.map((m) => m[0]).join(", ")}; every model × task cell with both arms). Bonferroni threshold ${ALPHA}/${tests.length} = ${threshold.toExponential(2)}.`,
);
out.push(
  `"floor" is the smallest p the cell could produce: no-ties is 2/C(n+m,n); ties is the most extreme split of the observed values. A cell whose floor exceeds the threshold could never pass.\n`,
);
out.push("| model | task | comparison | metric | n | median diff | p | floor no-ties | floor ties | survives |");
out.push("|---|---|---|---|---|---|---|---|---|---|");
for (const t of tests)
  out.push(
    `| ${t.model.replace("claude-", "")} | ${t.task} | ${t.x} vs ${t.y} | ${t.metric} | ${t.na}+${t.nb} | ${t.metric === "cost" ? (t.diff >= 0 ? "+" : "") + t.diff.toFixed(4) : (t.diff >= 0 ? "+" : "") + t.diff} | ${t.p.toPrecision(3)} | ${t.floorNoTies.toPrecision(3)} | ${t.floorTies.toPrecision(3)} | ${t.p <= threshold ? "**yes**" : t.floorTies > threshold ? "never" : "no"} |`,
  );
const survivors = tests.filter((t) => t.p <= threshold);
out.push(`\nSurvive correction: ${survivors.length ? survivors.map((t) => `${t.model} ${t.task} ${t.x} vs ${t.y} ${t.metric} (p=${t.p.toPrecision(3)})`).join("; ") : "none"}.`);
out.push(`\nMinimum attainable two-sided exact p with no ties, by group sizes:`);
for (const [n, m] of [[3, 3], [5, 5], [8, 8], [10, 10]])
  out.push(`- ${n} vs ${m}: ${(2 / choose(n + m, n)).toPrecision(3)}${2 / choose(n + m, n) > threshold ? " (cannot pass this family's threshold)" : ""}`);

const failed = all.filter((r) => !r.check.ok || r.subtype !== "success" || r.error);
out.push(`\nFailed or non-success samples: ${failed.length}`);
for (const r of failed)
  out.push(`- ${r.model} ${r.task}-${r.arm}-${r.idx}: subtype=${r.subtype} error=${r.error ?? "-"} check=${JSON.stringify(r.check)}`);
for (const tag of TAGS) {
  const t = all.filter((r) => r.tag === tag);
  out.push(`Tag ${tag}: $${t.reduce((s, r) => s + r.cost, 0).toFixed(4)} over ${t.length} samples.`);
}
out.push(`Claude Code versions seen: ${[...new Set(all.map((r) => r.claudeCodeVersion))].join(", ")}`);
console.log(out.join("\n"));

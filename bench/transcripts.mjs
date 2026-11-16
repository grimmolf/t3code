// Usage: node transcripts.mjs [tags=main,r2] [task=A] [sequencesOut]
// Classifies every tool call in the raw message streams of the given tags and prints per-arm transcript facts.
// Rules:
// - An edit call is Edit/MultiEdit/Write, a Bash call with `sed -i`, `perl -i`/`-pi`, or a node/python program that
//   writes files, or a code_run call whose program calls edit() or writes files.
// - Search is folded into the edit when the sample's first tool call is already an edit call.
// - A retry is any edit call after the first one: the first edit did not finish the job.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TAGS = (process.argv[2] ?? "main,r2").split(",");
const TASK = process.argv[3] ?? "A";
const SEQ_OUT = process.argv[4];
const ARMS = ["off", "instructions", "tool", "bashchain"];

const NODE_HEREDOC = /\bnode\b[^\n]*<<-?\s*['"]?\w+/;
const WRITES = /writeFileSync|writeFile\(|\.write\(|open\([^)]*['"]w/;
const SED_I = /\bsed\s+(-\w+\s+)*-i/;
const PERL_I = /\bperl\s+(-\w+\s+)*-\w*i/;
const text = (c) => String(c.input?.command ?? c.input?.code ?? c.input?.file_path ?? "");
function editMethods(c) {
  const t = text(c);
  if (["Edit", "MultiEdit", "Write"].includes(c.name)) return ["edit-tool"];
  const shellEdit = SED_I.test(t) || PERL_I.test(t);
  if (c.name.endsWith("code_run"))
    return /\bedit\s*\(/.test(t) || WRITES.test(t) ? ["code_run"] : shellEdit ? ["code_run", "code_run-shell"] : [];
  if (c.name !== "Bash") return [];
  const m = [];
  if (SED_I.test(t)) m.push("sed");
  if (PERL_I.test(t)) m.push("perl");
  if (NODE_HEREDOC.test(t) && WRITES.test(t)) m.push("node-heredoc");
  else if (/\bnode\s+(-e|--eval)\b/.test(t) && WRITES.test(t)) m.push("node-e");
  if (/\bpython3?\b/.test(t) && WRITES.test(t)) m.push("python");
  return m;
}
function retryReason(first, firstResult, calls) {
  const t = text(first);
  const sed = /\bsed\b/.test(t) && /\\b/.test(t);
  const zsh = /\$\{?files\}?(?!")/.test(t) && /files=/.test(t);
  if (sed && zsh) return "both: BSD sed \\b and an unsplit zsh $files";
  if (sed) return "BSD sed treats \\b as a literal, so the first edit matched nothing";
  if (zsh) return "zsh did not split an unquoted $files";
  if (first.name.endsWith("code_run") && /occurs|exactly once|not found/i.test(firstResult)) return "code_run edit() precondition failed";
  return `other: ${t.slice(0, 120).replace(/\s+/g, " ")} => ${firstResult.slice(0, 120).replace(/\s+/g, " ")}`;
}

const rows = fs
  .readFileSync(path.join(HERE, "results/summary.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => TAGS.includes(r.tag) && r.task === TASK);

const samples = rows.map((r) => {
  const calls = [];
  const results = new Map();
  for (const line of fs.readFileSync(r.jsonl, "utf8").split("\n").filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.type === "assistant")
      for (const b of m.message.content) if (b.type === "tool_use" && !calls.some((c) => c.id === b.id)) calls.push(b);
    if (m.type === "user" && Array.isArray(m.message?.content))
      for (const b of m.message.content)
        if (b.type === "tool_result")
          results.set(b.tool_use_id, { err: !!b.is_error, text: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
  }
  const methods = calls.map(editMethods);
  const editIdx = methods.map((m, i) => (m.length ? i : -1)).filter((i) => i >= 0);
  const first = editIdx.length ? calls[editIdx[0]] : undefined;
  return {
    r,
    calls,
    results,
    methods: new Set(methods.flat()),
    folded: methods.length > 0 && methods[0].length > 0,
    editCalls: editIdx.length,
    retry: editIdx.length > 1 ? retryReason(first, results.get(first.id)?.text ?? "", calls) : undefined,
  };
});

const out = [];
out.push(`Task ${TASK}, tags ${TAGS.join(",")}. Counts are samples.\n`);
out.push("| model | arm | n | sed/perl | node heredoc | code_run (of which shell sed/perl) | Edit tool | other script | folded search | retried | retry reasons |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const model of [...new Set(samples.map((s) => s.r.model))])
  for (const arm of ARMS) {
    const g = samples.filter((s) => s.r.model === model && s.r.arm === arm);
    if (!g.length) continue;
    const has = (...ms) => g.filter((s) => ms.some((m) => s.methods.has(m))).length;
    const reasons = {};
    for (const s of g) if (s.retry) reasons[s.retry] = (reasons[s.retry] ?? 0) + 1;
    out.push(
      `| ${model.replace("claude-", "")} | ${arm} | ${g.length} | ${has("sed", "perl")} | ${has("node-heredoc")} | ${has("code_run")} (${has("code_run-shell")}) | ${has("edit-tool")} | ${has("node-e", "python")} | ${g.filter((s) => s.folded).length} | ${g.filter((s) => s.retry).length} | ${Object.entries(reasons).map(([k, v]) => `${v}× ${k}`).join("; ") || "-"} |`,
    );
  }
console.log(out.join("\n"));

if (SEQ_OUT) {
  const seq = samples
    .sort((a, b) => `${a.r.model}${a.r.arm}${a.r.idx}`.localeCompare(`${b.r.model}${b.r.arm}${b.r.idx}`))
    .map(
      (s) =>
        `${s.r.tag} ${s.r.model} ${s.r.task}-${s.r.arm}-${s.r.idx} turns=${s.r.num_turns} ok=${s.r.check.ok} folded=${s.folded} edits=${s.editCalls} :: ` +
        s.calls.map((c) => `${c.name.replace("mcp__t3-code__", "")}[${text(c).replace(/\s+/g, " ").slice(0, 160)}]`).join(" | "),
    );
  fs.writeFileSync(SEQ_OUT, seq.join("\n") + "\n");
}

# Code Mode parity benchmark: `code_run` tool vs Bash instructions vs nothing

Goal: decide whether T3 Code should build its own code tool for Claude threads, since native Code Mode (`REPL`) is unreachable through the Agent SDK. The alternatives are telling Claude to batch work in Bash, which keeps Claude's permission rules and hooks, or doing nothing. This is a throwaway prototype, macOS only.

Two rounds:

- `main` covers Haiku and Sonnet on tasks A, B, B2 and C, with arms off, instructions and tool.
- `r2` adds Opus on A and C, a `bashchain` arm, and an entrypoint probe.

## Verdict

1. **`REPL` does not appear with entrypoint=cli.** With `CLAUDE_CODE_ENTRYPOINT=cli` in the SDK env, the binary bills itself as `cc_entrypoint=sdk-cli`, and init lists 24 tools without `REPL`. It prints no warning. With the pair in `settings.env`, it warns: `[WARN] CLAUDE_CODE_ENTRYPOINT in settings is ignored: no settings file can give it this value, only the environment Claude Code is started with or Claude Code itself.` `REPL` is absent there too. The probe logs no reason for the refusal. Probe output is in `results/r2-probe/`. The binary's gate function, extracted to `../probe/gate.txt`, returns `"entrypoint"` unless the entrypoint is exactly `cli`, which is consistent with this, but that link is an inference from minified code.
2. **Opus does not gain more from the tool than Sonnet did.** For Sonnet, the tool cut turns from 3 to 2 by folding the search into the edit program (8 of 10 samples). Opus folded once in 8 samples. Its tool samples avoided the retries that off and instructions hit (0 of 8 retried, against 5 and 4 of 8). Median cost fell 9.6% against off ($0.1958 to $0.1771). Mean cost rose 8% ($0.1896 to $0.2056). Without the one sample that paid a prefix cache write, the tool mean is $0.1822, 4% below off. Two more tool samples hit an escaping bug in this prototype's `$` helper. No Opus comparison survives correction.
3. **Bashchain shows no measurable difference from the tool at this n, on either model.** On Opus, bashchain was at least as good: 3 turns in 8 of 8 samples, median $0.1739 against $0.1771, mean $0.1736 against $0.2056, and 0 retries. On Sonnet, bashchain sat between instructions and the tool: median 2.5 turns against 2, median $0.0748 against $0.0708 (+5.6%), and folding in 5 of 10 samples against 8 of 10. Mean cost was $0.0742 against $0.0824, or $0.0732 for the tool without its prefix-write sample. At n=10 a gap of 5% in cost can go undetected, so these results do not show that the two are equal. The paragraph's example is close to the task A solution: Opus used `grep -rlE … | xargs perl -pi` in 8 of 8 samples. Bashchain was run only on A and C, so this does not show that it generalizes to other multi-step tasks.

What this means for the decision: the tool's measured benefit comes from two things, folding the search into the edit (Sonnet only) and avoiding BSD-sed and zsh retries. A prompt paragraph recovers most of both. Neither arm changed correctness on task A.

## Task A, Opus 5.5 (r2, 8 per arm, interleaved)

| arm | ok | cost $ median (range) | cost $ mean | turns median (range) | folded search | retried | cumulative input incl. cache reads |
|---|---|---|---|---|---|---|---|
| off | 8/8 | .1958 (.1683–.2030) | .1896 | 4 (3–4) | 0/8 | 5/8 | 157k (114–158k) |
| instructions | 8/8 | .1841 (.1690–.2008) | .1843 | 3.5 (3–4) | 0/8 | 4/8 | 136k (114–158k) |
| tool | 8/8 | .1771 (.1507–.3692\*) | .2056 (.1822 without \*) | 3 (2–6) | 1/8 | 0/8 | 116k (73–235k) |
| bashchain | 8/8 | .1739 (.1692–.1781) | .1736 | 3 (3–3) | 0/8 | 0/8 | 114k (114–115k) |

\*The first tool sample wrote 42k tokens to the cache, where 17k is typical, for the new tool-schema prefix. Two tool samples, at 5 and 6 turns, wrote `` $`grep -rn "retryPolicy\|maxAttempts" …` ``. The prototype's `$` joins the cooked template strings (`coderun.mjs:54`), which turns `\|` into `|`. The BRE grep returned `""`, and Opus went exploring with `ls -R` and `cat`. Building the command from `strings.raw` would fix this, so it is a bug in this prototype, not a cost every code tool pays.

## Task A, Sonnet 5.5 (main 10 per arm, plus r2 bashchain 10)

| arm | tag | ok | cost $ median (range) | cost $ mean | turns median (range) | folded search | retried | cumulative input incl. cache reads |
|---|---|---|---|---|---|---|---|---|
| off | main | 10/10 | .0787 (.0760–.0945) | .0806 | 3 (3–4) | 0/10 | 2/10 | 112k (111–155k) |
| instructions | main | 10/10 | .0800 (.0774–.0905) | .0833 | 3 (3–4) | 0/10 | 4/10 | 113k (112–155k) |
| tool | main | 10/10 | .0708 (.0703–.1646\*) | .0824 (.0732 without \*) | 2 (2–3) | 8/10 | 0/10 | 72k (72–114k) |
| bashchain | r2 | 10/10 | .0748 (.0705–.0768) | .0742 | 2.5 (2–3) | 5/10 | 0/10 | 92k (72–112k) |

\*This sample wrote 39k tokens to the cache, where 15k is typical, for the new prefix. Bashchain ran in a later session than the other three arms. One price vector ($2/M input, $10/M output, $0.10/M cache read, $4/M 1-hour cache write) reproduces every Sonnet row in both sessions, so prices did not drift between them.

## Task A, Haiku 5.5 (main, 5 per arm)

| arm | ok | cost $ median (range) | cost $ mean | turns median (range) | folded search | retried |
|---|---|---|---|---|---|---|
| off | 5/5 | .0063 (.0053–.0075) | .0063 | 4 (3–5) | 0/5 | 3/5 |
| instructions | 5/5 | .0058 (.0055–.0068) | .0060 | 4 (3–4) | 0/5 | 1/5 |
| tool | 5/5 | .0056 (.0053–.0083) | .0066 | 3 (3–6) | 0/5 | 2/5 |

Tasks B, B2 and C show no arm differences on any model. C on Opus (r2, 3 per arm, arms off, tool and bashchain) cost $0.146 to $0.150 and took 3 turns in every sample. In one bashchain sample, Opus also changed README's "port 3000" line, which the check counts as overreach (8 of 9 correct). The full tables are in `results/analysis-r2.md`.

## Significance, corrected

- **Family.** The family is every pair of tool/off, tool/instructions, instructions/off, bashchain/off, bashchain/instructions and bashchain/tool, in every model × task cell where both arms have at least 2 samples, on two metrics: cost (primary) and turns. That is 72 p-values. Bonferroni sets the threshold at 0.05/72 = 6.9e-4. `analyze.mjs` counts the p-values it prints and derives the threshold from that count.
- **Test.** Exact two-sided rank-sum test by full enumeration, with midranks for ties.
- **What survives** (all task A, Sonnet):
  - tool vs off, turns, p = 4.9e-4
  - tool vs instructions, turns, p = 3.0e-4
  - bashchain vs off, cost, p = 1.3e-4
  - bashchain vs instructions, cost, p = 1.1e-5

  Both bashchain results compare across sessions. Half the gap comes from fewer turns. In the 3-turn samples, bashchain still cost $0.0031 less than instructions, and $0.0028 of that is about 690 fewer cache-write tokens per sample, which fits its smaller "compact summary" tool output. Prices were identical in both sessions, but other session effects are not ruled out.
- **What does not survive.**
  - The old Sonnet claim "tool is cheaper than instructions" fails (cost p = 0.036). The old token comparison is no longer in the family, because cumulative input moves with turns and with the tool schema.
  - Tool vs bashchain fails on Sonnet (cost p = 0.32, turns p = 0.35) and on Opus (cost p = 0.083, turns p = 0.73).
  - Nothing on Opus survives. Its smallest p is bashchain vs off on turns, p = 0.026.
- **Minimum attainable p** with no ties is 2/C(n+m, n):
  - 3 vs 3: 0.10
  - 5 vs 5: 0.0079
  - 8 vs 8: 1.6e-4
  - 10 vs 10: 1.1e-5

  Every Haiku cell, every B and B2 cell and every C cell (48 of the 72 p-values) could never pass. Ties raise the floor further for turns: Opus tool vs bashchain on turns cannot go below 0.27. `analysis-r2.md` prints both floors per test.
- **Family choice.** Restricting the family to the 24 task A p-values with n ≥ 8 (threshold 0.0021) leaves the same four survivors.

## Transcript facts, task A (`transcripts.mjs`, all 87 samples)

Rules:

- An edit call is `sed -i`, `perl -i` or `-pi`, a node or python program that writes files, a `code_run` program that calls `edit()`, writes files or shells out to `sed -i`, or the Edit and Write tools.
- **Folded** means the sample's first tool call is already an edit call.
- **Retried** means the sample made more than one edit call.

The rules reproduce the earlier hand counts (Sonnet folded 0 of 20 in off and instructions, 8 of 10 in tool).

| model | arm | sed/perl | node heredoc | code_run | folded | retried, and why |
|---|---|---|---|---|---|---|
| Haiku | off / instr / tool | 5 / 1 / 3 | 0 / 4 / 0 | 0 / 0 / 3 | 0 / 0 / 0 | 3 / 1 / 2: BSD-sed `\b` in 5 samples, unquoted zsh `$files` in 1 |
| Sonnet | off / instr / tool / bashchain | 10 / 10 / 0 / 10 | 0 | 0 / 0 / 10 (3 ran `sed -i` inside) / 0 | 0 / 0 / 8 / 5 | 2 / 4 / 0 / 0: all BSD-sed `\b` |
| Opus | off / instr / tool / bashchain | 8 / 8 / 0 / 8 | 0 / 1 / 0 / 0 | 0 / 0 / 8 / 0 | 0 / 0 / 1 / 0 | 5 / 4 / 0 / 0: BSD-sed `\b` in 3, zsh `$files` in 3, both in 3 |

- Every retry happened in off or instructions, except 2 in Haiku tool. Every retry traced to one of two causes, and the classifier found no other.
- On macOS, `sed -i '' 's/\bretryPolicy\b/…/'` silently matches nothing. With zsh as the Bash tool's shell, `files=$(grep -rl …); perl -pi … $files` passes one argument containing newlines.
- The instructions paragraph produced a node heredoc in only 1 of 18 Sonnet and Opus samples.
- Bashchain folded on Sonnet but never on Opus. Its gain on Opus came from replacing `files=$(…)` and `sed` with `grep -rl | xargs perl`, which removed every retry.

## What the harness does not match in T3

- **Settings.** The harness passes `settingSources: []`. T3 passes `["user","project","local"]` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:5561`), or `["project","local"]` under a custom home, so real threads also load the user's CLAUDE.md, hooks, permissions, plugins and MCP servers. All of these change the prompt and tool list.
- **Prompt.** T3 appends `buildRuntimeInstructions` and, when MCP is on, its orchestration instructions to the preset prompt (`ClaudeAdapterV2.ts:2299`). The harness appends only the arm text. A real thread carries more appended text, so cost per turn is higher and the arm paragraph is a smaller share of it.
- **MCP.** The `t3-code` MCP server exists only in the tool arm. T3 normally attaches it with its full tool set (`mcpServers` is optional in the adapter), so the tool arm's one-time schema write and per-turn schema tokens are smaller than in production. In the other arms they are missing entirely.
- **Permissions.** The harness uses bypass permissions only. T3 defaults to `"default"` (`ClaudeAdapterV2.ts:2255`), where a chained Bash command or a `code_run` call can trigger a permission prompt. That cost is not measured here.
- **Platform.** Runs were macOS only. Most retries come from BSD `sed` and zsh. On Linux, with GNU sed and bash, off and instructions would retry less, which shrinks both the tool's and bashchain's advantage.
- **Other.** The harness sets no effort or thinking options, sets `CLAUDE_CODE_ENTRYPOINT=t3-code`, and inherits `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` from the parent shell.

## Errors, reproducibility and whether the work happened (checklist Q4, Q5, Q7)

- **Q4 (errors).** All 180 samples ended `success`, with 0 `is_error` tool results and 0 harness errors. 179 passed their checks; the failure is the Opus C README edit. An earlier herdr-pane launch failed 84 times at $0 on OAuth. Those rows are in `results/summary-authfail.jsonl` and are excluded.
- **Q5 (reproducibility).** Arms ran interleaved, 3 at a time, so each round shared machine noise. The load average was 3.6 to 6 on 28 cores. Within r2, the Opus arms were interleaved with each other. Sonnet bashchain could only be compared across sessions.
- **Q7 (did it happen).** Checks read the real fixture after each run: greps, a rerun of `node --test`, `git status --porcelain`, and the parsed answer. `selftest.mjs` shows that each check fails on broken fixtures. Every tool-arm init listed `mcp__t3-code__code_run`, no other arm's init did, and `REPL` was absent everywhere.

## Caveats

- `code_run` also gets `require` in scope, because `edit()` alone cannot rename a symbol that appears twice in a file. It has `alwaysLoad: true`, matching T3's own tools.
- The preset has no `Grep` or `Glob` tool, so all search ran through Bash.
- The instructions and bashchain texts were fixed by the brief and not tuned. Instructions produced a node heredoc in 1 of 18 Sonnet and Opus samples.
- Fixture directories have random names, so the arm cannot leak into the prompt.

## Spend and versions

`main` cost $5.34 over 129 samples, plus $0.03 in validation rows and $0.004 in canaries. `r2` cost $8.10 over 51 samples, including the 4-sample pilot. The init-only probes abort at `system/init` and are not recorded; each sends at most one request. Claude Code 2.1.325 (`~/.local/share/claude/versions/2.1.325`), `@anthropic-ai/claude-agent-sdk` 0.3.321, zod 4.6.7, Node 24.21.0, git 2.54.0 (Apple Git-157), macOS with zsh.

## REPRODUCE

Run everything from `./`, in a shell that can read the Claude keychain. A herdr pane cannot. The harness skips any `(tag, model, task, arm, idx)` already in `results/summary.jsonl`, so a rerun only fills gaps. To rebuild from scratch, move `summary.jsonl` aside first.

1. Pin the versions above, and set `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` in the parent environment, as all runs had it. `node_modules` links to `../probe/node_modules`, and the harness uses the binary that `~/.local/bin/claude` resolves to.
2. Run `node selftest.mjs` to confirm that the checks pass and fail correctly.
3. Run `./run-all.sh` for tag `main`: Haiku A, B and C (n=5), Sonnet A and B (n=5), Sonnet C (n=3).
4. Run `./run-extra.sh` for tag `main`: Haiku B2 (n=5), Sonnet B2 and A (n=5), then Sonnet A to n=10.
5. Run the r2 pilot: `node harness.mjs --model claude-opus-5-5 --tasks A --arms off,instructions,tool,bashchain --n 1 --tag r2 --budget 19.8`.
6. Run `./run-r2.sh` for tag `r2`: Sonnet bashchain A (n=10), Opus A with 4 arms (n=8), then Opus C with arms off, tool and bashchain (n=3).
7. Run the probes: `node probe-entrypoint.mjs env|settings|settings-user [debug]`, with output in `results/r2-probe/`.
8. Run the analysis:
   - `node analyze.mjs main,r2 > results/analysis-r2.md`
   - `node transcripts.mjs main,r2 A results/sequences-r2.txt`
   - `node transcripts.mjs r2 C`

The `validate` and `validate-forced` tags hold Haiku setup rows that the analysis ignores. The commands that made them were not saved.

## Paths

- Harness: `harness.mjs` (arms in `APPEND`), `fixtures.mjs`, `coderun.mjs`, `canary.mjs`, `selftest.mjs`, `probe-entrypoint.mjs`.
- Run scripts: `run-all.sh`, `run-extra.sh`, `run-r2.sh`.
- Analysis scripts: `analyze.mjs`, `transcripts.mjs`.
- Raw streams: `results/<tag>/<model>/<task>-<arm>-<i>.jsonl`. Per-sample rows: `results/summary.jsonl`, whose `work` field names the final fixture.
- Outputs: `results/analysis-r2.md`, `results/transcripts-A.md`, `results/sequences-r2.txt`, `results/r2-probe/`. `results/analysis-main.md` and `results/sequences-main.txt` are the round-1 outputs, which used the old uncorrected statistics.

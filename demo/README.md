# Code Mode REPL demo

These captures come from a T3 Code dev server running the `feat/code-mode` branch, with real model turns. The REPL scenario ran on both Claude Haiku 5.5 and Codex GPT-6 Luna. The Supervised approval flow was recorded on Claude only.

| File | What it shows |
| --- | --- |
| `captures/01-settings-code-mode-off.png` | Settings → Threads → Agent tools, with Code Mode off, which is the default. |
| `captures/02-settings-code-mode-on.png` | The same switch turned on. |
| `captures/03-thread-1-top.png`, `03-thread-1-bottom.png` | Claude thread, four steps. (1) Store `globalThis.files`. (2) In a later turn, reuse it without reading the disk. (3) Call `t3.tools()` and `t3.t3_thread_list()` from one script. (4) Run a 30 s script, which returns a handle, then `t3_code_poll` until done. |
| `captures/04-thread-2-top.png`, `04-thread-2-bottom.png` | The same four steps on a Codex thread. Codex calls the tools through T3's direct server. |
| `captures/05-supervised-approval-card.png` | A Supervised thread. The first script opens one approval card that shows the full code. |
| `captures/06-allowed-for-thread.png` | The script after **Allow for this thread**. |
| `captures/07-second-script-no-prompt.png` | The next script runs with no card and reads the state the approved script saved: 13 files. |
| `captures/approve-once-keep-state.mp4` | The Supervised flow as an 18 s video: card, Allow for this thread, state saved, state reused with no prompt. |
| `claude-scenario.txt`, `codex-scenario.txt` | The models' replies to the four scenario steps. |

The stored thread items confirm what the replies say:

- Step 2's code never read the disk and returned the 13 saved entries.
- Step 4 returned `status: "running"`, then `t3_code_poll` returned `"slow job done"`.
- The Supervised thread has exactly one `approval_request` across its two scripts.

## Rerun

These scripts have local paths replaced with placeholders.

- `scripts/repl-scenario.sh <providerInstanceId> <model> <label>` runs the four-step scenario through the T3 CLI.
- `scripts/demo.mjs` drives the web client with Playwright. It has three phases: `settings`, `threads`, and `supervised`.
- `scripts/pair.sh` mints a one-time pairing URL for each browser run.

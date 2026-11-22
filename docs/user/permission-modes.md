# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread. A new thread names its mode under the composer. In a thread
on your default mode, open the model picker and choose **Permissions** at its bottom, or press
`mod+shift+a`. A thread on another mode shows the mode next to the model.

Set the default for new threads in **Settings → Threads → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

An administrator can cap the modes available on a machine with a
[managed policy](./managed-policy.md#permission-modes); modes above the cap show who manages them.

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task. Subagent approval requests appear in
the parent conversation with the subagent's name, so you can respond without switching threads.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, Grok, Antigravity, and fx; providers without
an equivalent, including OpenCode, fall back to asking. On Grok and Antigravity, actions their review
does not approve come to you for approval. On fx, prompts it still sends also come to you.

Antigravity offers **Auto** only when your Antigravity sign-in provides its Auto mode; some accounts,
including some personal Google accounts, do not. Without it, an Antigravity thread already set to
**Auto** runs in **Supervised**.

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

T3 Code offers no **Auto-accept edits** for fx, and **Full access** only with fx 0.0.14 or later. An fx
thread set to a mode its fx lacks runs in **Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Claude can still ask in **Full access** when its settings disable bypass permissions or require
approval for an action. Dangerous-removal safety checks in bypass mode reject the command with
the original warning. Claude can use a safe rewrite when the warning supplies one; otherwise it
continues without the removal and tells you what it skipped.
While a Claude approval is pending, type a text reply to decline that request and give feedback
directly to the agent that asked, including a subagent. Other pending requests stay unanswered.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Kiro offers only **Supervised** and **Full access**. In **Supervised** Kiro also asks you to
review a turn's file changes. See [Kiro permissions](./providers-kiro.md#permission-modes).

See the [provider guides](./install.md#providers) for setup and provider-specific limits.

## Code Mode (experimental)

Code Mode gives agents in every thread a JavaScript session that T3 Code runs. One call can run
several commands at once, repeat an edit across many files, filter long output, or call T3 Code's
thread and task tools, and only what it returns goes back into the conversation. Values a script
stores on `globalThis` stay for the thread's later calls. A call that runs past 20 seconds keeps
going, and the agent checks on it later. It works with every provider.

Turn on **Code Mode** in **Settings → Threads → Agent tools**. The setting applies to the whole
environment. Turning it off stops running scripts and refuses new ones. Code Mode is not available
on Windows yet.

| Mode                                  | Scripts                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Full access**, **Auto**             | Run without asking.                                                                         |
| **Supervised**, **Auto-accept edits** | Ask first, showing the whole script. **Allow for this thread** stops asking in that thread. |
| Plan mode                             | Refused.                                                                                    |

A thread whose provider runs its mode as **Supervised** asks too.

**Allow for this thread** lasts as long as the thread does, including after a restart. Nothing
revokes it yet. To stop that thread's scripts, switch it to Plan mode, or turn Code Mode off.

Scripts run in the thread's project folder or worktree with T3 Code's own environment. A script
stops after 10 minutes, or when the turn that started it ends or the thread is archived. Any
change to the thread's mode ends its session, even between scripts. The session also ends after
10 idle minutes, when the agent resets it, when the provider session ends, or when T3 Code
restarts, and the agent is told its stored values are gone. Timers and background work a script
leaves behind keep running until the session ends. Commands inside a script bypass the
provider's own permission rules, hooks, and safety checks. T3 Code tools a script calls run with
the thread's own permissions. Some providers may also ask before they call the tool. Turn Code
Mode on only where you trust agents with the thread's file and shell access.

# Changelog

## Unreleased

- **Hermes Agent.** Hermes sessions walk in from `~/.hermes/state.db`, the SQLite file it already keeps: the model and the folder come from `sessions`, and `messages` gives the prompts, tool calls and replies, delegate_task's subagent sessions included as interns (a compression or branch continuation stays a worker of its own). Read-only, watched only — the control plane cannot hire it. `messages.id` is an INTEGER there while `sessions.id` is TEXT, and its timestamps are epoch seconds rather than milliseconds.

## 0.3.0

- **Chat mode in Daytona and Vercel sandboxes.** Claude Code and Codex hired into a Daytona or Vercel sandbox can now run in chat mode, as on Railway and ssh boxes. Daytona runs the agent as a command in a toolbox session of its own; Vercel as a command with its input attached. A dropped output connection is opened again without repeating what was already shown.
- **Windows.** The office watches transcripts live, the office tools (`office_status`, `office_peers`) find their worker, and `install`, `doctor` and `uninstall` work through `claude mcp add` and `codex mcp add`, on Node 18 to 24 from PowerShell or cmd. Hiring and driving agents from the page is not on Windows yet, and the page and `doctor` say so. System programs run from System32, and CLIs are only looked up on PATH, never in the current folder.
- **First run with npx.**
  - Unlock hints say `npx theagentoffice open` when the office runs from npx, where `agentoffice` isn't on PATH.
  - On a Linux box with no display, the office no longer claims it opened a browser; it points to `open --print`.
  - The locked page names the command that unlocks it.
  - A background service installed through npx hints the command that works there.
- **Fixes.** A Vercel sandbox created under the name of one just deleted shows up in Settings › Cloud at once.

## 0.2.0

The office can now run your agents, not just watch them.

- **Hire agents from the page.** Pick Claude Code, Codex, Command Code, opencode, Droid, Gemini CLI, Qwen Code or Cursor. Run it in a folder on this machine, in a new or running Daytona, Vercel or Railway sandbox, or on an ssh box. Drive it in a real terminal or in chat mode with approvals as buttons (1 allow, 2 always, 3 deny).
- **Bring your setup.** A sandbox hire can carry this machine's setup:
  - your Claude subscription (Settings › Logins › Connect Claude, via `claude setup-token`), Codex's sign-in, or keys from your shell;
  - your MCP servers;
  - CLAUDE.md, rules, skills, subagents and commands;
  - the project itself, uncommitted changes included.

  Claude's "use this API key?" and first-run screens are answered ahead of time.
- **Chat mode.** The chat view shows the agent's pixel worker, streaming replies, a work log per turn with diffs and test output, inline approvals and queued prompts. Command Code runs in chat mode over ACP (`command-code acp`).
- **Railway.** New sandboxes go in a project you pick, looked up by id. A `railway link` to a deleted project no longer breaks hires.
- **Faster.**
  - The page loads 108 KB of JS instead of 860 KB, with terminal, chat, Hire and Settings loading on demand.
  - Panels open at once.
  - A terminal attach sends the visible screen first.
  - "Your setup" and provider lists are cached.
- **Phones.** In portrait the office packs into desk rows and fills the screen with crisp pixels.
- **Fixes.**
  - A resumed background agent walks back in instead of leaving its boss "waiting for you".
  - opencode updates written in the same millisecond are no longer missed.
  - The login-shell probe can't hang a caller.
  - The python PTY bridge keeps an agent's last line.
- **Security.**
  - Controls need an unlocked browser's page token.
  - Approvals show the full request, with secrets masked.
  - Sandboxes the office creates are tracked, and deleted if a hire fails.
  - A project's `.git/config` goes over rebuilt, without credentials.

## 0.1.0

First release: a live pixel-art office for your coding agents, local and in sandboxes, with an MCP server and skill so agents can talk back.

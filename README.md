<div align="center">

<a href="https://github.com/bas3line/agent-office">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://ascii.rest/banner/agent%20office.dark.svg?color=d97757,8e75ff&tagline=your%20coding%20agents%2C%20working%20in%20a%20pixel%20office">
    <img alt="agent office: your coding agents, working in a pixel office" src="https://ascii.rest/banner/agent%20office.svg?color=d97757,8e75ff&tagline=your%20coding%20agents%2C%20working%20in%20a%20pixel%20office">
  </picture>
</a>

<br>
<br>

<img src="docs/demo.gif" alt="Hiring from the office: press Hire, a Claude Code worker walks out of the lift, its chat panel works through a diff, a request to run npm test is approved with 1, an intern walks in for a subagent, then a failing test flips the table" width="100%">

<br>

Claude Code, Codex, Command Code and five more agents, working in a live pixel-art office.<br>
On this machine, in Daytona, Vercel and Railway sandboxes, or over ssh. A failing test flips the table.

[install](#install) · [what you're looking at](#what-youre-looking-at) · [agents](#supported-agents) · [sandboxes](#sandboxes-and-ssh-boxes) · [hire from the page](#hire-agents-from-the-page) · [mcp + skill](#with-an-ai-coding-agent) · [privacy](#privacy) · [contributing](CONTRIBUTING.md)

[![by @bas3line](https://img.shields.io/badge/by-%40bas3line-181717?logo=github&logoColor=white)](https://github.com/bas3line)
[![CI](https://github.com/bas3line/agent-office/actions/workflows/ci.yml/badge.svg)](https://github.com/bas3line/agent-office/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/theagentoffice?color=181717&logo=npm&logoColor=white)](https://www.npmjs.com/package/theagentoffice)
[![MIT](https://img.shields.io/badge/license-MIT-181717)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-181717?logo=typescript&logoColor=white)](tsconfig.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0%20%2B%201%20optional-181717)](package.json)

<br>

<sub>Sponsored by</sub>

<a href="https://commandcode.ai"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/sponsors/command-code.dark.svg"><img alt="Command Code" src="docs/sponsors/command-code.svg" height="28"></picture></a>

</div>

<br>

Written in TypeScript by [@bas3line](https://github.com/bas3line). `npx theagentoffice` reads the transcripts your agents already write and turns them into an office you can watch: every session is a worker at a desk, subagents are interns who walk in from the lift, a raised hand means an agent is waiting on you, and a failing `npm test` gets the table flipped. You can also hire agents from the page, here or in a sandbox, and drive them in a real terminal right in the office. One command, no required dependencies, nothing to configure, nothing leaves your machine that you didn't send.

<p align="center">
  <img src="docs/hero.png" width="49%" alt="The office at full size: a desk per project on the left, the glass cloud wing with Daytona, Vercel and Railway pods on the right, and Hire in the toolbar">
  <img src="docs/ascii.png" width="49%" alt="The same office in ASCII mode">
</p>

<p align="center">
  <img src="docs/logos/claude.svg" width="26" alt="Claude Code">&nbsp;
  <img src="docs/logos/codex.svg" width="26" alt="Codex">&nbsp;
  <img src="docs/logos/commandcode.svg" width="26" alt="Command Code">&nbsp;
  <img src="docs/logos/opencode.svg" width="26" alt="opencode">&nbsp;
  <img src="docs/logos/cursor.svg" width="26" alt="Cursor">&nbsp;
  <img src="docs/logos/droid.svg" width="26" alt="Droid">&nbsp;
  <img src="docs/logos/qwen.svg" width="26" alt="Qwen Code">&nbsp;
  <img src="docs/logos/gemini.svg" width="26" alt="Gemini CLI">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/logos/daytona.svg" width="26" alt="Daytona">&nbsp;
  <img src="docs/logos/vercel.svg" width="26" alt="Vercel Sandbox">&nbsp;
  <img src="docs/logos/railway.svg" width="26" alt="Railway">&nbsp;
  <img src="docs/logos/boat.svg" width="26" alt="boat">
</p>

## Why

I run Claude Code, Command Code and Codex side by side most days, some of them in sandboxes. A wall of terminals doesn't tell you who's stuck, who's waiting on you and who just broke the tests. I wanted to see all of it at a glance, and I wanted it to be fun enough to leave open on a second screen. So I gave my agents an office.

## Install

```sh
npx theagentoffice          # your real agents (Node 18+)
npx theagentoffice --demo   # a busy simulated office, for a first look or a recording
```

It opens `http://127.0.0.1:4747`. Start Claude Code, Codex or any agent below in another terminal and it walks in the moment it starts; quit it and it walks back to the lift. Or press **Hire** on the page and start one from there ([below](#hire-agents-from-the-page)). `npm install -g theagentoffice` gives you the `agentoffice` command instead.

Something good just happened? Press <kbd>R</kbd>: the office keeps a rolling buffer and saves the last ~15 seconds as a clip, with a caption for the moment burned in. <kbd>H</kbd> turns on stream mode, where the camera cuts to every flip, shout and arrival. The demo starts from the top for each new viewer, so every recording opens on the arrivals.

## What you're looking at

| in the office | what happened |
| --- | --- |
| A worker walks out of the lift to a desk | A session started (sandboxed agents beam into the cloud wing instead) |
| A paper plane lands on the desk | You sent a prompt |
| Thought bubble | The model is thinking |
| Fast typing, code on the monitor | Editing files |
| Terminal on the monitor | Running a command |
| A page scrolling on the monitor | Reading files |
| Magnifier sweeping the monitor | Grep, glob, search |
| Spinning globe | Web fetch or search |
| A plug | An MCP tool call |
| Sticky notes pile up | Todo list or plan updates |
| The worker points, an intern walks in | A subagent was spawned; it clocks out when it's done |
| Leaning back, "supervising 3 interns" | The turn ended while its subagents keep working |
| Hand up, a bobbing "!" and the amber **needs you** button | The agent finished and is waiting on you; the button jumps to it |
| Leaning back, then asleep | Idle for a while |
| Smoke from the monitor | A tool call failed |
| Red alarm | API error or an interrupted turn |
| **(╯°□°)╯︵ ┻━┻** | **A test command failed.** Hit-stop, the camera punches in, the desk lands legs-up; later ┬─┬ノ( º _ ºノ) |
| A cheer, the monitor goes green | Tests passed |
| Walks back to the lift | The agent quit (or went quiet for 20 minutes) |
| Mood chip over the head, megaphone, confetti | The agent used the office's own MCP tools |

One pod per project: two agents on the same repo share it, each desk in its own agent's colours. The wall TV keeps score, the office follows your clock from morning to night, it rains now and then, and there is a cat.

## Supported agents

| | agent | reads | status |
| --- | --- | --- | --- |
| <img src="docs/logos/claude.svg" width="18"> | **Claude Code** | `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR`), subagents included | tested |
| <img src="docs/logos/codex.svg" width="18"> | **Codex** | `~/.codex/sessions` (or `$CODEX_HOME`), subagents included | tested |
| <img src="docs/logos/commandcode.svg" width="18"> | **Command Code** | `~/.commandcode/projects`, v3 and legacy formats | tested |
| <img src="docs/logos/opencode.svg" width="18"> | **opencode** | `~/.local/share/opencode/opencode.db` (read-only SQLite) | tested |
| <img src="docs/logos/cursor.svg" width="18"> | **Cursor** (cursor-agent) | `~/.cursor/projects` | tested; Cursor records no tool results, so no pass/fail |
| <img src="docs/logos/droid.svg" width="18"> | **Droid** (Factory) | `~/.factory/sessions` | tested |
| <img src="docs/logos/qwen.svg" width="18"> | **Qwen Code** | `~/.qwen/projects` | tested |
| <img src="docs/logos/gemini.svg" width="18"> | **Gemini CLI** | `~/.gemini/tmp/*/chats` | built from gemini-cli's recorder source, untested on real data |
| <img src="docs/logos/hermes.svg" width="18"> | **Hermes Agent** | `~/.hermes/state.db` (or `$HERMES_HOME`), read-only SQLite, subagent sessions included | tested; watched only, the control plane cannot hire it |

"Tested" means checked against real transcripts on a real machine, every file, with zero crashes and zero prompt text in any label. Formats drift between versions: if your agent stops showing up, [open an issue](https://github.com/bas3line/agent-office/issues/new/choose) with its version. Want another agent? [CONTRIBUTING.md](CONTRIBUTING.md#add-an-agent) shows how to add one.

## Sandboxes and ssh boxes

Agents in cloud sandboxes or on another machine sit in a glass-walled **cloud wing** next to the office, one pod per sandbox, its sign naming the platform. Nothing is installed on the remote: the office runs plain POSIX `sh` (`find`, `stat`, `tail`, `base64`) through the platform's own exec and reads the transcripts there, exactly as it does locally.

<img src="docs/cloud.png" width="100%" alt="The cloud wing: Daytona, Vercel and Railway pods side by side, a Gemini worker in the Vercel pod and a perf pass running on Railway">

| | where | how it connects | status |
| --- | --- | --- | --- |
| <img src="docs/logos/vercel.svg" width="18"> | **Vercel Sandbox** | `VERCEL_TOKEN` / `VERCEL_OIDC_TOKEN`, or the `npx sandbox` CLI's login | tested |
| <img src="docs/logos/daytona.svg" width="18"> | **Daytona** | `DAYTONA_API_KEY`, or the `daytona` CLI's login | tested |
| <img src="docs/logos/railway.svg" width="18"> | **Railway Sandboxes** | `RAILWAY_API_TOKEN`, or the `railway` CLI's login | tested |
| <img src="docs/logos/boat.svg" width="18"> | **boat** | `BOAT_API_KEY`, or the `boat` CLI; only with `--boat` | built from docs.boat.dev, untested on a real VM |
| | **any ssh box** | your own `ssh`, `BatchMode=yes`, one multiplexed connection | beta |

**Auto-detect.** On start the office looks for those keys and logins (files and environment only) and watches the running sandboxes in your own scope, so a teammate's sandbox never ends up in your recording: your default Vercel team, the Railway project linked to the folder and the one the office creates its sandboxes in, plus the sandboxes the office and your CLI created, and your personal Daytona organization. boat keeps every command's output for 90 days, so it is watched only when you ask with `--boat`. `--no-cloud` turns auto-detect off.

| flag | |
| --- | --- |
| `--vercel [name]`, `--daytona [id]`, `--railway [id]`, `--boat [id]` | watch these; no value means every running one the login can see |
| `--ssh <host>` | an alias, `user@host` or `ssh://user@host:port`; repeatable |
| `--local-only` | this machine only |

Remotes you always want go in `~/.agentoffice/config.json`:

```json
{
  "remotes": [{ "ssh": "me@gpu-box" }, { "vercel": "all" }, { "daytona": "all" }],
  "cloud": true
}
```

A quiet poll is one exec of a few hundred bytes. Polls back off when a host stops answering (it dims and shows OFFLINE), idle Daytona and Railway sandboxes are left alone so they can still auto-stop, and expired logins are reported, never refreshed behind your back.

### Claude in a Vercel Sandbox, in your office

```sh
npx sandbox@latest login     # once; the office reuses this login
npx sandbox@latest sh --rm   # a fresh sandbox, removed when you exit
claude                       # inside it; Claude Code, Codex and opencode are preinstalled
```

Claude Code signs in separately inside the sandbox. On your machine, `npx theagentoffice` finds the sandbox and the worker beams into the cloud wing.

## Hire agents from the page

Press **Hire**, pick an agent, a folder (or a sandbox, or an ssh box) and a first prompt, and a worker walks in. Its desk opens a panel with the agent's own TUI in a real terminal, so everything the agent can do in a terminal works there, plus buttons for what the office can do natively:

<p align="center">
  <img src="docs/hire.png" width="49%" alt="The Hire dialog: pick Claude Code, Codex, Command Code or another agent, a folder on this Mac or a Daytona, Vercel or Railway sandbox, terminal or chat, and a permission mode">
  <img src="docs/chat.png" width="49%" alt="A hired Claude Code in chat mode: its work log with a diff of src/args.ts, and an inline card asking to run npm test, with Allow 1, Always allow 2 and Deny 3">
</p>

| | terminal | prompt box, Interrupt, Stop | Approve / Deny on the page | chat mode |
| --- | --- | --- | --- | --- |
| **Claude Code** | yes | yes | yes (a permission hook passed for that run only) | yes (`claude -p` stream-json) |
| **Codex** | yes | yes | in chat mode | yes (`codex app-server`) |
| **opencode** | yes (this machine only, for now) | yes (its own HTTP API) | yes | yes (`opencode serve`) |
| **Command Code** | yes | yes | in chat mode | yes (`command-code acp`, the Agent Client Protocol) |
| **Droid, Gemini CLI, Qwen Code, Cursor** | yes | yes | in the terminal | no |

The prompt box pastes your text into the agent and presses Enter, **Interrupt** sends one Esc (opencode: its abort call), and **Stop** sends SIGHUP, then SIGKILL four seconds later if the agent is still there. Close the tab and come back later: the office keeps the current screen and the last 3,000 lines, and redraws them when you reconnect (the screen first, the scrollback a moment later), in as many browsers as you like.

Chat mode is the agent's headless protocol shown as a conversation: replies, tool calls with the same redacted labels as the office, approvals as buttons. An approval, in either mode, shows what it asks for in full (the whole command, the file and its change, the URL; anything that looks like a key masked), and **Always allow** appears only when the agent offers a rule of its own for it: the office never makes up a rule that would allow every command. Pick a permission mode when you hire (default, accept edits, plan, or bypass, for the agents that have them); the office always passes one explicitly, and the form only offers the modes an agent has (Droid starts in its own default; Cursor has default or `--force`). Claude Code's approvals reach the page through a permission hook passed on its command line for that run; when no unlocked browser is watching, the hook steps aside at once and Claude asks in its terminal as usual. When the agent's transcript appears, the worker the hire created hands its desk to the transcript's worker: exactly by session id for Claude Code, Gemini CLI, Qwen Code, opencode and Codex's chat mode, by folder and start time for the rest.

First-run screens: the office passes the agents' own flags to skip what they let you skip (Codex's update check, Command Code's onboarding and folder trust, Gemini's per-session trust). Claude Code and Codex ask whether you trust a new folder; the office doesn't answer that for you, and the panel says "Answer the trust question in the terminal" (in Claude's dialog the default is **No**: press Down, then Enter).

The terminal needs the optional `@lydell/node-pty` package, which npm installs with the office (prebuilt, no compiler); without it the office falls back to `python3`, and without that only chat mode is offered. `agentoffice doctor` says which one you have. Agents you start in a terminal stay watch-only.

### Unlock

Watching needs nothing; driving does. The browser `agentoffice` opens is unlocked with a one-time link (valid two minutes, used once) that sets an `HttpOnly`, `SameSite=Strict` cookie for 30 days and hands the page a token it keeps in its own storage. Every control request needs both: browsers send cookies for `127.0.0.1` to every port there, so another local server that sees the cookie still can't drive the office. The link is opened, never printed, so it can't end up in a recording. To unlock another browser:

```sh
agentoffice open            # opens the running office, unlocked
agentoffice open --print    # prints the link instead (it works once, for 2 minutes)
agentoffice open --rotate   # logs every browser out first
```

Without a global install that's `npx theagentoffice open`, and the office's own hints say so. On a machine with no display (an ssh session, a server) nothing can be opened: the banner says so, and `open --print` gives you the link to open in your own browser through `ssh -L 4747:127.0.0.1:4747`.

Every control request also has to come from the office's own page: the right `Host`, no foreign `Origin` or `Sec-Fetch-Site`, and an `X-Agent-Office` header that another site can't send. A locked browser keeps the read-only office. Controls are off with `--demo`, `--no-control`, a `--host` other than loopback, and on Windows.

### Keys: the office passes your keys

To run an agent in a sandbox or on an ssh box you can give it API keys from the page (or **Import** them from your login shell, which reads only the key names the office knows, never the rest of your environment). With [Your setup](#your-setup-bring-it-along) on, the known key names your login shell exports are offered too, ticked: their values are read from a fresh login shell at hire time, handed to that one agent and never stored. The office stores the keys you add in `~/.agentoffice/keys.json` (readable only by you), never sends them back to the browser, and when you pick keys for an agent in a sandbox or on an ssh box it hands them to that agent's process there. The page only ever sees a key's name and a short preview (`sk-ant…a1b2`). Values are never logged, never put on a command line, never written into the service's unit file. `keys.json` is plain JSON with the same protection the agents' own auth files get: anything running as you can read it. Platform tokens (`DAYTONA_API_KEY`, `VERCEL_TOKEN`, `RAILWAY_API_TOKEN`) stored there are what the office itself uses for those platforms when no other login is found; they are never handed to an agent. Agents hired on this machine get your own environment, as in a terminal, and no stored keys.

How a key reaches a remote agent, the least persistent way each platform has:

- **Vercel:** in the environment of the agent's own command (the interactive shell's start frame, or the chat's command). No file. Vercel keeps every command's arguments; the office never puts a key or a prompt there.
- **Daytona, Railway, ssh:** a file readable only by you, `~/.agentoffice/run/<id>.env` on the remote, written by one command that carries the values in its own environment (Daytona, Railway) or in a script on ssh's input, then read and deleted by the line that starts the agent, before it starts. Daytona's terminal settings and a sandbox's create-time variables are stored by the platform, so keys never go there.
- **Railway chat mode:** in the environment of the agent's command on Railway's exec bridge. No file.
- Codex with `OPENAI_API_KEY` is started with a provider definition on its command line that reads the key from its environment, so it skips its login screen without writing `~/.codex/auth.json`.

What stays on the remote: the agent's own files, a pid file in `~/.agentoffice/run` (so the office can stop the agent), what [Your setup](#your-setup-bring-it-along) copied there, on Railway the relay's copy of about 8 MiB of the terminal's scrollback, and on Vercel a chat's output (the conversation as the agent streams it), which Vercel keeps after the command ends: its API still returns it. On Daytona a chat's output is logged in its session while it runs, and the session and its log are deleted when the chat ends.

### Sandboxes from the page

Hire an agent into a new sandbox, a running one, or an ssh box, and its terminal opens in the office. The office uses the logins it already reads for watching (the same keys and CLIs as above).

| | new sandbox | terminal | chat mode |
| --- | --- | --- | --- |
| **Daytona** | `agentoffice-…`, labelled `agentoffice=1`, deleted as soon as it stops, never alive past its lifetime | Daytona's own PTY; `daytona ssh` if that fails | Claude Code and Codex, as a command in a Daytona session of its own |
| **Vercel Sandbox** | `agentoffice-…`, tagged `agentoffice=1`, not persistent (no snapshot is kept), in `vercel-sandbox-default-project` (created on your first sandbox if it's missing; the page says so first) or `VERCEL_PROJECT_ID` | Vercel's interactive shell; the pinned `npx sandbox@4.8.1` CLI if that fails | Claude Code and Codex, as a command with its input attached |
| **Railway** | in the project and environment you pick in Hire (the office remembers it for next time); it starts on the last one you used, else the one in `config.json` (below, ids or names), a project the office's sandboxes are in, a project named `agentoffice…`, the `railway link` of the folder you started the office in, or your account's only project. A `RAILWAY_TOKEN` project token always uses its own. Each is looked up in your account first, so a link to a deleted project is skipped. Destroyed by Railway once it has been idle for its lifetime | `railway sandbox ssh` (needs the `railway` CLI, which registers its ssh key on your Railway account the first time, as it always does) | Claude Code and Codex |
| **ssh box** | | your own `ssh`, sharing the watcher's connection, with no prompts: a key with a passphrase must be in your ssh-agent and the host key already known (run `ssh <host>` once), or the hire says so | Claude Code and Codex |

```json
{ "control": { "railway": { "project": "<project id or name>", "environment": "<environment id or name>" } } }
```

**What it costs.** A new sandbox lives 30 minutes unless you pick another lifetime (1 to 240; Railway caps idle time at 120, Vercel's Hobby plan at 45). The office never extends one, keeps at most three of its own at once, and stops its heartbeats when the agent quits, so the platform's own timers end the sandbox. Every sandbox it creates is recorded in `~/.agentoffice/sandboxes.json`; only those can be deleted from the page without "force".

**Agents.** Claude Code, Codex and opencode are preinstalled on Vercel's image (and, per their docs, on Daytona's and Railway's). Anything missing is installed when you hire it: `npm i -g` when the sandbox's Node is new enough (retried under `~/.local` if the global folder isn't writable), otherwise the agent's own installer (Claude Code, Droid, Cursor). Daytona's lower tiers block Droid's and Command Code's download and API sites. In a sandbox the office created, it also skips first-run screens: Claude Code's onboarding and folder trust in `~/.claude.json`, Codex's folder trust in `~/.codex/config.toml`, Gemini CLI's auth choice when you hand it `GEMINI_API_KEY`. Only missing entries are written. On an ssh box or a sandbox you made, nothing is seeded, except what Your setup brings (and there only what's missing).

**Two questions you answer once, in the panel.** Claude Code asks whether to use an `ANTHROPIC_API_KEY` it finds in its environment, the first time it sees that key; its default is **No**. With Your setup signing Claude in with an API key, the office answers it ahead of time the way Claude records a Yes (the key's last 20 characters in `customApiKeyResponses.approved` in the sandbox's `~/.claude.json`, checked on Claude Code 2.1.19 and 2.1.283), so it doesn't come up. Without that, pick **1. Yes** to use the key you handed over; that dialog is Claude's own screen and shows the key's last characters, so it is on your screen (and in a recording) while it is open. On Railway, the first terminal ever asks which of your ssh keys the `railway` CLI should register on your Railway account (chat mode doesn't need one).

### Your setup: bring it along

A sandbox starts empty. With **Your setup** on (the default for a sandbox or an ssh box), the agent is set up there the way it is on this machine before it starts: signed in, with your MCP servers, your instructions and skills, and your project. The hire form lists what there is by name only, in four rows you can open and untick and one line that sums them up ("Claude subscription · 4 of 6 MCP servers · instructions + 12 skills · ~/Codes/app (3.1 MB)"), and remembers your choices per agent in that browser:

| row | what goes | how it gets there |
| --- | --- | --- |
| **Login** | Claude: your subscription (**Settings, Logins, Connect Claude** runs `claude setup-token` here, Claude's documented sign-in for a headless box; the one-year token it prints is stored as `CLAUDE_CODE_OAUTH_TOKEN`, the process ended, the token never shown), or an API key. Codex: an API key, a device code (`codex login --device-auth` runs first in the terminal, and the panel shows its link and code), or a copy of this machine's `~/.codex/auth.json` (OpenAI documents copying it as the fallback for headless boxes; it holds your ChatGPT tokens). Other agents: stored keys and the known keys your shell exports. | in the agent's own environment, the way [keys](#keys-the-office-passes-your-keys) go; `auth.json` as a 0600 file |
| **MCP servers** | Claude: user-scope servers from `~/.claude.json` and the chosen project's local ones (its `.mcp.json` travels with the code, with your choices about it). Codex: `[mcp_servers.*]` from `~/.codex/config.toml`. http and sse servers, and stdio servers run through `npx`, `uvx`, `bunx` or `docker`, are ticked; one that runs a file on this machine or listens on its localhost is listed with the reason and left unticked. claude.ai connectors don't come along with a setup-token sign-in. | merged into the agent's own config there (`~/.claude.json`, `~/.codex/config.toml`), 0600, env and header values included |
| **Instructions and skills** | Claude: `~/.claude/CLAUDE.md`, `rules/`, `skills/`, `agents/`, `commands/`, and `settings.json` minus hooks, `statusLine`, `apiKeyHelper` and the like that run files on this machine (and plugins, which stay here). Codex: `~/.codex/AGENTS.md`, `prompts/`, `skills/`. At most 20 MB; links that leave the folder and big binaries stay here, and the form says which. | files 0600 and folders 0700 under the agent's folder there |
| **Project** | A folder here (your recent ones): tracked files plus untracked ones `.gitignore` doesn't exclude (`git ls-files -co --exclude-standard`), and `.git` up to 50 MB so the agent can diff and commit, without hooks and with any `user:token@` taken out of remote URLs. `.env*` files only when you tick them. At most 100 MB and 20,000 files. | into the working folder there (`~/<name>` unless you give one), 0600 files |

How it travels: plain files as a tar.gz through the platform's own file upload (Vercel's `fs/write`, Daytona's `files/upload-v2` into `~/.agentoffice/run`, then `tar`), or streamed into `tar` on the exec channel's stdin (Railway's bridge, ssh). Everything that holds a secret (the merged configs, `auth.json`, `.env` files) is written by one command that carries it in its own environment (ssh: on its stdin), never on a command line or in a log. In a sandbox the office created, your setup replaces what's there; on an ssh box or a sandbox you made, only what's missing is added, and the project goes only into an empty folder. The session's starting steps show it as its own step, with what was left out.

### Background service

Agents hired from the page belong to the office process that started them: close the terminal running `npx theagentoffice` and they stop. The background service is an office that starts at login and keeps them:

```sh
agentoffice install --service     # install it and start it now (or switch it on from the page)
agentoffice uninstall --service   # stop it and remove it
```

On macOS it is a LaunchAgent (`~/Library/LaunchAgents/com.agentoffice.office.plist`), on Linux a `systemd --user` unit (`~/.config/systemd/user/agentoffice.service`; run `loginctl enable-linger` if agents should outlive your login). It runs a stable copy of the office in `~/.agentoffice/app/` with the node that installed it, so an npx cache being cleared or a checkout moving doesn't break it, and it logs to `~/.agentoffice/logs/office.log` (agent, project and mode per hire, never prompts, commands or keys). The unit file holds only `PATH`, `HOME` and `LANG`; the office reads the rest of your login shell's environment into memory when it starts, so agents and logins see what a terminal would. Turning "start at login" off from the page keeps a running service going until you log out. Switching the service on from a terminal office with no agents running hands the page straight over to it on the same port; with agents running it waits for the next login. Restarting or upgrading the service ends the agents it runs.

## With an AI coding agent

Agents can talk back. `agentoffice mcp` is a zero-dependency MCP server with five tools, and a short skill teaches agents when to use them:

| tool | what it does |
| --- | --- |
| `office_status {text, mood?}` | the status line and emoji floating over the agent's head |
| `office_peers {}` | who else is working right now and which files they just edited; agents in the same repo come first, with a heads-up before two of them edit the same file |
| `office_shout {text}` | a milestone on the office TV and in a toast (rate-limited) |
| `office_celebrate {reason?}` | confetti at the agent's desk |
| `office_flip {reason?}` | the agent flips its own table, in its own words (once every 2 minutes per repo) |

Install both into every agent on the machine at once:

```sh
npx theagentoffice install --dry-run   # the plan, and the exact diff of every file it would touch
npx theagentoffice install             # do it
npx theagentoffice doctor              # what's installed where, and is the office running
npx theagentoffice uninstall           # every file back the way it was
```

It uses each agent's own mechanism (`claude mcp add`, `codex mcp add`, or its MCP JSON, plus its skills folder), touches only the agents it finds, backs up every file first, and keeps your comments and formatting. Re-running is a no-op. Add `--vercel all` or `--ssh me@gpu-box` to install inside sandboxes and boxes too. Everything an agent sends is scrubbed before it reaches the screen: paths become file names, URLs become host names, anything that looks like a secret becomes `•••`.

## Privacy

agent office is built to be screen-recorded.

- **Local only.** The server binds `127.0.0.1`, rejects foreign `Host` headers and cross-site requests, and sends a strict CSP. `--host` exists, warns you when you use it, and turns the controls off.
- **Watching is read-only.** Watching never writes to your agents' transcripts or configs; only `install` touches configs, and only when you ask.
- **Hiring writes what the agent writes, plus a few office files.** Codex's chat mode records the folder as trusted in `~/.codex/config.toml` (what answering yes in its TUI does), and Command Code is started with `-t`, which trusts the folder; you picked it. Claude Code's two hooks (the permission hook, and a session-start hook so the desk follows the new transcript after `/clear`, which needs `curl` 8.3 or newer) are passed on its command line for that run, never written to a settings file. opencode runs its own server on a random loopback port with a random password, so only the office can drive it. The office's own new files in `~/.agentoffice` are `keys.json`, `control.json` (the unlock secret), `sandboxes.json`, `service.json` and `control-state.json` (recent folders), all `0600`.
- **The office passes your keys** to the remote agents you choose them for, as described in [Keys](#keys-the-office-passes-your-keys), and to nothing else.
- **Your setup copies what you leave ticked, into that sandbox or box only:** your sign-in (a stored key or `CLAUDE_CODE_OAUTH_TOKEN`, keys your shell exports, read at hire time and never stored, or Codex's `auth.json`), the MCP servers with their env and header values, your instructions, skills and sanitized `settings.json`, and the project with its history (and `.env` files only if you tick them). Secrets land in 0600 files in the agent's own config there and in its environment, never on a command line or in a log; the page only ever sees names. Connect Claude keeps the token it gets in `keys.json` like any other key. A sandbox provider can technically read what is inside its sandboxes, so whatever you bring is as private as that provider: delete the sandbox when you're done, and leave a key or a project behind when that matters.
- **Nothing leaves your machine**, except the calls to the sandbox platforms and ssh boxes you're logged in to or configured, and whatever you hire an agent to do. No telemetry, no CDN; it works offline.
- **Labels, not content.** What reaches the browser is an action and a file name, "Edit auth.ts", "$ npm test". Never prompt text, file contents, command arguments past the subcommand, or anything that looks like a key. Your home directory shows as `~`, and IPs are masked. The exceptions are yours: a hired agent's terminal panel shows its screen, chat mode shows your prompts and its replies, and an approval shows the command or change it asks you to allow, in your own unlocked browser only (anything that looks like a key is still masked).
- **Command lines are visible to your own machine.** A hired agent's first prompt is passed as its own argument (no keystroke timing), so other users of the same machine can see it with `ps` while the agent runs. So is the unlock link, for the moment `open` or `xdg-open` hands it to your browser; it works once, within two minutes, and the browser normally uses it first. On remotes it travels in the environment instead. Vercel keeps the arguments of every command run in a sandbox (never a key or a prompt here), and Railway's relay keeps about 8 MiB of a terminal's scrollback.
- **The unlock cookie alone unlocks nothing.** Browsers send cookies for `127.0.0.1` to every port there, so another local server you visit can see it; control also needs the token the office's page keeps in its own origin's storage, which no other port can read. `agentoffice open --rotate` logs every browser out.

## How it works

```
 ~/.claude  ~/.codex  ~/.commandcode  opencode.db  ...      sandboxes / ssh boxes
        \        |         |            /                   (same reads, over sh)
         ingest: one small parser per agent  <──────────────────────┘
                 │  "worker X started Edit auth.ts"
         state:  re-redacts; who's here, who quit (ps), who went quiet
                 │  Server-Sent Events on 127.0.0.1
         browser: Canvas 2D office drawn at pixel resolution, scaled crisp
                 │  unlocked browsers only: /api/control
         control: hire, PTYs and chat for the agents it starts, keys, sandboxes
```

The CLI tails transcript folders, backfills sessions active in the last 30 minutes, watches which agent processes are running so a worker walks in when its agent starts and leaves when it quits, and streams one event per line it understands. A hired agent is a worker the moment it is hired; when its transcript appears, the transcript's worker takes over the same desk. The office is drawn at true pixel-art resolution into an offscreen buffer and scaled up with crisp pixels; labels, ASCII mode and CRT are passes on the same canvas, so screenshots and clips include them. No framework, no runtime dependencies: one bundled `dist/cli.js` (with a worker thread that keeps the terminals' screens) and one bundled web app, split so the office loads first and the terminal (xterm.js), chat, Hire and Settings arrive as chunks of their own, fetched ahead while the page is idle (no CDN). The one optional dependency is `@lydell/node-pty`, the prebuilt PTY the terminal panels run on.

## CLI

```sh
npx theagentoffice [office] [options]     # open the office (the default command)
npx theagentoffice <command> [options]    # install | uninstall | doctor | mcp | open
```

| option | |
| --- | --- |
| `--port <n>`, `-p` | port, 4747 by default; tries the next 20 if taken |
| `--host <addr>` | interface to bind, `127.0.0.1` by default |
| `--agents <list>` | `claude,commandcode,codex,opencode,droid,gemini,qwen,cursor`, all by default |
| `--demo` | a simulated office; reads no transcripts |
| `--seed <n>` | demo seed, for reproducible recordings |
| `--no-open` | don't open the browser |
| `-q`, `--quiet` | banner only, no arrivals or flips in the terminal |
| `--verbose` | log what the watchers are doing |
| `--no-cloud`, `--local-only` | no sandbox auto-detect; this machine only |
| `--no-control` | watch-only: no hiring or driving agents from the page |

`AGENT_OFFICE_HOME` moves `~/.agentoffice`, `AGENT_OFFICE_<AGENT>_DIR` points one agent at a non-default folder, and `AGENT_OFFICE_PTY` (`node-pty`, `python` or `none`) forces a terminal backend, for troubleshooting.

| key | |
| --- | --- |
| <kbd>A</kbd> | pixel or ASCII |
| <kbd>C</kbd> | CRT scanlines |
| <kbd>S</kbd> | PNG screenshot |
| <kbd>R</kbd> | clip that: save the last ~15 seconds |
| <kbd>Shift</kbd>+<kbd>R</kbd> | record the next 10 seconds |
| <kbd>H</kbd> | stream mode: hide the chrome, the camera cuts in on every big moment |
| <kbd>F</kbd> | fullscreen |
| <kbd>M</kbd> | sound, off by default |
| <kbd>\\</kbd> | show or hide the activity feed |
| <kbd>?</kbd> | every shortcut |

Click a worker for its inspector: model, host, tool calls, tokens, recent actions. Scroll to zoom, drag to pan, double-click to reset.

## Contributing

New agents, sandbox platforms, fixes and ideas are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers how it fits together, how to add an agent, the privacy rules every label follows and how to open a pull request, and the [code of conduct](CODE_OF_CONDUCT.md) applies everywhere. Found a security problem? See [SECURITY.md](SECURITY.md).

## Trademarks

Claude, Codex, Command Code, opencode, Cursor, Droid and Factory, Qwen, Gemini, Daytona, boat, Railway and Vercel are trademarks of their owners. Their logos appear only to name those products, mostly from [Simple Icons](https://github.com/simple-icons/simple-icons) (CC0) and the owners' own marks; apart from Command Code, which sponsors agent office, it is not affiliated with or endorsed by any of them. Codex is shown as a neutral hexagon rather than OpenAI's logo.

## Author

Made by [@bas3line](https://github.com/bas3line), sponsored by [Command Code](https://commandcode.ai). If you use it, a link back is appreciated, and so is a star.

To support it: [GitHub Sponsors](https://github.com/sponsors/bas3line), [Buy Me a Coffee](https://buymeacoffee.com/bas3line) or [PayPal](https://paypal.me/ShubhamYadav886).

## License

MIT, © [@bas3line](https://github.com/bas3line)

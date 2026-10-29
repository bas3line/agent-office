/*
 * The seams inside the control plane (src/control/**). Three parts are built
 * against this file, the way the server and the page are built against
 * src/shared/control.ts:
 *
 *   sessions  (A)  PTYs, the session registry, agent launch specs, chat
 *                  adapters, approvals              -> SessionManager
 *   platform  (B)  /api/control routing and unlock, the key store, process
 *                  presence and worker linking, the service, server/CLI
 *                  wiring                           -> ControlContext, KeyStore,
 *                                                      OfficePort, ControlPlane
 *   cloud     (C)  sandboxes and ssh boxes: create, list ours, delete, attach
 *                  a TTY, install agents, hand over keys -> Places
 *
 * B builds a ControlContext and hands it to A (createSessionManager) and C
 * (createPlaces); A drives C's Places for every place that isn't this
 * machine. Nobody imports another part's modules except through these
 * shapes, so each part can be tested with fakes of the others.
 *
 * Secrets: a key value lives in KeyStore, in a Launch's env (named in
 * `secret`) on its way to one agent, and in that agent's environment. It is
 * never logged, never put on any argv, never sent to the browser, never
 * written anywhere but keys.json and, for milliseconds, a 0600 env file on a
 * remote that is sourced and deleted before the agent starts. "Bring my
 * setup" (SetupBundle) adds the agent's own 0600 config files there (MCP env
 * and header values, the key's approval, auth.json, .env files), written by
 * one command that carries them in its environment (ssh: its stdin).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TarEntry } from "./tar.ts";
import type { AgentKind, Host, RawEvent, RemoteTarget } from "../shared/events.ts";
import type {
  AgentAvailability, Approval, ApprovalAnswer, ChatItem, ControlInfo, ControlSession, HireRequest,
  KeyInfo, KeyInput, PermissionMode, Place, ProviderStatus, SandboxInfo, SessionStatus,
} from "../shared/control.ts";

export interface Disposable {
  dispose(): void;
}

/** Thrown anywhere in the control plane; the router answers `status` with {error: message}. Messages are shown as is: no secrets, no prompt text. */
export class ControlError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/* ------------------------------------------------------------ constants */

/** Where the control plane runs: it needs PTYs, process groups, POSIX signals and file modes. Elsewhere (Windows) the office is watch-only. */
export function controlSupported(platform: string = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/** The unlock cookie. HttpOnly, SameSite=Strict, Path=/. */
export const COOKIE = "ao_key";
/** Agent -> office callbacks (Claude Code's http hooks): POST /api/hook/<sessionId>/<event>. Not a browser route. */
export const HOOK_PREFIX = "/api/hook/";

/** Files under $AGENT_OFFICE_HOME. Every file 0600, every folder 0700. */
export const FILES = {
  /** {v:1, secret, notBefore}: the per-install unlock secret. */
  control: "control.json",
  /** {v:1, keys:[{name, value, agents, addedAt}]}. */
  keys: "keys.json",
  /** Sandboxes the office created: {v:1, sandboxes:[{provider, id, name, createdAt, environmentId?, projectId?}]}. */
  sandboxes: "sandboxes.json",
  /** {v:1, version, node, installedAt, startAtLogin}. */
  service: "service.json",
  /** {v:1, recentFolders: string[], railway?: {projectId, environmentId}} (the last Railway project a sandbox went in). */
  state: "control-state.json",
  /** The service's stable copy of the package: app/<version>/, app/current -> it. */
  app: "app",
  logs: "logs",
  /** Local sockets and scratch. Never anything secret. */
  run: "run",
} as const;

export const DEFAULT_TERM_SIZE = { cols: 120, rows: 32 } as const;
/** Server-side scrollback per terminal session, in lines (the browser keeps 5000 of its own). */
export const SCROLLBACK_LINES = 3_000;
/** An exited session stays listed (and its terminal replayable) this long, then `control_gone`. */
export const EXITED_KEEP_MS = 10 * 60_000;
export const MAX_SESSIONS = 16;
/** Sandboxes the office keeps alive at once that it created itself (cost guard). */
export const MAX_OFFICE_SANDBOXES = 3;
export const SANDBOX_TIMEOUT_MIN = { default: 30, max: 240 } as const;

/**
 * Removed from every agent's environment (and from the service's). Claude Code
 * sets these in processes it spawns; an inherited CLAUDE_CODE_CHILD_SESSION
 * silently turns transcript saving off, so a hired worker would never link.
 * Codex marks processes inside its sandbox. Explicit names: CLAUDE_CODE_OAUTH_TOKEN,
 * CLAUDE_CODE_USE_BEDROCK and friends are the user's own settings and stay.
 */
export const NESTED_ENV: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
];

/** Platform tokens the key store can hold for the office's own cloud calls (never handed to an agent). */
export const PLATFORM_KEY_NAMES: readonly string[] = ["DAYTONA_API_KEY", "VERCEL_TOKEN", "RAILWAY_API_TOKEN", "BOAT_API_KEY"];

/** Static facts per agent that sessions (A) and cloud (C) both need. A owns corrections. */
export interface AgentFacts {
  /** Executables, first found on PATH wins. */
  bins: readonly string[];
  /** npm package, for `npm i -g` (local hint and remote install). */
  npm?: string;
  /** Official installer script, piped to sh (preferred remotely when Node is too old or absent). */
  script?: string;
  /** What the hire form shows when the agent isn't installed here. */
  installCmd: string;
  /** Node major the npm package needs. */
  nodeMin?: number;
  /** Key names this agent reads, most preferred first (also the import allowlist). */
  keyNames: readonly string[];
  /** It has a headless protocol the office speaks: chat mode. "acp": the Agent Client Protocol (chat/acp.ts). */
  chat?: "claude" | "codex" | "opencode" | "acp";
}

export const AGENT_FACTS: Record<AgentKind, AgentFacts> = {
  claude: {
    bins: ["claude"],
    npm: "@anthropic-ai/claude-code",
    script: "https://claude.ai/install.sh",
    installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
    nodeMin: 22,
    keyNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
    chat: "claude",
  },
  commandcode: {
    bins: ["command-code", "commandcode"],
    npm: "command-code",
    installCmd: "npm i -g command-code",
    nodeMin: 22,
    keyNames: ["COMMAND_CODE_API_KEY"],
    chat: "acp",
  },
  codex: {
    bins: ["codex"],
    npm: "@openai/codex",
    installCmd: "npm i -g @openai/codex",
    keyNames: ["OPENAI_API_KEY"],
    chat: "codex",
  },
  opencode: {
    bins: ["opencode"],
    npm: "opencode-ai",
    installCmd: "npm i -g opencode-ai",
    keyNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    chat: "opencode",
  },
  droid: {
    bins: ["droid"],
    npm: "@factory/cli",
    script: "https://app.factory.ai/cli",
    installCmd: "curl -fsSL https://app.factory.ai/cli | sh",
    nodeMin: 20,
    keyNames: ["FACTORY_API_KEY"],
  },
  gemini: {
    bins: ["gemini"],
    npm: "@google/gemini-cli",
    installCmd: "npm i -g @google/gemini-cli",
    nodeMin: 20,
    keyNames: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  qwen: {
    bins: ["qwen"],
    npm: "@qwen-code/qwen-code",
    installCmd: "npm i -g @qwen-code/qwen-code",
    nodeMin: 22,
    keyNames: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "DASHSCOPE_API_KEY"],
  },
  cursor: {
    // Never the npm package "cursor-agent": it belongs to an unrelated third party.
    bins: ["cursor-agent", "agent"],
    script: "https://cursor.com/install",
    installCmd: "curl https://cursor.com/install -fsS | bash",
    keyNames: ["CURSOR_API_KEY"],
  },
  hermes: {
    // Watched through its own SQLite; the control plane cannot launch it.
    bins: [],
    installCmd: "",
    keyNames: [],
  },
};

/* -------------------------------------------------------------- context */

/** What B hands to A and C. One per office process. */
export interface ControlContext {
  /** $AGENT_OFFICE_HOME (default ~/.agentoffice). */
  home: string;
  /** The user's home folder: the fs listing root, "~" in labels. */
  userHome: string;
  version: string;
  platform: NodeJS.Platform;
  now(): number;
  /** One line for the terminal or the service log. Never a key value, token, prompt or full command line. */
  log(msg: string, level?: "info" | "warn"): void;
  /**
   * Environment for an agent started on this machine: the office's own
   * (which the service fills from the login shell at start) minus NESTED_ENV.
   * A fresh copy each call.
   */
  agentEnv(): Record<string, string>;
  /** http://127.0.0.1:<port> of this office, for hook URLs handed to local agents. */
  officeUrl(): string;
  office: OfficePort;
  keys: KeyStore;
  /** Unlocked browsers connected to /events right now. */
  viewers(): number;
}

/* ---------------------------------------------------- the office (B -> A) */

/** The office floor as the control plane sees it: OfficeState plus the linker. Implemented by B. */
export interface OfficePort {
  /** Into OfficeState.ingest, exactly like an ingest event. */
  emit(e: RawEvent): void;
  /**
   * Wait for the real transcript worker of a placeholder ("ctl:<id>",
   * "proc:<pid>", or a linked worker after Claude's /clear). When it shows
   * up the office publishes its session_start with `replaces` and calls
   * onLinked. Dispose to stop waiting (the session ended).
   */
  expect(x: LinkExpectation): Disposable;
  /** Exempt a worker from the quiet timers and from reconcileLocal: its process owns its lifetime. A link moves the hold. */
  hold(workerId: string): void;
  release(workerId: string): void;
  /**
   * Send a worker home now (session_end, interns too), release its hold, and
   * drop that worker's transcript events for a minute so a last line read
   * after the process exited doesn't walk it back in.
   */
  end(workerId: string): void;
  /** Top-level workers in the office on that host ("daytona:<id>", ...): SandboxInfo.workers. */
  workersOn(hostId: string): number;
  /** Absolute local folders agents worked in, most recent first. */
  recentFolders(): string[];
}

export interface LinkExpectation {
  /** The worker to be replaced. */
  placeholder: string;
  agent: AgentKind;
  /** Host.id of the transcript's machine; absent for this machine. */
  hostId?: string;
  /** Working folder (absolute, as the agent sees it). Compared after the office's own folding ("~", /private). */
  cwd?: string;
  /** The agent's own session id, when the launch pinned it: matched exactly (with the "<hostId>/" prefix remotely). */
  sessionId?: string;
  /** Epoch ms. A transcript worker first seen before since - 5s never matches. */
  since: number;
  /** Only the exact sessionId may claim (no agent + folder guess). Default: true when sessionId is set. */
  exactOnly?: boolean;
  onLinked(workerId: string): void;
  /**
   * Opt in to "never guess between two": when a transcript's guess matches
   * this and another open expectation, this one is dropped (and told so)
   * instead of the oldest winning. Presence sets it, so two terminals in
   * one repo can't swap desks.
   */
  onAmbiguous?(): void;
}

/* ------------------------------------------------------- keys (B -> A, C) */

export interface KeyStore {
  /** What the page sees: never a value. */
  list(): KeyInfo[];
  /** Add or replace. Throws ControlError(400) for a bad name or empty value. `meta.expiresAt`: shown as KeyInfo.expiresAt. */
  put(k: KeyInput, meta?: { expiresAt?: string }): KeyInfo;
  remove(name: string): boolean;
  /** Known key names (AGENT_FACTS keyNames + PLATFORM_KEY_NAMES) found in a fresh login shell; returns the names stored. */
  importFromShell(): Promise<string[]>;
  /** The values of these stored keys, for one agent's environment. Throws ControlError(400) naming a missing key. Never log the result. */
  reveal(names: string[]): Record<string, string>;
  /** Stored PLATFORM_KEY_NAMES, as an env overlay for the office's own provider calls. */
  platformEnv(): Record<string, string>;
  onChange(fn: () => void): Disposable;
}

export const KEY_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/* ------------------------------------------------------------ terminals */

/** A live terminal: a local PTY, or a remote TTY behind a WebSocket or a local ssh/CLI in a PTY. Bytes in, bytes out. */
export interface Term {
  /** The local process, when there is one (the agent, or the ssh/railway client wrapping it). */
  readonly pid?: number;
  write(data: string | Uint8Array): void;
  /** Clamped by the caller to 10..500 x 4..200. */
  resize(cols: number, rows: number): void;
  onData(fn: (chunk: Uint8Array) => void): Disposable;
  onExit(fn: (e: TermExit) => void): Disposable;
  /** Local: the signal to the process (SIGHUP by default). Remote: closes the TTY, which ends the command. */
  kill(signal?: NodeJS.Signals): void;
}

export interface TermExit {
  /** Exit status; 128 + n for a death by signal n; null when the transport can't tell. */
  code: number | null;
  signal?: string;
}

export interface PtySpawn {
  /** Absolute path, or a name resolved on env.PATH. */
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** @lydell/node-pty when it loads, else the python3 bridge. A owns it; C uses it for ssh and CLI-wrapped TTYs. */
export interface PtyBackend {
  readonly kind: "node-pty" | "python";
  /** Throws ControlError(500) when the program can't start. */
  spawn(spec: PtySpawn): Term;
}

/** A child with plain pipes (chat mode): local child_process, `ssh -T`, a Railway exec, a Daytona session command, a Vercel command with its stdin attached. */
export interface PipeProc {
  readonly pid?: number;
  write(data: string | Uint8Array): void;
  /** Close stdin. */
  end(): void;
  onStdout(fn: (chunk: Uint8Array) => void): Disposable;
  onStderr(fn: (chunk: Uint8Array) => void): Disposable;
  onExit(fn: (e: TermExit) => void): Disposable;
  kill(signal?: NodeJS.Signals): void;
}

/* ---------------------------------------------------------------- launch */

/** An argv element: a literal, or a reference to an env var of the same Launch (remote: rendered "$NAME"; local: substituted). */
export type Arg = string | { env: string };

/** One agent process, as A builds it and C runs it remotely. */
export interface Launch {
  /** argv[0] is the bin name (remote) or its resolved absolute path (local). */
  argv: Arg[];
  /** Absolute; remotely "~/x" is allowed and means under that machine's home. */
  cwd: string;
  /** Added to the base environment: flags, AO_PROMPT, AO_HOOK_TOKEN, and for remotes the chosen keys. */
  env: Record<string, string>;
  /** Names in env whose values are secret: never on argv, never logged, delivered with the least persistence the transport allows. */
  secret: string[];
  /** Folders to put in front of PATH on the remote (where the installer put the agent). */
  path?: string[];
}

/* ----------------------------------------------------- places (C -> A, B) */

/** What B hands to C on top of the ControlContext. */
export interface PlacesContext extends ControlContext {
  /** process.env plus keys.platformEnv(): the logins the providers read. */
  providerEnv(): NodeJS.ProcessEnv;
  pty(): Promise<PtyBackend | null>;
  /** Make the transcript watcher follow this host (src/remote Manager); dispose when no session needs it any more. */
  watch(target: RemoteTarget): Disposable;
}

export interface Places {
  /**
   * ControlInfo.providers. Cached: a row past its TTL is answered at once while it is refreshed
   * (the new one arrives through onChange). A platform not seen yet gets `deadlineMs` (default 3 s),
   * then its login state; its real row follows through onChange too.
   */
  status(o?: { fresh?: boolean; deadlineMs?: number }): Promise<ProviderStatus[]>;
  /** Resolve a place (creating the sandbox when target is "new"), ready to install and attach. */
  open(place: Place, o: OpenOptions): Promise<RemotePlace>;
  /** Only sandboxes the office created, unless force. Throws ControlError(409) for someone else's. */
  deleteSandbox(provider: SandboxInfo["provider"], id: string, force?: boolean): Promise<void>;
  onChange(fn: (providers: ProviderStatus[]) => void): Disposable;
  shutdown(): void;
}

export interface OpenOptions {
  agent: AgentKind;
  sandbox?: HireRequest["sandbox"];
  /** Feeds ControlSession.status / detail ("Creating Daytona sandbox…"). */
  progress(status: Extract<SessionStatus, "creating" | "installing" | "starting">, detail: string): void;
  signal?: AbortSignal;
  /** Create place.cwd there when it's missing, also outside office sandboxes (a project is being uploaded into it). */
  createCwd?: boolean;
}

/**
 * "Bring my setup", collected on this machine at hire time (src/control/setup.ts)
 * for one remote place to apply (RemotePlace.bring). Plain files travel as
 * tar.gz archives through the platform's file upload (or a tar stream on the
 * exec channel); everything that holds a secret (MCP env and header values,
 * the API key's approval, auth.json, .env files) is merged into the agent's
 * own config there and written 0600 by one command that carries it in its
 * own environment, never on a command line.
 */
export interface SetupBundle {
  agent: AgentKind;
  /** Files under the remote home (instructions, skills, prompts): names relative to $HOME, modes 0600/0700. */
  home?: { entries: TarEntry[]; files: number; bytes: number };
  /** The project, relative to the working folder there. */
  project?: { entries: TarEntry[]; files: number; bytes: number; display: string };
  /** Claude Code: merged into ~/.claude.json and ~/.claude/settings.json there. */
  claude?: {
    /** User-scope servers (name -> config, secrets included). */
    mcpServers: Record<string, unknown>;
    /** Local-scope servers of the chosen project, for projects[<cwd there>]. */
    projectMcpServers: Record<string, unknown>;
    /** The project's own .mcp.json choices (enabledMcpjsonServers and friends), for projects[<cwd there>]. */
    projectFlags: Record<string, unknown>;
    onboarding: boolean;
    /** Sanitized settings.json (hooks, statusLine, apiKeyHelper that run local files removed). */
    settings?: Record<string, unknown>;
  };
  /** Codex: `[mcp_servers.<name>]` sections appended to ~/.codex/config.toml; auth.json when asked. */
  codex?: { mcp: { name: string; toml: string }[]; authJson?: string };
  /** .env files of the project (relative paths), written 0600 into the working folder. */
  envFiles?: { path: string; content: string }[];
  /** Approve this API key in Claude's "use this key?" dialog ahead of time (the key itself rides the launch env). */
  approveClaudeKey?: boolean;
  summary: string;
  /** Left out on this machine already (shown in the session's setup step). */
  skipped: string[];
}

export interface SetupApplied {
  /** What didn't make it there ("~/app there isn't empty: the project wasn't uploaded"). */
  skipped: string[];
}

/** A sandbox or ssh box a session runs in. */
export interface RemotePlace {
  readonly host: Host;
  /** Resolved working folder there (absolute). */
  readonly cwd: string;
  /** Created by the office: first-run seeding is allowed, deletion needs no force. */
  readonly ours: boolean;
  /** exec for installs and checks; also what the transcript watcher polls. */
  readonly target: RemoteTarget;
  /** Install the agent if it's missing (status "installing"). Resolves the bin to run and its version. */
  ensureAgent(agent: AgentKind, progress: OpenOptions["progress"]): Promise<{ bin: string; version?: string; path?: string[] }>;
  /** Office-created sandboxes only (no-op otherwise): pre-answer first-run and trust screens for cwd there. */
  firstRun(agent: AgentKind, cwd: string): Promise<void>;
  /**
   * "Bring my setup": copy what was collected into this place (into cwd for
   * the project). `secrets` are values the merge needs (the API key, for its
   * approval); never logged. Only missing entries are written outside office
   * sandboxes. Resolves with what was skipped; throws only when nothing could be done.
   */
  bring?(bundle: SetupBundle, secrets: Record<string, string>, progress: (detail: string) => void): Promise<SetupApplied>;
  /** The agent's TUI on a TTY of this size. Secret env goes the least persistent way the platform has. */
  attach(launch: Launch, size: { cols: number; rows: number }): Promise<Term>;
  /** The agent on plain pipes, for chat mode. Absent: chat mode isn't available here. */
  pipe?(launch: Launch): Promise<PipeProc>;
  /** Heartbeats that keep an idle-timeout sandbox up while a session runs. */
  keepAlive(): Disposable;
  close(): void;
  /**
   * Only on a sandbox created for this session: delete it. The session calls
   * it when it ends before its agent ever ran (Stop while creating, a failed
   * install or attach), so a sandbox nobody used doesn't bill until its timeout.
   * Never throws; false when it is still there.
   */
  discard?(): Promise<boolean>;
}

/* -------------------------------------------------- sessions (A -> B) */

export interface SessionManager {
  /** ControlInfo.agents. Cached (versions are probed in the background); fresh re-probes. */
  /** `quick`: before the first probe is done, which agents are on PATH without their versions (the probe goes on). */
  availability(o?: { fresh?: boolean; quick?: boolean }): Promise<AgentAvailability[]>;
  /** Validates, registers and starts. Resolves at once with status creating / installing / starting; progress arrives through onChange. */
  hire(req: HireRequest): Promise<ControlSession>;
  list(): ControlSession[];
  get(id: string): ControlSession | undefined;
  /** Raw keystrokes into the PTY (terminal mode). */
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Terminal: paste + Enter (or the agent's own API). Chat: a new user turn. */
  prompt(id: string, text: string): Promise<void>;
  interrupt(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Throws ControlError(409) when that approval is no longer open. */
  answer(id: string, a: ApprovalAnswer): Promise<void>;
  /** Replays the screen and scrollback first, then live bytes; exit last. Throws ControlError(404) for chat sessions. */
  attachTerm(id: string, sink: TermSink): Disposable;
  /** Replays every item (latest version of each id), then live items. Throws ControlError(404) for terminal sessions. */
  attachChat(id: string, sink: ChatSink): Disposable;
  /** An agent calling back through HOOK_PREFIX (B has checked: POST, no browser headers, size). */
  hook(call: HookCall): Promise<HookReply>;
  /** Local processes the control plane owns (PTY children, chat children, ssh wrappers): presence leaves them and their descendants alone. */
  ownedPids(): number[];
  onChange(fn: (s: ControlSession) => void): Disposable;
  onGone(fn: (id: string) => void): Disposable;
  /** Ctrl+C on the office: every agent gets SIGHUP, then SIGKILL after a few seconds. */
  shutdown(): Promise<void>;
}

export interface TermSink {
  data(chunk: Uint8Array): void;
  exit(code: number | null): void;
  /**
   * A viewer that takes its replay in two steps: the visible screen at once ("screen"), then the
   * whole replay with the scrollback ("full"), each drawn from a reset terminal; live bytes come
   * through data() in between and after. Without it, the replay is one data() chunk.
   */
  replay?(chunk: Uint8Array, part: "screen" | "full"): void;
}

export interface ChatSink {
  item(it: ChatItem): void;
}

export interface HookCall {
  sessionId: string;
  /** "permission" | "session-start". */
  event: string;
  /** The bearer token from the Authorization header ("" when absent). */
  token: string;
  body: unknown;
  /** Aborted when the agent drops the request (its hook timed out, it quit): an open approval is withdrawn. */
  signal?: AbortSignal;
}

export interface HookReply {
  status: number;
  body?: unknown;
}

/* ------------------------------------------------- chat adapters (A) */

/** One headless conversation (Claude stream-json, Codex app-server, opencode serve). Internal to A; here so B and C can read what chat mode is. */
export interface ChatConn {
  /** The agent's own session id once known (Claude: pinned; Codex: thread id; opencode: ses_…): the link to its transcript worker. */
  readonly agentSessionId?: string;
  /** A user turn. Queued by the adapter while a turn runs (Claude queues natively). */
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  answer(a: ApprovalAnswer): Promise<void>;
  stop(): Promise<void>;
  onItem(fn: (it: ChatItem) => void): Disposable;
  /** The open approval, or null once it is answered or withdrawn. */
  onApproval(fn: (a: Approval | null) => void): Disposable;
  onTurn(fn: (state: "busy" | "idle") => void): Disposable;
  onSessionId(fn: (id: string) => void): Disposable;
  onExit(fn: (e: TermExit) => void): Disposable;
}

/** How a terminal-mode agent is driven once its TUI runs. */
export interface TermDrive {
  /** "paste": bracketed paste, then Enter after enterDelayMs. "opencode": its /tui/append-prompt + /tui/submit-prompt. */
  submit: "paste" | "opencode";
  enterDelayMs: number;
  /** "esc": one Esc byte, never two within 1.5s (two is "rewind" in Command Code). "opencode": POST /session/:id/abort. */
  interrupt: "esc" | "opencode";
}

/** Per-agent mapping of the contract's permission modes to flags. Absent mode: the agent can't start in it (AgentAvailability.permissions). */
export type PermissionFlags = Partial<Record<PermissionMode, string[]>>;

/* ------------------------------------------------ the plane (B -> server) */

/** Mounted by src/server/http.ts. */
export interface ControlPlane {
  /** False with --demo, --no-control, a non-loopback --host, or on Windows: /api/control answers 404 ("off"). */
  readonly enabled: boolean;
  /** /unlock, /api/control/**, /api/hook/**. True when it took the request (it answers asynchronously). */
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  /** Does this request carry a valid unlock cookie? Decides Snapshot.control and whether /events gets control frames. */
  unlocked(req: IncomingMessage): boolean;
  /** Frames for unlocked /events clients. */
  onFrame(fn: (f: ControlFrame) => void): Disposable;
  /** The server tells the plane how many unlocked browsers are on /events right now (ControlContext.viewers). */
  setViewers?(count: () => number): void;
  shutdown(): Promise<void>;
}

export type ControlFrame =
  | { event: "control"; data: ControlSession }
  | { event: "control_gone"; data: { id: string } }
  | { event: "control_info"; data: Partial<ControlInfo> };

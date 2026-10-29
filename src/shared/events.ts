/*
 * The one shape every part of agent office agrees on. Ingest turns transcript
 * lines into OfficeEvents, the server streams them over SSE, the web client
 * folds them into the scene. Nothing here carries raw transcript content:
 * `summary` is a short, already-redacted label like "Edit cli.ts" or
 * "$ npm test", capped at SUMMARY_MAX characters.
 */

export type AgentKind =
  | "claude"
  | "commandcode"
  | "codex"
  | "opencode"
  | "droid"   // Factory
  | "gemini"
  | "qwen"
  | "cursor"   // cursor-agent CLI
  | "hermes";  // Hermes Agent (read-only SQLite)

/** Where a worker is running. Local sessions omit `host` on events. */
export type HostKind = "local" | "ssh" | "daytona" | "boat" | "railway" | "vercel";

export interface Host {
  kind: HostKind;
  /** Stable id: "local", "ssh:user@box", "daytona:<sandboxId>", "boat:<id>", "railway:<sandboxId>", "vercel:<sandboxId>". */
  id: string;
  /** Short display name: the ssh alias, sandbox name, boat name. */
  name: string;
}

export type ToolCategory =
  | "read"    // Read, read_file, cat-like tools
  | "edit"    // Edit, Write, MultiEdit, apply_patch, write_file, NotebookEdit
  | "bash"    // Bash, shell, exec_command, run_command
  | "search"  // Grep, Glob, search, find, ls
  | "web"     // WebFetch, WebSearch, browser tools
  | "agent"   // Task / Agent / spawning a subagent
  | "todo"    // TodoWrite, plan updates
  | "mcp"     // any mcp__* tool
  | "other";

export type EventKind =
  | "session_start"  // first sighting of a session (also sent on backfill)
  | "prompt"         // the human sent a message
  | "thinking"       // model is reasoning / generating
  | "tool_start"     // a tool call was issued
  | "tool_end"       // its result came back (isError set if it failed)
  | "reply"          // assistant text addressed to the human
  | "waiting"        // turn finished, agent is waiting on the human
  | "test_fail"      // a test command exited non-zero  -> table flip
  | "test_pass"      // a test command passed           -> celebration
  | "error"          // API error, interrupted turn, crashed tool
  | "subagent_start" // a subagent of this session appeared
  | "subagent_end"   // that subagent finished
  | "idle"           // no activity for IDLE_MS
  | "session_end"    // no activity for GONE_MS, remove from the office
  // Sent by the agent itself through the agentoffice MCP server:
  | "status"         // agent set its own status line (summary) and mood (tool = emoji)
  | "shout"          // agent posted to the office TV / toasts (summary)
  | "celebrate"      // agent asked for confetti
  | "flip";          // agent flipped its own table, unprompted

export interface OfficeEvent {
  /** Monotonic per-server id, assigned by the server. */
  seq: number;
  /** ISO timestamp from the transcript line (or now, for synthetic events). */
  ts: string;
  agent: AgentKind;
  /** Stable id of the worker: the session id, or the subagent id for subagents. */
  workerId: string;
  /** For subagents: the workerId of the parent session. */
  parentId?: string;
  /** Project label, the basename of cwd. */
  project: string;
  /** Set for workers in a sandbox or on another machine. */
  host?: Host;
  /** Full cwd, shown only in the inspector. */
  cwd?: string;
  model?: string;
  kind: EventKind;
  tool?: string;
  category?: ToolCategory;
  /** Short redacted label, <= SUMMARY_MAX chars. */
  summary?: string;
  isError?: boolean;
  /** Tokens this line reported (input + output), when the transcript has it. */
  tokens?: number;
  /** Subagent role / description, e.g. "Explore", "general-purpose". */
  role?: string;
  /**
   * On session_start only: this worker takes over another one in place (same
   * desk, no walk out and back in). A hired agent ("ctl:<id>") or one seen
   * launching ("proc:<pid>") is replaced by its real transcript's worker.
   */
  replaces?: string;
}

/** What the server sends on connect: the current office, then live events. */
export interface Snapshot {
  version: 1;
  startedAt: string;
  demo: boolean;
  workers: WorkerState[];
  recent: OfficeEvent[]; // last <= 200 events, oldest first
  /** Remotes being watched and whether they answer (src/remote/index.ts hosts()). */
  hosts?: HostStatus[];
  /**
   * The control plane (src/shared/control.ts) for the browser that opened this
   * stream: "enabled" (unlocked: the page fetches GET /api/control), "locked"
   * (watch-only, nothing to fetch) or "off" (this server has none, e.g. --demo).
   * Absent: the page probes GET /api/control and reads its 401 / 404.
   */
  control?: "enabled" | "locked" | "off";
}

export interface HostStatus {
  host: Host;
  /** false while it can't be reached: its pod dims. */
  online: boolean;
  /** "dormant": a quiet sandbox the office stopped polling so it can idle out and stop billing. */
  status: "connecting" | "online" | "offline" | "dormant";
  /** Short, already-safe reason while offline ("login expired", "timed out"). */
  error?: string;
}

export interface WorkerState {
  workerId: string;
  parentId?: string;
  agent: AgentKind;
  project: string;
  host?: Host;
  /** Last status line / mood the agent set through MCP, if any. */
  mood?: string;
  cwd?: string;
  model?: string;
  role?: string;
  /** Last event kind and its tool, so a fresh client can pose the sprite. */
  status: EventKind;
  tool?: string;
  category?: ToolCategory;
  summary?: string;
  lastTs: string;
  toolCalls: number;
  tokens: number;
  filesTouched: number;
}

export const SUMMARY_MAX = 64;
/** Quiet this long -> idle. */
export const IDLE_MS = 90_000;
/** Quiet this long -> leaves the office. */
export const GONE_MS = 20 * 60_000;
/** On startup, sessions touched within this window are backfilled. */
export const ACTIVE_WINDOW_MS = 30 * 60_000;

/* Wire format.  GET /events is text/event-stream:
 *   event: snapshot   data: Snapshot      (once, on connect)
 *   event: office     data: OfficeEvent   (every live event)
 *   : ping                                (every 15s)
 * GET /api/snapshot returns the Snapshot as JSON.
 * GET / serves the web app; GET /assets/* serves dist/web/assets.
 */

export const BRAND: Record<AgentKind, { name: string; color: string; ink: string }> = {
  claude: { name: "Claude Code", color: "#D97757", ink: "#1F1E1D" },
  commandcode: { name: "Command Code", color: "#F2F2F2", ink: "#0A0A0A" },
  codex: { name: "Codex", color: "#10A37F", ink: "#0B0F0E" },
  opencode: { name: "opencode", color: "#FAB283", ink: "#0A0A0A" },
  droid: { name: "Droid", color: "#EE6018", ink: "#0B0B0B" },
  gemini: { name: "Gemini CLI", color: "#8E75FF", ink: "#0B0B14" },
  qwen: { name: "Qwen Code", color: "#615CED", ink: "#0B0B14" },
  cursor: { name: "Cursor", color: "#EDECEC", ink: "#0A0A0A" },
  hermes: { name: "Hermes", color: "#F5C542", ink: "#0B0B0B" },
};

/** Agents the office watches but cannot hire: no control-plane launcher. */
export const WATCH_ONLY_AGENTS: readonly AgentKind[] = ["hermes"];

export const HOST_BRAND: Record<Exclude<HostKind, "local">, { name: string; color: string }> = {
  ssh: { name: "SSH", color: "#9AA4B2" },
  daytona: { name: "Daytona", color: "#2ECC71" },
  boat: { name: "boat", color: "#4F8CFF" },
  railway: { name: "Railway", color: "#853BCE" },
  vercel: { name: "Vercel Sandbox", color: "#EDEDED" },
};

/* Ingest -> server seam. Implemented in src/ingest/index.ts. */
export type RawEvent = Omit<OfficeEvent, "seq">;

export interface IngestOptions {
  agents: AgentKind[];
  /** Remote hosts to watch in addition to this machine (see src/remote). */
  remotes?: RemoteTarget[];
  onEvent: (e: RawEvent) => void;
  log?: (msg: string) => void;
}

export type StartIngest = (opts: IngestOptions) => { stop(): void };

/* Remote sources. A remote is anything we can run a POSIX shell command on
 * and read stdout from: an ssh box, a Daytona sandbox, a boat VM, a Railway sandbox, a Vercel Sandbox. Ingest
 * polls each remote's transcript dirs through that one primitive, so the
 * remote needs nothing installed. Implemented in src/remote/**. */
export interface RemoteTarget {
  host: Host;
  /** Run `sh -c script` on the remote, resolve stdout. Rejects on failure. */
  exec(script: string, opts?: { timeoutMs?: number }): Promise<string>;
  close?(): void;
}

/* MCP -> office seam. The agentoffice MCP server appends AgentSignals as
 * JSONL to $AGENT_OFFICE_HOME/outbox/<pid>.jsonl (default ~/.agentoffice);
 * ingest tails that dir locally and on remotes like any transcript, and
 * attributes each signal to the live worker with the same agent + cwd. */
export interface AgentSignal {
  v: 1;
  ts: string;
  /** From the MCP initialize clientInfo.name, mapped to an AgentKind when known. */
  agent?: AgentKind;
  client?: string;
  cwd: string;
  kind: "status" | "shout" | "celebrate" | "flip";
  /** Status/shout text, <= SUMMARY_MAX, redacted by the MCP server before writing. */
  text?: string;
  /** Single emoji for status. */
  mood?: string;
}

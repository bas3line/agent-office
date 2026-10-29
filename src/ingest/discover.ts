/*
 * Where each agent keeps its transcripts and how to list them through a
 * Source. A driver turns a root into ListRequests (a "full" listing walks
 * everything, a quick one only where new activity can appear: Codex's last
 * two date folders, the subagent folders of Claude sessions already being
 * watched, the chat folders a full scan found) and classifies each listed
 * file as a session, a subagent, or noise. opencode lives in SQLite and is
 * polled separately (src/ingest/opencode.ts); only its database path is here.
 */
import { existsSync } from "node:fs";
import type { AgentKind } from "../shared/events.ts";
import type { FileStat, ListRequest, SourceEnv } from "./source.ts";

export interface Candidate extends FileStat {
  agent: AgentKind;
  /** A subagent transcript: tracked after the sessions, so its parent is in the office first. */
  subagent?: boolean;
  /** Where the parent's transcript is, when the layout says. */
  parentPath?: string;
  /** Parent workerId, when the layout says (Gemini nests subagents under the parent's session id). */
  parentId?: string;
  /** A whole-file JSON document rewritten on every change (legacy Gemini), not an append-only log. */
  doc?: boolean;
}

/** Hints for quick listings, from what the loop already watches. */
export interface ListHint {
  /** Main session transcripts being watched (Claude: their subagent folders get listed). */
  watched: string[];
  /** Folders found by the last full scan that new transcripts appear in. */
  dirs: Set<string>;
  now: number;
}

export interface Driver {
  agent: AgentKind;
  lists(root: string, full: boolean, hint: ListHint): ListRequest[];
  classify(root: string, f: FileStat): Candidate | null;
  /** Folder a quick listing should keep an eye on, for a classified file. */
  dir?(root: string, c: Candidate): string | undefined;
}

const SEP = "/";
const rel = (root: string, p: string) => p.slice(root.length + 1).split(/[\\/]+/);
const join2 = (...p: string[]) => p.join(SEP).replace(/\/{2,}/g, "/");

/* ------------------------------------------------------------------ roots */

/** `dir/<name>` if it exists, else `dir` itself when it was given explicitly (local overrides only). */
function under(dir: string, name: string, explicit: boolean, local: boolean): string {
  const child = join2(dir, name);
  if (!explicit || !local || existsSync(child)) return child;
  return dir;
}

/**
 * Transcript roots for an agent on one machine. AGENT_OFFICE_<AGENT>_DIR
 * overrides (accepting the agent's home or its sessions folder) only apply
 * to this machine; remotes use the agents' own env vars and defaults.
 */
export function agentRoots(agent: AgentKind, env: SourceEnv, local = true): string[] {
  const v = env.vars;
  const home = env.home;
  const o = (name: string) => (local ? v[`AGENT_OFFICE_${name}_DIR`] : undefined);
  switch (agent) {
    case "claude": {
      const x = o("CLAUDE");
      return [under(x || v.CLAUDE_CONFIG_DIR || join2(home, ".claude"), "projects", !!x, local)];
    }
    case "commandcode": {
      const x = o("COMMANDCODE");
      return [under(x || join2(home, ".commandcode"), "projects", !!x, local)];
    }
    case "codex": {
      const x = o("CODEX");
      return [under(x || v.CODEX_HOME || join2(home, ".codex"), "sessions", !!x, local)];
    }
    case "droid": {
      const x = o("DROID");
      return [under(x || v.FACTORY_HOME || join2(home, ".factory"), "sessions", !!x, local)];
    }
    case "qwen": {
      const x = o("QWEN");
      return [under(x || v.QWEN_HOME || join2(home, ".qwen"), "projects", !!x, local)];
    }
    case "cursor": {
      const x = o("CURSOR");
      return [under(x || join2(home, ".cursor"), "projects", !!x, local)];
    }
    case "gemini": {
      const x = o("GEMINI");
      if (x) return [under(x, "tmp", true, local)];
      const gh = v.GEMINI_CLI_HOME || home;
      // Under macOS sandbox-exec the CLI keeps its runtime state in ~/.cache/.gemini.
      return [join2(gh, ".gemini", "tmp"), join2(home, ".cache", ".gemini", "tmp")];
    }
    case "hermes":
      return [hermesDb(env, local)];
    case "opencode":
      return [opencodeDb(env, local)];
  }
}

/** opencode >= 1.0 keeps everything in one SQLite file under its XDG data dir. */
export function opencodeDb(env: SourceEnv, local = true): string {
  const x = local ? env.vars.AGENT_OFFICE_OPENCODE_DIR : undefined;
  if (x) return x.endsWith(".db") ? x : join2(x, "opencode.db");
  return join2(env.vars.XDG_DATA_HOME || join2(env.home, ".local", "share"), "opencode", "opencode.db");
}

/** Hermes keeps everything in one SQLite file under $HERMES_HOME (default ~/.hermes). */
export function hermesDb(env: SourceEnv, local = true): string {
  const x = local ? env.vars.AGENT_OFFICE_HERMES_DIR : undefined;
  if (x) return x.endsWith(".db") ? x : join2(x, "state.db");
  return join2(env.vars.HERMES_HOME || join2(env.home, ".hermes"), "state.db");
}

/** Where the agentoffice MCP server drops AgentSignals. */
export function outboxDir(env: SourceEnv): string {
  return join2(env.vars.AGENT_OFFICE_HOME || join2(env.home, ".agentoffice"), "outbox");
}

/* ---------------------------------------------------------------- drivers */

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSONL = [".jsonl"];

const claude: Driver = {
  agent: "claude",
  lists(root, full, hint) {
    // <slug>/<id>.jsonl, <slug>/<id>/subagents/[workflows/<run>/]agent-*.jsonl
    // .meta.json rides along so the loop sees a subagent's "finished" flag change without its own stat.
    const sub = [".jsonl", ".meta.json"];
    if (full) return [{ root, depth: 5, suffixes: sub, skip: ["tool-results", "memory", "node_modules", ".git"] }];
    return [
      { root, depth: 1, suffixes: JSONL, onlyNew: true },
      ...hint.watched.map((p) => ({ root: p.replace(/\.jsonl$/, "") + "/subagents", depth: 2, suffixes: sub, onlyNew: true })),
    ];
  },
  classify(root, f) {
    const r = rel(root, f.path);
    const name = r[r.length - 1]!;
    if (!name.endsWith(".jsonl")) return null;
    if (r.length === 2) return { ...f, agent: "claude" };
    const si = r.indexOf("subagents");
    if (si === 2 && UUIDISH.test(r[1]!) && name.startsWith("agent-") && r.length <= 6) {
      return { ...f, agent: "claude", subagent: true, parentPath: join2(root, r[0]!, `${r[1]}.jsonl`) };
    }
    return null;
  },
};

const commandcode: Driver = {
  agent: "commandcode",
  lists: (root, full) => [{ root, depth: 1, suffixes: JSONL, onlyNew: !full }],
  classify(root, f) {
    const r = rel(root, f.path);
    const name = r[r.length - 1]!;
    if (r.length !== 2 || name.endsWith(".checkpoints.jsonl") || name.startsWith("hooks-audit")) return null;
    return { ...f, agent: "commandcode" };
  },
};

function dayDirs(root: string, now: number): string[] {
  const dirs = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const back of [0, 1]) {
    const d = new Date(now - back * 86_400_000);
    dirs.add(join2(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
    dirs.add(join2(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
  }
  return [...dirs];
}

const codex: Driver = {
  agent: "codex",
  lists(root, full, hint) {
    // YYYY/MM/DD/rollout-*.jsonl (very old versions: rollouts in the root itself).
    if (full) return [{ root, depth: 3, suffixes: JSONL }];
    return dayDirs(root, hint.now).map((d) => ({ root: d, depth: 0, suffixes: JSONL, onlyNew: true }));
  },
  classify(root, f) {
    const r = rel(root, f.path);
    const name = r[r.length - 1]!;
    if (!name.startsWith("rollout-")) return null;
    if (r.length === 1 || (r.length === 4 && /^\d{4}$/.test(r[0]!))) return { ...f, agent: "codex" };
    return null;
  },
};

const droid: Driver = {
  agent: "droid",
  // <cwd-slug>/<id>.jsonl (older builds: straight in the root), plus <id>.settings.json for model and tokens.
  lists: (root, full) => [{ root, depth: 1, suffixes: [".jsonl", ".settings.json"], onlyNew: !full }],
  classify(root, f) {
    const r = rel(root, f.path);
    return r.length <= 2 && f.path.endsWith(".jsonl") ? { ...f, agent: "droid" } : null;
  },
};

const qwen: Driver = {
  agent: "qwen",
  lists: (root, full) => [{ root, depth: 2, suffixes: JSONL, onlyNew: !full }],
  classify(root, f) {
    const r = rel(root, f.path);
    return r.length === 3 && r[1] === "chats" ? { ...f, agent: "qwen" } : null;
  },
};

const cursor: Driver = {
  agent: "cursor",
  lists(root, full, hint) {
    // <slug>/agent-transcripts/<id>/<id>.jsonl and .../<id>/subagents/<sub>.jsonl
    if (full || !hint.dirs.size) {
      return [{ root, depth: 4, suffixes: JSONL, skip: ["node_modules", "canvases", "mcps", "terminals", "agent-tools", ".git"] }];
    }
    return [...hint.dirs].filter((d) => d.startsWith(root + "/")).map((d) => ({ root: d, depth: 2, suffixes: JSONL, onlyNew: true }));
  },
  classify(root, f) {
    const r = rel(root, f.path);
    if (r[1] !== "agent-transcripts") return null;
    const id = r[2]!;
    if (r.length === 4 && r[3] === `${id}.jsonl`) return { ...f, agent: "cursor" };
    if (r.length === 5 && r[3] === "subagents") {
      return { ...f, agent: "cursor", subagent: true, parentPath: join2(root, r[0]!, "agent-transcripts", id, `${id}.jsonl`) };
    }
    return null;
  },
  dir: (root, c) => {
    const r = rel(root, c.path);
    return join2(root, r[0]!, "agent-transcripts");
  },
};

const gemini: Driver = {
  agent: "gemini",
  lists(root, full, hint) {
    // <project>/chats/session-*.jsonl (legacy: .json), subagents in chats/<parentSessionId>/<id>.jsonl
    if (full || !hint.dirs.size) return [{ root, depth: 3, suffixes: [".jsonl", ".json"], skip: ["node_modules", "checkpoints", "logs", "plans", "tracker", "tasks", "memory"] }];
    return [...hint.dirs].filter((d) => d.startsWith(root + "/")).map((d) => ({ root: d, depth: 1, suffixes: [".jsonl", ".json"], onlyNew: true }));
  },
  classify(root, f) {
    const r = rel(root, f.path);
    if (r[1] !== "chats") return null;
    const name = r[r.length - 1]!;
    if (r.length === 3 && name.startsWith("session-")) {
      if (name.endsWith(".jsonl")) return { ...f, agent: "gemini" };
      // A legacy .json document that has already been migrated to .jsonl is history.
      if (name.endsWith(".json")) return { ...f, agent: "gemini", doc: true };
    }
    if (r.length === 4 && name.endsWith(".jsonl")) return { ...f, agent: "gemini", subagent: true, parentId: r[2]! };
    return null;
  },
  dir: (root, c) => {
    const r = rel(root, c.path);
    return join2(root, r[0]!, "chats");
  },
};

export const DRIVERS: Partial<Record<AgentKind, Driver>> = { claude, commandcode, codex, droid, qwen, cursor, gemini };

/** For Claude-style slugs ("-Users-me-my-app", "C--Users-me-my-app" on Windows): the cwd an absolute path inside it implies, if it matches. */
export function cwdFromSlug(slug: string, abs: unknown): string | undefined {
  if (typeof abs !== "string") return undefined;
  const drive = /^[A-Za-z]:[\\/]/.test(abs);
  if (!drive && !abs.startsWith("/")) return undefined;
  const norm = (s: string) => s.replace(/[^A-Za-z0-9]/g, "-").replace(/^-+/, "");
  // Windows paths compare without case, and a slug may spell the ":\" after the drive as one dash or two.
  const key = drive ? (s: string) => norm(s).toLowerCase().replace(/-{2,}/g, "-") : norm;
  const want = key(slug);
  const parts = abs.split(drive ? /[\\/]/ : "/").filter(Boolean);
  for (let n = parts.length; n > 0; n--) {
    const p = drive ? parts.slice(0, n).join("\\") + (n === 1 ? "\\" : "") : "/" + parts.slice(0, n).join("/");
    if (key(p) === want) return p;
  }
  return undefined;
}


/*
 * Which coding agents are running on this machine right now, and in which
 * folder. Transcripts never say "I exited", so without this a session that
 * quit lingers until GONE_MS; with it the office sends it home within seconds.
 * macOS: `ps` for the command lines, one `lsof` call for every match's cwd.
 * Linux: `ps`, then /proc/<pid>/cwd. Anywhere else the answer is "unknown"
 * (null) and the office falls back to the quiet timer.
 *
 * scanProcesses() is the fuller answer src/control/presence.ts walks agents
 * in with: the parent, terminal and start time of every agent process, the
 * parent of every process on the machine (to tell a nested or office-owned
 * agent from one started in a terminal), and the processes whose cwd could
 * not be read, so a blind round never sends a live session home.
 */
import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import type { AgentKind } from "../shared/events.ts";

export interface AgentProcess {
  pid: number;
  agent: AgentKind;
  /** Absolute working folder, with macOS's /private prefix folded away. */
  cwd: string;
  ppid?: number;
  /** Controlling terminal ("ttys003", "pts/1"); null for none ("??" / "?"). */
  tty?: string | null;
  /** Epoch ms, from ps's elapsed time (second resolution). */
  startedAt?: number;
}

/** An agent process from scanProcesses(): cwd is null when it couldn't be read. */
export interface ScannedAgent extends Omit<AgentProcess, "cwd"> {
  cwd: string | null;
  ppid: number;
  tty: string | null;
  startedAt: number;
}

export interface ProcessScan {
  agents: ScannedAgent[];
  /** pid -> ppid for every process on the machine. */
  parents: Map<number, number>;
}

/** Executable names, matched exactly (so "Claude", the desktop app, is not "claude"). */
const BINARIES: Record<string, AgentKind> = {
  claude: "claude",
  "command-code": "commandcode",
  commandcode: "commandcode",
  codex: "codex",
  opencode: "opencode",
  droid: "droid",
  gemini: "gemini",
  qwen: "qwen",
  "cursor-agent": "cursor",
  hermes: "hermes",
};

/** Package paths of agents that run as a script under a JS runtime. */
const SCRIPTS: [RegExp, AgentKind][] = [
  [/@anthropic-ai\/claude-code\//, "claude"],
  [/@openai\/codex\//, "codex"],
  [/@google\/gemini-cli\//, "gemini"],
  [/@qwen-code\/qwen-code\//, "qwen"],
  [/[\\/]opencode-ai\//, "opencode"],
  [/[\\/]command-?code[\\/]/, "commandcode"],
];
const RUNTIMES = new Set(["node", "bun", "deno"]);

const base = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

/** The agent a command line belongs to, or null. */
export function matchAgent(args: string): AgentKind | null {
  const argv = args.trim().split(/\s+/);
  const exe = base(argv[0] ?? "");
  if (Object.hasOwn(BINARIES, exe)) return BINARIES[exe]!;
  if (!RUNTIMES.has(exe)) return null;
  // node [flags] <script>: the first non-flag argument is the script.
  const script = argv.slice(1).find((a) => !a.startsWith("-")) ?? "";
  if (Object.hasOwn(BINARIES, base(script))) return BINARIES[base(script)]!;
  for (const [re, agent] of SCRIPTS) if (re.test(script)) return agent;
  return null;
}

/** /private/tmp and /tmp are the same folder on macOS; transcripts may record either. */
export function foldPrivate(p: string): string {
  return /^\/private\/(tmp|var|etc)(\/|$)/.test(p) ? p.slice("/private".length) : p;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => done(err && !stdout ? null : stdout));
  });
}

/** ps's elapsed time "[[dd-]hh:]mm:ss" in ms; null if it doesn't parse. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const [d, h, min, sec] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0)) as [number, number, number, number];
  return (((d * 24 + h) * 60 + min) * 60 + sec) * 1000;
}

/** Parse `ps -o pid=,ppid=,tty=,etime=,args=`: the agent processes (cwd still unknown) and every pid's parent. */
export function parsePs(out: string, now: number, self = process.pid): { agents: Omit<ScannedAgent, "cwd">[]; parents: Map<number, number> } {
  const agents: Omit<ScannedAgent, "cwd">[] = [];
  const parents = new Map<number, number>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    parents.set(pid, ppid);
    if (pid === self) continue;
    const agent = matchAgent(m[5]!);
    if (!agent) continue;
    const tty = m[3] === "?" || m[3] === "??" || m[3] === "-" ? null : m[3]!;
    const age = parseEtime(m[4]!);
    agents.push({ pid, ppid, agent, tty, startedAt: age === null ? now : now - age });
  }
  return { agents, parents };
}

/** Every agent process with its parent, terminal, start time and cwd, plus every pid's parent. null when this platform can't tell. */
export async function scanProcesses(now = Date.now()): Promise<ProcessScan | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const cols = "pid=,ppid=,tty=,etime=,args=";
  const ps = await run("ps", process.platform === "darwin" ? ["-axo", cols] : ["-eo", cols]);
  if (ps === null) return null;
  const { agents, parents } = parsePs(ps, now);
  const cwds = await readCwds(agents.map((a) => a.pid));
  if (!cwds) return null;
  return { agents: agents.map((a) => ({ ...a, cwd: cwds.has(a.pid) ? foldPrivate(cwds.get(a.pid)!) : null })), parents };
}

/** Every agent process with its cwd; null when this platform can't tell. */
export async function scanAgentProcesses(): Promise<AgentProcess[] | null> {
  const scan = await scanProcesses();
  if (!scan) return null;
  // A process whose cwd can't be read (another user's, or gone mid-scan) is left out.
  return scan.agents.flatMap((a) => (a.cwd ? [{ ...a, cwd: a.cwd }] : []));
}

/** pid -> cwd for these pids (unreadable ones missing); null when the lookup itself failed. */
async function readCwds(pids: number[]): Promise<Map<number, string> | null> {
  const cwds = new Map<number, string>();
  if (!pids.length) return cwds;
  const found = pids.map((pid) => ({ pid }));
  if (process.platform === "darwin") {
    // -a: AND the filters; -d cwd: only the cwd entry; -F pn: machine-readable pid / name lines.
    const out = await run("lsof", ["-a", "-d", "cwd", "-p", found.map((f) => f.pid).join(","), "-Fpn"]);
    if (out === null) return null;
    let pid = 0;
    for (const line of out.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "n" && pid) cwds.set(pid, line.slice(1));
    }
  } else {
    await Promise.all(found.map(async (f) => {
      const cwd = await readlink(`/proc/${f.pid}/cwd`).catch(() => null);
      if (cwd) cwds.set(f.pid, cwd);
    }));
  }
  return cwds;
}

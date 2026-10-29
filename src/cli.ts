/*
 * `npx theagentoffice`: parse flags, fill the state store from the transcript
 * watcher (or the demo), serve the office on localhost, print the banner and
 * open the browser. No dependencies: flags are parsed by hand and the colours
 * are raw ANSI, off for NO_COLOR and when stdout is not a terminal.
 *
 * With the control plane (src/control; off for --demo, --no-control, a
 * non-loopback --host and Windows) the browser it opens is unlocked through
 * a one-time link, and hiring from the page works. `--service` is how the
 * background service starts it: login environment first, no browser, a log
 * file instead of the terminal.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentKind, OfficeEvent } from "./shared/events.ts";
import { BRAND } from "./shared/events.ts";
import { startIngest } from "./ingest/index.ts";
import { scanProcesses } from "./ingest/presence.ts";
import { DEFAULT_SEED, startDemo } from "./demo/index.ts";
import { DEFAULT_HOST, DEFAULT_PORT, isLoopback, isWildcard, startServer, type OfficeServer } from "./server/http.ts";
import { OfficeState } from "./server/state.ts";
import { SUBCOMMANDS, runSubcommand } from "./install/index.ts";
import { registerRemoteDetector, registerRemoteFactory } from "./install/remotes.ts";
import { AGENT_KINDS, parseAgentKind } from "./mcp/clients.ts";
import { clearOfficeFile, newOfficeSecret, officeFilePath, writeOfficeFile, type OfficeFile } from "./mcp/office.ts";
import { officeHome } from "./mcp/outbox.ts";
import { createControlPlane, type Plane } from "./control/index.ts";
import { createSessionManager } from "./control/sessions.ts";
import { createPlaces } from "./control/cloud/index.ts";
import { loadPty } from "./control/pty.ts";
import { adoptLoginEnv } from "./control/env.ts";
import { createLinker, createOfficePort } from "./control/link.ts";
import { claudeSessionOf, startPresence } from "./control/presence.ts";
import { createInstallApi } from "./control/install-api.ts";
import { appCurrent, installService, serviceLogger, serviceStatus, setStartAtLogin, startService } from "./control/service.ts";
import { canOpenBrowser, loginPath, openBrowser, serviceDeps, waitForOffice } from "./control/cli.ts";
import { selfCommand } from "./install/command.ts";
import type { ServiceControl } from "./control/api.ts";
import { controlSupported } from "./control/types.ts";
import { join } from "node:path";
import {
  REMOTE_FACTORIES, REMOTE_KINDS, defaultProviders, mergeSelectors, readRemoteConfig, startRemotes,
  type RemoteSelector, type Remotes,
} from "./remote/index.ts";
import { RailwayBudget } from "./remote/railway.ts";

const ALL_AGENTS: AgentKind[] = [...AGENT_KINDS];
const PORT_FALLBACK = 20;
/** Terminal stand-ins for the logos. */
const GLYPH: Record<AgentKind, string> = {
  claude: "✻",
  commandcode: "⌘",
  codex: "⬡",
  opencode: "▣",
  droid: "◆",
  gemini: "✦",
  qwen: "◈",
  cursor: "◭",
  hermes: "☤",
};

interface Options {
  port: number;
  host: string;
  open: boolean;
  demo: boolean;
  seed: number;
  agents: AgentKind[];
  quiet: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  /** --ssh / --daytona / --boat / --railway / --vercel. */
  remotes: RemoteSelector[];
  /** Auto-detect sandbox platforms that have a login (--no-cloud turns it off). */
  cloud: boolean;
  /** --local-only: this machine and nothing else. */
  localOnly: boolean;
  /** Hiring and driving agents from the page (--no-control turns it off). */
  control: boolean;
  /** Started by the background service (launchd / systemd): help-hidden. */
  service: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    open: true,
    demo: false,
    seed: DEFAULT_SEED,
    agents: [...ALL_AGENTS],
    quiet: false,
    verbose: false,
    help: false,
    version: false,
    remotes: [],
    cloud: true,
    localOnly: false,
    control: true,
    service: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = (): string => {
      if (eq !== -1) return arg.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--port":
      case "-p": {
        const v = value();
        const n = Number(v);
        if (!/^\d+$/.test(v) || n > 65535) throw new UsageError(`--port must be 0-65535, got "${v}"`);
        o.port = n;
        break;
      }
      case "--host":
        o.host = value().trim();
        if (!o.host) throw new UsageError("--host needs a value");
        break;
      case "--agents":
      case "--agent": {
        const names = value().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (names.includes("all")) {
          o.agents = [...ALL_AGENTS];
          break;
        }
        const picked = new Set<AgentKind>();
        for (const n of names) {
          const a = parseAgentKind(n);
          if (!a) throw new UsageError(`unknown agent "${n}" (expected ${ALL_AGENTS.join(", ")})`);
          picked.add(a);
        }
        if (!picked.size) throw new UsageError("--agents needs at least one agent");
        o.agents = ALL_AGENTS.filter((a) => picked.has(a));
        break;
      }
      case "--seed": {
        const v = value();
        if (!/^-?\d+$/.test(v)) throw new UsageError(`--seed must be an integer, got "${v}"`);
        o.seed = Number(v);
        break;
      }
      case "--demo":
        o.demo = true;
        break;
      case "--no-open":
        o.open = false;
        break;
      case "--open":
        o.open = true;
        break;
      case "--quiet":
      case "-q":
        o.quiet = true;
        break;
      case "--verbose":
        o.verbose = true;
        break;
      case "--help":
      case "-h":
        o.help = true;
        break;
      case "--version":
      case "-v":
        o.version = true;
        break;
      case "--ssh": {
        const v = value().trim();
        if (!v || v === "all") throw new UsageError("--ssh needs a host (user@host or an ~/.ssh/config alias)");
        o.remotes.push({ kind: "ssh", id: v });
        break;
      }
      case "--daytona":
      case "--boat":
      case "--railway":
      case "--vercel": {
        // The value is optional: `--daytona` alone means every running sandbox.
        const next = argv[i + 1];
        const v = eq !== -1 ? arg.slice(eq + 1).trim() : next !== undefined && !next.startsWith("-") ? argv[++i]!.trim() : "all";
        o.remotes.push({ kind: flag.slice(2) as RemoteSelector["kind"], id: v || "all" });
        break;
      }
      case "--no-cloud":
        o.cloud = false;
        break;
      case "--local-only":
        o.localOnly = true;
        break;
      case "--no-control":
        o.control = false;
        break;
      case "--service":
        o.service = true;
        o.open = false;
        o.quiet = true;
        break;
      default:
        throw new UsageError(arg.startsWith("-") ? `unknown option ${flag}` : `unexpected argument "${arg}"`);
    }
  }
  return o;
}

/* ---------- terminal styling ---------- */

const env = process.env;
const COLOR =
  !(env.NO_COLOR !== undefined && env.NO_COLOR !== "") &&
  env.TERM !== "dumb" &&
  (Boolean(process.stdout.isTTY) || (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0"));
const TRUECOLOR = COLOR && (/truecolor|24bit/i.test(env.COLORTERM ?? "") || /iTerm|WezTerm|ghostty|vscode/i.test(env.TERM_PROGRAM ?? ""));

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const sgr = (open: string, close: string) => (s: string) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : s);
const bold = sgr("1", "22");
const dim = sgr("2", "22");
const underline = sgr("4", "24");
const yellow = sgr("33", "39");
const red = sgr("31", "39");
const green = sgr("32", "39");

function rgb([r, g, b]: Rgb): (s: string) => string {
  if (!COLOR) return (s) => s;
  if (TRUECOLOR) return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
  const q = (v: number) => Math.round((v / 255) * 5);
  return (s) => `\x1b[38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m${s}\x1b[39m`;
}
const brand = (a: AgentKind) => rgb(hex(a === "commandcode" ? "#F2F2F2" : BRAND[a].color));

/** Claude orange -> Command Code white -> Codex green, across the title. */
function gradient(t: number): Rgb {
  const stops = [hex(BRAND.claude.color), hex("#F2F2F2"), hex(BRAND.codex.color)];
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  return stops[i]!.map((v, k) => Math.round(v + (stops[i + 1]![k]! - v) * f)) as Rgb;
}

const TITLE = [
  "▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀   █▀█ █▀▀ █▀▀ █ █▀▀ █▀▀",
  "█▀█ █▄█ ██▄ █ ▀█  █    █▄█ █▀  █▀  █ █▄▄ ██▄",
];

function title(version: string): string[] {
  const width = [...TITLE[0]!].length;
  if ((process.stdout.columns ?? 80) < width + 14) {
    return [`${bold(rgb(hex(BRAND.claude.color))("agent office"))} ${dim(`v${version}`)}`];
  }
  return TITLE.map((row, r) => {
    const painted = COLOR ? [...row].map((ch, i) => (ch === " " ? ch : rgb(gradient(i / (width - 1)))(ch))).join("") : row;
    return r === 1 ? `${painted}  ${dim(`v${version}`)}` : painted;
  });
}

const out = (line = "") => process.stdout.write(`${line}\n`);
const PAD = "  ";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The banner's Controls line: never the unlock link itself, which must not end up in a recording. "headless": no browser can open here. */
type ControlsLine = "opened" | "locked" | "headless" | "off" | "demo";

function banner(o: Options, server: OfficeServer, state: OfficeState, version: string, remotes?: Remotes, controls: ControlsLine = "off"): void {
  const label = (s: string) => dim(s.padEnd(10));
  out();
  for (const line of title(version)) out(PAD + line);
  out();
  const portNote = server.port !== o.port && o.port !== 0 ? dim(`  (${o.port} was taken)`) : "";
  out(`${PAD}${green("➜")}  ${label("Office")}${bold(underline(server.url))}${portNote}`);

  const everyone = state.sessions();
  const sessions = everyone.filter((s) => !s.host); // remotes get their own line
  if (o.demo) {
    out(`${PAD}   ${label("Mode")}${rgb(hex(BRAND.claude.color))("demo")} ${dim("·")} seed ${o.seed} ${dim("·")} ${dim("plays from the top each time the page opens")}`);
  }
  const cols = Math.max(60, process.stdout.columns ?? 100);
  const rows: string[][] = [[]];
  let width = 0;
  for (const a of o.agents) {
    const w = BRAND[a].name.length + 5;
    if (width && 15 + width + w > cols) rows.push([]), (width = 0);
    rows[rows.length - 1]!.push(`${brand(a)(GLYPH[a])} ${BRAND[a].name}`);
    width += w;
  }
  rows.forEach((r, i) => out(`${PAD}   ${label(i ? "" : o.demo ? "Cast" : "Watching")}${r.join(dim("   "))}`));
  if (!o.demo) {
    const per = o.agents
      .map((a) => [a, sessions.filter((s) => s.agent === a).length] as const)
      .filter(([, n]) => n > 0)
      .map(([a, n]) => `${brand(a)(GLYPH[a])} ${n}`)
      .join("  ");
    const live = sessions.length
      ? `${bold(plural(sessions.length, "live session"))}  ${per}`
      : `${dim("no live sessions yet. Start an agent and it walks in.")}`;
    out(`${PAD}   ${label("Live")}${live}`);
  }
  const self = selfCommand();
  if (controls === "opened") out(`${PAD}   ${label("Controls")}unlocked in the browser it opened ${dim("·")} ${dim(`${self} open for another`)}`);
  else if (controls === "locked") out(`${PAD}   ${label("Controls")}locked ${dim("·")} ${dim(`${self} open unlocks a browser`)}`);
  else if (controls === "headless") out(`${PAD}   ${label("Controls")}locked ${dim("·")} ${dim(`no browser to open here: ${self} open --print gives a link for yours`)}`);
  else if (controls === "off" && !o.service) {
    const why = !o.control ? "off (--no-control): watch-only" : controlSupported() ? "off: watch-only (only on 127.0.0.1, macOS and Linux)" : "off: watch-only (hiring from the page needs macOS or Linux)";
    out(`${PAD}   ${label("Controls")}${dim(why)}`);
  }
  if (remotes) {
    const { watching, problems } = remotes.summary();
    if (watching.length) out(`${PAD}   ${label("Remotes")}${watching.join(dim(" · "))}`);
    for (const p of problems) out(`${PAD}   ${label("")}${dim(`⚠ ${p}`)}`);
    if (o.remotes.some((r) => r.kind === "boat")) {
      out(`${PAD}   ${label("")}${yellow("⚠")} ${dim("boat keeps every exec's output for 90 days; the office's reads of transcripts land there too.")}`);
    }
  }

  if (isWildcard(o.host)) {
    out();
    out(`${PAD}${red(bold("⚠"))}  ${red(bold(`Listening on every network interface (${o.host}).`))}`);
    out(`${PAD}   ${red("Anyone who can reach this machine can watch your agents work.")}`);
  } else if (!isLoopback(o.host)) {
    out();
    out(`${PAD}${yellow("⚠")}  ${yellow(`Listening on ${o.host}: visible to that network, not just this machine.`)}`);
  }
  out();
  out(`${PAD}   ${dim("Ctrl+C to close")}`);
  out();
}

/** A line per arrival, departure and table flip, so the terminal tells the story too. */
function logEvent(e: OfficeEvent): void {
  // A transcript taking over a hired or just-launched worker's desk isn't a second arrival.
  if (e.parentId || e.replaces) return;
  const time = dim(new Date().toTimeString().slice(0, 5));
  const who = `${brand(e.agent)(GLYPH[e.agent])} ${e.project}${e.host ? dim(` @ ${e.host.name}`) : ""}`;
  if (e.kind === "session_start") out(`${PAD}${time}  ${who} ${dim("walked in")}`);
  else if (e.kind === "session_end") out(`${PAD}${time}  ${who} ${dim("went home")}`);
  else if (e.kind === "test_fail") out(`${PAD}${time}  ${who} ${red("(╯°□°)╯︵ ┻━┻")} ${dim(e.summary ?? "tests failed")}`);
}

/* ---------- process plumbing ---------- */

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (pkg && (pkg.name === "theagentoffice" || pkg.name === "agentoffice") && typeof pkg.version === "string") return pkg.version;
  } catch {
    // Fall through: running from somewhere without the package.json beside it.
  }
  return "0.0.0-dev";
}

/** Resolve once the watcher's backfill has gone quiet (or after `max` ms). */
function settle(state: OfficeState, quietMs = 150, max = 1_200): Promise<void> {
  return new Promise((done) => {
    let last = Date.now();
    const off = state.subscribe(() => (last = Date.now()));
    const start = Date.now();
    const check = setInterval(() => {
      const now = Date.now();
      if (now - last >= quietMs || now - start >= max) {
        clearInterval(check);
        off();
        done();
      }
    }, 25);
  });
}

function help(version: string): string {
  return `
${bold("agent office")} ${dim(`v${version}`)}  a live pixel-art office for your coding agents

${bold("Usage")}
  npx theagentoffice [office] [options]     open the office (the default command)
  npx theagentoffice <command> [options]    install | uninstall | doctor | mcp | open

${bold("Office options")}
  --port <n>, -p    Port to serve on (default ${DEFAULT_PORT}; tries the next ${PORT_FALLBACK} if taken)
  --host <addr>     Interface to bind (default ${DEFAULT_HOST}; anything else is visible on that network)
  --agents <list>   Who to watch (default all): ${ALL_AGENTS.join(",")}
  --demo            A simulated office; reads no transcripts
  --seed <n>        Demo seed, for reproducible recordings (default ${DEFAULT_SEED})
  --no-open         Don't open the browser (also skipped when BROWSER=none or CI is set)
  -q, --quiet       Print the banner only, no arrivals or table flips
  --verbose         Log what the transcript watcher and remotes are doing
  -h, --help        Show this help
  -v, --version     Print the version

${bold("Remotes")}  agents in sandboxes and on other machines, in the same office
  --ssh <host>      Watch a box you can ssh into (repeatable; alias, user@host or ssh://user@host:port)
  --daytona [id]    Daytona sandboxes: every running one the login can see, or one id/name
  --railway [id]    Railway sandboxes: every workspace's, or one id
  --vercel [name]   Vercel Sandboxes in every team (e.g. the ones \`npx sandbox@latest sh\` creates)
  --boat [id]       boat VMs (never auto-detected: boat keeps every command's output for 90 days)
  --no-cloud        Don't auto-detect sandbox platforms you're logged in to
  --local-only      Only this machine (ignores the flags above and config.json)
  --no-control      Watch-only: no hiring or driving agents from the page
  Without flags, platforms you're logged in to are watched in your own scope only: Daytona's
  personal organization, Railway's linked project, the office's own project and sandboxes, the sandboxes your railway CLI made,
  Vercel's default team. Nothing is installed on a remote: the office only reads transcripts
  there over that platform's exec. Permanent remotes go in ~/.agentoffice/config.json:
    {"remotes": [{"ssh": "me@box"}, {"vercel": "all"}], "cloud": true}

${bold("Commands")}
  office            The office itself (what runs when you give no command)
  install           Give every coding agent the office tools (MCP server + skill)
  uninstall         Take exactly that back out, restoring each file
  doctor            Which agents have the tools, and whether the office is running
  mcp               The MCP server itself, on stdio (agents launch this)
  open              Unlock the running office's controls in a browser (--print, --rotate)
  install --service Run the office in the background from login; uninstall --service removes it
  Run ${bold(`${selfCommand()} <command> --help`)} for a command's flags (--dry-run, --agents, --ssh, --vercel, ...).

${bold("Environment")}
  AGENT_OFFICE_HOME   Where office.json and agent signals live (default ~/.agentoffice)
  CLAUDE_CONFIG_DIR, CODEX_HOME and AGENT_OFFICE_<AGENT>_DIR point at non-default transcript folders
`;
}

async function main(): Promise<void> {
  process.stdout.on("error", () => {}); // EPIPE when piped into head
  const version = readVersion();
  // `agentoffice mcp | install | uninstall | doctor` live in src/install.
  const sub = process.argv[2];
  for (const kind of REMOTE_KINDS) registerRemoteFactory(kind, REMOTE_FACTORIES[kind]);
  registerRemoteDetector(() =>
    defaultProviders()
      .map((p) => [p, p.available()] as const)
      .filter(([, a]) => a.ok)
      .map(([p, a]) => `${a.via ? `${p.label} (${a.via})` : p.label}${p.autoDetect === false ? ` (only with --${p.kind})` : ""}`),
  );
  if (sub && SUBCOMMANDS.has(sub)) {
    process.exitCode = await runSubcommand(sub, process.argv.slice(3), version);
    return;
  }
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(sub === "office" ? 3 : 2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`agentoffice: ${err.message}\nRun ${selfCommand()} --help for usage.\n`);
    process.exit(2);
  }
  if (o.help) return void out(help(version));
  if (o.version) return void out(version);

  // The service starts with launchd's or systemd's bare environment: take a terminal's first, so
  // transcript roots, provider logins and hired agents see what they would in a terminal.
  const serviceLog = o.service ? serviceLogger(officeHome()) : undefined;
  if (o.service && !(await adoptLoginEnv())) serviceLog?.("couldn't read the login shell's environment; running with the unit's PATH", "warn");
  const controlOn = o.control && !o.demo && isLoopback(o.host) && controlSupported();

  const state = new OfficeState({ demo: o.demo });
  const onEvent = (e: Parameters<typeof state.ingest>[0]) => state.ingest(e);
  let source: { stop(): void } = { stop() {} };
  let demo: ReturnType<typeof startDemo> | undefined;
  if (o.demo) {
    // The demo plays from the top for each new viewer, so every recording opens on the arrivals.
    demo = startDemo({ onEvent, seed: o.seed, agents: o.agents, paused: true });
    source = demo;
  } else {
    try {
      source = startIngest({
        agents: o.agents,
        onEvent,
        log: o.verbose ? (msg) => process.stderr.write(`${PAD}${dim(msg)}\n`) : () => {},
      });
    } catch (err) {
      process.stderr.write(`${PAD}${yellow("⚠")}  Could not start the transcript watcher: ${(err as Error).message}\n`);
    }
  }
  // With controls on, a remotes manager exists even with nothing to watch yet: sessions hired into
  // a sandbox or onto an ssh box are watched through it.
  // One hourly Railway API budget for the watcher and the control plane's own Railway calls.
  const railwayBudget = new RailwayBudget();
  const remotes = o.demo || o.localOnly ? undefined : watchRemotes(o, onEvent, controlOn, railwayBudget, (id) => state.has(id));
  if (remotes) {
    const local = source;
    source = { stop: () => (local.stop(), remotes.stop()) };
    // A client that connects late learns which remotes are down from the snapshot (Snapshot.hosts).
    const snapshot = state.snapshot.bind(state);
    state.snapshot = () => ({ ...snapshot(), hosts: remotes.hosts() });
  }
  state.start();

  // Agents' MCP servers trust only an office that can prove it knows this (see src/mcp/office.ts).
  const secret = newOfficeSecret();
  const userHome = homedir();
  const linker = o.demo ? undefined : createLinker(state, userHome);
  const svc = serviceDeps(version);
  let server!: OfficeServer;
  let plane: Plane;
  const time = () => dim(new Date().toTimeString().slice(0, 5));
  const log = (msg: string, level?: "info" | "warn") => {
    if (serviceLog) return serviceLog(msg, level);
    if (!o.quiet || level === "warn") out(`${PAD}${time()}  ${level === "warn" ? yellow("⚠") : dim("·")} ${dim(msg)}`);
  };
  const service: ServiceControl = {
    status: () => serviceStatus(svc, o.service),
    async set(startAtLogin) {
      const st = serviceStatus(svc, o.service);
      if (st.installed) return { ...(await setStartAtLogin(svc, startAtLogin)), running: st.running };
      if (!startAtLogin) return st;
      // A foreground office installing the service: hand over now unless agents are running here.
      const live = plane.liveSessions();
      const installed = await installService(svc, { start: false, port: server.port, path: await loginPath() });
      if (live > 0) {
        log(`installed the background service; it starts at the next login (${live} agent${live === 1 ? "" : "s"} still run here)`);
        return { ...installed, running: false };
      }
      setTimeout(() => void handOver(), 250).unref?.();
      return { ...installed, running: true };
    },
  };
  plane = createControlPlane({
    state,
    enabled: controlOn,
    version,
    host: o.host,
    officeUrl: () => `http://127.0.0.1:${server.port}`,
    userHome,
    log,
    linker,
    pty: () => loadPty(),
    places: o.localOnly ? undefined : (ctx) => createPlaces(ctx, { railwayBudget }),
    sessions: (ctx, places) => createSessionManager(ctx, places ?? undefined),
    watch: remotes ? (t) => remotes.watch(t) : undefined,
    service,
    // Under the service, agents register the stable app/current path, never the versioned one an upgrade prunes.
    installer: createInstallApi({ version, script: o.service ? join(appCurrent(svc.home) ?? join(svc.home, "app", "current"), "dist", "cli.js") : undefined }),
  });

  const serve = async (port: number) => {
    const onViewer = demo
      ? (first: boolean) => {
          if (!first) return;
          state.reset();
          demo!.restart();
        }
      : undefined;
    return startServer({ state, host: o.host, port, portFallback: port === o.port ? PORT_FALLBACK : 0, secret, onViewer, control: plane });
  };
  try {
    server = await serve(o.port);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const why =
      e.code === "EADDRINUSE"
        ? `ports ${o.port}-${o.port + PORT_FALLBACK} are all in use. Try --port <n>.`
        : e.code === "EACCES"
          ? `no permission to listen on ${o.host}:${o.port}.`
          : e.code === "EADDRNOTAVAIL" || e.code === "ENOTFOUND"
            ? `${o.host} is not an address on this machine.`
            : e.message;
    process.stderr.write(`agentoffice: ${why}\n`);
    source.stop();
    process.exit(1);
  }

  // Lets the MCP server inside each agent find this office on a non-default port.
  const advertised = advertise(o, server, version, secret, controlOn);
  if (!o.demo) await settle(state);
  if (remotes) await remotes.ready;
  state.tick();
  // Agents started in a terminal walk in at launch and leave when they quit (src/control/presence.ts).
  const presence = o.demo || !linker
    ? undefined
    : startPresence({
        state,
        office: plane.office ?? createOfficePort(state, linker, { home: userHome }),
        scan: () => scanProcesses(),
        ownedPids: () => plane.ownedPids(),
        startedAt: Date.parse(state.startedAt),
        home: userHome,
        agents: o.agents,
        // Read per scan: the service adopts the login shell's environment after it starts.
        sessionOf: (agent, pid, startedAt) => (agent === "claude" ? claudeSessionOf(env.CLAUDE_CONFIG_DIR?.trim() || join(userHome, ".claude"), pid, startedAt) : undefined),
      });
  const wantsBrowser = o.open && env.BROWSER !== "none" && !env.CI;
  const opening = wantsBrowser && canOpenBrowser(env);
  const controls: ControlsLine = o.demo ? "demo" : !plane.enabled ? "off" : opening ? "opened" : wantsBrowser ? "headless" : "locked";
  banner(o, server, state, version, remotes, controls);
  if (o.service) serviceLog?.(`office running at ${server.url} (service)`);
  if (!o.quiet) state.subscribe(logEvent);
  // The unlock code goes to the browser only, never into the banner.
  if (opening) {
    void openBrowser(plane.enabled && plane.auth ? `${server.url}/unlock?t=${plane.auth.mintCode()}` : server.url).then((ok) => {
      if (!ok) log(plane.enabled ? `couldn't open a browser; ${selfCommand()} open --print gives an unlock link` : `couldn't open a browser; open ${server.url} in yours`, "warn");
    });
  }

  /** Foreground office -> the background service on the same port; back to serving if it doesn't come up. */
  async function handOver(): Promise<void> {
    log("handing over to the background service");
    const port = server.port;
    await Promise.race([server.close(), new Promise((r) => setTimeout(r, 1_500))]);
    try {
      await startService(svc);
      if ((await waitForOffice(10_000, { service: true, notPid: process.pid })) !== null) {
        log("the background service has the office now; this one is closing");
        presence?.stop();
        source.stop();
        state.stop();
        process.exit(0);
      }
      log("the background service didn't answer within 10 seconds; this office keeps serving", "warn");
    } catch (err) {
      log(`couldn't start the background service: ${(err as Error).message}`, "warn");
    }
    server = await serve(port);
    advertise(o, server, version, secret, controlOn);
    plane.info({ service: service.status() });
  }

  let closing = false;
  // Another office on this home (a terminal one next to the service) took office.json and has quit since:
  // take it back, so `agentoffice open` and the agents' MCP tools find this one again.
  const readvertise = advertised
    ? setInterval(() => {
        if (closing) return;
        try {
          const cur = JSON.parse(readFileSync(officeFilePath(), "utf8")) as Partial<OfficeFile>;
          if (cur.pid === process.pid || (typeof cur.pid === "number" && pidAlive(cur.pid))) return;
        } catch {
          // Missing or unreadable: ours to write.
        }
        advertise(o, server, version, secret, controlOn);
      }, 5_000)
    : undefined;
  readvertise?.unref?.();
  const shutdown = async () => {
    if (closing) process.exit(0);
    closing = true;
    clearInterval(readvertise);
    if (!o.service) out(`\n${PAD}${dim("Closing the office. Bye.")}`);
    serviceLog?.("office closing");
    // Agents first: their workers walk out while the stream is still up.
    await Promise.race([plane.shutdown(), new Promise((r) => setTimeout(r, 4_000))]);
    if (advertised) clearOfficeFile();
    presence?.stop();
    source.stop();
    state.stop();
    await Promise.race([server.close(), new Promise((r) => setTimeout(r, 1_500))]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
}

let exitHooked = false;

/** Write $AGENT_OFFICE_HOME/office.json. A demo never displaces a real office that is still running. */
function advertise(o: Options, server: OfficeServer, version: string, secret: string, control: boolean): boolean {
  if (o.demo) {
    try {
      const cur = JSON.parse(readFileSync(officeFilePath(), "utf8")) as Partial<OfficeFile>;
      if (!cur.demo && typeof cur.pid === "number" && cur.pid !== process.pid && pidAlive(cur.pid)) return false;
    } catch {
      // No file yet.
    }
  }
  writeOfficeFile({
    pid: process.pid,
    port: server.port,
    host: o.host,
    url: server.url,
    startedAt: new Date().toISOString(),
    version,
    demo: o.demo,
    secret,
    ...(o.service ? { service: true } : {}),
    control,
  });
  if (!exitHooked) process.on("exit", () => clearOfficeFile());
  exitHooked = true;
  return true;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remotes from flags, config.json and logged-in sandbox platforms; a broken one never stops the office. */
function watchRemotes(
  o: Options,
  onEvent: (e: Parameters<OfficeState["ingest"]>[0]) => void,
  always = false,
  railwayBudget?: RailwayBudget,
  inOffice?: (workerId: string) => boolean,
): Remotes | undefined {
  const cfg = readRemoteConfig();
  for (const p of cfg.problems) process.stderr.write(`${PAD}${yellow("⚠")}  ${p}\n`);
  const selectors = mergeSelectors(o.remotes, cfg.selectors);
  const autoDetect = o.cloud && cfg.cloud !== false;
  if (!selectors.length && !autoDetect && !always) return undefined;
  const time = () => dim(new Date().toTimeString().slice(0, 5));
  try {
    return startRemotes({
      inOffice,
      agents: o.agents,
      selectors,
      autoDetect,
      railwayBudget,
      onEvent,
      log: (msg, level) => {
        if (!o.quiet) out(`${PAD}${time()}  ${level === "warn" ? yellow("⚠") : dim("·")} ${dim(msg)}`);
      },
      debug: o.verbose ? (msg) => process.stderr.write(`${PAD}${dim(msg)}\n`) : undefined,
    });
  } catch (err) {
    process.stderr.write(`${PAD}${yellow("⚠")}  Could not start watching remotes: ${(err as Error).message}\n`);
    return undefined;
  }
}

main().catch((err) => {
  process.stderr.write(`agentoffice: ${(err as Error)?.stack ?? err}\n`);
  process.exit(1);
});

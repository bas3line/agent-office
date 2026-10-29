/*
 * install / uninstall / doctor on one machine (a Sys: this laptop or a
 * sandbox). Each run is plan, print, confirm, apply, verify:
 *  - the plan is computed in full before anything is touched, and --dry-run
 *    prints it with the exact diff of every file that would change;
 *  - every existing file gets a timestamped backup next to it before its
 *    first edit; edits are atomic and keep the file's formatting;
 *  - a CLI route (claude/codex mcp add) is verified by reading the config
 *    back, and falls back to editing the file if the CLI didn't stick;
 *  - what we created (files, containers, skill folders) is recorded in
 *    $AGENT_OFFICE_HOME/installed.json, so uninstall can put things back the
 *    way they were rather than leaving empty husks.
 * Re-running install is a no-op once everything is in place.
 */
import type { AgentKind } from "../shared/events.ts";
import { BRAND } from "../shared/events.ts";
import { ADAPTERS, detect, pathFor, tilde, type Adapter, type Detection, type FileEdit, type McpPlan, type McpState } from "./agents.ts";
import { display, launchFor, type Launch, type LaunchCommand } from "./command.ts";
import { diffHunk } from "./diff.ts";
import { nodeAt, parseJsonc } from "./jsonc.ts";
import { SKILL_NAME, SKILL_TEXT, isOurSkill } from "./skill.ts";
import type { Sys } from "./sys.ts";
import { PAD, agentLabel, bold, cyan, dim, green, pad, red, visible, yellow } from "./ui.ts";

export type Out = (line?: string) => void;

export interface RunOptions {
  /** Only these agents; default: every agent detected on the machine. */
  agents?: AgentKind[];
  dryRun?: boolean;
  yes?: boolean;
  /** Skip the MCP registration or the skill. */
  mcp?: boolean;
  skill?: boolean;
  launch: Launch;
  out: Out;
  /** Ask before applying; resolves true to go ahead. Absent: non-interactive, needs --yes. */
  confirm?: (question: string) => Promise<boolean>;
  /** Clock, for backup names in tests. */
  now?: () => Date;
  /** Handed the plan, one row per agent, once it is computed (the office page's install view). */
  report?: (rows: PlanRow[]) => void;
}

/** One agent's line of an install plan, as the office page shows it (src/shared/control.ts InstallPlan). */
export interface PlanRow {
  agent: AgentKind;
  found: boolean;
  mcp: "add" | "update" | "ok" | "skip";
  skill: "add" | "update" | "ok" | "skip";
  /** Files it would touch, as ~ paths. */
  files: string[];
  /** The same masked diff `--dry-run` prints. */
  diff?: string;
  /** Why something is skipped (a config that doesn't parse, someone else's skill). */
  error?: string;
}

/* ------------------------------------------------------------- manifest */

interface ManifestEntry {
  at: string;
  mcpFile?: string;
  createdFile?: boolean;
  createdContainer?: boolean;
  skillFile?: string;
  /** Folders install created for the skill, deepest first (~/.agents/skills, ~/.agents). */
  createdSkillDirs?: string[];
}

interface Manifest {
  v: 1;
  agents: Partial<Record<AgentKind, ManifestEntry>>;
}

export function officeHomeOn(sys: Sys): string {
  return sys.env("AGENT_OFFICE_HOME") || pathFor(sys).join(sys.home, ".agentoffice");
}

const manifestPath = (sys: Sys) => pathFor(sys).join(officeHomeOn(sys), "installed.json");

async function readManifest(sys: Sys): Promise<Manifest> {
  try {
    const m = JSON.parse((await sys.read(manifestPath(sys))) ?? "");
    if (m && m.v === 1 && m.agents && typeof m.agents === "object") return m as Manifest;
  } catch {
    // Missing or damaged: start fresh. Uninstall still works without it, just less tidily.
  }
  return { v: 1, agents: {} };
}

async function writeManifest(sys: Sys, m: Manifest): Promise<void> {
  if (!Object.keys(m.agents).length) {
    await sys.remove(manifestPath(sys));
    return;
  }
  await sys.write(manifestPath(sys), JSON.stringify(m, null, 2) + "\n", 0o600);
}

/* ---------------------------------------------------------------- plans */

interface SkillPlan {
  root: string;
  dir: string;
  file: string;
  before: string | null;
  after: string | null;
  /** A skill called agent-office that isn't ours: never touched. */
  conflict?: boolean;
  /** Folders above the skill's own that don't exist yet, deepest first. */
  createdDirs: string[];
}

interface AgentPlan {
  adapter: Adapter;
  detection: Detection;
  cmd?: LaunchCommand;
  useCli: boolean;
  mcp?: McpPlan;
  mcpBefore?: McpState;
  skill?: SkillPlan;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backup(sys: Sys, file: string, now: Date): Promise<string> {
  return sys.backup(file, `${file}.agentoffice-backup-${stamp(now)}`);
}

async function applyEdit(sys: Sys, e: FileEdit, now: Date, backups: string[]): Promise<void> {
  if (e.before != null && (await sys.exists(e.file))) backups.push(await backup(sys, e.file, now));
  if (e.after == null) await sys.remove(e.file);
  else await sys.write(e.file, e.after, e.file.endsWith(".json") || e.file.endsWith(".jsonc") || e.file.endsWith(".toml") ? 0o600 : 0o644);
}

const sameCmd = (a: LaunchCommand | undefined, b: LaunchCommand) =>
  !!a && a.command === b.command && a.args.length === b.args.length && a.args.every((x, k) => x === b.args[k]);

function allPaths(sys: Sys, adapters: Adapter[]): string[] {
  const P = pathFor(sys);
  return [
    manifestPath(sys),
    ...adapters.flatMap((a) => [...a.files(sys), P.join(a.skillRoot(sys), SKILL_NAME, "SKILL.md")]),
  ];
}

/** Folders detection and skill planning ask about, so a remote answers them in the same round trip. */
function allDirs(sys: Sys, adapters: Adapter[]): string[] {
  const P = pathFor(sys);
  const out = new Set<string>();
  for (const a of adapters) {
    for (const d of a.dirs(sys)) out.add(d);
    for (let d = a.skillRoot(sys); d !== sys.home && d !== P.dirname(d); d = P.dirname(d)) out.add(d);
  }
  return [...out];
}

async function skillPlan(sys: Sys, a: Adapter, install: boolean): Promise<SkillPlan> {
  const P = pathFor(sys);
  const root = a.skillRoot(sys);
  const dir = P.join(root, SKILL_NAME);
  const file = P.join(dir, "SKILL.md");
  const before = await sys.read(file);
  const createdDirs: string[] = [];
  if (install) {
    for (let d = root; d !== sys.home && d !== P.dirname(d) && !(await sys.exists(d)); d = P.dirname(d)) createdDirs.push(d);
  }
  if (before != null && !isOurSkill(before)) return { root, dir, file, before, after: before, conflict: true, createdDirs };
  return { root, dir, file, before, after: install ? SKILL_TEXT : null, createdDirs };
}

function selectAgents(opts: RunOptions, detections: Map<AgentKind, Detection>, out: Out, also?: (a: Adapter) => boolean): Adapter[] {
  if (opts.agents?.length) {
    const picked: Adapter[] = [];
    for (const id of opts.agents) {
      const a = ADAPTERS.find((x) => x.id === id);
      if (!a) continue;
      if (detections.get(id)!.installed || also?.(a)) picked.push(a);
      else {
        const why = [...a.bins.map((b) => `no ${b} on PATH`)].slice(0, 1).join(", ");
        out(`${PAD}${dim("·")} ${agentLabel(id)} ${dim(`isn't installed here (${why}, no config folder); skipped`)}`);
      }
    }
    return picked;
  }
  return ADAPTERS.filter((a) => detections.get(a.id)!.installed || also?.(a));
}

function printDiffs(sys: Sys, edits: FileEdit[], out: Out): void {
  for (const e of edits) {
    if (e.file.endsWith("SKILL.md")) {
      // The same file for every agent; one line each instead of the whole thing eight times.
      const what = e.after == null ? red("delete") : e.before == null ? green("new file") : yellow("update");
      out(`${PAD}${bold(tilde(sys, e.file))} ${dim("(")}${what}${dim(`: the agent-office skill, ${(e.after ?? e.before ?? "").split("\n").length} lines)`)}`);
      continue;
    }
    const h = diffHunk(e.before, e.after);
    if (!h) continue;
    const verb = e.before == null ? "new file" : e.after == null ? "delete" : `line ${h.line}`;
    out(`${PAD}${bold(tilde(sys, e.file))} ${dim(`(${verb})`)}`);
    const shown = h.lines.length > 40 ? [...h.lines.slice(0, 36), { op: " " as const, text: `… ${h.lines.length - 36} more lines` }] : h.lines;
    for (const l of shown) {
      const text = `${PAD}  ${l.op} ${l.text}`;
      out(l.op === "+" ? green(text) : l.op === "-" ? red(text) : dim(text));
    }
    out();
  }
}

function header(sys: Sys, verb: string, opts: RunOptions): void {
  const out = opts.out;
  out();
  out(`${PAD}${bold("agent office")} ${dim("·")} ${verb}${sys.remote ? ` ${dim("on")} ${cyan(sys.where)}` : ""}${opts.dryRun ? `  ${yellow("(dry run: nothing will be written)")}` : ""}`);
  out();
}

async function confirmOrStop(opts: RunOptions, question: string): Promise<boolean> {
  if (opts.yes) return true;
  if (opts.confirm) return opts.confirm(question);
  opts.out(`${PAD}${yellow("Nothing written.")} Re-run with ${bold("--yes")} to apply, or ${bold("--dry-run")} to see the exact changes.`);
  return false;
}

/* -------------------------------------------------------------- install */

export async function install(sys: Sys, opts: RunOptions): Promise<number> {
  const out = opts.out;
  const now = opts.now ?? (() => new Date());
  const wantMcp = opts.mcp !== false;
  const wantSkill = opts.skill !== false;
  header(sys, "install", opts);

  await sys.prefetch(allPaths(sys, ADAPTERS), [...ADAPTERS.flatMap((a) => a.bins), "node", "npx"], allDirs(sys, ADAPTERS));

  if (opts.launch.how === "npx" && sys.remote) {
    const node = await sys.which("node");
    const npx = await sys.which("npx");
    if (!node || !npx) {
      out(`${PAD}${red("✗")} ${bold(`Node.js isn't installed on ${sys.where}`)}${node ? dim(" (node is there, npx isn't)") : ""}.`);
      out(`${PAD}  Agents there launch the office tools with ${bold("npx")}, so it needs Node 18 or newer.`);
      out(`${PAD}  Install it in the sandbox (for example ${dim("curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22")}), then run this again.`);
      return 1;
    }
    const v = await sys.run(["node", "-p", "process.versions.node"], 20_000);
    const major = Number(/^(\d+)\./.exec(v.out.trim())?.[1] ?? 0);
    if (v.code === 0 && major && major < 18) {
      out(`${PAD}${red("✗")} ${bold(`Node ${v.out.trim()} on ${sys.where} is too old`)}: the office tools need Node 18 or newer.`);
      return 1;
    }
  }

  const detections = new Map<AgentKind, Detection>();
  for (const a of ADAPTERS) detections.set(a.id, await detect(sys, a));
  const chosen = selectAgents(opts, detections, out);
  if (!chosen.length) {
    opts.report?.(planRows(sys, [], detections));
    out(`${PAD}${yellow("No supported agents found")} on ${sys.where}.`);
    out(`${PAD}${dim(`Looked for: ${ADAPTERS.map((a) => BRAND[a.id].name).join(", ")}.`)}`);
    return opts.agents?.length ? 1 : 0;
  }

  const sample = launchFor(opts.launch, "claude");
  out(`${PAD}${dim("MCP server")}  ${display({ command: sample.command, args: sample.args.slice(0, -1) })} <agent>`);
  out(`${PAD}            ${dim(`${opts.launch.how === "npx" ? "npx" : "local node"}: ${opts.launch.why}`)}`);
  out();

  const plans: AgentPlan[] = [];
  for (const a of chosen) {
    const cmd = launchFor(opts.launch, a.id);
    const useCli = !!a.cli && !!(await sys.which(a.cli));
    const p: AgentPlan = { adapter: a, detection: detections.get(a.id)!, cmd, useCli };
    if (wantMcp) {
      p.mcpBefore = await a.readMcp(sys);
      p.mcp = await a.planInstall(sys, cmd, useCli);
    }
    if (wantSkill) p.skill = await skillPlan(sys, a, true);
    plans.push(p);
  }
  opts.report?.(planRows(sys, plans, detections));

  // The plan.
  const width = Math.max(...plans.map((p) => BRAND[p.adapter.id].name.length));
  let changes = 0;
  let blocked = 0;
  for (const p of plans) {
    const rows: string[] = [];
    if (p.mcp) {
      const m = p.mcp;
      if (m.blocked) {
        blocked++;
        rows.push(`${red("✗ MCP")}    ${m.blocked}`);
      } else if (m.noop) rows.push(`${green("✓ MCP")}    ${dim("already registered")}`);
      else {
        changes++;
        const verb = p.mcpBefore?.state === "registered" ? yellow("↻ MCP") : green("+ MCP");
        const how = m.run ? `${dim("via")} ${m.run.map((r) => r.slice(0, 3).join(" ")).join(dim(" then "))}` : tilde(sys, m.edit!.file);
        rows.push(`${verb}    ${how}`);
      }
    }
    if (p.skill) {
      const s = p.skill;
      if (s.conflict) rows.push(`${yellow("! skill")}  ${tilde(sys, s.file)} ${dim("is someone else's agent-office skill; left alone")}`);
      else if (s.before === s.after) rows.push(`${green("✓ skill")}  ${dim("already installed")}`);
      else {
        changes++;
        rows.push(`${s.before == null ? green("+ skill") : yellow("↻ skill")}  ${tilde(sys, s.file)}`);
      }
    }
    rows.forEach((r, k) => out(`${PAD}${k === 0 ? agentLabel(p.adapter.id, width) : " ".repeat(width + 2)}  ${r}`));
  }
  out();

  const edits: FileEdit[] = [];
  for (const p of plans) {
    if (p.mcp?.edit && !p.mcp.noop && !p.mcp.blocked) edits.push(p.mcp.edit);
    if (p.skill && !p.skill.conflict && p.skill.before !== p.skill.after) edits.push({ file: p.skill.file, before: p.skill.before, after: p.skill.after });
  }

  if (opts.dryRun) {
    if (edits.length) {
      out(`${PAD}${bold("What would change")}`);
      out();
      for (const p of plans.filter((x) => x.mcp?.run && !x.mcp.noop)) {
        out(`${PAD}${dim("$")} ${p.mcp!.run!.map((r) => display({ command: r[0]!, args: r.slice(1) })).join(dim("  &&  "))}`);
        out(`${PAD}  ${dim(`(${p.adapter.cli} edits ${tilde(sys, p.mcp!.edit!.file)} itself; the result is the diff below)`)}`);
      }
      if (plans.some((x) => x.mcp?.run && !x.mcp.noop)) out();
      printDiffs(sys, edits, out);
    } else out(`${PAD}${green("Everything is already in place.")} Nothing to do.`);
    return blocked ? 1 : 0;
  }

  if (!changes) {
    out(`${PAD}${green("Everything is already in place.")} ${dim("Open the office with")} ${bold("npx theagentoffice")}`);
    out();
    return blocked ? 1 : 0;
  }
  if (!(await confirmOrStop(opts, `Apply ${changes} change${changes === 1 ? "" : "s"}${sys.remote ? ` on ${sys.where}` : ""}?`))) return 1;

  // Apply.
  const manifest = await readManifest(sys);
  const backups: string[] = [];
  let failed = blocked;
  for (const p of plans) {
    const notes: string[] = [];
    const entry: ManifestEntry = { ...(manifest.agents[p.adapter.id] ?? {}), at: now().toISOString() };
    if (p.mcp?.blocked) notes.push(`${yellow("MCP skipped")} ${dim("(its config doesn't parse; fix it and re-run)")}`);
    try {
      if (p.mcp && !p.mcp.noop && !p.mcp.blocked) {
        const e = p.mcp.edit!;
        if (entry.mcpFile !== e.file) {
          entry.mcpFile = e.file;
          entry.createdFile = e.before == null;
          entry.createdContainer = !!p.adapter.container && !hasContainer(e.before, p.adapter.container);
        }
        const how = await applyMcp(sys, p, now(), backups);
        notes.push(`${green("MCP")} ${dim(how)}`);
      }
    } catch (err) {
      failed++;
      notes.push(`${red("MCP failed:")} ${(err as Error).message}`);
    }
    try {
      const s = p.skill;
      if (s && !s.conflict && s.before !== s.after) {
        await sys.write(s.file, s.after!, 0o644);
        if (entry.skillFile !== s.file || !entry.createdSkillDirs) entry.createdSkillDirs = s.createdDirs;
        entry.skillFile = s.file;
        notes.push(`${green("skill")} ${dim(s.before == null ? "installed" : "updated")}`);
      }
    } catch (err) {
      failed++;
      notes.push(`${red("skill failed:")} ${(err as Error).message}`);
    }
    if (notes.length) {
      if (entry.mcpFile || entry.skillFile) manifest.agents[p.adapter.id] = entry;
      const mark = notes.some((n) => n.includes("failed")) ? red("✗") : p.mcp?.blocked ? yellow("!") : green("✓");
      out(`${PAD}${mark} ${agentLabel(p.adapter.id, width)}  ${notes.join(dim("  ·  "))}`);
    }
  }
  try {
    await writeManifest(sys, manifest);
  } catch {
    // Uninstall works without it.
  }
  if (backups.length) {
    out();
    out(`${PAD}${dim("Backups:")} ${backups.map((b) => tilde(sys, b)).join(dim(", "))}`);
  }
  out();
  if (failed) {
    const what = failed === blocked ? `${failed} config${failed === 1 ? "" : "s"} couldn't be edited safely and ${failed === 1 ? "was" : "were"} left alone.` : `${failed} step${failed === 1 ? "" : "s"} didn't work.`;
    out(`${PAD}${red(what)} ${dim("Everything else was applied; run")} ${bold("agentoffice doctor")} ${dim("to see where things stand.")}`);
  } else if (sys.remote) {
    out(`${PAD}${bold("Done.")} New agent sessions on ${sys.where} get the office tools. The office itself runs on your`);
    out(`${PAD}machine and watches the sandbox from there; agents in it can't see peers, but their status, shouts and flips show up.`);
  } else {
    out(`${PAD}${bold("Done.")} Restart running agents (or ${bold("/mcp")} in Claude Code) to pick up the office tools,`);
    out(`${PAD}then open the office: ${bold("npx theagentoffice")}`);
  }
  out();
  return failed ? 1 : 0;
}

/** The plan as rows for the page: every agent, chosen or not. */
function planRows(sys: Sys, plans: AgentPlan[], detections: Map<AgentKind, Detection>): PlanRow[] {
  return ADAPTERS.map((a): PlanRow => {
    const p = plans.find((x) => x.adapter.id === a.id);
    const found = detections.get(a.id)?.installed ?? false;
    if (!p) return { agent: a.id, found, mcp: "skip", skill: "skip", files: [] };
    const row: PlanRow = { agent: a.id, found, mcp: "skip", skill: "skip", files: [] };
    const errors: string[] = [];
    const diffs: string[] = [];
    const edits: FileEdit[] = [];
    if (p.mcp) {
      if (p.mcp.blocked) errors.push(p.mcp.blocked);
      else if (p.mcp.noop) row.mcp = "ok";
      else row.mcp = p.mcpBefore?.state === "registered" ? "update" : "add";
      if (p.mcp.edit && !p.mcp.noop && !p.mcp.blocked) edits.push(p.mcp.edit);
    }
    if (p.skill) {
      const s = p.skill;
      if (s.conflict) errors.push(`${tilde(sys, s.file)} is someone else's agent-office skill; left alone`);
      else if (s.before === s.after) row.skill = "ok";
      else {
        row.skill = s.before == null ? "add" : "update";
        edits.push({ file: s.file, before: s.before, after: s.after });
      }
    }
    for (const e of edits) {
      row.files.push(tilde(sys, e.file));
      if (e.file.endsWith("SKILL.md")) {
        diffs.push(`${tilde(sys, e.file)} (${e.before == null ? "new file" : "update"}: the agent-office skill)`);
        continue;
      }
      const h = diffHunk(e.before, e.after);
      if (!h) continue;
      diffs.push([`--- ${tilde(sys, e.file)}`, `+++ ${tilde(sys, e.file)}`, `@@ line ${h.line} @@`, ...h.lines.map((l) => `${l.op}${l.text}`)].join("\n"));
    }
    if (diffs.length) row.diff = diffs.join("\n\n");
    if (errors.length) row.error = errors.join("; ");
    return row;
  });
}

function hasContainer(text: string | null, container: string[]): boolean {
  if (!text?.trim()) return false;
  try {
    return !!nodeAt(parseJsonc(text), container);
  } catch {
    return true;
  }
}

/** Register through the agent's CLI (verified) or by editing the file. Returns how it was done. */
async function applyMcp(sys: Sys, p: AgentPlan, now: Date, backups: string[]): Promise<string> {
  const m = p.mcp!;
  const e = m.edit!;
  if (m.run) {
    if (e.before != null && (await sys.exists(e.file))) backups.push(await backup(sys, e.file, now));
    let last = "";
    for (const argv of m.run) {
      const r = await sys.run(argv, 90_000);
      last = r.out.trim().split("\n").pop() ?? "";
      // `mcp remove` of an entry the CLI can't see is fine: the add after it is what counts.
      if (r.code !== 0 && !argv.includes("remove")) break;
    }
    sys.forget(e.file);
    const st = await p.adapter.readMcp(sys);
    if (st.state === "registered" && sameCmd(st.command, p.cmd!) && st.enabled) return `registered with ${p.adapter.cli} mcp add`;
    // The CLI didn't do it (old version, different config dir...): edit the file ourselves.
    const again = await p.adapter.planInstall(sys, p.cmd!, false);
    if (again.noop) return "registered";
    if (again.blocked || !again.edit) throw new Error(again.blocked ?? `${p.adapter.cli} mcp add failed: ${last}`);
    await applyEdit(sys, again.edit, now, backups);
    return `registered in ${tilde(sys, again.edit.file)} (${p.adapter.cli} mcp add didn't take${last ? `: ${last.slice(0, 80)}` : ""})`;
  }
  await applyEdit(sys, e, now, backups);
  return `registered in ${tilde(sys, e.file)}`;
}

/* ------------------------------------------------------------ uninstall */

export async function uninstall(sys: Sys, opts: RunOptions): Promise<number> {
  const out = opts.out;
  const now = opts.now ?? (() => new Date());
  header(sys, "uninstall", opts);
  await sys.prefetch(allPaths(sys, ADAPTERS), ADAPTERS.flatMap((a) => a.bins), allDirs(sys, ADAPTERS));
  const manifest = await readManifest(sys);

  const detections = new Map<AgentKind, Detection>();
  for (const a of ADAPTERS) detections.set(a.id, await detect(sys, a));

  const plans: AgentPlan[] = [];
  const candidates = opts.agents?.length ? ADAPTERS.filter((a) => opts.agents!.includes(a.id)) : ADAPTERS;
  for (const a of candidates) {
    const m = manifest.agents[a.id];
    const useCli = !!a.cli && !!(await sys.which(a.cli));
    const p: AgentPlan = { adapter: a, detection: detections.get(a.id)!, useCli };
    if (opts.mcp !== false) {
      p.mcpBefore = await a.readMcp(sys);
      p.mcp = await a.planUninstall(sys, useCli, { dropContainer: !!m?.createdContainer, dropFile: !!m?.createdFile });
    }
    if (opts.skill !== false) p.skill = await skillPlan(sys, a, false);
    const touches = (p.mcp && !p.mcp.noop) || (p.skill && !p.skill.conflict && p.skill.before != null);
    if (touches) plans.push(p);
  }

  if (!plans.length) {
    out(`${PAD}${green("Nothing to remove.")} ${dim("No agent on")} ${sys.where} ${dim("has the office tools or skill installed.")}`);
    out();
    if (Object.keys(manifest.agents).length && !opts.dryRun && !opts.agents?.length) await writeManifest(sys, { v: 1, agents: {} }).catch(() => {});
    return 0;
  }

  const width = Math.max(...plans.map((p) => BRAND[p.adapter.id].name.length));
  const edits: FileEdit[] = [];
  let blocked = 0;
  for (const p of plans) {
    const rows: string[] = [];
    if (p.mcp?.blocked) {
      blocked++;
      rows.push(`${red("✗ MCP")}    ${p.mcp.blocked}`);
    } else if (p.mcp && !p.mcp.noop) {
      rows.push(`${red("- MCP")}    ${p.mcp.run ? `${dim("via")} ${p.mcp.run[0]!.slice(0, 3).join(" ")}` : tilde(sys, p.mcp.edit!.file)}`);
      edits.push(p.mcp.edit!);
    }
    if (p.skill && !p.skill.conflict && p.skill.before != null) {
      rows.push(`${red("- skill")}  ${tilde(sys, p.skill.file)}`);
      edits.push({ file: p.skill.file, before: p.skill.before, after: null });
    }
    rows.forEach((r, k) => out(`${PAD}${k === 0 ? agentLabel(p.adapter.id, width) : " ".repeat(width + 2)}  ${r}`));
  }
  out();

  if (opts.dryRun) {
    out(`${PAD}${bold("What would change")}`);
    out();
    printDiffs(sys, edits, out);
    out();
    return blocked ? 1 : 0;
  }
  if (!(await confirmOrStop(opts, `Remove agent office from ${plans.length} agent${plans.length === 1 ? "" : "s"}?`))) return 1;

  const backups: string[] = [];
  let failed = blocked;
  for (const p of plans) {
    const notes: string[] = [];
    const m = manifest.agents[p.adapter.id];
    try {
      if (p.mcp && !p.mcp.noop && !p.mcp.blocked) {
        const e = p.mcp.edit!;
        if (p.mcp.run) {
          if (await sys.exists(e.file)) backups.push(await backup(sys, e.file, now()));
          for (const argv of p.mcp.run) await sys.run(argv, 90_000);
          sys.forget(e.file);
          const st = await p.adapter.readMcp(sys);
          if (st.state !== "missing") {
            const again = await p.adapter.planUninstall(sys, false, { dropContainer: !!m?.createdContainer, dropFile: !!m?.createdFile });
            if (again.blocked) throw new Error(again.blocked);
            if (again.edit) await applyEdit(sys, again.edit, now(), backups);
          }
        } else await applyEdit(sys, e, now(), backups);
        notes.push(`${green("MCP")} ${dim("removed")}`);
      }
    } catch (err) {
      failed++;
      notes.push(`${red("MCP failed:")} ${(err as Error).message}`);
    }
    try {
      const s = p.skill;
      if (s && !s.conflict && s.before != null) {
        // Our folder, then any folders install created on the way (~/.agents/skills, ~/.agents), while empty.
        await sys.prune(s.file, [s.dir, ...(m?.skillFile === s.file ? (m.createdSkillDirs ?? []) : [])]);
        notes.push(`${green("skill")} ${dim("removed")}`);
      }
    } catch (err) {
      failed++;
      notes.push(`${red("skill failed:")} ${(err as Error).message}`);
    }
    if (!notes.some((n) => n.includes("failed"))) delete manifest.agents[p.adapter.id];
    out(`${PAD}${notes.some((n) => n.includes("failed")) ? red("✗") : green("✓")} ${agentLabel(p.adapter.id, width)}  ${notes.join(dim("  ·  "))}`);
  }
  try {
    await writeManifest(sys, manifest);
  } catch {
    // Not important.
  }
  if (backups.length) {
    out();
    out(`${PAD}${dim("Backups:")} ${backups.map((b) => tilde(sys, b)).join(dim(", "))}`);
  }
  out();
  return failed ? 1 : 0;
}

/* --------------------------------------------------------------- doctor */

export interface DoctorRow {
  agent: AgentKind;
  installed: boolean;
  evidence: string[];
  mcp: "registered" | "missing" | "broken" | "disabled" | "unreadable";
  mcpDetail: string;
  skill: "installed" | "outdated" | "missing" | "foreign";
}

export async function diagnose(sys: Sys): Promise<DoctorRow[]> {
  await sys.prefetch(allPaths(sys, ADAPTERS), ADAPTERS.flatMap((a) => a.bins), allDirs(sys, ADAPTERS));
  const rows: DoctorRow[] = [];
  for (const a of ADAPTERS) {
    const d = await detect(sys, a);
    const st = await a.readMcp(sys);
    let mcp: DoctorRow["mcp"] = "missing";
    let mcpDetail = "";
    if (st.state === "unreadable") {
      mcp = "unreadable";
      mcpDetail = st.message;
    } else if (st.state === "registered") {
      mcp = st.enabled ? "registered" : "disabled";
      mcpDetail = display(st.command);
      const P = pathFor(sys);
      const script = st.command.args.find((x) => /\.m?js$/.test(x));
      if (P.isAbsolute(st.command.command) && !(await sys.exists(st.command.command))) {
        mcp = "broken";
        mcpDetail = `${st.command.command} is gone`;
      } else if (script && P.isAbsolute(script) && !(await sys.exists(script))) {
        mcp = "broken";
        mcpDetail = `${tilde(sys, script)} is gone`;
      }
    }
    const s = await skillPlan(sys, a, false);
    const skill: DoctorRow["skill"] =
      s.before == null ? "missing" : !isOurSkill(s.before) ? "foreign" : s.before === SKILL_TEXT ? "installed" : "outdated";
    rows.push({ agent: a.id, installed: d.installed, evidence: d.evidence, mcp, mcpDetail, skill });
  }
  return rows;
}

export function printDoctor(rows: DoctorRow[], out: Out): { fixable: number } {
  const width = Math.max(...rows.map((r) => BRAND[r.agent].name.length));
  const cells = rows.map((r) => {
    const inst = r.installed ? `${green("✓")} ${dim(r.evidence[0] ?? "")}` : dim("· not found");
    const mcp =
      !r.installed && r.mcp === "missing"
        ? dim("–")
        : r.mcp === "registered"
          ? green("✓ registered")
          : r.mcp === "missing"
            ? yellow("· not registered")
            : r.mcp === "disabled"
              ? yellow("· disabled")
              : red(`✗ ${r.mcp}`);
    const skill =
      !r.installed && r.skill === "missing"
        ? dim("–")
        : r.skill === "installed"
          ? green("✓ installed")
          : r.skill === "outdated"
            ? yellow("↻ outdated")
            : r.skill === "foreign"
              ? yellow("! not ours")
              : yellow("· missing");
    return { r, inst, mcp, skill };
  });
  const w1 = Math.max(9, ...cells.map((c) => visible(c.inst)));
  const w2 = Math.max(10, ...cells.map((c) => visible(c.mcp)));
  out(`${PAD}${dim(pad("Agent", width + 2))}  ${dim(pad("Installed", w1))}  ${dim(pad("MCP server", w2))}  ${dim("Skill")}`);
  let fixable = 0;
  for (const { r, inst, mcp, skill } of cells) {
    const needsMcp = r.mcp === "missing" || r.mcp === "disabled" || r.mcp === "broken";
    if (r.installed && (needsMcp || r.skill === "missing" || r.skill === "outdated")) fixable++;
    out(`${PAD}${agentLabel(r.agent, width)}  ${pad(inst, w1)}  ${pad(mcp, w2)}  ${skill}`);
    if (r.mcp === "broken" || r.mcp === "unreadable") out(`${PAD}${" ".repeat(width + 4)}${red(r.mcpDetail)}`);
  }
  return { fixable };
}

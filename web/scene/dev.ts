/*
 * Standalone harness for the scene: feeds it a scripted stream of fake events
 * (synthetic sessions, nothing from real transcripts) so the art can be
 * iterated on without the server. Query params: n (sessions), remote (how
 * many of them run in sandboxes / over ssh), hour, mode, crt, seed, quiet (no
 * random events), clean (hide buttons), moods, offline (one remote is down).
 * window.__dev exposes hooks for scripted screenshots.
 */
import type { AgentKind, Host, OfficeEvent, Snapshot, ToolCategory, WorkerState } from "../../src/shared/events.ts";
import { create } from "./index.ts";
import { rng } from "./util.ts";

const q = new URLSearchParams(location.search);
const N = Number(q.get("n") ?? 6);
const REMOTE = Number(q.get("remote") ?? 0);
const R = rng(Number(q.get("seed") ?? 42));
if (q.has("clean")) document.body.classList.add("clean");

const scene = create(document.getElementById("office")!);
if (q.has("hour")) scene.setHour(Number(q.get("hour")));
if (q.get("mode") === "ascii") scene.setMode("ascii");
if (q.has("crt")) scene.setCrt(true);
scene.setWeather(q.get("weather") === "rain" ? "rain" : q.get("weather") === "auto" ? null : "clear");
scene.onSelect((id) => console.log("select", id));

const PROJECTS: [AgentKind, string][] = [
  ["claude", "agent-office"], ["codex", "payments-api"], ["commandcode", "context-bridge"], ["opencode", "tui-kit"],
  ["claude", "ascii.rest"], ["gemini", "docs-site"], ["droid", "infra"], ["qwen", "ml-pipeline"],
  ["cursor", "web-app"], ["codex", "ml-pipeline"], ["claude", "dotfiles"], ["commandcode", "web-app"],
];
const HOSTS: Host[] = [
  { kind: "daytona", id: "daytona:7f3a", name: "auth-refactor" },
  { kind: "vercel", id: "vercel:sbx_92ac", name: "landing-v2" },
  { kind: "railway", id: "railway:4c1e", name: "api-sandbox" },
  { kind: "boat", id: "boat:b-11", name: "devbox" },
  { kind: "ssh", id: "ssh:shubham", name: "shubham" },
];
const MODELS: Record<AgentKind, string> = {
  claude: "claude-opus-5-5", commandcode: "cmd-1", codex: "gpt-5.6-sol", opencode: "deepseek/deepseek-v4-pro",
  droid: "droid-core", gemini: "gemini-3-pro", qwen: "qwen3.5-coder", cursor: "cursor-agent",
  hermes: "deepseek/deepseek-v4.1-flash",
};
const ROLES = ["Explore", "general-purpose", "code-reviewer", "test-runner", "Plan"];
const FILES = ["cli.ts", "server.ts", "index.ts", "scene.ts", "README.md", "auth.go", "main.py", "routes.ts", "db.sql", "style.css"];
const MOODS = ["🧠 deep in the auth refactor", "🔥 shipping v2 tonight", "☕ waiting on CI", "🐛 hunting a flaky test", "🚀 deploy window open"];
const SUMMARY: Record<ToolCategory, () => string> = {
  read: () => `Read ${pickR(FILES)}`,
  edit: () => `Edit ${pickR(FILES)}`,
  bash: () => pickR(["$ npm test", "$ git status", "$ cargo build", "$ ls", "$ pytest", "$ npm run build", "$ go test"]),
  search: () => pickR(["Grep TODO", "Glob **/*.ts", "Grep handleEvent", "Glob src/**"]),
  web: () => pickR(["WebFetch docs", "WebSearch esbuild loader", "Fetch MDN canvas"]),
  agent: () => "Spawn subagent",
  todo: () => "Update todos",
  mcp: () => pickR(["mcp context7", "mcp github", "mcp linear"]),
  other: () => pickR(["NotebookEdit", "Skill", "Task"]),
};
function pickR<T>(a: T[]): T { return a[Math.floor(R() * a.length)]; }

let seq = 1;
const live = new Map<string, { agent: AgentKind; project: string; parentId?: string; host?: Host }>();
function ev(workerId: string, kind: OfficeEvent["kind"], extra: Partial<OfficeEvent> = {}): OfficeEvent {
  const w = live.get(workerId)!;
  return { seq: seq++, ts: new Date().toISOString(), agent: w.agent, workerId, parentId: w.parentId, project: w.project, host: w.host, kind, model: MODELS[w.agent], ...extra };
}
function emit(e: OfficeEvent) { scene.apply(e); }

// initial snapshot: N sessions (REMOTE of them in sandboxes), some with interns
const workers: WorkerState[] = [];
const ids: string[] = [];
const remoteAt = new Set<number>();
for (let k = 0; k < REMOTE; k++) remoteAt.add(N - 1 - k);
for (let i = 0; i < N; i++) {
  const spread = Math.min(PROJECTS.length, 3 + Math.ceil(N / 2.2));
  const [agent, project] = PROJECTS[i < 4 ? i : Math.floor(R() * spread)];
  const id = `sess-${i}-${Math.floor(R() * 1e6).toString(36)}`;
  const host = remoteAt.has(i) ? HOSTS[(N - 1 - i) % HOSTS.length] : undefined;
  live.set(id, { agent, project, host });
  ids.push(id);
  const cats: ToolCategory[] = ["read", "edit", "bash", "search", "web", "todo", "mcp"];
  const cat = cats[i % cats.length];
  const mood = q.has("moods") && i % 4 === 1 ? MOODS[i % MOODS.length] : undefined;
  workers.push({ workerId: id, agent, project, host, mood, model: MODELS[agent], status: i % 5 === 4 ? "thinking" : "tool_start", category: cat, summary: SUMMARY[cat](), lastTs: new Date().toISOString(), toolCalls: Math.floor(R() * 120), tokens: 0, filesTouched: 0 });
}
const internTarget = Math.max(0, Math.floor(N * 0.45));
for (let i = 0; i < internTarget; i++) {
  const parent = ids[Math.floor(R() * ids.length)];
  const p = live.get(parent)!;
  const id = `sub-${i}-${Math.floor(R() * 1e6).toString(36)}`;
  live.set(id, { agent: p.agent, project: p.project, parentId: parent, host: p.host });
  workers.push({ workerId: id, parentId: parent, agent: p.agent, project: p.project, host: p.host, role: pickR(ROLES), status: "tool_start", category: "read", summary: SUMMARY.read(), lastTs: new Date().toISOString(), toolCalls: 3, tokens: 0, filesTouched: 0 });
}
const snap: Snapshot = { version: 1, startedAt: new Date().toISOString(), demo: true, workers, recent: [] };
scene.load(snap);
if (q.has("offline") && REMOTE) {
  const h = HOSTS[REMOTE % HOSTS.length];
  emit({ seq: seq++, ts: new Date().toISOString(), agent: "claude", workerId: `host:${h.id}`, project: h.name, host: h, kind: "error", summary: "remote offline" });
}

// random activity
function tick() {
  if (q.has("quiet")) return;
  const all = [...live.keys()];
  const id = all[Math.floor(Math.random() * all.length)];
  if (!id) return;
  const r = Math.random();
  const cats: ToolCategory[] = ["read", "edit", "edit", "bash", "search", "web", "todo", "mcp", "read", "edit"];
  if (r < 0.55) {
    const c = cats[Math.floor(Math.random() * cats.length)];
    emit(ev(id, "tool_start", { tool: c, category: c, summary: SUMMARY[c]() }));
  } else if (r < 0.75) emit(ev(id, "thinking"));
  else if (r < 0.85) emit(ev(id, "reply", { summary: "Here's the plan" }));
  else if (r < 0.88) emit(ev(id, "waiting"));
  else if (r < 0.9) emit(ev(id, "idle"));
  else if (r < 0.905) emit(ev(id, "test_fail", { summary: "$ npm test" }));
  else if (r < 0.91) emit(ev(id, "test_pass", { summary: "$ npm test" }));
}
setInterval(tick, Math.max(60, 1600 / Math.max(1, N)));

// hooks
function spawnIntern(parent?: string) {
  const mains = [...live.entries()].filter(([, v]) => !v.parentId).map(([k]) => k);
  const p = parent ?? mains[Math.floor(Math.random() * mains.length)];
  const pv = live.get(p)!;
  const id = `sub-x-${seq}`;
  live.set(id, { agent: pv.agent, project: pv.project, parentId: p, host: pv.host });
  emit(ev(id, "subagent_start", { role: pickR(ROLES) }));
  return id;
}
function join(agent: AgentKind = "claude", project = "new-project", host?: Host) {
  const id = `sess-j-${seq}`;
  live.set(id, { agent, project, host });
  emit(ev(id, "session_start"));
  return id;
}
function leave(id?: string) {
  const k = id ?? [...live.keys()].pop()!;
  const v = live.get(k);
  if (!v) return;
  emit(ev(k, v.parentId ? "subagent_end" : "session_end"));
  live.delete(k);
}
const mains = () => [...live.entries()].filter(([, v]) => !v.parentId).map(([k]) => k);
const remotes = () => [...live.entries()].filter(([, v]) => v.host && !v.parentId).map(([k]) => k);
let hour = 22;
const actions: Record<string, () => void> = {
  mode: () => scene.setMode(scene.getMode() === "pixel" ? "ascii" : "pixel"),
  crt: (() => { let on = q.has("crt"); return () => scene.setCrt((on = !on)); })(),
  flip: () => emit(ev(pickR(mains()), "test_fail", { summary: "$ npm test" })),
  pass: () => emit(ev(pickR(mains()), "test_pass", { summary: "$ npm test" })),
  wait: () => emit(ev(pickR(mains()), "waiting", { summary: "Approve edit?" })),
  intern: () => { spawnIntern(); },
  join: () => { join(pickR(["claude", "codex", "commandcode", "gemini", "droid"] as AgentKind[]), pickR(["agent-office", "new-thing", "context-bridge"])); },
  beam: () => { join(pickR(["claude", "codex", "opencode"] as AgentKind[]), "sandbox-job", pickR(HOSTS)); },
  leave: () => leave(),
  mood: () => emit(ev(pickR(mains()), "status", { summary: pickR(MOODS) })),
  shout: () => emit(ev(pickR(mains()), "shout", { summary: "shipped v2 🚀" })),
  party: () => emit(ev(pickR(mains()), "celebrate")),
  rage: () => emit(ev(pickR(mains()), "flip", { summary: "the linter disagrees with physics" })),
  night: () => { hour = (hour + 3) % 24; scene.setHour(hour); },
};
document.getElementById("bar")!.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).dataset.a;
  if (a) actions[a]();
});
const stats = document.getElementById("stats")!;
setInterval(() => { const s = scene.stats(); stats.textContent = `${s.fps} fps · ${s.drawMs} ms · ascii ${s.asciiMs} ms · ${s.workers} workers · ${s.particles} particles`; }, 500);

(window as unknown as { __dev: unknown }).__dev = {
  scene, emit, ev, live, ids, mains, remotes, spawnIntern, join, leave, HOSTS,
  flip: (id?: string) => emit(ev(id ?? mains()[0], "test_fail", { summary: "$ npm test" })),
  rage: (id?: string, why = "the linter disagrees with physics") => emit(ev(id ?? mains()[0], "flip", { summary: why })),
  pass: (id?: string) => emit(ev(id ?? mains()[0], "test_pass", { summary: "$ npm test" })),
  party: (id?: string) => emit(ev(id ?? mains()[0], "celebrate")),
  wait: (id?: string) => emit(ev(id ?? mains()[0], "waiting", { summary: "Approve edit?" })),
  prompt: (id?: string) => emit(ev(id ?? mains()[0], "prompt")),
  error: (id?: string) => emit(ev(id ?? mains()[0], "error", { summary: "API overloaded" })),
  mood: (id: string, text: string) => emit(ev(id, "status", { summary: text })),
  shout: (id: string, text: string) => emit(ev(id, "shout", { summary: text })),
  beam: (agent: AgentKind, host: Host, project = "sandbox-job") => join(agent, project, host),
  offline: (h: Host) => emit({ seq: seq++, ts: new Date().toISOString(), agent: "claude", workerId: `host:${h.id}`, project: h.name, host: h, kind: "error", summary: "remote offline" }),
  zoomTo: (id: string, z: number, dy = -16) => { const p = scene.workerAt(id); if (p) scene.view(p.x, p.y + dy, z); },
  tool: (id: string, c: ToolCategory) => emit(ev(id, "tool_start", { tool: c, category: c, summary: SUMMARY[c]() })),
};

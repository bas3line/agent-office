// Tests for src/server/state.ts: seq + ring buffer, counters, idle/gone timers, interns, sanitising.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Bundle TS entry points into one temp ESM module and import it. */
async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agentoffice-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { OfficeState, editedFiles, IDLE_MS, GONE_MS, SUMMARY_MAX, INTERN_GRACE_MS, PRESENCE_QUIET_MS, matchAgent } = await load(
  "src/server/state.ts",
  "src/shared/events.ts",
  "src/ingest/presence.ts",
);

function office(opts = {}) {
  const clock = { t: Date.parse("2026-10-18T10:00:00Z") };
  const state = new OfficeState({ now: () => clock.t, home: "/Users/test", ...opts });
  const seen = [];
  state.subscribe((e) => seen.push(e));
  const iso = (dt = 0) => new Date(clock.t + dt).toISOString();
  const ev = (over = {}) => ({ ts: iso(), agent: "claude", workerId: "s1", project: "api-gateway", kind: "prompt", ...over });
  const advance = (ms) => {
    clock.t += ms;
    state.tick();
  };
  return { state, seen, ev, iso, clock, advance };
}

test("seq is monotonic and the ring keeps the last 200, oldest first", () => {
  const { state, ev } = office();
  state.ingest(ev({ kind: "session_start" }));
  for (let i = 0; i < 250; i++) state.ingest(ev({ kind: i % 2 ? "thinking" : "prompt" }));
  const recent = state.snapshot().recent;
  assert.equal(recent.length, 200);
  assert.equal(recent[0].seq, 52);
  assert.equal(recent.at(-1).seq, 251);
  for (let i = 1; i < recent.length; i++) assert.equal(recent[i].seq, recent[i - 1].seq + 1);
});

test("a worker seen mid-session gets a synthetic arrival first", () => {
  const { state, seen, ev } = office();
  state.ingest(ev({ kind: "tool_start", tool: "Read", category: "read", summary: "Read a.ts" }));
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "thinking", role: "Explore" }));
  assert.deepEqual(seen.map((e) => e.kind), ["session_start", "tool_start", "subagent_start", "thinking"]);
  assert.equal(seen[2].parentId, "s1");
  assert.equal(seen[2].role, "Explore");
  assert.equal(state.size, 2);
});

test("endings for unknown workers are dropped; duplicate starts only refresh metadata", () => {
  const { state, seen, ev } = office();
  assert.equal(state.ingest(ev({ kind: "session_end" })), null);
  assert.equal(state.ingest(ev({ kind: "idle" })), null);
  assert.equal(seen.length, 0);
  state.ingest(ev({ kind: "session_start" }));
  assert.equal(state.ingest(ev({ kind: "session_start", model: "claude-opus-5-5" })), null);
  assert.equal(seen.length, 1);
  assert.equal(state.snapshot().workers[0].model, "claude-opus-5-5");
});

test("counters: tool calls, tokens, distinct edited basenames; tool_end keeps the pose", () => {
  const { state, ev } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ kind: "thinking", tokens: 1000 }));
  state.ingest(ev({ kind: "tool_start", tool: "Edit", category: "edit", summary: "Edit router.ts", tokens: 200 }));
  state.ingest(ev({ kind: "tool_end", tool: "Edit", category: "edit" }));
  state.ingest(ev({ kind: "tool_start", tool: "Edit", category: "edit", summary: "Edit src/router.ts" }));
  state.ingest(ev({ kind: "tool_start", tool: "Write", category: "edit", summary: "Write retry.ts" }));
  state.ingest(ev({ kind: "tool_start", tool: "Bash", category: "bash", summary: "$ pnpm test", tokens: 5 }));
  state.ingest(ev({ kind: "tool_end", tool: "Bash", category: "bash", isError: true }));
  const w = state.snapshot().workers[0];
  assert.equal(w.toolCalls, 4);
  assert.equal(w.tokens, 1205);
  assert.equal(w.filesTouched, 2);
  assert.equal(w.status, "tool_end");
  assert.equal(w.summary, "$ pnpm test");
  assert.equal(w.category, "bash");
  state.ingest(ev({ kind: "reply" }));
  assert.equal(state.snapshot().workers[0].tool, undefined);
});

test("editedFiles pulls basenames out of redacted summaries", () => {
  assert.deepEqual(editedFiles("Edit router.ts"), ["router.ts"]);
  assert.deepEqual(editedFiles("Edit src/deep/rate-limit.ts"), ["rate-limit.ts"]);
  assert.deepEqual(editedFiles("Patch a.go, b.go"), ["a.go", "b.go"]);
  assert.deepEqual(editedFiles("Write Dockerfile"), ["Dockerfile"]);
  assert.deepEqual(editedFiles("Edit"), []);
});

test("idle after IDLE_MS of quiet, once; activity wakes the worker", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ kind: "tool_end", tool: "Read" }));
  advance(IDLE_MS - 1_000);
  assert.equal(seen.at(-1).kind, "tool_end");
  advance(1_000);
  assert.equal(seen.at(-1).kind, "idle");
  const n = seen.length;
  advance(30_000);
  assert.equal(seen.length, n, "idle is not repeated");
  assert.equal(state.ingest(ev({ kind: "idle" })), null, "an upstream idle on an idle worker is dropped");
  state.ingest(ev({ kind: "prompt" }));
  assert.equal(state.snapshot().workers[0].status, "prompt");
  advance(IDLE_MS);
  assert.equal(seen.at(-1).kind, "idle");
});

test("a worker waiting on its human stays waiting until it goes home", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ kind: "waiting" }));
  advance(IDLE_MS * 5);
  assert.equal(seen.at(-1).kind, "waiting");
  assert.equal(state.snapshot().workers[0].status, "waiting");
  advance(GONE_MS);
  assert.equal(seen.at(-1).kind, "session_end");
});

test("a session waiting while its interns work is supervising, then needs its human", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_start", role: "Explore" }));
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "tool_start", tool: "Read", category: "read" }));
  state.ingest(ev({ kind: "waiting" }));
  assert.equal(seen.at(-1).kind, "idle");
  assert.equal(seen.at(-1).summary, "supervising 1 intern");
  assert.equal(state.sessions()[0].status, "idle");
  // the boss stays while the intern works, however long
  for (let i = 0; i < 30; i++) {
    advance(60_000);
    state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "tool_start", tool: "Read", category: "read" }));
  }
  assert.equal(state.sessions().length, 1, "a boss does not go home while the interns work");
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_end" }));
  advance(1_000);
  assert.equal(seen.filter((e) => e.workerId === "s1").at(-1).kind, "waiting");
});

test("interns showing up after the turn ended turn waiting into supervising", () => {
  const { state, seen, ev } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ kind: "waiting" }));
  assert.equal(seen.at(-1).kind, "waiting");
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_start", role: "general-purpose" }));
  const boss = seen.filter((e) => e.workerId === "s1").at(-1);
  assert.equal(boss.kind, "idle");
  assert.match(boss.summary, /^supervising/);
  state.ingest(ev({ kind: "prompt" }));
  assert.equal(state.sessions()[0].status, "prompt", "new activity clears the held wait");
});

test("a turn with no prompt (a background task's notification) takes the worker out of waiting", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ kind: "reply", summary: "Replied" }));
  state.ingest(ev({ kind: "waiting", summary: "Waiting" }));
  advance(3.5 * 60_000);
  assert.equal(state.sessions()[0].status, "waiting");
  // the next turn opens on a tool call, not a prompt
  state.ingest(ev({ kind: "thinking", summary: "Thinking" }));
  state.ingest(ev({ kind: "tool_start", tool: "Bash", category: "bash", summary: "$ git status" }));
  let w = state.sessions()[0];
  assert.equal(w.status, "tool_start");
  assert.equal(w.toolCalls, 1);
  state.ingest(ev({ kind: "tool_end", tool: "Bash", category: "bash" }));
  for (let i = 0; i < 12; i++) {
    advance(5_000);
    state.ingest(ev({ kind: "tool_start", tool: "Bash", category: "bash", summary: "$ git status" }));
    state.ingest(ev({ kind: "tool_end", tool: "Bash", category: "bash" }));
  }
  w = state.sessions()[0];
  assert.equal(w.status, "tool_end");
  assert.equal(w.toolCalls, 13);
  assert.ok(!seen.slice(-26).some((e) => e.kind === "waiting"), "nothing put it back to waiting mid-turn");
});

test("a held wait (supervising) doesn't come back when a no-prompt turn starts", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_start", role: "general-purpose" }));
  state.ingest(ev({ kind: "waiting" }));
  assert.equal(seen.at(-1).summary, "supervising 1 intern");
  // the boss starts a turn of its own (a notification) while the intern still works
  advance(30_000);
  state.ingest(ev({ kind: "tool_start", tool: "Bash", category: "bash", summary: "$ git status" }));
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_end" }));
  advance(1_000);
  advance(1_000);
  const mine = seen.filter((e) => e.workerId === "s1");
  assert.equal(mine.at(-1).kind, "tool_start", "the intern leaving doesn't release a wait the new turn already cleared");
  assert.equal(state.sessions()[0].status, "tool_start");
});

test("command lines map to agents; look-alikes don't", () => {
  const cases = {
    "claude": "claude",
    "/Users/a/.local/bin/claude --resume x": "claude",
    "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js": "claude",
    "command-code ": "commandcode",
    "/opt/homebrew/bin/codex exec": "codex",
    "node --no-warnings /x/node_modules/@google/gemini-cli/dist/index.js": "gemini",
    "node /x/bin/qwen": "qwen",
    "cursor-agent": "cursor",
    "/Applications/Claude.app/Contents/MacOS/Claude": null,
    "/Applications/CodexBar.app/Contents/MacOS/CodexBar": null,
    "node dist/cli.js --no-open": null,
    "grep claude": null,
  };
  for (const [args, agent] of Object.entries(cases)) assert.equal(matchAgent(args), agent, args);
});

test("local sessions whose agent quit go home; running ones and remotes stay", () => {
  const { state, seen, ev, advance } = office();
  const cc = (id, cwd = "/Users/test/Codes/site") => ev({ workerId: id, agent: "commandcode", project: "site", cwd, kind: "waiting" });
  state.ingest({ ...cc("a"), kind: "session_start" });
  state.ingest({ ...cc("b"), kind: "session_start" });
  state.ingest({ ...cc("c", "/private/tmp/x"), kind: "session_start" });
  state.ingest(ev({ workerId: "r1", agent: "commandcode", cwd: "/home/u/site", kind: "session_start", host: { kind: "daytona", id: "daytona:1", name: "box" } }));
  advance(1_000);
  state.ingest(cc("b"));
  // one process in ~/Codes/site and one in /tmp/x (lsof's /private spelling folds away)
  const procs = [{ agent: "commandcode", cwd: "/Users/test/Codes/site" }, { agent: "commandcode", cwd: "/tmp/x" }];
  state.reconcileLocal(procs);
  assert.equal(state.sessions().length, 4, "nothing ends before it has been quiet a while");
  advance(PRESENCE_QUIET_MS);
  state.reconcileLocal(procs);
  assert.deepEqual(seen.filter((e) => e.kind === "session_end").map((e) => e.workerId), ["a"], "the least recently active extra goes home");
  state.reconcileLocal([]);
  assert.deepEqual(state.sessions().map((w) => w.workerId).sort(), ["r1"], "with no processes left only the remote worker stays");
});

test("a watch-only agent (Hermes) is never counted out; only the quiet timer sends it home", () => {
  const { state, seen, ev, advance } = office();
  const hermes = (id, over = {}) =>
    ev({ workerId: id, agent: "hermes", project: "hermes", cwd: "/Users/test/.hermes", kind: "prompt", ...over });
  state.ingest({ ...hermes("h1"), kind: "session_start" });
  state.ingest(hermes("h1"));
  state.ingest({ ...hermes("h1-sub"), parentId: "h1", role: "Explore", kind: "subagent_start" });
  state.ingest(hermes("h1-sub", { parentId: "h1", kind: "tool_start", tool: "Read", category: "read" }));
  state.ingest(ev({ workerId: "c1", agent: "claude", project: "site", cwd: "/Users/test/Codes/site", kind: "session_start" }));
  advance(PRESENCE_QUIET_MS + 1);
  seen.length = 0;
  state.reconcileLocal([]);
  assert.ok(state.has("h1"), "Hermes has no process the scan can see, so it must not be counted out");
  assert.ok(state.has("h1-sub"), "nor its interns");
  assert.deepEqual(seen.map((e) => [e.kind, e.workerId]), [["session_end", "c1"]], "agents with a process still reconcile");
  advance(GONE_MS);
  assert.deepEqual(seen.filter((e) => e.workerId === "h1").map((e) => e.kind), ["session_end"]);
  assert.ok(!state.has("h1-sub"), "the quiet timer is what ends it, interns included");
});

test("session_end after GONE_MS removes the worker and its interns", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_start", role: "Explore" }));
  state.ingest(ev({ workerId: "s2", project: "other", kind: "session_start" }));
  advance(GONE_MS - 60_000);
  state.ingest(ev({ workerId: "s2", project: "other", kind: "prompt" }));
  seen.length = 0;
  advance(60_000);
  assert.deepEqual(seen.map((e) => [e.kind, e.workerId]), [["subagent_end", "a1"], ["session_end", "s1"]]);
  assert.deepEqual(state.snapshot().workers.map((w) => w.workerId), ["s2"]);
});

test("an upstream session_end also clears interns, immediately", () => {
  const { state, seen, ev } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_start" }));
  seen.length = 0;
  state.ingest(ev({ kind: "session_end" }));
  assert.deepEqual(seen.map((e) => e.kind), ["subagent_end", "session_end"]);
  assert.equal(state.size, 0);
});

test("subagent_end keeps the intern for a short grace, then removes it silently", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_start", role: "Plan" }));
  state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_end" }));
  assert.equal(state.ingest(ev({ workerId: "a1", parentId: "s1", kind: "subagent_end" })), null, "duplicate end dropped");
  assert.equal(state.snapshot().workers.find((w) => w.workerId === "a1").status, "subagent_end");
  const n = seen.length;
  advance(INTERN_GRACE_MS + 1);
  assert.equal(state.size, 1);
  assert.equal(seen.length, n);
  assert.equal(state.sessions().length, 1);
});

test("backfilled sessions age by transcript time; future timestamps are clamped", () => {
  const { state, seen, ev, iso, advance } = office();
  state.ingest(ev({ workerId: "old", kind: "session_start", ts: iso(-10 * 60_000) }));
  state.ingest(ev({ workerId: "ancient", kind: "session_start", ts: iso(-25 * 60_000) }));
  state.ingest(ev({ workerId: "future", kind: "session_start", ts: iso(60 * 60_000) }));
  advance(0);
  const byId = Object.fromEntries(seen.filter((e) => e.kind !== "session_start").map((e) => [e.workerId, e.kind]));
  assert.deepEqual(byId, { old: "idle", ancient: "session_end" });
  advance(IDLE_MS);
  assert.equal(seen.at(-1).workerId, "future");
  assert.equal(seen.at(-1).kind, "idle");
});

test("events are re-sanitised: length cap, control chars, secrets, home dir, bad enums", () => {
  const { state, ev } = office();
  const long = state.ingest(ev({ kind: "tool_start", summary: "Edit " + "x".repeat(200) + ".ts" }));
  assert.equal([...long.summary].length, SUMMARY_MAX);
  assert.ok(long.summary.endsWith("…"));
  const ctl = state.ingest(ev({ kind: "tool_start", summary: "$ git\u001b[31m status‮\n" }));
  assert.equal(ctl.summary, "$ git [31m status");
  const secret = state.ingest(ev({ kind: "tool_start", summary: "$ curl sk-ant-api03-abcdefghijklmnop" }));
  assert.equal(secret.summary, "$ curl •••");
  const opaque = state.ingest(ev({ kind: "tool_start", summary: "token a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8" }));
  assert.equal(opaque.summary, "token •••");
  const snake = state.ingest(ev({ kind: "tool_start", summary: "Edit a_very_long_snake_case_module_name_here.py" }));
  assert.equal(snake.summary, "Edit a_very_long_snake_case_module_name_here.py");
  const cwd = state.ingest(ev({ kind: "thinking", cwd: "/Users/test/code/api-gateway" }));
  assert.equal(cwd.cwd, "~/code/api-gateway");
  const cat = state.ingest(ev({ kind: "tool_start", tool: "Weird", category: "nope" }));
  assert.equal(cat.category, "other");
  assert.equal(state.ingest(ev({ agent: "aider" })), null);
  assert.equal(state.ingest(ev({ kind: "explode" })), null);
  assert.equal(state.ingest(ev({ workerId: "" })), null);
  const noProject = state.ingest(ev({ workerId: "p2", project: "", cwd: "/Users/test/code/tplay", kind: "session_start" }));
  assert.equal(noProject.project, "tplay");
  const badTs = state.ingest(ev({ ts: "yesterday" }));
  assert.ok(!Number.isNaN(Date.parse(badTs.ts)));
});

test("snapshot shape, and a throwing listener can't break the office", () => {
  const { state, ev } = office({ demo: true });
  state.subscribe(() => {
    throw new Error("boom");
  });
  state.ingest(ev({ kind: "session_start", model: "claude-opus-5-5", cwd: "/tmp/x" }));
  const snap = state.snapshot();
  assert.equal(snap.version, 1);
  assert.equal(snap.demo, true);
  assert.ok(!Number.isNaN(Date.parse(snap.startedAt)));
  assert.equal(snap.recent.length, 1);
  assert.deepEqual(Object.keys(snap.workers[0]).sort(), [
    "agent", "cwd", "filesTouched", "lastTs", "model", "project", "status", "tokens", "toolCalls", "workerId",
  ]);
  snap.workers[0].tokens = 999;
  assert.equal(state.snapshot().workers[0].tokens, 0, "snapshots are copies");
});

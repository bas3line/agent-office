// Hermes through the whole loop (src/ingest/index.ts + hermes.ts): a synthetic
// state.db in WAL mode, backfilled, then live rows (a prompt, a tool call and
// its result, a reply, a child session as an intern) and a terminal run that
// ends in "Exit code: 1". Skipped on Nodes without node:sqlite.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

const I = await load("src/ingest/index.ts", "src/shared/events.ts", "src/server/state.ts");
let sqlite;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}

const kinds = (evs) => evs.map((e) => e.kind);
const sec = () => Date.now() / 1000;
const tc = (id, name, args) => [{ id, call_id: id, response_item_id: `r_${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
/** What Hermes' terminal tool answers with (tools/terminal_tool_result.py). */
const term = (output, exit_code, extra = {}) => JSON.stringify({ output, exit_code, error: null, ...extra });

// The columns the driver reads, as Hermes declares them: last_activity_at is a nullable heartbeat that
// appending a message never touches, and messages.id is AUTOINCREMENT.
function makeDb(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.db");
  const db = new sqlite.DatabaseSync(path);
  db.exec(`pragma journal_mode = wal;
    create table sessions (
      id text primary key, source text not null, profile_name text, model text, billing_provider text,
      cwd text, git_repo_root text, git_branch text,
      started_at real not null, last_activity_at real, ended_at real, end_reason text,
      message_count integer default 0, tool_call_count integer default 0, tool_names text,
      input_tokens integer default 0, output_tokens integer default 0,
      cache_read_tokens integer default 0, cache_write_tokens integer default 0, reasoning_tokens integer default 0,
      parent_session_id text, title text, archived integer default 0, hidden integer default 0, pinned integer default 0
    );
    create table messages (
      id integer primary key autoincrement, session_id text not null, role text not null, tool_name text, tool_call_id text,
      tool_calls text, timestamp real not null, content text
    );
    create index idx_messages_session on messages (session_id, timestamp);
    create index idx_sessions_last_active on sessions (coalesce(last_activity_at, started_at) desc, started_at desc);`);
  const api = {
    path,
    session(id, o = {}) {
      const t = o.started ?? sec();
      db.prepare(`insert or replace into sessions
        (id, source, profile_name, model, cwd, started_at, last_activity_at, parent_session_id, end_reason, title)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, o.source ?? "cli", o.profile ?? "default", o.model ?? "deepseek/deepseek-v4.1-flash",
          o.cwd ?? "/tmp/demo-app", t, o.heartbeat ?? null, o.parent ?? null, o.endReason ?? null, o.title ?? null);
    },
    heartbeat(id, at = sec()) {
      db.prepare("update sessions set last_activity_at = ? where id = ?").run(at, id);
    },
    end(id, reason) {
      db.prepare("update sessions set ended_at = ?, end_reason = ? where id = ?").run(sec(), reason, id);
    },
    message(id, sid, o = {}) {
      db.prepare(`insert or replace into messages (id, session_id, role, tool_name, tool_call_id, tool_calls, timestamp, content)
        values (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, sid, o.role ?? "assistant", o.tool_name ?? null, o.tool_call_id ?? null,
          typeof o.tool_calls === "string" ? o.tool_calls : o.tool_calls ? JSON.stringify(o.tool_calls) : null,
          o.ts ?? sec(), o.content ?? "");
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
  return api;
}

/** A session that already ran the suite: prompt, terminal call, result, reply. */
function seed(db) {
  db.session("ses_main");
  db.message(1, "ses_main", { role: "user", content: "please run the tests and read auth.ts" });
  db.message(2, "ses_main", { role: "assistant", tool_calls: tc("c1", "terminal", { command: "npm test" }) });
  db.message(3, "ses_main", { role: "tool", tool_name: "terminal", tool_call_id: "c1", content: term("Tests: 0 failed", 0) });
  db.message(4, "ses_main", { role: "assistant", content: "Done." });
}

async function scenario(t) {
  if (!sqlite) {
    t.skip("node:sqlite not available");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "agentoffice-hm-"));
  const db = makeDb(join(dir, "hermes"));
  seed(db);
  const events = [];
  const all = [];
  const ingest = I.createIngest({
    agents: ["hermes"],
    onEvent: (e) => events.push(e),
    watch: false,
    env: { AGENT_OFFICE_HERMES_DIR: join(dir, "hermes"), AGENT_OFFICE_HOME: join(dir, "ao") },
  });
  const tick = async () => {
    await ingest.tick();
    const evs = events.splice(0);
    all.push(...evs);
    return evs;
  };
  try {
    const back = await tick();
    return { db, tick, back, dir, ingest, all };
  } catch (err) {
    db.close();
    throw err;
  }
}

function cleanup(s) {
  s.ingest.stop();
  s.db.close();
  rmSync(s.dir, { recursive: true, force: true });
}

test("hermes: backfill poses the session, live rows animate it", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    assert.deepEqual(kinds(s.back), ["session_start", "waiting"]);
    assert.equal(s.back[0].project, "demo-app");
    assert.equal(s.back[0].model, "deepseek/deepseek-v4.1-flash");

    s.db.message(5, "ses_main", { role: "user", content: "SECRET_PROMPT_TEXT" });
    assert.deepEqual(kinds(await s.tick()), ["prompt"]);

    s.db.message(6, "ses_main", { role: "assistant", tool_calls: tc("c2", "read_file", { file_path: "/tmp/demo-app/src/auth.ts" }) });
    let evs = await s.tick();
    assert.deepEqual(kinds(evs), ["tool_start"]);
    assert.equal(evs[0].summary, "Read auth.ts");
    assert.equal(evs[0].category, "read");

    s.db.message(7, "ses_main", { role: "tool", tool_name: "read_file", tool_call_id: "c2", content: "FILE_BODY_SECRET" });
    evs = await s.tick();
    assert.deepEqual(kinds(evs), ["tool_end"]);
    assert.equal(evs[0].summary, "Read auth.ts");

    s.db.message(8, "ses_main", { role: "assistant", content: "Replied with words." });
    evs = await s.tick();
    assert.deepEqual(kinds(evs), ["reply", "waiting"]);
    assert.deepEqual(await s.tick(), []);

    const wire = JSON.stringify(s.all);
    assert.ok(!wire.includes("SECRET_PROMPT_TEXT"), "prompt text never reaches an event");
    assert.ok(!wire.includes("FILE_BODY_SECRET"), "file content never reaches an event");
    assert.ok(!wire.includes("please run the tests"), "old prompt text never reaches an event");
  } finally {
    cleanup(s);
  }
});

// Cutting the serialized tool_calls column at 2,000 characters loses every call after a big one, and a
// terminal call whose arguments got cut has no command, so its test verdict is never scored.
test("hermes: a big argument doesn't swallow the calls after it", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    const big = "x".repeat(9000);
    s.db.message(5, "ses_main", {
      role: "assistant",
      tool_calls: [
        ...tc("p1", "patch", { path: "/tmp/demo-app/src/big.ts", patch: big }),
        ...tc("p2", "terminal", { command: "npm test" }),
      ],
    });
    const evs = (await s.tick()).filter((e) => e.kind === "tool_start");
    assert.equal(evs.length, 2, "both calls in one row are reported");
    assert.equal(evs[0].summary, "Edit big.ts");
    assert.equal(evs[1].summary, "$ npm test");
  } finally {
    cleanup(s);
  }
});

// A live poll must read everything written since the last row it saw. Reading "the last N messages"
// drops the assistant row that issued a call when a burst of writes lands between two polls, and the
// result then has nothing to close — a failed test included.
test("hermes: a burst of writes between polls still closes its call", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.message(5, "ses_main", { role: "assistant", tool_calls: tc("b1", "terminal", { command: "npm test" }) });
    s.db.message(6, "ses_main", { role: "tool", tool_name: "terminal", tool_call_id: "b1", content: term("1 test failed", 1) });
    for (let i = 7; i <= 16; i++) s.db.message(i, "ses_main", { role: "user", content: `filler ${i}` });
    const evs = await s.tick();
    assert.ok(kinds(evs).includes("tool_start"), "the call that the burst pushed out of the window still starts");
    assert.ok(kinds(evs).includes("test_fail"), "and its failure is still scored");
  } finally {
    cleanup(s);
  }
});

// More rows than one poll reads: the rest come on the next tick, though the files haven't changed since.
test("hermes: a burst bigger than a page is read on, a page per tick", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    for (let i = 5; i < 255; i++) s.db.message(i, "ses_main", { role: "user", content: `filler ${i}` });
    s.db.message(255, "ses_main", { role: "assistant", tool_calls: tc("pg", "terminal", { command: "npm test" }) });
    s.db.message(256, "ses_main", { role: "tool", tool_name: "terminal", tool_call_id: "pg", content: term("", 1) });
    assert.ok(!kinds(await s.tick()).includes("test_fail"));
    assert.ok(kinds(await s.tick()).includes("test_fail"), "the second page arrives without another write");
  } finally {
    cleanup(s);
  }
});

// sessions.last_activity_at is a heartbeat Hermes writes at most once a minute, and a new message never
// touches it. Picking sessions by it left one whose heartbeat is older than another's silent, its last
// reply included, until its next heartbeat (never, once it went idle).
test("hermes: rows land without a heartbeat, in two sessions at once", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.heartbeat("ses_main", sec() - 50);
    s.db.session("ses_two", { heartbeat: sec() });
    s.db.message(5, "ses_two", { role: "user", content: "hi" });
    s.db.message(6, "ses_main", { role: "assistant", tool_calls: tc("h1", "read_file", { path: "/tmp/demo-app/a.ts" }) });
    let evs = await s.tick();
    assert.deepEqual(kinds(evs.filter((e) => e.workerId === "ses_main")), ["tool_start"]);
    assert.ok(evs.some((e) => e.workerId === "ses_two" && e.kind === "session_start"), "a session first seen live walks in");

    s.db.message(7, "ses_main", { role: "tool", tool_name: "read_file", tool_call_id: "h1", content: "body" });
    s.db.message(8, "ses_main", { role: "assistant", content: "All read." });
    evs = await s.tick();
    assert.deepEqual(kinds(evs), ["tool_end", "reply", "waiting"]);
  } finally {
    cleanup(s);
  }
});

// The cursor moves past a page only once the page is handled. Moved first, a session lookup that failed
// once (a locked database) left that session's rows behind it, and a session that wrote no more stayed
// out of the office.
test("hermes: a new session whose lookup fails once still walks in", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.session("ses_new");
    s.db.message(5, "ses_new", { role: "user", content: "hello" });
    s.db.exec("alter table sessions rename to sessions_away");
    assert.ok(!(await s.tick()).some((e) => e.workerId === "ses_new"));
    s.db.exec("alter table sessions_away rename to sessions");
    assert.ok((await s.tick()).some((e) => e.workerId === "ses_new" && e.kind === "session_start"));
  } finally {
    cleanup(s);
  }
});

// Hermes points a compression (or branch, or reset) continuation at the session it carries on through
// parent_session_id, the same column a subagent uses. As an intern, the conversation would walk out of
// the office on its first reply.
test("hermes: a compression continuation is a worker, not an intern", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.end("ses_main", "compression");
    s.db.session("ses_cont", { parent: "ses_main" });
    s.db.message(5, "ses_cont", { role: "user", content: "carry on" });
    let evs = (await s.tick()).filter((e) => e.workerId === "ses_cont");
    assert.equal(evs[0]?.kind, "session_start");
    assert.ok(evs.every((e) => !e.parentId));

    s.db.message(6, "ses_cont", { role: "assistant", content: "Carrying on." });
    evs = await s.tick();
    assert.deepEqual(kinds(evs), ["reply", "waiting"]);
  } finally {
    cleanup(s);
  }
});

// json_each/json_extract raise on the wrong shapes too, and with one cursor for every session, a row that
// fails the query would stop Hermes for good.
test("hermes: tool_calls that aren't an array of calls don't stop the poll", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.message(5, "ses_main", { role: "assistant", tool_calls: `[{"id":"cut` });
    s.db.message(6, "ses_main", { role: "assistant", tool_calls: `{"id":"x"}` });
    s.db.message(7, "ses_main", { role: "assistant", tool_calls: `["x", 1, null, {"id":"y"}]` });
    s.db.message(8, "ses_main", { role: "assistant", tool_calls: tc("ok1", "read_file", { path: "/tmp/demo-app/ok.ts" }) });
    const evs = (await s.tick()).filter((e) => e.kind === "tool_start");
    assert.deepEqual(evs.map((e) => e.summary), ["Read ok.ts"]);
  } finally {
    cleanup(s);
  }
});

// A saved call can carry empty or malformed arguments. Reading them in SQL made SQLite raise, which failed
// the whole message query: the poll then retried the same row forever and the session went silent.
test("hermes: a call with broken arguments doesn't silence the session", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.message(5, "ses_main", {
      role: "assistant",
      tool_calls: [
        { id: "q1", call_id: "q1", type: "function", function: { name: "terminal", arguments: "" } },
        { id: "q2", call_id: "q2", type: "function", function: { name: "patch", arguments: "{not json" } },
        ...tc("q3", "read_file", { file_path: "/tmp/demo-app/src/after.ts" }),
      ],
    });
    const evs = (await s.tick()).filter((e) => e.kind === "tool_start");
    assert.equal(evs.length, 3, "the unreadable calls are kept, and the readable one after them too");
    assert.equal(evs[2].summary, "Read after.ts");

    // and the session keeps moving afterwards
    s.db.message(6, "ses_main", { role: "tool", tool_name: "read_file", tool_call_id: "q3", content: "ok" });
    assert.deepEqual(kinds(await s.tick()), ["tool_end"]);
  } finally {
    cleanup(s);
  }
});

// The driver can be perfect and still reach nobody: OfficeState.sanitize drops an event whose agent it
// doesn't know. Fold the ingest output through the office itself, or a new agent can look green in the
// parser and be invisible on screen.
test("hermes: the office keeps the worker the ingest hands it", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    const office = new I.OfficeState({ home: null, now: () => Date.now() });
    for (const e of s.all) office.ingest(e);
    const snap = office.snapshot();
    assert.equal(snap.workers.length, 1);
    assert.equal(snap.workers[0].agent, "hermes");
    assert.equal(snap.workers[0].project, "demo-app");
    assert.ok(snap.recent.some((e) => e.agent === "hermes" && e.kind === "session_start"));
  } finally {
    cleanup(s);
  }
});

test("hermes: a child session walks in as an intern", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    // delegate_task's children are tagged source 'subagent'; profile_name is the whole state.db's.
    s.db.session("ses_kid", { parent: "ses_main", source: "subagent" });
    s.db.message(20, "ses_kid", { role: "assistant", tool_calls: tc("k1c", "terminal", { command: "npm test" }) });
    const kid = (await s.tick()).filter((e) => e.workerId === "ses_kid");
    assert.deepEqual(kinds(kid), ["subagent_start", "tool_start"]);
    assert.equal(kid[0].parentId, "ses_main");
    assert.equal(kid[0].role, "subagent");
    assert.equal(kid[1].summary, "$ npm test");
  } finally {
    cleanup(s);
  }
});

// The verdict comes from the envelope's exit_code: the output itself can say anything, here nothing a
// failure marker would catch.
test("hermes: a terminal answering exit_code 1 flips the table", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.message(5, "ses_main", { role: "assistant", tool_calls: tc("c9", "terminal", { command: "npm test" }) });
    let evs = await s.tick();
    assert.deepEqual(kinds(evs), ["tool_start"]);
    assert.equal(evs[0].summary, "$ npm test");

    s.db.message(6, "ses_main", { role: "tool", tool_name: "terminal", tool_call_id: "c9", content: term("ran 12 suites (exit code 0 expected)", 1) });
    evs = await s.tick();
    assert.deepEqual(kinds(evs), ["tool_end", "test_fail"]);
    assert.equal(evs[1].isError, true);
  } finally {
    cleanup(s);
  }
});

test("hermes: a test run handed to the background has no verdict yet", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.message(5, "ses_main", { role: "assistant", tool_calls: tc("bg", "terminal", { command: "npm test" }) });
    s.db.message(6, "ses_main", {
      role: "tool", tool_name: "terminal", tool_call_id: "bg",
      content: term("", null, { status: "yielded_to_background", session_id: "proc_1" }),
    });
    assert.deepEqual(kinds(await s.tick()), ["tool_start", "tool_end"]);
  } finally {
    cleanup(s);
  }
});

test("hermes: a plain-text terminal answer ending in Exit code: 1 still flips the table", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.message(5, "ses_main", { role: "assistant", tool_calls: tc("c8", "terminal", { command: "npm test" }) });
    s.db.message(6, "ses_main", { role: "tool", tool_name: "terminal", tool_call_id: "c8", content: "1 test failed\nExit code: 1" });
    assert.deepEqual(kinds(await s.tick()), ["tool_start", "tool_end", "test_fail"]);
  } finally {
    cleanup(s);
  }
});

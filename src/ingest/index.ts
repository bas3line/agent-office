/*
 * The ingest loop: find transcripts, tail them, hand RawEvents to the server.
 *
 * One Watcher per machine: this one (LocalSource) and every remote
 * (RemoteSource over RemoteTarget.exec, src/remote/source.ts). Each poll a
 * watcher lists every agent's transcript folders in one batch, decides which
 * files to follow, stats and reads them in one batch each, and parses what
 * was appended. A file it starts following (at startup, or a new or resumed
 * session later) is not replayed: the tail is parsed to rebuild state and only
 * one session_start / subagent_start per live worker plus its latest pose goes
 * out. opencode's SQLite database is polled the same way, and the agentoffice
 * MCP outbox is tailed for AgentSignals, which go to the matching live worker.
 * The server makes up idle and session_end; this loop only ends interns and
 * re-sights a parent whose interns are still busy so it is not sent home
 * mid-delegation. Remote events carry `host` and host-prefixed worker ids.
 */
import { watch, type FSWatcher } from "node:fs";
import { createRemoteSource } from "../remote/source.ts";
import {
  ACTIVE_WINDOW_MS, BRAND, GONE_MS,
  type AgentKind, type EventKind, type IngestOptions, type RawEvent, type RemoteTarget, type StartIngest,
} from "../shared/events.ts";
import { claudeFileInfo, createClaudeState, parseClaudeLine } from "./claude.ts";
import { createCodexState, codexSessionId, parseCodexLine } from "./codex.ts";
import { createCommandCodeState, parseCommandCodeLine } from "./commandcode.ts";
import { announcement, basename, emit, parseJson, type ParserState, type WorkerCtx } from "./common.ts";
import { createCursorState, parseCursorLine, type CursorState } from "./cursor.ts";
import {
  agentRoots, DRIVERS, hermesDb, opencodeDb, outboxDir,
  type Candidate, type Driver, type ListHint,
} from "./discover.ts";
import { applyDroidSettings, createDroidState, parseDroidLine } from "./droid.ts";
import { createGeminiState, geminiShortId, parseGeminiDoc, parseGeminiLine } from "./gemini.ts";
import {
  applyOpencode, asMessage, asPart, asSession, createOpencodeState, messagesSql, partsSql, sessionSql,
  type OcMessage, type OcPart, type OcSession, type OpencodeState,
} from "./opencode.ts";
import {
  applyHermes, asHermesMessage, asHermesSession, createHermesState, HM_MAX_ID_SQL, hmMessagesAfterSql, hmMessagesSql, hmSessionSql,
  type HermesState, type HmMessage, type HmSession,
} from "./hermes.ts";
import { createQwenState, parseQwenLine } from "./qwen.ts";
import { OFFICE_TOOL, parseSignal, pickSignalWorker, signalEvent } from "./signals.ts";
import {
  createLocalSource, readHeadLines, readJsonFiles,
  type FileStat, type ListRequest, type ReadRequest, type Source, type SourceEnv,
} from "./source.ts";
import { LineTail } from "./tail.ts";

export type { Source } from "./source.ts";

export const POLL_MS = 1_500;
export const REMOTE_POLL_MS = 2_500;
/** Full rescans (every folder walked) this often. */
export const FULL_SCAN_MS = 15_000;
export const REMOTE_FULL_SCAN_MS = 30_000;
export const TAIL_WINDOW = 512 << 10;
const REMOTE_TAIL_WINDOW = 256 << 10;
const MAX_WINDOW = 8 << 20;
/** Whole-document transcripts (legacy Gemini .json) bigger than this are skipped. */
const MAX_DOC = 16 << 20;
/** More than this appended between polls is caught up, not replayed. */
const LIVE_JUMP = 4 << 20;
/** An intern whose transcript is quiet this long has left (longer if a tool call is still out). */
export const SUBAGENT_QUIET_MS = 3 * 60_000;
export const SUBAGENT_BUSY_QUIET_MS = 10 * 60_000;
/** An intern whose turn is over (Codex threads stay open for follow-ups) leaves after this much quiet. */
export const INTERN_DONE_MS = 60_000;
/** Gemini CLI never writes "turn over": a reply followed by this much quiet is one. */
export const GEMINI_SETTLE_MS = 5_000;
const KEEPALIVE_MS = 60_000;
/** Files quiet this long stop being watched (they are picked up again if they grow). */
const FORGET_MS = GONE_MS + 10 * 60_000;
const MIN_GAP_MS = 200;
/** A signal whose worker isn't in the office yet waits this long for it, then is dropped. */
export const SIGNAL_WAIT_MS = 6_000;
/** With several workers in the signal's folder and none visibly calling the tool, wait this long for a transcript to show the call. */
const SIGNAL_SETTLE_MS = 2_500;
const SIGNAL_WINDOW = 64 << 10;
const SIGNAL_STALE_MS = 60_000;
/** opencode rows read per session: on first sight (to rebuild state), and per live poll. */
const OC_BACKFILL_MSGS = 12;
const OC_LIVE_MSGS = 6;
/** Hermes rows read per session on first sight, to rebuild its state. */
const HM_BACKFILL_MSGS = 12;
/**
 * Ceiling on the rows one live poll reads. It is a page, not a window: the poll asks for everything
 * written after the last row it saw (`messages.id` is AUTOINCREMENT), and a full page polls again on
 * the next tick, so a burst of writes can't hide the assistant row that issued a tool call.
 */
const HM_LIVE_MSGS_MAX = 200;
/** Slack on Hermes' once-a-minute heartbeat when picking the sessions active lately on first sight. */
const HM_HEARTBEAT_SLACK_S = 86_400;
const MAX_BACKOFF_MS = 60_000;
/** Remotes fetch up to this much of each followed file's growth with every listing. */
const PREFETCH_BYTES = 256 << 10;
const HEAD_BYTES = 64 << 10;
/** Files opened per batched read. */
const OPEN_BATCH = 16;
const PARSE_SLICE_MS = 6;

const STATUS = new Set<EventKind>([
  "prompt", "thinking", "tool_start", "tool_end", "reply", "waiting", "test_fail", "test_pass", "error", "idle",
]);

interface Parser {
  state: ParserState;
  parse(line: string): RawEvent[];
  /** Whole-document formats: parse the entire file. */
  doc?(text: string): RawEvent[];
  /** Formats without timestamps: the time the next lines happened. */
  clock?(ms: number): void;
  /** The sibling meta / settings file changed. */
  meta?(json: Record<string, any> | null): RawEvent[];
}

interface Tracked {
  agent: AgentKind;
  path: string;
  sub: boolean;
  doc: boolean;
  parser: Parser;
  tail: LineTail;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Wall ms the file last grew. */
  grewAt: number;
  /** workerIds this file has registered. */
  ids: Set<string>;
  parentPath?: string;
  metaPath?: string;
  metaMtime?: number;
  /**
   * Claude subagent whose .meta.json says finished: its lines are no longer shown. Not for good: a
   * message to a finished agent resumes it and rewrites its meta without the flag.
   */
  finished?: boolean;
  /** Pulled in as the parent of an active intern: announce it as active at this wall ms. */
  activeAt?: number;
  /** Lines (or a document) read on first sight, waiting to be admitted. */
  backlog?: string[];
  docText?: string;
  admitted?: boolean;
}

interface OutboxFile {
  ino: number;
  tail: LineTail;
}

interface Watched {
  driver: Driver;
  root: string;
}

export interface IngestTuning {
  pollMs?: number;
  /** Poll interval for remotes (default REMOTE_POLL_MS). */
  remotePollMs?: number;
  now?: () => number;
  /** Use fs.watch as a hint. Defaults to on for macOS and Windows (native recursive watching). */
  watch?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Watch this machine (default true). Tests that only exercise remotes turn it off. */
  local?: boolean;
  /** Extra sources, for tests: watched like remotes, through whatever Source they are. */
  sources?: Source[];
}

/* ================================================================ watcher */

class Watcher {
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly local: boolean;
  private readonly fullMs: number;
  private readonly tailWindow: number;
  private readonly readCap: number;
  private readonly maxDoc: number;
  private env?: SourceEnv;
  private roots: Watched[] = [];
  private outbox?: string;
  private ocDb?: string;
  private resolved = false;

  private readonly tracked = new Map<string, Tracked>();
  private readonly opening = new Set<string>();
  private readonly waiting = new Map<string, Tracked>();
  private readonly seen = new Map<string, { size: number; mtimeMs: number }>();
  /** Every worker this machine has in the office, by unprefixed workerId. */
  readonly registry = new Map<string, WorkerCtx>();
  private readonly codexIndex = new Map<string, string>();
  /** Folder -> files in it, from listings (sibling lookups). */
  private readonly dirIndex = new Map<string, string[]>();
  private readonly quickDirs = new Map<AgentKind, Set<string>>();
  private readonly ccCwd = new Map<string, string | null>();
  private readonly outboxFiles = new Map<string, OutboxFile>();
  private pendingSignals: { line: string; at: number }[] = [];

  private readonly oc = new Map<string, { st: OpencodeState; updated: number }>();
  private ocCols?: Set<string>;
  private ocSig = "";
  private ocCursor?: number;
  private ocOff = false;
  private hmDb?: string;
  private readonly hm = new Map<string, { st: HermesState; updated: number }>();
  private hmCols?: Set<string>;
  private hmSig = "";
  private hmCursor?: number;
  private hmOff = false;

  private ticks = 0;
  private lastFull = Number.NEGATIVE_INFINITY;
  private lastCodexSearch = Number.NEGATIVE_INFINITY;
  stopped = false;

  constructor(
    readonly source: Source,
    private readonly agents: AgentKind[],
    private readonly onEvent: (e: RawEvent) => void,
    opts: { log: (msg: string) => void; now: () => number },
  ) {
    this.log = opts.log;
    this.now = opts.now;
    this.local = !source.host;
    this.fullMs = this.local ? FULL_SCAN_MS : REMOTE_FULL_SCAN_MS;
    // A window must come back whole: a source that caps reads (Railway) gets windows no bigger than
    // its cap, or the unread end of the window would be replayed as "new" lines on the next poll.
    this.readCap = source.maxReadBytes ?? Number.POSITIVE_INFINITY;
    this.tailWindow = Math.min(this.local ? TAIL_WINDOW : REMOTE_TAIL_WINDOW, this.readCap);
    this.maxDoc = Math.min(MAX_DOC, this.readCap);
  }

  get name(): string {
    return this.source.host ? `${this.source.host.name} (${this.source.host.kind})` : "this machine";
  }

  /** Transcript folders to fs.watch (local only). */
  watchRoots(): string[] {
    return this.roots.map((r) => r.root);
  }

  async resolve(): Promise<void> {
    if (this.resolved) return;
    this.env = await this.source.env();
    const seenRoots = new Set<string>();
    for (const agent of this.agents) {
      if (agent === "opencode") {
        this.ocDb = opencodeDb(this.env, this.local);
        continue;
      }
      if (agent === "hermes") {
        this.hmDb = hermesDb(this.env, this.local);
        continue;
      }
      const driver = DRIVERS[agent];
      if (!driver) continue;
      for (const r of agentRoots(agent, this.env, this.local)) {
        const root = r.replace(/[\\/]+$/, "");
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        this.roots.push({ driver, root });
        this.log(`ingest: ${BRAND[agent].name} transcripts in ${root}${this.local ? "" : ` on ${this.name}`}`);
      }
    }
    if (this.ocDb) this.log(`ingest: ${BRAND.opencode.name} database ${this.ocDb}${this.local ? "" : ` on ${this.name}`}`);
    if (this.hmDb) this.log(`ingest: ${BRAND.hermes.name} database ${this.hmDb}${this.local ? "" : ` on ${this.name}`}`);
    this.outbox = outboxDir(this.env).replace(/[\\/]+$/, "");
    this.resolved = true;
  }

  /* ------------------------------------------------------------ output */

  private forward(e: RawEvent): void {
    if (this.stopped) return;
    const host = this.source.host;
    const out: RawEvent = host
      ? { ...e, host, workerId: `${host.id}/${e.workerId}`, ...(e.parentId ? { parentId: `${host.id}/${e.parentId}` } : {}) }
      : e;
    try {
      this.onEvent(out);
    } catch (err) {
      this.log(`ingest: onEvent threw: ${(err as Error)?.message ?? err}`);
    }
  }

  private forwardAll(events: RawEvent[]): void {
    for (const e of events) this.forward(e);
  }

  /* -------------------------------------------------------------- poll */

  async tick(): Promise<void> {
    await this.resolve();
    const now = this.now();
    const initial = this.ticks === 0;
    const full = initial || now - this.lastFull >= this.fullMs;

    // 1. One listing for every agent, opencode's database files and the outbox.
    const reqs: ListRequest[] = [];
    const owners: (Watched | "outbox" | "opencode" | "hermes")[] = [];
    for (const w of this.roots) {
      const hint: ListHint = { watched: this.watchedMains(w.driver.agent), dirs: this.quickDirs.get(w.driver.agent) ?? new Set(), now };
      for (const q of w.driver.lists(w.root, full, hint)) {
        reqs.push(q);
        owners.push(w);
      }
    }
    if (this.ocDb && !this.ocOff) {
      reqs.push({ root: this.ocDb.slice(0, this.ocDb.lastIndexOf("/")), depth: 0, suffixes: [".db", ".db-wal"] });
      owners.push("opencode");
    }
    if (this.hmDb && !this.hmOff) {
      reqs.push({ root: this.hmDb.slice(0, this.hmDb.lastIndexOf("/")), depth: 0, suffixes: [".db", ".db-wal"] });
      owners.push("hermes");
    }
    if (this.outbox) {
      reqs.push({ root: this.outbox, depth: 0, suffixes: [".jsonl"], newerThanMs: GONE_MS });
      owners.push("outbox");
    }
    // Where a round trip is expensive, the growth of every followed file comes back with the listing.
    const prefetch: ReadRequest[] = [];
    if (this.source.listAndRead) {
      const per = this.source.prefetchBytes ?? PREFETCH_BYTES;
      for (const t of this.tracked.values()) if (!t.doc) prefetch.push({ path: t.path, start: t.tail.offset, end: t.tail.offset + per });
    }
    let listed: FileStat[][];
    const pre = new Map<string, Buffer | null>();
    if (prefetch.length) {
      const r = await this.source.listAndRead!(reqs, prefetch);
      listed = r.lists;
      prefetch.forEach((q, i) => pre.set(q.path, r.reads[i] ?? null));
    } else {
      listed = reqs.length ? await this.source.list(reqs) : [];
    }
    this.ticks++;
    if (full) this.lastFull = now;

    /** Every listed file's stat, candidates or not (meta files, opencode's db). */
    const fresh = new Map<string, FileStat>();
    const cands: Candidate[] = [];
    const outbox: FileStat[] = [];
    const dirs = new Map<string, string[]>();
    listed.forEach((files, i) => {
      const w = owners[i]!;
      if (w === "outbox") {
        outbox.push(...files);
        return;
      }
      for (const f of files) fresh.set(f.path, f);
      if (w === "opencode" || w === "hermes") return;
      for (const f of files) {
        const c = w.driver.classify(w.root, f);
        if (!c) continue;
        cands.push(c);
        const d = c.path.slice(0, c.path.lastIndexOf("/"));
        (dirs.get(d) ?? dirs.set(d, []).get(d)!).push(c.path);
        if (c.agent === "codex") {
          const id = codexSessionId(c.path);
          if (id) this.codexIndex.set(id, c.path);
        }
        const qd = w.driver.dir?.(w.root, c);
        if (qd && full) (this.quickDirs.get(c.agent) ?? this.quickDirs.set(c.agent, new Set()).get(c.agent)!).add(qd);
      }
    });
    // Quick listings may report only new files: merge them; a full listing is the truth.
    for (const [d, files] of dirs) this.dirIndex.set(d, full ? files : [...new Set([...(this.dirIndex.get(d) ?? []), ...files])]);

    // 2. Which files to start following. Sessions before subagents, so a parent is in the office before its interns.
    cands.sort((a, b) => Number(!!a.subagent) - Number(!!b.subagent));
    const toTrack: Candidate[] = [];
    for (const c of cands) {
      if (this.tracked.has(c.path) || this.opening.has(c.path)) continue;
      const prev = this.seen.get(c.path);
      this.seen.set(c.path, { size: c.size, mtimeMs: c.mtimeMs });
      const recent = now - c.mtimeMs <= ACTIVE_WINDOW_MS;
      const changed = !!prev && (prev.size !== c.size || prev.mtimeMs !== c.mtimeMs);
      if (initial || !prev ? recent : changed) toTrack.push(c);
    }
    if (toTrack.length) await this.trackMany(toTrack, fresh);

    // 3. What the followed files gained.
    await this.updateAll(fresh, pre, full);
    if (this.stopped) return;

    // 4. opencode's database.
    if (this.ocDb && !this.ocOff) await this.pollOpencode(now, full, fresh);
    if (this.hmDb && !this.hmOff) await this.pollHermes(now, full, fresh);

    // 5. MCP signals, now that the workers they belong to are fresh.
    await this.pollOutbox(outbox, initial);

    this.housekeeping(this.now());
  }

  private watchedMains(agent: AgentKind): string[] {
    const out: string[] = [];
    for (const t of this.tracked.values()) if (t.agent === agent && !t.sub) out.push(t.path);
    return out;
  }

  /* ---------------------------------------------------------- tracking */

  private async trackMany(cands: Candidate[], listed: Map<string, FileStat>, activeAt?: number): Promise<void> {
    // In slices, so a startup with hundreds of active files never holds all their windows at once.
    for (let i = 0; i < cands.length; i += OPEN_BATCH) {
      if (this.stopped) return;
      await this.trackSlice(cands.slice(i, i + OPEN_BATCH), listed, activeAt);
      if (i + OPEN_BATCH < cands.length) await new Promise((r) => setImmediate(r));
    }
  }

  private async trackSlice(cands: Candidate[], listed: Map<string, FileStat>, activeAt?: number): Promise<void> {
    const todo = cands.filter((c) => !this.tracked.has(c.path) && !this.opening.has(c.path));
    if (!todo.length) return;
    for (const c of todo) this.opening.add(c.path);
    try {
      const opened = await this.openMany(todo, listed);
      if (activeAt) for (const t of opened) t.activeAt = activeAt;
      await this.fillWindows(opened.filter((t) => t.backlog === undefined && t.docText === undefined));
      for (const t of opened) this.waiting.set(t.path, t);
      for (const t of opened) {
        if (this.stopped) return;
        await this.admit(t);
      }
    } finally {
      for (const c of todo) {
        this.opening.delete(c.path);
        this.waiting.delete(c.path);
      }
    }
  }

  /**
   * Build each file's parser from its header and sibling meta files, and read its
   * tail window, all in one batched read (one round trip on a remote).
   */
  private async openMany(cands: Candidate[], listed: Map<string, FileStat>): Promise<Tracked[]> {
    const src = this.source;
    const reqs: ReadRequest[] = [];
    const slot = new Map<string, number>();
    const add = (key: string, r: ReadRequest) => {
      if (slot.has(key)) return;
      slot.set(key, reqs.length);
      reqs.push(r);
    };
    const metaPathOf = (c: Candidate): string | undefined => {
      const dir = c.path.slice(0, c.path.lastIndexOf("/"));
      const id = basename(c.path).replace(/\.jsonl$/, "");
      if (c.agent === "claude" && claudeFileInfo(c.path).agentId) return c.path.replace(/\.jsonl$/, ".meta.json");
      if (c.agent === "commandcode") return `${dir}/${id}.meta.json`;
      if (c.agent === "droid") return `${dir}/${id}.settings.json`;
      return undefined;
    };
    const wantsHead = (c: Candidate) => c.agent === "codex" || c.agent === "commandcode" || c.agent === "droid" || (c.agent === "gemini" && !c.doc);
    const projRootOf = (c: Candidate) => c.path.split("/chats/")[0]! + "/.project_root";
    for (const c of cands) {
      if (wantsHead(c)) add(`h ${c.path}`, { path: c.path, start: 0, end: HEAD_BYTES });
      const mp = metaPathOf(c);
      if (mp) add(`m ${mp}`, { path: mp, start: 0, end: 1 << 20 });
      if (c.agent === "gemini") add(`p ${projRootOf(c)}`, { path: projRootOf(c), start: 0, end: 4096 });
      if (c.doc) add(`d ${c.path}`, { path: c.path, start: 0, end: Math.min(c.size, this.maxDoc) });
      else add(`w ${c.path}`, { path: c.path, start: Math.max(0, c.size - this.tailWindow), end: c.size });
    }
    const bufs = reqs.length ? await src.read(reqs) : [];
    const got = (key: string) => {
      const i = slot.get(key);
      return i === undefined ? undefined : bufs[i] ?? null;
    };
    const json = (b: Buffer | null | undefined): Record<string, any> | null => {
      if (!b || b.length >= 1 << 20) return null;
      const o = parseJson(b.toString("utf8"));
      return o;
    };

    // Headers longer than HEAD_BYTES (Codex session_meta can be) get a read of their own.
    const heads = new Map<string, string>();
    const long: string[] = [];
    for (const c of cands) {
      if (!wantsHead(c)) continue;
      const b = got(`h ${c.path}`);
      const nl = b ? b.indexOf(10) : -1;
      if (b && nl >= 0) heads.set(c.path, b.subarray(0, nl).toString("utf8"));
      else if (b && b.length >= HEAD_BYTES) long.push(c.path);
    }
    if (long.length) (await readHeadLines(src, long, 1 << 20)).forEach((h, i) => heads.set(long[i]!, h));

    const out: Tracked[] = [];
    for (const c of cands) {
      try {
        const metaPath = metaPathOf(c);
        const meta = metaPath ? json(got(`m ${metaPath}`)) : null;
        const t: Tracked = {
          agent: c.agent,
          path: c.path,
          sub: !!c.subagent,
          doc: !!c.doc,
          parser: undefined as unknown as Parser,
          tail: new LineTail(c.path),
          ino: c.ino,
          size: c.size,
          mtimeMs: c.mtimeMs,
          grewAt: this.now(),
          ids: new Set(),
          ...(c.parentPath ? { parentPath: c.parentPath } : {}),
        };
        if (metaPath && (c.agent === "claude" || c.agent === "droid")) {
          t.metaPath = metaPath;
          t.metaMtime = listed.get(metaPath)?.mtimeMs;
        }
        const pr = c.agent === "gemini" ? got(`p ${projRootOf(c)}`)?.toString("utf8").split("\n")[0]?.trim() : undefined;
        t.parser = await this.parserFor(c, heads.get(c.path) ?? "", meta, pr && /^(?:\/|[A-Za-z]:[\\/])/.test(pr) ? pr : undefined);
        if (c.agent === "claude" && meta?.finished === true) t.finished = true;
        if (c.doc) {
          t.docText = c.size <= this.maxDoc ? got(`d ${c.path}`)?.toString("utf8") ?? "" : "";
          t.tail.offset = c.size;
        } else {
          const b = got(`w ${c.path}`);
          const start = Math.max(0, c.size - this.tailWindow);
          t.tail.seek(start);
          const lines = b ? t.tail.take(b) : [];
          // Too few whole lines in the window (huge lines): fillWindows widens it.
          if (!(start > 0 && lines.length < 8)) t.backlog = lines;
        }
        out.push(t);
      } catch (err) {
        this.log(`ingest: could not open ${basename(c.path)}: ${(err as Error)?.message ?? err}`);
        this.seen.set(c.path, { size: c.size, mtimeMs: c.mtimeMs });
      }
    }
    return out;
  }

  private async parserFor(c: Candidate, head: string, meta: Record<string, any> | null, projectRoot?: string): Promise<Parser> {
    const dir = c.path.slice(0, c.path.lastIndexOf("/"));
    const file = basename(c.path).replace(/\.jsonl?$/, "");
    const slugProject = (basename(dir).split("-").filter(Boolean).pop() ?? "");
    switch (c.agent) {
      case "claude": {
        const info = claudeFileInfo(c.path);
        const role = claudeRole(meta);
        const state = createClaudeState({ ...info, ...(role ? { role } : {}) });
        if (!info.agentId) state.main.project = slugProject;
        return {
          state,
          parse: (l) => parseClaudeLine(state, l),
          meta: (j) => (j?.finished === true ? emit(state.main, "subagent_end", iso(this.now())) : []),
        };
      }
      case "commandcode": {
        const h = parseJson(head);
        let cwd = h?.type === "session" && typeof h.cwd === "string" ? h.cwd : undefined;
        cwd ??= (await this.siblingCwd(dir)) ?? undefined;
        const state = createCommandCodeState({
          sessionId: file,
          ...(cwd ? { cwd } : {}),
          ...(typeof meta?.model === "string" ? { model: meta.model } : {}),
        });
        if (!state.main.project) state.main.project = slugProject;
        return { state, parse: (l) => parseCommandCodeLine(state, l) };
      }
      case "codex": {
        const state = createCodexState({ sessionId: codexSessionId(c.path) ?? file });
        // The session header names the cwd and, for subagents, the parent thread.
        if (parseJson(head)?.type === "session_meta") parseCodexLine(state, head);
        return { state, parse: (l) => parseCodexLine(state, l) };
      }
      case "droid": {
        const state = createDroidState({ sessionId: file });
        if (parseJson(head)?.type === "session_start") parseDroidLine(state, head);
        if (!state.main.project) state.main.project = slugProject;
        applyDroidSettings(state, meta);
        return {
          state,
          parse: (l) => parseDroidLine(state, l),
          meta: (j) => {
            applyDroidSettings(state, j);
            return [];
          },
        };
      }
      case "qwen": {
        const state = createQwenState({ sessionId: file });
        state.main.project = basename(dir.replace(/\/chats$/, "")).split("-").filter(Boolean).pop() ?? "";
        return { state, parse: (l) => parseQwenLine(state, l) };
      }
      case "cursor": {
        const parts = c.path.split("/");
        const ai = parts.lastIndexOf("agent-transcripts");
        const slug = parts[ai - 1] ?? "";
        const parentId = c.subagent ? parts[ai + 1] : undefined;
        const state = createCursorState({ sessionId: file, slug, ...(parentId ? { parentId } : {}) });
        return {
          state,
          parse: (l) => parseCursorLine(state, l),
          clock: (ms) => {
            state.clock = iso(ms);
          },
        };
      }
      case "gemini": {
        const h = parseJson(head);
        const projDir = c.path.split("/chats/")[0]!;
        const cwd = projectRoot;
        const name = basename(projDir);
        const sessionId = typeof h?.sessionId === "string" && h.sessionId ? h.sessionId : c.subagent ? file : geminiShortId(basename(c.path)) ?? file;
        const state = createGeminiState({
          sessionId,
          ...(c.parentId ? { parentId: c.parentId } : {}),
          ...(cwd ? { cwd } : /^[0-9a-f]{40,}$/.test(name) ? {} : { project: name }),
        });
        if (h) parseGeminiLine(state, head);
        return { state, parse: (l) => parseGeminiLine(state, l), ...(c.doc ? { doc: (text: string) => parseGeminiDoc(state, text) } : {}) };
      }
      default:
        throw new Error(`no parser for ${c.agent}`);
    }
  }

  /** Legacy Command Code files carry no cwd; a v3 sibling in the same project folder does. */
  private async siblingCwd(dir: string): Promise<string | null> {
    if (this.ccCwd.has(dir)) return this.ccCwd.get(dir)!;
    let found: string | null = null;
    const names = (this.dirIndex.get(dir) ?? []).slice(0, 12);
    const heads = await readHeadLines(this.source, names, 1 << 20).catch(() => [] as string[]);
    for (const h of heads) {
      const o = parseJson(h);
      if (o?.type === "session" && typeof o.cwd === "string") {
        found = o.cwd;
        break;
      }
    }
    this.ccCwd.set(dir, found);
    return found;
  }

  /** Read (or widen) the tail window of each file, one batch per window size. */
  private async fillWindows(ts: Tracked[]): Promise<void> {
    let todo = ts.filter((t) => !t.doc).map((t) => ({ t, window: Math.min(this.tailWindow * 4, this.readCap) }));
    while (todo.length) {
      const reqs: ReadRequest[] = todo.map(({ t, window }) => ({ path: t.path, start: Math.max(0, t.size - window), end: t.size }));
      const bufs = await this.source.read(reqs);
      const again: typeof todo = [];
      todo.forEach(({ t, window }, i) => {
        const start = reqs[i]!.start;
        t.tail.seek(start);
        t.backlog = bufs[i] ? t.tail.take(bufs[i]!) : [];
        if (start > 0 && t.backlog.length < 8 && window < Math.min(MAX_WINDOW, this.readCap)) again.push({ t, window: Math.min(window * 4, this.readCap) });
      });
      todo = again;
    }
  }

  /** Register a newly followed file, make sure its parent is in the office, then pose its workers. */
  private async admit(t: Tracked): Promise<void> {
    if (t.admitted) return;
    t.admitted = true;
    this.tracked.set(t.path, t);
    this.seen.delete(t.path);
    this.register(t);
    await this.ensureParent(t);
    if (t.agent === "cursor" && t.sub) this.cursorRole(t);
    t.parser.clock?.(t.mtimeMs);
    const events = t.doc ? this.parseDoc(t, t.docText ?? "") : await this.parseBacklog(t);
    t.docText = undefined;
    this.register(t);
    for (const c of t.parser.state.workers.values()) c.lastActivityMs = t.mtimeMs;
    this.forwardAll(this.condense(t.parser.state, events, { lastWrite: t.mtimeMs, finished: !!t.finished, activeAt: t.activeAt }));
  }

  private cursorRole(t: Tracked): void {
    const ctx = t.parser.state.main;
    const parent = t.parentPath ? this.tracked.get(t.parentPath) : undefined;
    const role = (parent?.parser.state as CursorState | undefined)?.lastSpawnRole;
    if (role && ctx.role === "subagent") ctx.role = role;
  }

  private register(t: Tracked): void {
    const ids = new Set(t.parser.state.workers.keys());
    for (const id of t.ids) if (!ids.has(id) && this.registry.get(id)?.agent === t.agent) this.registry.delete(id);
    for (const [id, c] of t.parser.state.workers) this.registry.set(id, c);
    t.ids = ids;
  }

  /** Make sure an intern's parent is in the office first; an intern with no findable parent stands alone. */
  private async ensureParent(t: Tracked): Promise<void> {
    const ctx = t.parser.state.main;
    if (!ctx.parentId) return;
    let parent = this.registry.get(ctx.parentId);
    if (!parent) {
      let ppath = t.parentPath;
      if (!ppath && t.agent === "codex") ppath = await this.findCodex(ctx.parentId);
      if (!ppath && t.agent === "gemini") ppath = this.findGeminiParent(t.path, ctx.parentId);
      if (ppath) {
        const queued = this.waiting.get(ppath);
        if (queued) await this.admit(queued);
        else if (!this.tracked.has(ppath) && !this.opening.has(ppath)) {
          const [st] = await this.source.stat([ppath]);
          if (st) await this.trackMany([{ ...st, agent: t.agent }], new Map(), t.mtimeMs);
        }
        parent = this.registry.get(ctx.parentId);
      }
    }
    if (!parent) {
      delete ctx.parentId;
      return;
    }
    if (!parent.announced) {
      // Announce as active now: its intern is, and a stale timestamp would send it straight home.
      const ts = iso(Math.max(Date.parse(parent.lastTs ?? "") || 0, t.mtimeMs));
      parent.keepTs = ts;
      this.forwardAll(emit(parent, "session_start", ts));
    }
  }

  private async findCodex(id: string): Promise<string | undefined> {
    const hit = this.codexIndex.get(id);
    if (hit) return hit;
    const now = this.now();
    const w = this.roots.find((r) => r.driver.agent === "codex");
    if (!w || now - this.lastCodexSearch < this.fullMs) return undefined;
    this.lastCodexSearch = now;
    const [files] = await this.source.list(w.driver.lists(w.root, true, { watched: [], dirs: new Set(), now }));
    for (const f of files ?? []) {
      const cid = codexSessionId(f.path);
      if (cid) this.codexIndex.set(cid, f.path);
    }
    return this.codexIndex.get(id);
  }

  /** Gemini subagents live in chats/<parentSessionId>/; the parent is chats/session-*-<first 8 of its id>.jsonl. */
  private findGeminiParent(path: string, parentId: string): string | undefined {
    const chats = path.slice(0, path.lastIndexOf("/", path.lastIndexOf("/") - 1));
    const short = parentId.slice(0, 8);
    return (this.dirIndex.get(chats) ?? []).find((p) => basename(p).startsWith("session-") && basename(p).endsWith(`-${short}.jsonl`));
  }

  private parseLine(t: Tracked, line: string): RawEvent[] {
    try {
      return t.parser.parse(line);
    } catch (err) {
      this.log(`ingest: skipped a line of ${basename(t.path)}: ${(err as Error)?.message ?? err}`);
      return [];
    }
  }

  /** A backfill window can be thousands of lines: parse it in slices so the server keeps answering. */
  private async parseBacklog(t: Tracked): Promise<RawEvent[]> {
    const lines = t.backlog ?? [];
    t.backlog = undefined;
    const events: RawEvent[] = [];
    let slice = performance.now();
    for (const l of lines) {
      events.push(...this.parseLine(t, l));
      if (performance.now() - slice > PARSE_SLICE_MS) {
        await new Promise((r) => setImmediate(r));
        slice = performance.now();
      }
    }
    return events;
  }

  private parseDoc(t: Tracked, text: string): RawEvent[] {
    try {
      return t.parser.doc?.(text) ?? [];
    } catch (err) {
      this.log(`ingest: skipped ${basename(t.path)}: ${(err as Error)?.message ?? err}`);
      return [];
    }
  }

  /** From a rebuilt state, only what poses each live worker: its arrival plus its latest status. */
  private condense(state: ParserState, events: RawEvent[], o: { lastWrite: number; finished?: boolean; activeAt?: number }): RawEvent[] {
    const now = this.now();
    const groups = new Map<string, RawEvent[]>();
    for (const e of events) {
      let g = groups.get(e.workerId);
      if (!g) groups.set(e.workerId, (g = []));
      g.push(e);
    }
    const out: RawEvent[] = [];
    for (const [id, evs] of groups) {
      const ctx = state.workers.get(id);
      if (!ctx || !ctx.announced) continue; // ended inside the window
      if (ctx.parentId && !ctx.synthetic) {
        const limit = internQuietLimit(ctx);
        if (o.finished || now - o.lastWrite > limit) {
          ctx.announced = false;
          continue;
        }
      }
      // Tokens counted after the last event (opencode's step-finish closes a step) ride along too.
      let tokens = ctx.pendingTokens;
      ctx.pendingTokens = 0;
      for (const e of evs) tokens += e.tokens ?? 0;
      let last: RawEvent | undefined;
      for (let i = evs.length - 1; i >= 0 && !last; i--) if (STATUS.has(evs[i]!.kind)) last = evs[i];
      let ts = (last ?? evs[evs.length - 1]!).ts;
      if (o.activeAt && ctx === state.main && o.activeAt > (Date.parse(ts) || 0)) {
        ts = iso(Math.min(o.activeAt, now));
        ctx.keepTs = ts;
      }
      const ann = announcement(ctx, ts);
      if (tokens) ann.tokens = tokens;
      out.push(ann);
      if (last) {
        const { tokens: _drop, ...pose } = last;
        out.push(pose);
      }
    }
    return out.sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId));
  }

  /**
   * What every followed file gained: sizes from this poll's listing (or a stat),
   * bytes from the prefetch that came with the listing (or one batched read),
   * parsed in order, sessions first.
   */
  private async updateAll(fresh: Map<string, FileStat>, pre: Map<string, Buffer | null>, full: boolean): Promise<void> {
    const list = [...this.tracked.values()].sort((a, b) => Number(a.sub) - Number(b.sub));
    if (!list.length) return;
    // With a prefetch, a file outside this poll's listing that came back (even empty: nothing new) exists;
    // only the ones that didn't are stat'ed, and everything is on full polls (truncation, replacement).
    const prefetching = pre.size > 0;
    const mustStat = (path: string) => !fresh.has(path) && (!prefetching || full || !pre.get(path));
    const need = list.filter((t) => mustStat(t.path)).map((t) => t.path);
    const metas = list.filter((t) => t.metaPath && !fresh.has(t.metaPath) && (!prefetching || full)).map((t) => t.metaPath!);
    const asked = [...need, ...metas];
    const stats = asked.length ? await this.source.stat(asked) : [];
    const statOf = new Map<string, FileStat | null>();
    asked.forEach((p, i) => statOf.set(p, stats[i] ?? null));
    const metaStat = (p: string) => fresh.get(p) ?? statOf.get(p) ?? undefined;

    // Sibling meta files that changed (a finished subagent's too: it may have been resumed).
    const metaChanged = list.filter((t) => {
      if (!t.metaPath) return false;
      const m = metaStat(t.metaPath)?.mtimeMs;
      return m !== undefined && m !== t.metaMtime;
    });
    if (metaChanged.length) {
      const json = await readJsonFiles(this.source, metaChanged.map((t) => t.metaPath!));
      metaChanged.forEach((t, i) => {
        t.metaMtime = metaStat(t.metaPath!)!.mtimeMs;
        const j = json[i] ?? null;
        if (t.agent === "claude") {
          const done = j?.finished === true;
          if (done === !!t.finished) return;
          t.finished = done;
          if (!done) {
            // Resumed: the intern walks back in with its next line.
            t.parser.state.main.announced = false;
            return;
          }
        }
        this.forwardAll(t.parser.meta?.(j) ?? []);
      });
    }

    const reads: ReadRequest[] = [];
    const readers: Tracked[] = [];
    const ready = new Map<Tracked, Buffer>();
    const caught: Tracked[] = [];
    for (const t of list) {
      const p = pre.get(t.path);
      const st = fresh.get(t.path) ?? statOf.get(t.path);
      if (st === null) {
        this.untrack(t);
        continue;
      }
      if (!st) {
        // Remote quick poll, file outside the listing: the prefetch alone says it grew.
        if (p?.length) {
          ready.set(t, p);
          t.size = t.tail.offset + p.length;
          t.grewAt = this.now();
        }
        continue;
      }
      if (t.doc) {
        if (st.size !== t.size || st.mtimeMs !== t.mtimeMs) {
          reads.push({ path: t.path, start: 0, end: Math.min(st.size, this.maxDoc) });
          readers.push(t);
          t.grewAt = this.now();
        }
      } else if (st.ino !== t.ino || st.size < t.tail.offset) {
        // Replaced or truncated: start over from the new tail.
        t.ino = st.ino;
        caught.push(t);
      } else if (st.size > t.tail.offset) {
        const want = st.size - t.tail.offset;
        if (want > LIVE_JUMP) caught.push(t);
        else if (p?.length) ready.set(t, p.length > want ? p.subarray(0, want) : p);
        else if (p === undefined || p === null) {
          reads.push({ path: t.path, start: t.tail.offset, end: st.size });
          readers.push(t);
        }
        // An empty prefetch with a bigger size: the bytes landed after the read; next poll has them.
        t.grewAt = this.now();
      }
      t.size = st.size;
      t.mtimeMs = st.mtimeMs;
    }

    if (caught.length) {
      for (const t of caught) t.tail.seek(Math.max(0, t.size - this.tailWindow));
      const bufs = await this.source.read(caught.map((t) => ({ path: t.path, start: t.tail.offset, end: t.size })));
      const narrow: Tracked[] = [];
      caught.forEach((t, i) => {
        const start = t.tail.offset;
        t.backlog = bufs[i] ? t.tail.take(bufs[i]!) : [];
        if (start > 0 && t.backlog.length < 8) narrow.push(t);
      });
      if (narrow.length) await this.fillWindows(narrow);
      for (const t of caught) {
        t.grewAt = this.now();
        t.parser.clock?.(t.mtimeMs);
        const events = await this.parseBacklog(t);
        this.register(t);
        for (const c of t.parser.state.workers.values()) c.lastActivityMs = t.mtimeMs;
        this.forwardAll(this.condense(t.parser.state, events, { lastWrite: t.mtimeMs, finished: !!t.finished }));
      }
    }

    if (reads.length) {
      const bufs = await this.source.read(reads);
      readers.forEach((t, i) => {
        const buf = bufs[i];
        if (buf) ready.set(t, buf);
        else this.untrack(t);
      });
    }
    if (!ready.size) return;
    const now = this.now();
    for (const t of list) {
      const buf = ready.get(t);
      if (!buf || this.stopped || !this.tracked.has(t.path)) continue;
      t.parser.clock?.(now);
      const events = t.doc ? this.parseDoc(t, buf.toString("utf8")) : t.tail.take(buf).flatMap((l) => this.parseLine(t, l));
      this.register(t);
      t.parser.state.main.lastActivityMs = now;
      for (const e of events) {
        const c = t.parser.state.workers.get(e.workerId);
        if (!c) continue;
        c.lastActivityMs = now;
        if (e.kind === "tool_start" && e.tool && OFFICE_TOOL.test(e.tool)) c.officeCall = { tool: e.tool, at: now };
      }
      if (!t.finished) this.forwardAll(events);
    }
  }

  private untrack(t: Tracked): void {
    this.tracked.delete(t.path);
    for (const id of t.ids) if (this.registry.get(id) === t.parser.state.workers.get(id)) this.registry.delete(id);
    this.seen.set(t.path, { size: t.size, mtimeMs: t.mtimeMs });
  }

  /* ----------------------------------------------------------- opencode */

  private async pollOpencode(now: number, full: boolean, listed: Map<string, FileStat>): Promise<void> {
    const db = this.ocDb!;
    const main = listed.get(db);
    const wal = listed.get(`${db}-wal`);
    if (!main) return;
    const sig = [main, wal].map((s) => (s ? `${s.size}:${s.mtimeMs}:${s.ino}` : "-")).join("|");
    if (sig === this.ocSig && !full) return;
    this.ocSig = sig;
    try {
      if (!this.ocCols) {
        const cols = await this.source.query(db, "select name from pragma_table_info('session')");
        if (cols === null) {
          this.ocOff = true;
          this.log(`ingest: ${BRAND.opencode.name} needs SQLite (Node >= 22.5${this.local ? "" : ", or sqlite3 on the remote"}); skipping it${this.local ? "" : ` on ${this.name}`}`);
          return;
        }
        this.ocCols = new Set(cols.map((r) => String(r.name)));
        if (!this.ocCols.has("time_updated")) {
          this.ocOff = true;
          this.log(`ingest: ${BRAND.opencode.name} database has an unknown layout; skipping it`);
          return;
        }
      }
      const since = this.ocCursor ?? now - ACTIVE_WINDOW_MS;
      const rows = (await this.source.query(db, sessionSql(this.ocCols, "updated"), [Math.floor(since) - 2_000])) ?? [];
      const sessions = rows.map(asSession).filter((s): s is OcSession => !!s);
      for (const s of sessions) this.ocCursor = Math.max(this.ocCursor ?? since, s.time_updated);
      this.ocCursor ??= since;
      // The database changed (sig above), and opencode stamps in ms: a second write in the same ms as
      // the last one seen leaves time_updated equal, so equal counts as changed. Rows already folded in
      // say nothing when read again.
      const changed = sessions.filter((s) => (this.oc.get(s.id)?.updated ?? -1) <= s.time_updated || !this.oc.has(s.id));
      if (!changed.length) return;
      const known = changed.filter((s) => this.oc.has(s.id));
      const fresh = changed.filter((s) => !this.oc.has(s.id)).sort((a, b) => Number(!!a.parent_id) - Number(!!b.parent_id));
      if (fresh.length) await this.ocLoad(fresh, true);
      if (known.length) await this.ocLoad(known, false);
    } catch (err) {
      this.log(`ingest: reading ${BRAND.opencode.name} failed: ${(err as Error)?.message ?? err}`);
      this.ocSig = "";
    }
  }

  /** Fetch the latest messages and their parts for these sessions, fold them in, and post (or pose) the result. */
  private async ocLoad(sessions: OcSession[], first: boolean, activeAt?: number): Promise<void> {
    const db = this.ocDb!;
    const limit = first ? OC_BACKFILL_MSGS : OC_LIVE_MSGS;
    const msgs: OcMessage[] = [];
    const parts: OcPart[] = [];
    for (let i = 0; i < sessions.length; i += 100) {
      const ids = sessions.slice(i, i + 100).map((s) => s.id);
      // Independent queries over the same window: one round trip of wall time on a remote.
      const [mrows, prows] = await Promise.all([
        this.source.query(db, messagesSql(ids.length), [...ids, limit]),
        this.source.query(db, partsSql(ids.length), [...ids, limit]),
      ]);
      for (const r of mrows ?? []) {
        const m = asMessage(r);
        if (m) msgs.push(m);
      }
      for (const r of prows ?? []) {
        const p = asPart(r);
        if (p) parts.push(p);
      }
    }
    const msgsOf = new Map<string, OcMessage[]>();
    for (const m of msgs) (msgsOf.get(m.session_id) ?? msgsOf.set(m.session_id, []).get(m.session_id)!).push(m);
    const msgSession = new Map(msgs.map((m) => [m.id, m.session_id]));
    const partsOf = new Map<string, OcPart[]>();
    for (const p of parts) {
      const sid = msgSession.get(p.message_id);
      if (sid) (partsOf.get(sid) ?? partsOf.set(sid, []).get(sid)!).push(p);
    }
    const now = this.now();
    for (const s of sessions) {
      let entry = this.oc.get(s.id);
      const isNew = !entry;
      if (!entry) {
        entry = { st: createOpencodeState(s), updated: s.time_updated };
        this.oc.set(s.id, entry);
      }
      entry.updated = s.time_updated;
      const st = entry.st;
      for (const [id, c] of st.workers) this.registry.set(id, c);
      if (isNew && st.main.parentId) await this.ocParent(st, s);
      const events = applyOpencode(st, msgsOf.get(s.id) ?? [], partsOf.get(s.id) ?? []);
      if (isNew) {
        st.main.lastActivityMs = s.time_updated;
        this.forwardAll(this.condense(st, events, { lastWrite: s.time_updated, activeAt }));
      } else {
        if (events.length) st.main.lastActivityMs = now;
        this.forwardAll(events);
      }
    }
  }

  /** A subagent session whose parent isn't in the office yet: load the parent first, announced as active. */
  private async ocParent(st: OpencodeState, s: OcSession): Promise<void> {
    const pid = st.main.parentId!;
    let parent = this.registry.get(pid);
    if (!parent) {
      const rows = (await this.source.query(this.ocDb!, sessionSql(this.ocCols!, "id"), [pid])) ?? [];
      const ps = rows.map(asSession).find((x): x is OcSession => !!x);
      if (ps && !this.oc.has(ps.id)) await this.ocLoad([ps], true, s.time_updated);
      parent = this.registry.get(pid);
    }
    if (!parent) {
      delete st.main.parentId;
      return;
    }
    if (!parent.announced) {
      const ts = iso(Math.max(Date.parse(parent.lastTs ?? "") || 0, s.time_updated));
      parent.keepTs = ts;
      this.forwardAll(emit(parent, "session_start", ts));
    }
  }

  /* ------------------------------------------------------------- hermes */

  private async pollHermes(now: number, full: boolean, listed: Map<string, FileStat>): Promise<void> {
    const db = this.hmDb!;
    const main = listed.get(db);
    const wal = listed.get(`${db}-wal`);
    if (!main) return;
    const sig = [main, wal].map((s) => (s ? `${s.size}:${s.mtimeMs}:${s.ino}` : "-")).join("|");
    if (sig === this.hmSig && !full) return;
    this.hmSig = sig;
    try {
      if (!this.hmCols) {
        const cols = await this.source.query(db, "select name from pragma_table_info('sessions')");
        if (cols === null) {
          this.hmOff = true;
          this.log(`ingest: ${BRAND.hermes.name} needs SQLite (Node >= 22.5${this.local ? "" : ", or sqlite3 on the remote"}); skipping it${this.local ? "" : ` on ${this.name}`}`);
          return;
        }
        this.hmCols = new Set(cols.map((r) => String(r.name)));
        if (!this.hmCols.has("last_activity_at")) {
          this.hmOff = true;
          this.log(`ingest: ${BRAND.hermes.name} database has an unknown layout; skipping it`);
          return;
        }
      }
      if (this.hmCursor === undefined) {
        // First look: the newest row id first, so a row written while the rest loads is read again
        // (and deduped) rather than missed; then the sessions active lately, posed from their latest rows.
        const top = (await this.source.query(db, HM_MAX_ID_SQL)) ?? [];
        const cursor = Number(top[0]?.id) || 0;
        const since = (now - ACTIVE_WINDOW_MS) / 1000;
        const rows = (await this.source.query(db, hmSessionSql(this.hmCols, "recent"), [since - HM_HEARTBEAT_SLACK_S, since])) ?? [];
        await this.hmLoad(this.hmSessions(rows));
        this.hmCursor = cursor;
        return;
      }
      // Live: every row written since the last one read. sessions.last_activity_at can't say which
      // sessions moved: Hermes heartbeats it at most once a minute, and a new message doesn't touch it.
      const rows = (await this.source.query(db, hmMessagesAfterSql(), [this.hmCursor, HM_LIVE_MSGS_MAX])) ?? [];
      if (!rows.length) return;
      const msgs = rows.map(asHermesMessage).filter((m): m is HmMessage => !!m);
      const ids = [...new Set(msgs.map((m) => m.session_id))];
      const unknown = ids.filter((id) => !this.hm.has(id));
      this.hmLive(msgs.filter((m) => this.hm.has(m.session_id)));
      for (let i = 0; i < unknown.length; i += 100) {
        const chunk = unknown.slice(i, i + 100);
        await this.hmLoad(this.hmSessions((await this.source.query(db, hmSessionSql(this.hmCols, "ids", chunk.length), chunk)) ?? []));
      }
      // Past the page only once it is handled: a session lookup that fails (a locked database) reads the
      // same page again next tick, and the rows already folded in say nothing the second time.
      for (const r of rows) this.hmCursor = Math.max(this.hmCursor, Number(r.id) || 0);
      // A full page: more rows wait behind it, so read again next tick even if the files look the same.
      if (rows.length >= HM_LIVE_MSGS_MAX) this.hmSig = "";
    } catch (err) {
      this.log(`ingest: reading ${BRAND.hermes.name} failed: ${(err as Error)?.message ?? err}`);
      this.hmSig = "";
    }
  }

  /** Well-formed session rows, parents before their subagents. */
  private hmSessions(rows: Record<string, unknown>[]): HmSession[] {
    return rows.map(asHermesSession).filter((s): s is HmSession => !!s).sort((a, b) => Number(!!a.subagent) - Number(!!b.subagent));
  }

  /** First sight of these sessions: read their latest rows, fold them in, and pose the result. */
  private async hmLoad(sessions: HmSession[], activeAt?: number): Promise<void> {
    if (!sessions.length) return;
    const db = this.hmDb!;
    const msgs: HmMessage[] = [];
    for (let i = 0; i < sessions.length; i += 100) {
      const ids = sessions.slice(i, i + 100).map((s) => s.id);
      const rows = (await this.source.query(db, hmMessagesSql(ids.length), [...ids, HM_BACKFILL_MSGS])) ?? [];
      for (const r of rows) {
        const m = asHermesMessage(r);
        if (m) msgs.push(m);
      }
    }
    const msgsOf = new Map<string, HmMessage[]>();
    for (const m of msgs) (msgsOf.get(m.session_id) ?? msgsOf.set(m.session_id, []).get(m.session_id)!).push(m);
    for (const s of sessions) {
      // Already loaded as another session's parent.
      if (this.hm.has(s.id)) continue;
      const st = createHermesState(s);
      this.hm.set(s.id, { st, updated: s.active_at });
      for (const [id, c] of st.workers) this.registry.set(id, c);
      if (st.main.parentId) await this.hmParent(st, s);
      const events = applyHermes(st, msgsOf.get(s.id) ?? []);
      st.main.lastActivityMs = s.active_at * 1000;
      this.forwardAll(this.condense(st, events, { lastWrite: s.active_at * 1000, activeAt }));
    }
  }

  /** Rows written since the last poll, for sessions already in the office. */
  private hmLive(msgs: HmMessage[]): void {
    const msgsOf = new Map<string, HmMessage[]>();
    for (const m of msgs) (msgsOf.get(m.session_id) ?? msgsOf.set(m.session_id, []).get(m.session_id)!).push(m);
    const now = this.now();
    for (const [sid, rows] of msgsOf) {
      const entry = this.hm.get(sid)!;
      for (const m of rows) entry.updated = Math.max(entry.updated, m.timestamp);
      const st = entry.st;
      for (const [id, c] of st.workers) this.registry.set(id, c);
      const events = applyHermes(st, rows);
      if (events.length) st.main.lastActivityMs = now;
      this.forwardAll(events);
    }
  }

  /** A subagent session whose parent isn't in the office yet: load the parent first, announced as active. */
  private async hmParent(st: HermesState, s: HmSession): Promise<void> {
    const pid = st.main.parentId!;
    let parent = this.registry.get(pid);
    if (!parent) {
      const rows = (await this.source.query(this.hmDb!, hmSessionSql(this.hmCols!, "ids"), [pid])) ?? [];
      const ps = rows.map(asHermesSession).find((x): x is HmSession => !!x);
      if (ps && !this.hm.has(ps.id)) await this.hmLoad([ps], s.active_at * 1000);
      parent = this.registry.get(pid);
    }
    if (!parent) {
      delete st.main.parentId;
      return;
    }
    if (!parent.announced) {
      const ts = iso(Math.max(Date.parse(parent.lastTs ?? "") || 0, s.active_at * 1000));
      parent.keepTs = ts;
      this.forwardAll(emit(parent, "session_start", ts));
    }
  }

  /* ------------------------------------------------------------ signals */

  private async pollOutbox(files: FileStat[], initial: boolean): Promise<void> {
    const listed = new Set(files.map((f) => f.path));
    for (const p of [...this.outboxFiles.keys()]) if (!listed.has(p)) this.outboxFiles.delete(p);
    const reqs: ReadRequest[] = [];
    const replay: boolean[] = [];
    /** Signals written well before the file's last write are old news (both times are that machine's clock). */
    const cutoff: number[] = [];
    for (const f of files) {
      let o = this.outboxFiles.get(f.path);
      if (o && (o.ino !== f.ino || f.size < o.tail.offset)) o = undefined;
      if (!o) {
        o = { ino: f.ino, tail: new LineTail(f.path) };
        this.outboxFiles.set(f.path, o);
        // Present at startup: only the latest status per agent+cwd still matters. Later: the fresh tail is news.
        const start = Math.max(0, f.size - SIGNAL_WINDOW);
        o.tail.seek(start);
        reqs.push({ path: f.path, start, end: f.size });
        replay.push(initial);
      } else if (f.size > o.tail.offset) {
        reqs.push({ path: f.path, start: o.tail.offset, end: Math.min(f.size, o.tail.offset + SIGNAL_WINDOW) });
        replay.push(false);
      } else {
        continue;
      }
      cutoff.push(f.mtimeMs - SIGNAL_STALE_MS);
    }
    const now = this.now();
    if (reqs.length) {
      const bufs = await this.source.read(reqs);
      reqs.forEach((r, i) => {
        const o = this.outboxFiles.get(r.path);
        const buf = bufs[i];
        if (!o || !buf) return;
        const lines = o.tail.take(buf);
        if (!replay[i]) {
          for (const line of lines) {
            const t = Date.parse(parseSignal(line)?.ts ?? "");
            if (!(t < cutoff[i]!)) this.pendingSignals.push({ line, at: now });
          }
          return;
        }
        const latest = new Map<string, string>();
        for (const line of lines) {
          const s = parseSignal(line);
          if (s?.kind === "status") latest.set(`${s.agent ?? ""}\0${s.cwd}`, line);
        }
        for (const line of latest.values()) this.pendingSignals.push({ line, at: now });
      });
    }
    if (!this.pendingSignals.length) return;
    const keep: { line: string; at: number }[] = [];
    for (const p of this.pendingSignals) {
      const sig = parseSignal(p.line);
      if (!sig) continue;
      const hit = pickSignalWorker(this.registry.values(), sig, this.env?.home, now);
      // Twins in one folder: give the caller's transcript a moment to show the tool call.
      if (hit && (hit.sure || now - p.at >= SIGNAL_SETTLE_MS)) {
        hit.ctx.lastActivityMs = Math.max(hit.ctx.lastActivityMs, now);
        this.forward(signalEvent(sig, hit.ctx, now));
      } else if (now - p.at < SIGNAL_WAIT_MS) {
        keep.push(p);
      }
    }
    this.pendingSignals = keep.slice(-64);
  }

  /* ------------------------------------------------------- housekeeping */

  private housekeeping(now: number): void {
    const busyParents = new Set<string>();
    for (const ctx of this.registry.values()) {
      if (ctx.agent === "gemini" && !ctx.parentId && ctx.announced && ctx.lastKind === "reply" && !ctx.pending.size && now - ctx.lastActivityMs >= GEMINI_SETTLE_MS) {
        // Stamped just after the reply, so an old session isn't made to look fresh.
        const at = Date.parse(ctx.lastTs ?? "") || now;
        this.forwardAll(emit(ctx, "waiting", iso(Math.min(now, at + 1_000)), { summary: "Waiting" }));
      }
      if (!ctx.parentId || !ctx.announced) continue;
      // Interns that went quiet have left.
      const limit = internQuietLimit(ctx);
      if (!ctx.synthetic && now - ctx.lastActivityMs > limit) {
        this.forwardAll(emit(ctx, "subagent_end", iso(now)));
        continue;
      }
      busyParents.add(ctx.parentId);
      // Keep the parent in the office while its intern works.
      const parent = this.registry.get(ctx.parentId);
      if (!parent?.announced || !ctx.lastTs) continue;
      const childT = Date.parse(ctx.lastTs);
      const ref = Math.max(Date.parse(parent.keepTs ?? "") || 0, Date.parse(parent.lastTs ?? "") || 0);
      if (childT - ref > KEEPALIVE_MS) {
        parent.keepTs = ctx.lastTs;
        this.forward(announcement(parent, ctx.lastTs));
      }
    }
    for (const t of [...this.tracked.values()]) {
      if (now - t.grewAt < FORGET_MS) continue;
      if ([...t.ids].some((id) => busyParents.has(id))) continue;
      this.untrack(t);
    }
    for (const [id, e] of [...this.oc]) {
      if (now - Math.max(e.updated, e.st.main.lastActivityMs) < FORGET_MS || busyParents.has(id)) continue;
      this.oc.delete(id);
      for (const wid of e.st.workers.keys()) if (this.registry.get(wid) === e.st.workers.get(wid)) this.registry.delete(wid);
    }
    for (const [id, e] of [...this.hm]) {
      if (now - Math.max(e.updated * 1000, e.st.main.lastActivityMs) < FORGET_MS || busyParents.has(id)) continue;
      this.hm.delete(id);
      for (const wid of e.st.workers.keys()) if (this.registry.get(wid) === e.st.workers.get(wid)) this.registry.delete(wid);
    }
  }
}

/* ================================================================= ingest */

interface Loop {
  w: Watcher;
  pollMs: number;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  again: boolean;
  failures: number;
  lastError?: string;
}

export class Ingest {
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly loops: Loop[] = [];
  private readonly watchers: FSWatcher[] = [];
  private readonly useWatch: boolean;
  private kickTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(opts: IngestOptions & IngestTuning) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    const agents = [...new Set(opts.agents)];
    const mk = (src: Source, pollMs: number) =>
      this.loops.push({ w: new Watcher(src, agents, opts.onEvent, { log: this.log, now: this.now }), pollMs, running: false, again: false, failures: 0 });
    if (opts.local !== false) mk(createLocalSource({ env: opts.env ?? process.env }), opts.pollMs ?? POLL_MS);
    for (const r of opts.remotes ?? []) mk(createRemoteSource(r as RemoteTarget), opts.remotePollMs ?? REMOTE_POLL_MS);
    for (const s of opts.sources ?? []) mk(s, opts.remotePollMs ?? opts.pollMs ?? REMOTE_POLL_MS);
    this.useWatch = opts.watch ?? (process.platform === "darwin" || process.platform === "win32");
  }

  start(): void {
    for (const l of this.loops) void this.run(l, true);
  }

  stop(): void {
    this.stopped = true;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    for (const l of this.loops) {
      l.w.stopped = true;
      if (l.timer) clearTimeout(l.timer);
      try {
        l.w.source.close();
      } catch {
        // Already closed.
      }
    }
    for (const w of this.watchers.splice(0)) {
      try {
        w.close();
      } catch {
        // Already closed.
      }
    }
  }

  /** One poll of every machine, in order, for tests. Errors propagate. */
  async tick(): Promise<void> {
    for (const l of this.loops) {
      if (this.stopped) return;
      await l.w.tick();
    }
  }

  private async run(l: Loop, first = false): Promise<void> {
    if (this.stopped || l.running) return;
    l.running = true;
    try {
      await l.w.tick();
      if (l.failures) this.log(`ingest: ${l.w.name} is reachable again`);
      l.failures = 0;
      l.lastError = undefined;
    } catch (err) {
      l.failures++;
      const msg = (err as Error)?.message ?? String(err);
      if (msg !== l.lastError) this.log(`ingest: polling ${l.w.name} failed: ${msg.split("\n")[0]}`);
      l.lastError = msg;
    }
    l.running = false;
    if (this.stopped) return;
    if (first && !l.w.source.host && this.useWatch) this.watchLocal(l);
    const backoff = l.failures ? Math.min(MAX_BACKOFF_MS, l.pollMs * 2 ** Math.min(l.failures, 6)) : l.pollMs;
    const next = l.again ? MIN_GAP_MS : backoff;
    l.again = false;
    l.timer = setTimeout(() => void this.run(l), next);
    l.timer.unref?.();
  }

  /** fs.watch only makes the next local poll come sooner; polling alone is correct. */
  private watchLocal(l: Loop): void {
    for (const root of l.w.watchRoots()) {
      try {
        const w = watch(root, { recursive: true, persistent: false }, () => this.kick(l));
        w.on("error", () => {});
        this.watchers.push(w);
      } catch {
        // Folder missing or watching unsupported.
      }
    }
  }

  private kick(l: Loop): void {
    if (this.stopped) return;
    if (l.running) {
      l.again = true;
      return;
    }
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      if (l.timer) clearTimeout(l.timer);
      void this.run(l);
    }, MIN_GAP_MS);
    this.kickTimer.unref?.();
  }
}

/** How long an intern may be quiet before it has left: longer with a call out, shorter once its turn is over. */
function internQuietLimit(ctx: WorkerCtx): number {
  if (ctx.pending.size) return SUBAGENT_BUSY_QUIET_MS;
  if (ctx.lastKind === "idle" || ctx.lastKind === "error") return INTERN_DONE_MS;
  return SUBAGENT_QUIET_MS;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createIngest(opts: IngestOptions & IngestTuning): Ingest {
  return new Ingest(opts);
}

export const startIngest: StartIngest = (opts) => {
  const ingest = new Ingest(opts);
  ingest.start();
  return { stop: () => ingest.stop() };
};

/**
 * An intern's role from its .meta.json. Workflow subagents all share one type,
 * so they go by their script label ("research:local") when it is an
 * identifier; free-text descriptions can echo the task, so they never show.
 */
function claudeRole(meta: Record<string, any> | null): string | undefined {
  const type = typeof meta?.agentType === "string" ? meta.agentType : undefined;
  const label = typeof meta?.description === "string" ? meta.description.trim() : "";
  if (type === "workflow-subagent") return /^[\w.:/-]{1,32}$/.test(label) ? label : "workflow";
  return type;
}

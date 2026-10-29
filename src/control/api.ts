/*
 * Every /api/control route (src/shared/control.ts lists them), after
 * checkControl (auth.ts) has passed: Host, origin, X-Agent-Office, cookie.
 * Bodies are JSON (415 otherwise) and capped: 1 MB for a hire, a prompt or
 * keystrokes, 64 KB for the rest (413). Errors are {error} with the status
 * of the ControlError thrown anywhere below; anything else is a 500
 * "Internal error" whose scrubbed message goes to the log. Hiring, driving
 * and the sandboxes are delegated to the sessions (A) and places (C) parts
 * through src/control/types.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { WATCH_ONLY_AGENTS, type AgentKind } from "../shared/events.ts";
import type {
  ApprovalAnswer, ControlInfo, ControlMode, HireRequest, PermissionMode, Place, PlaceKind, ServiceStatus, SetupChoice, SetupLoginKind,
} from "../shared/control.ts";
import { SECURITY_HEADERS } from "../server/http.ts";
import { scrubMessage } from "../remote/util.ts";
import { AGENT_FACTS, ControlError, KEY_NAME, type ControlContext, type Disposable, type KeyStore, type Places, type SessionManager } from "./types.ts";
import { COOKIE_REFRESH_S, type ControlAuth } from "./auth.ts";
import { expandPath, folderUnderHome, listFolders, type HiredFolders } from "./fs.ts";
import { importableNames } from "./keys.ts";
import { loginShellVars } from "./env.ts";
import type { Logins } from "./logins.ts";
import { createSetupCache, shellKeyNames, type SetupCache } from "./setup.ts";
import { Swr } from "./swr.ts";

export const BIG_BODY = 1 << 20;
export const SMALL_BODY = 64 << 10;
/** A slow stream client this far behind is dropped; it reconnects and gets the replay. */
const MAX_BACKLOG = 1 << 20;
const PING_MS = 15_000;
const HIRES_PER_MINUTE = 10;
/** How long GET /api/control waits for a platform it has no row for yet (then: its login state, and the row follows). */
export const INFO_PLACES_MS = 400;
const AGENTS = (Object.keys(AGENT_FACTS) as AgentKind[]).filter((a) => !WATCH_ONLY_AGENTS.includes(a));
const PLACES: PlaceKind[] = ["local", "ssh", "daytona", "vercel", "railway"];
const MODES: ControlMode[] = ["terminal", "chat"];
const PERMISSIONS: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];
const PROVIDERS = ["daytona", "vercel", "railway"] as const;

export interface ServiceControl {
  status(): ServiceStatus;
  /** POST /service {startAtLogin}. */
  set(startAtLogin: boolean): Promise<ServiceStatus>;
}

export interface InstallControl {
  plan(): Promise<import("../shared/control.ts").InstallPlan>;
  apply(agents?: AgentKind[]): Promise<import("../shared/control.ts").InstallPlan>;
}

export interface ApiDeps {
  ctx: ControlContext;
  auth: ControlAuth;
  keys: KeyStore;
  sessions: SessionManager | null;
  places: Places | null;
  hired: HiredFolders;
  service: ServiceControl;
  installer: InstallControl;
  /** control_info frames for the page. */
  info(patch: Partial<ControlInfo>): void;
  pingMs?: number;
  /** Settings, Logins (Connect Claude). */
  logins?: Logins | null;
  /** Known key names set in the login shell (names only); default: a fresh login shell, cached a minute. */
  shellNames?: () => Promise<string[]>;
  /** "Your setup", cached (tests pass their own). */
  setupCache?: SetupCache;
}

/* ------------------------------------------------------------- helpers */

export function sendJson(res: ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (status === 204 || body === undefined) {
    res.writeHead(status === 200 ? 204 : status, { ...SECURITY_HEADERS, "Cache-Control": "no-store", ...extra });
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(data)),
    ...extra,
  });
  res.end(data);
}

/** The request body, at most `cap` bytes. ControlError 413 past it; 415 for a non-JSON body. Empty: undefined. */
export function readJson(req: IncomingMessage, cap: number): Promise<unknown> {
  return new Promise((done, fail) => {
    const len = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(len) && len > cap) {
      req.resume();
      return fail(new ControlError(413, "That request is too large."));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > cap) {
        over = true;
        fail(new ControlError(413, "That request is too large."));
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => fail(new ControlError(400, "The request broke off.")));
    req.on("end", () => {
      if (over) return;
      if (!size) return done(undefined);
      const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/json") return fail(new ControlError(415, "Send JSON (content-type: application/json)."));
      try {
        done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        fail(new ControlError(400, "That isn't valid JSON."));
      }
    });
  });
}

/** decodeURIComponent that answers 400 instead of throwing. */
export function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new ControlError(400, "Bad path.");
  }
}

const b64 = (chunk: Uint8Array) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const bad = (msg: string) => new ControlError(400, msg);

/** A text/event-stream with pings, dropped when it falls MAX_BACKLOG behind. */
function openSse(req: IncomingMessage, res: ServerResponse, pingMs: number, onClose: () => void): (event: string, data: unknown) => void {
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  let open = true;
  const ping = setInterval(() => write(": ping\n\n"), pingMs);
  ping.unref?.();
  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(ping);
    onClose();
  };
  req.on("close", close);
  res.on("close", close);
  res.on("error", close);
  function write(frame: string): void {
    if (!open) return;
    if (res.writableLength > MAX_BACKLOG) {
      res.destroy();
      close();
      return;
    }
    res.write(frame);
  }
  return (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/* ---------------------------------------------------------- validation */

function parseHire(body: unknown, home: string): HireRequest {
  const b = obj(body);
  const agent = b.agent as AgentKind;
  if (!AGENTS.includes(agent)) throw bad("Pick an agent.");
  const mode = (b.mode ?? "terminal") as ControlMode;
  if (!MODES.includes(mode)) throw bad("Pick terminal or chat.");
  const p = obj(b.place);
  const kind = p.kind as PlaceKind;
  if (!PLACES.includes(kind)) throw bad("Pick where the agent runs.");
  if (typeof p.target !== "string" || !p.target.trim() || p.target.length > 4096 || p.target.includes("\0")) throw bad("Pick where the agent runs.");
  const place: Place = { kind, target: p.target.trim() };
  if (p.cwd !== undefined) {
    if (typeof p.cwd !== "string" || p.cwd.length > 4096 || p.cwd.includes("\0")) throw bad("Bad working folder.");
    if (p.cwd.trim()) place.cwd = p.cwd.trim();
  }
  if (kind === "local") place.target = expandPath(place.target, home);
  const req: HireRequest = { agent, place, mode };
  if (b.prompt !== undefined) {
    if (typeof b.prompt !== "string") throw bad("The prompt must be text.");
    if (b.prompt.trim()) req.prompt = b.prompt;
  }
  if (b.permission !== undefined) {
    if (!PERMISSIONS.includes(b.permission as PermissionMode)) throw bad("Unknown permission mode.");
    req.permission = b.permission as PermissionMode;
  }
  if (b.keys !== undefined) {
    if (!Array.isArray(b.keys) || b.keys.length > 32 || !b.keys.every((k) => typeof k === "string" && KEY_NAME.test(k))) throw bad("Bad key list.");
    if (b.keys.length && kind === "local") throw bad("Keys are only handed to agents in a sandbox or on an ssh box.");
    if (b.keys.length) req.keys = [...new Set(b.keys as string[])];
  }
  if (b.sandbox !== undefined) {
    const s = obj(b.sandbox);
    const sandbox: NonNullable<HireRequest["sandbox"]> = {};
    if (s.name !== undefined) {
      if (typeof s.name !== "string" || s.name.length > 64 || !/^[\w.-]*$/.test(s.name)) throw bad("A sandbox name is letters, digits, dots, dashes and underscores.");
      if (s.name) sandbox.name = s.name;
    }
    if (s.timeoutMin !== undefined) {
      if (typeof s.timeoutMin !== "number" || !Number.isFinite(s.timeoutMin)) throw bad("Bad sandbox lifetime.");
      sandbox.timeoutMin = Math.round(s.timeoutMin);
    }
    // Railway's project and environment: ids, or names (looked up in the account's list).
    for (const k of ["project", "environment"] as const) {
      if (s[k] === undefined) continue;
      if (typeof s[k] !== "string" || s[k].length > 128 || /[\0-\x1f\x7f]/.test(s[k])) throw bad(`Bad Railway ${k}.`);
      if (s[k].trim()) sandbox[k] = s[k].trim();
    }
    if (sandbox.environment && !sandbox.project) throw bad("Pick the Railway project too.");
    req.sandbox = sandbox;
  }
  if (b.setup !== undefined && b.setup !== null) {
    if (kind === "local") throw bad("Your setup is already here: it is only copied into a sandbox or an ssh box.");
    req.setup = parseSetup(b.setup, home);
  }
  return req;
}

const LOGINS: SetupLoginKind[] = ["subscription", "key", "device", "copy", "none"];
const names = (v: unknown, max: number, re: RegExp, what: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string" && re.test(x))) throw bad(`Bad ${what} list.`);
  return [...new Set(v as string[])];
};

/** HireRequest.setup: names and a folder only. */
function parseSetup(v: unknown, home: string): SetupChoice {
  const b = obj(v);
  const out: SetupChoice = {};
  if (b.login !== undefined) {
    if (!LOGINS.includes(b.login as SetupLoginKind)) throw bad("Unknown sign-in choice.");
    out.login = b.login as SetupLoginKind;
  }
  const shell = names(b.shellKeys, 32, KEY_NAME, "shell key");
  if (shell) out.shellKeys = shell;
  const mcp = names(b.mcp, 200, /^[^\0\n]{1,200}$/, "MCP server");
  if (mcp) out.mcp = mcp;
  const ins = names(b.instructions, 32, /^[\w.-]{1,40}$/, "instructions");
  if (ins) out.instructions = ins;
  if (b.project !== undefined) {
    const p = obj(b.project);
    if (typeof p.folder !== "string" || !p.folder.trim() || p.folder.length > 4096 || p.folder.includes("\0")) throw bad("Pick the project folder.");
    out.project = { folder: expandPath(p.folder.trim(), home), git: p.git !== false, env: p.env === true };
  }
  return out;
}

function parseAnswer(body: unknown): ApprovalAnswer {
  const b = obj(body);
  if (typeof b.id !== "string" || !b.id || b.id.length > 200) throw bad("Which approval?");
  if (b.decision !== "allow" && b.decision !== "deny") throw bad("Allow or deny?");
  const a: ApprovalAnswer = { id: b.id, decision: b.decision };
  if (b.always === true) a.always = true;
  return a;
}

/* ---------------------------------------------------------------- router */

export function createApi(d: ApiDeps): (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void> {
  const hires: number[] = [];
  const pingMs = d.pingMs ?? PING_MS;
  const home = d.ctx.userHome;

  const need = <T>(part: T | null, what: string): T => {
    if (!part) throw new ControlError(503, `${what} isn't available in this office.`);
    return part;
  };
  const sessions = () => need(d.sessions, "Hiring agents");
  const places = () => need(d.places, "Sandboxes");
  const logins = () => need(d.logins ?? null, "Signing in");
  const setupCache = d.setupCache ?? createSetupCache({ now: d.ctx.now });
  /**
   * Names only: the values a login shell prints are dropped right here. Fresh for a minute, then
   * the last answer at once while a new shell is asked. A shell that didn't answer in time isn't
   * remembered as "none": the next ask tries again.
   */
  const shellSwr = new Swr<string[]>(
    () =>
      loginShellVars(shellKeyNames(importableNames())).then((env) => {
        if (!env) throw new Error("the login shell didn't answer");
        return Object.keys(env).filter((k) => env[k]?.trim());
      }),
    { ttlMs: 60_000, now: d.ctx.now },
  );
  const shellNames = async (): Promise<string[]> => {
    if (d.shellNames) return d.shellNames();
    try {
      return (await shellSwr.get()).value;
    } catch {
      return [];
    }
  };

  function session(id: string) {
    const s = sessions().get(id);
    if (!s) throw new ControlError(404, "No such session.");
    return s;
  }

  async function info(): Promise<ControlInfo> {
    const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref?.())]);
    // The page waits on neither: the agents on PATH until their versions are probed, each platform's
    // last known row (or its login state); the rest follows as control_info.
    const [agents, providers] = await Promise.all([
      d.sessions ? within(d.sessions.availability({ quick: true }), 5_000, []) : Promise.resolve([]),
      d.places ? within(d.places.status({ deadlineMs: INFO_PLACES_MS }), 3_000, []) : Promise.resolve([]),
    ]);
    return {
      enabled: true,
      agents,
      providers,
      keys: d.keys.list(),
      service: d.service.status(),
      sessions: d.sessions?.list() ?? [],
      recentFolders: d.ctx.office.recentFolders(),
      ...(d.logins ? { logins: d.logins.status() } : {}),
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? "GET";
    const rest = path.slice("/api/control".length) || "/";
    const only = (m: string) => {
      if (method !== m) {
        res.setHeader("Allow", m);
        throw new ControlError(405, `${m} only.`);
      }
    };

    if (rest === "/") {
      only("GET");
      const extra: Record<string, string> = {};
      const iat = d.auth.cookieIat(req.headers.cookie);
      if (iat !== null && Math.floor(d.ctx.now() / 1000) - iat > COOKIE_REFRESH_S) extra["Set-Cookie"] = d.auth.cookie();
      return sendJson(res, 200, await info(), extra);
    }

    if (rest === "/hire") {
      only("POST");
      const t = d.ctx.now();
      while (hires.length && t - hires[0]! > 60_000) hires.shift();
      if (hires.length >= HIRES_PER_MINUTE) throw new ControlError(429, "That's a lot of hiring; wait a minute.");
      const hire = parseHire(await readJson(req, BIG_BODY), home);
      if (hire.place.kind === "local") {
        const recent = d.ctx.office.recentFolders();
        try {
          hire.place.target = folderUnderHome(hire.place.target, home);
        } catch (err) {
          // A folder agents already worked in elsewhere (another disk) is fine too.
          if (!(err instanceof ControlError && err.status === 403 && recent.includes(hire.place.target))) throw err;
        }
      }
      hires.push(t);
      const s = await sessions().hire(hire);
      // The session manager logs the hire itself.
      if (hire.place.kind === "local") d.hired.add(hire.place.target);
      return sendJson(res, 200, s);
    }

    if (rest === "/setup") {
      only("GET");
      const q = new URL(req.url ?? "/", "http://office").searchParams;
      const agent = q.get("agent") as AgentKind;
      if (!AGENTS.includes(agent)) throw bad("Which agent?");
      const f = q.get("folder");
      let folder: string | undefined;
      if (f) {
        try {
          folder = folderUnderHome(f, home);
        } catch (err) {
          const recent = d.ctx.office.recentFolders();
          if (!(err instanceof ControlError && err.status === 403 && recent.includes(f))) throw err;
          folder = f;
        }
      }
      const inv = await setupCache.inventory(agent, { home, env: d.ctx.agentEnv(), keys: d.keys.list(), shellKeys: await shellNames() }, folder, { wait: q.get("wait") === "1" });
      return sendJson(res, 200, inv);
    }

    if (rest === "/logins/claude" || rest === "/logins/claude/input") {
      if (rest.endsWith("/input")) {
        only("POST");
        const b = obj(await readJson(req, SMALL_BODY));
        if (typeof b.data !== "string") throw bad("No keystrokes.");
        logins().input("claude", b.data);
        return sendJson(res, 204);
      }
      if (method === "DELETE") {
        logins().cancel("claude");
        return sendJson(res, 204);
      }
      only("POST");
      await readJson(req, SMALL_BODY);
      return sendJson(res, 200, await logins().start("claude"));
    }

    if (rest === "/fs") {
      only("GET");
      const q = new URL(req.url ?? "/", "http://office").searchParams.get("path") ?? undefined;
      return sendJson(res, 200, listFolders(home, q || undefined));
    }

    const m = /^\/sessions\/([^/]{1,64})\/([a-z]+)$/.exec(rest);
    if (m) {
      const id = decode(m[1]!);
      const what = m[2]!;
      if (what === "term" || what === "chat") {
        only("GET");
        const s = session(id);
        if ((what === "term") !== (s.mode === "terminal")) throw new ControlError(404, what === "term" ? "Not a terminal session." : "Not a chat session.");
        let sub: Disposable | undefined;
        const send = openSse(req, res, pingMs, () => sub?.dispose());
        try {
          sub =
            what === "term"
              ? sessions().attachTerm(id, {
                  data: (chunk) => send("data", { d: b64(chunk) }),
                  exit: (code) => send("exit", { code }),
                  // The screen at once ("screen", which an older page ignores), then the whole replay as the
                  // first data frame, marked full: the page redraws from it.
                  replay: (chunk, part) => (part === "screen" ? send("screen", { d: b64(chunk) }) : send("data", { d: b64(chunk), full: 1 })),
                })
              : sessions().attachChat(id, { item: (it) => send("item", it) });
        } catch {
          res.end();
        }
        if (res.destroyed || res.writableEnded) sub?.dispose();
        return;
      }
      only("POST");
      session(id);
      const body = obj(await readJson(req, what === "input" || what === "prompt" ? BIG_BODY : SMALL_BODY));
      switch (what) {
        case "input":
          if (typeof body.data !== "string") throw bad("No keystrokes.");
          sessions().input(id, body.data);
          return sendJson(res, 204);
        case "resize": {
          const cols = Number(body.cols);
          const rows = Number(body.rows);
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw bad("cols and rows, please.");
          sessions().resize(id, Math.min(500, Math.max(10, Math.round(cols))), Math.min(200, Math.max(4, Math.round(rows))));
          return sendJson(res, 204);
        }
        case "prompt":
          if (typeof body.text !== "string" || !body.text.trim()) throw bad("Type a prompt first.");
          await sessions().prompt(id, body.text);
          return sendJson(res, 204);
        case "interrupt":
          await sessions().interrupt(id);
          return sendJson(res, 204);
        case "stop":
          await sessions().stop(id);
          return sendJson(res, 204);
        case "approval":
          await sessions().answer(id, parseAnswer(body));
          return sendJson(res, 204);
        default:
          throw new ControlError(404, "Unknown action.");
      }
    }

    if (rest === "/keys") {
      only("POST");
      const b = obj(await readJson(req, SMALL_BODY));
      const k = d.keys.put({ name: b.name as string, value: b.value as string, agents: b.agents as AgentKind[] | undefined });
      return sendJson(res, 200, k);
    }
    if (rest === "/keys/import") {
      only("POST");
      await readJson(req, SMALL_BODY);
      const imported = await d.keys.importFromShell();
      return sendJson(res, 200, { imported });
    }
    if (rest.startsWith("/keys/")) {
      only("DELETE");
      const name = decode(rest.slice("/keys/".length));
      if (!d.keys.remove(name)) throw new ControlError(404, "No such key.");
      return sendJson(res, 204);
    }

    if (rest === "/sandboxes/delete") {
      only("POST");
      const b = obj(await readJson(req, SMALL_BODY));
      const provider = b.provider as (typeof PROVIDERS)[number];
      if (!PROVIDERS.includes(provider)) throw bad("Which platform?");
      if (typeof b.id !== "string" || !b.id || b.id.length > 200) throw bad("Which sandbox?");
      // createPlaces logs the deletion itself (one line, the id as the platform knows it).
      await places().deleteSandbox(provider, b.id, b.force === true);
      return sendJson(res, 204);
    }

    if (rest === "/service") {
      only("POST");
      const b = obj(await readJson(req, SMALL_BODY));
      if (typeof b.startAtLogin !== "boolean") throw bad("startAtLogin: true or false.");
      const st = await d.service.set(b.startAtLogin);
      d.info({ service: st });
      return sendJson(res, 200, st);
    }

    if (rest === "/install") {
      if (method === "GET") return sendJson(res, 200, await d.installer.plan());
      only("POST");
      const b = obj(await readJson(req, SMALL_BODY));
      let agents: AgentKind[] | undefined;
      if (b.agents !== undefined) {
        if (!Array.isArray(b.agents) || !b.agents.every((a) => AGENTS.includes(a as AgentKind))) throw bad("Unknown agent.");
        agents = b.agents as AgentKind[];
      }
      const plan = await d.installer.apply(agents);
      if (d.sessions) void d.sessions.availability({ fresh: true }).then((a) => d.info({ agents: a }), () => {});
      return sendJson(res, 200, plan);
    }

    throw new ControlError(404, "Not found.");
  }

  return async (req, res, path) => {
    try {
      await route(req, res, path);
    } catch (err) {
      if (err instanceof ControlError) {
        if (err.status === 413) res.setHeader("Connection", "close");
        return sendJson(res, err.status, { error: err.message });
      }
      d.ctx.log(`control: ${scrubMessage(String((err as Error)?.message ?? err)).slice(0, 200)}`, "warn");
      sendJson(res, 500, { error: "Internal error" });
    }
  };
}

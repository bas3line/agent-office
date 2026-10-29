/*
 * What the office knows about starting each agent: where its binary is and
 * which version, the flags for each permission mode, how its first prompt
 * and session id go on the command line, how a later prompt and an
 * interrupt reach its TUI, and the headless command for chat mode.
 *
 * First-run screens are skipped with the agent's own flags where it has them
 * (Codex's update check, Command Code's onboarding and trust, Gemini's
 * per-session trust). Claude's and Codex's folder-trust questions are left to
 * the user in the terminal panel: answering them means writing the agent's
 * global config, which the office doesn't do on this machine.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { WATCH_ONLY_AGENTS, type AgentKind } from "../shared/events.ts";
import type { AgentAvailability, ControlMode, PermissionMode } from "../shared/control.ts";
import { which } from "../remote/util.ts";
import { AGENT_FACTS, type Launch, type PermissionFlags, type PtyBackend, type TermDrive } from "./types.ts";

export const AGENTS = (Object.keys(AGENT_FACTS) as AgentKind[]).filter((a) => !WATCH_ONLY_AGENTS.includes(a));
export const ALL_PERMISSIONS: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];

/** Paste, then Enter this much later: sooner and Claude's TUI takes the Enter as a newline in the paste. */
export const ENTER_DELAY_MS = 600;

/** TUI flags per permission mode. A missing mode can't be started (and isn't offered). */
export const PERMISSION_FLAGS: Record<AgentKind, PermissionFlags> = {
  claude: {
    default: ["--permission-mode", "default"],
    acceptEdits: ["--permission-mode", "acceptEdits"],
    plan: ["--permission-mode", "plan"],
    bypass: ["--dangerously-skip-permissions"],
  },
  codex: {
    default: ["-a", "on-request", "-s", "workspace-write"],
    // Codex has no edits-only mode: workspace-write already lets edits inside the folder through.
    acceptEdits: ["-a", "on-request", "-s", "workspace-write"],
    plan: ["-a", "on-request", "-s", "read-only"],
    bypass: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  opencode: { default: [], acceptEdits: [], plan: ["--agent", "plan"], bypass: ["--auto"] },
  commandcode: {
    default: ["--permission-mode", "standard"],
    acceptEdits: ["--permission-mode", "accept-edits"],
    plan: ["--permission-mode", "plan"],
    bypass: ["--permission-mode", "yolo"],
  },
  droid: { default: [] },
  gemini: {
    default: ["--approval-mode", "default"],
    acceptEdits: ["--approval-mode", "auto_edit"],
    plan: ["--approval-mode", "plan"],
    bypass: ["--approval-mode", "yolo"],
  },
  qwen: {
    // Choices from qwen-code 0.25.2's APPROVAL_MODES: plan, default, auto-edit, auto, yolo.
    default: ["--approval-mode", "default"],
    acceptEdits: ["--approval-mode", "auto-edit"],
    plan: ["--approval-mode", "plan"],
    bypass: ["--approval-mode", "yolo"],
  },
  cursor: { default: [], bypass: ["--force"] },
  hermes: {},
};

/**
 * opencode allows every tool unless its config says otherwise, so "ask before acting" and "accept
 * edits" are passed as OPENCODE_PERMISSION, which opencode merges over the user's own config.
 * Plan and bypass are flags (--agent plan, --auto; chat mode answers approvals itself in bypass).
 */
export const OPENCODE_PERMISSION_ENV = "OPENCODE_PERMISSION";
export const OPENCODE_PERMISSION: Partial<Record<PermissionMode, Record<string, string>>> = {
  default: { edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" },
  acceptEdits: { edit: "allow", bash: "ask", webfetch: "ask", external_directory: "ask" },
};

/** Codex app-server thread settings per permission mode. */
export const CODEX_POLICY: Record<PermissionMode, { approvalPolicy: string; sandbox: string }> = {
  default: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  acceptEdits: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  plan: { approvalPolicy: "on-request", sandbox: "read-only" },
  bypass: { approvalPolicy: "never", sandbox: "danger-full-access" },
};

const PERMISSION_NOTES: Partial<Record<AgentKind, string>> = {
  droid: "Droid starts in its own default mode; switch modes in its terminal.",
  cursor: "Cursor starts in its default mode, or with --force for bypass.",
};

export function permissionsOf(agent: AgentKind): PermissionMode[] {
  return ALL_PERMISSIONS.filter((p) => PERMISSION_FLAGS[agent][p] !== undefined);
}

export function driveOf(agent: AgentKind): TermDrive {
  return agent === "opencode"
    ? { submit: "opencode", enterDelayMs: 0, interrupt: "opencode" }
    : { submit: "paste", enterDelayMs: ENTER_DELAY_MS, interrupt: "esc" };
}

/**
 * Agents whose new session takes an id from the command line (Claude, Gemini,
 * Qwen: --session-id). Claude's is exact; for Gemini and Qwen the transcript
 * carrying that id is unverified, so the link may still fall back to
 * agent + folder.
 */
export function pinsSessionId(agent: AgentKind): "exact" | "hint" | null {
  if (agent === "claude") return "exact";
  if (agent === "gemini" || agent === "qwen") return "hint";
  return null;
}

/* ------------------------------------------------------------- launches */

export interface TerminalLaunchOptions {
  agent: AgentKind;
  /** Absolute path locally, the bare name remotely. */
  bin: string;
  cwd: string;
  permission: PermissionMode;
  prompt?: string;
  /** Pinned session id (pinsSessionId agents). */
  sessionId?: string;
  remote?: boolean;
  /** Claude: the office's base URL for its http hooks, and the hook token (local only). */
  hook?: { url: string; token: string; sessionId: string };
  /** opencode: the port its TUI's server listens on, and that server's password. */
  opencode?: { port: number; password: string };
  /** Keys handed to a remote agent (name -> value); listed as secret. */
  keys?: Record<string, string>;
  path?: string[];
}

export const PROMPT_ENV = "AO_PROMPT";
export const HOOK_TOKEN_ENV = "AO_HOOK_TOKEN";
export const OPENCODE_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";

/** One argv element that can't be read as a flag. */
function promptArg(text: string): string {
  return text.startsWith("-") ? ` ${text}` : text;
}

/**
 * Claude's per-run hooks. PermissionRequest is an http hook (Claude waits for
 * the office's answer). Claude never fires http hooks for SessionStart
 * (checked on 2.1.302), so that one is a command hook: curl posts the event,
 * reading the token from the environment itself (--variable, curl 8.3+), so
 * the token is on no argv; an older curl fails quietly and /clear just isn't
 * followed. Only URLs and the token's env name are on Claude's own argv.
 */
export function claudeHookSettings(hook: { url: string; sessionId: string }): string {
  const base = `${hook.url.replace(/\/+$/, "")}/api/hook/${encodeURIComponent(hook.sessionId)}`;
  const permission = {
    type: "http",
    url: `${base}/permission`,
    timeout: 1800,
    headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV}` },
    allowedEnvVars: [HOOK_TOKEN_ENV],
  };
  const sessionStart = {
    type: "command",
    command:
      `curl -fsS -m 5 -o /dev/null --variable %${HOOK_TOKEN_ENV} --expand-header 'Authorization: Bearer {{${HOOK_TOKEN_ENV}}}' ` +
      `-H 'Content-Type: application/json' --data-binary @- '${base}/session-start' >/dev/null 2>&1 || true`,
    timeout: 10,
  };
  return JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [permission] }], SessionStart: [{ hooks: [sessionStart] }] } });
}

/** The agent's TUI, as it runs in the terminal panel. */
export function terminalLaunch(o: TerminalLaunchOptions): Launch {
  const env: Record<string, string> = {};
  const secret: string[] = [];
  const argv: Launch["argv"] = [o.bin];
  const flags = PERMISSION_FLAGS[o.agent][o.permission] ?? PERMISSION_FLAGS[o.agent].default ?? [];
  let prompt: Launch["argv"][number] | undefined;
  if (o.prompt) {
    if (o.remote) {
      env[PROMPT_ENV] = promptArg(o.prompt);
      prompt = { env: PROMPT_ENV };
    } else prompt = promptArg(o.prompt);
  }
  for (const [k, v] of Object.entries(o.keys ?? {})) {
    env[k] = v;
    secret.push(k);
  }
  switch (o.agent) {
    case "claude":
      if (o.sessionId) argv.push("--session-id", o.sessionId);
      argv.push(...flags);
      if (o.hook && !o.remote) {
        argv.push("--settings", claudeHookSettings(o.hook));
        env[HOOK_TOKEN_ENV] = o.hook.token;
        secret.push(HOOK_TOKEN_ENV);
      }
      if (prompt !== undefined) argv.push(prompt);
      break;
    case "codex":
      argv.push("-c", "check_for_update_on_startup=false", ...flags, "-C", o.cwd);
      if (o.remote && o.keys?.OPENAI_API_KEY) argv.push(...codexApiKeyArgs());
      if (prompt !== undefined) argv.push(prompt);
      break;
    case "opencode":
      if (o.opencode) {
        argv.push("--port", String(o.opencode.port), "--hostname", "127.0.0.1");
        env[OPENCODE_PASSWORD_ENV] = o.opencode.password;
        secret.push(OPENCODE_PASSWORD_ENV);
      }
      if (OPENCODE_PERMISSION[o.permission]) env[OPENCODE_PERMISSION_ENV] = JSON.stringify(OPENCODE_PERMISSION[o.permission]);
      argv.push(...flags);
      if (prompt !== undefined) argv.push("--prompt", prompt);
      argv.push(o.cwd);
      break;
    case "commandcode":
      argv.push("-t", "--skip-onboarding", "--no-auto-update", ...flags);
      if (prompt !== undefined) argv.push(prompt);
      break;
    case "droid":
      argv.push("--cwd", o.cwd, ...flags);
      if (prompt !== undefined) argv.push(prompt);
      break;
    case "gemini":
      if (o.sessionId) argv.push("--session-id", o.sessionId);
      argv.push(...flags, "--skip-trust");
      if (prompt !== undefined) argv.push("-i", prompt);
      break;
    case "qwen":
      if (o.sessionId) argv.push("--session-id", o.sessionId);
      argv.push(...flags);
      if (prompt !== undefined) argv.push("-i", prompt);
      break;
    case "cursor":
      argv.push(...flags);
      if (prompt !== undefined) argv.push(prompt);
      break;
  }
  return { argv, cwd: o.cwd, env, secret, ...(o.path?.length ? { path: o.path } : {}) };
}

/**
 * Codex in a sandbox with OPENAI_API_KEY: a provider that reads the key from
 * the environment, so nothing is written to its auth.json. Unverified on
 * Codex 0.163; the cloud side owns the fallback (codex login --with-api-key).
 */
export function codexApiKeyArgs(): string[] {
  return [
    "-c",
    "model_provider=agentoffice",
    "-c",
    'model_providers.agentoffice={name="OpenAI",base_url="https://api.openai.com/v1",env_key="OPENAI_API_KEY",wire_api="responses"}',
  ];
}

export interface ChatLaunchOptions {
  agent: AgentKind;
  bin: string;
  cwd: string;
  permission: PermissionMode;
  sessionId?: string;
  remote?: boolean;
  opencode?: { port: number; password: string };
  keys?: Record<string, string>;
  path?: string[];
}

/** The headless process behind chat mode. */
export function chatLaunch(o: ChatLaunchOptions): Launch {
  const env: Record<string, string> = {};
  const secret: string[] = [];
  for (const [k, v] of Object.entries(o.keys ?? {})) {
    env[k] = v;
    secret.push(k);
  }
  const argv: Launch["argv"] = [o.bin];
  switch (o.agent) {
    case "claude":
      argv.push(
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool", "stdio",
        ...(PERMISSION_FLAGS.claude[o.permission] ?? PERMISSION_FLAGS.claude.default!),
      );
      if (o.sessionId) argv.push("--session-id", o.sessionId);
      break;
    case "codex":
      if (o.remote && o.keys?.OPENAI_API_KEY) argv.push(...codexApiKeyArgs());
      argv.push("app-server");
      break;
    case "opencode":
      argv.push("serve", "--port", String(o.opencode?.port ?? 0), "--hostname", "127.0.0.1");
      if (o.opencode) {
        env[OPENCODE_PASSWORD_ENV] = o.opencode.password;
        secret.push(OPENCODE_PASSWORD_ENV);
      }
      if (OPENCODE_PERMISSION[o.permission]) env[OPENCODE_PERMISSION_ENV] = JSON.stringify(OPENCODE_PERMISSION[o.permission]);
      break;
    case "commandcode":
      // `command-code acp`: an ACP agent on stdio (its --help: "Run as an ACP agent over stdio"). The
      // subcommand takes no other flags; the permission is its ACP session mode (chat/acp.ts ACP_PROFILES).
      argv.push("acp");
      break;
    default:
      throw new Error(`${o.agent} has no chat mode`);
  }
  return { argv, cwd: o.cwd, env, secret, ...(o.path?.length ? { path: o.path } : {}) };
}

/* --------------------------------------------------------- availability */

/** The agent's executable on this PATH. Cursor's `agent` name counts only when it really is Cursor's. */
export function findBin(agent: AgentKind, env: NodeJS.ProcessEnv): string | undefined {
  for (const bin of AGENT_FACTS[agent].bins) {
    const p = which(bin, env);
    if (!p) continue;
    if (agent === "cursor" && bin === "agent") {
      let real = p;
      try {
        real = realpathSync(p);
      } catch {
        // Keep the PATH entry.
      }
      if (!/cursor/i.test(real)) continue;
    }
    return p;
  }
  return undefined;
}

/** "2.1.302 (Claude Code)", "codex-cli 0.146.0" -> the first x.y.z. */
export function parseVersion(out: string): string | undefined {
  return /\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0];
}

export function probeVersion(bin: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 4000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(bin, ["--version"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve(undefined);
    }
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const take = (d: Buffer) => {
      if (out.length < 4096) out += d.toString("utf8");
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    child.on("error", () => {
      clearTimeout(t);
      resolve(undefined);
    });
    child.on("close", () => {
      clearTimeout(t);
      resolve(parseVersion(out));
    });
  });
}

export interface ProbeOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  pty: PtyBackend | null;
  /** Default: probeVersion. */
  version?: (bin: string) => Promise<string | undefined>;
}

/** Bins found on this machine (absolute paths), for the launches. */
export type FoundBins = Partial<Record<AgentKind, string>>;

export async function probeAgents(o: ProbeOptions): Promise<{ agents: AgentAvailability[]; bins: FoundBins }> {
  const bins: FoundBins = {};
  const version = o.version ?? ((bin: string) => probeVersion(bin, o.env, o.home));
  const agents = await Promise.all(
    AGENTS.map(async (agent): Promise<AgentAvailability> => {
      const facts = AGENT_FACTS[agent];
      const bin = findBin(agent, o.env);
      if (bin) bins[agent] = bin;
      const modes: ControlMode[] = [];
      const notes: string[] = [];
      if (!bin || o.pty) modes.push("terminal");
      else notes.push("Terminal mode needs the PTY library (reinstall agentoffice with optional dependencies) or python3.");
      if (facts.chat) modes.push("chat");
      const permissions = permissionsOf(agent);
      if (PERMISSION_NOTES[agent]) notes.push(PERMISSION_NOTES[agent]!);
      const a: AgentAvailability = {
        agent,
        installed: !!bin,
        modes,
        keyNames: [...facts.keyNames],
        ...(permissions.length < ALL_PERMISSIONS.length ? { permissions } : {}),
      };
      if (!bin) a.installCmd = facts.installCmd;
      else {
        const v = await version(bin).catch(() => undefined);
        if (v) a.version = v;
      }
      if (notes.length) a.note = notes.join(" ");
      return a;
    }),
  );
  return { agents, bins };
}

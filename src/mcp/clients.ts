/*
 * Who is calling the MCP server. Every agent names itself in MCP's clientInfo
 * ("claude-code", "codex-mcp-client", "gemini-cli-mcp-client", ...); this maps
 * those self-reported names onto the office's AgentKinds. The installer also
 * registers the server with `--agent <kind>`, which wins when present: it is
 * the one hint that cannot be wrong about which config launched us.
 */
import type { AgentKind } from "../shared/events.ts";

export const AGENT_KINDS: readonly AgentKind[] = [
  "claude", "commandcode", "codex", "opencode", "droid", "gemini", "qwen", "cursor", "hermes",
];

/** Ordered: the first pattern that matches the normalized name wins. */
const CLIENT_PATTERNS: [RegExp, AgentKind][] = [
  [/commandcode|^cmd(code)?$/, "commandcode"],
  [/claude/, "claude"],
  [/codex/, "codex"],
  [/opencode/, "opencode"],
  [/droid|factory/, "droid"],
  [/gemini|antigravity/, "gemini"],
  [/qwen/, "qwen"],
  [/cursor/, "cursor"],
];

/** "Claude Code" / "claude-code" / "claude_code" -> "claudecode". */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Map an MCP clientInfo.name to an AgentKind, or undefined when unknown. */
export function agentFromClient(name: unknown): AgentKind | undefined {
  if (typeof name !== "string" || !name.trim()) return undefined;
  const n = normalize(name);
  for (const [re, kind] of CLIENT_PATTERNS) if (re.test(n)) return kind;
  return undefined;
}

/** Accept an AgentKind or a friendly alias ("claude-code", "factory", "cursor-agent"). */
export function parseAgentKind(v: unknown): AgentKind | undefined {
  if (typeof v !== "string") return undefined;
  const n = v.trim().toLowerCase();
  if ((AGENT_KINDS as readonly string[]).includes(n)) return n as AgentKind;
  return agentFromClient(n);
}

/** Last resort: Claude Code marks the processes it spawns. */
export function agentFromEnv(env: NodeJS.ProcessEnv): AgentKind | undefined {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  return undefined;
}

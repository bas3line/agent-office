/*
 * Terminal styling for install / uninstall / doctor, in the same voice as the
 * office banner: raw ANSI, brand colours per agent, off for NO_COLOR, dumb
 * terminals and pipes.
 */
import type { AgentKind } from "../shared/events.ts";
import { BRAND } from "../shared/events.ts";

const env = process.env;
export const COLOR =
  !(env.NO_COLOR !== undefined && env.NO_COLOR !== "") &&
  env.TERM !== "dumb" &&
  (Boolean(process.stdout.isTTY) || (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0"));
const TRUECOLOR = COLOR && (/truecolor|24bit/i.test(env.COLORTERM ?? "") || /iTerm|WezTerm|ghostty|vscode/i.test(env.TERM_PROGRAM ?? ""));

const sgr = (open: string, close: string) => (s: string) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const bold = sgr("1", "22");
export const dim = sgr("2", "22");
export const red = sgr("31", "39");
export const green = sgr("32", "39");
export const yellow = sgr("33", "39");
export const cyan = sgr("36", "39");

export function hexColor(h: string): (s: string) => string {
  if (!COLOR) return (s) => s;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  if (TRUECOLOR) return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
  const q = (v: number) => Math.round((v / 255) * 5);
  return (s) => `\x1b[38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m${s}\x1b[39m`;
}

/** Terminal stand-ins for the logos. */
export const GLYPH: Record<AgentKind, string> = {
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

export function agentLabel(a: AgentKind, width = 0): string {
  const name = BRAND[a].name;
  return `${hexColor(BRAND[a].color)(GLYPH[a])} ${bold(name)}${" ".repeat(Math.max(0, width - name.length))}`;
}

/** Visible width (ANSI stripped). */
export function visible(s: string): number {
  return [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

export function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visible(s)));
}

export const PAD = "  ";

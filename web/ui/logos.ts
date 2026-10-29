/*
 * The real agent and sandbox-provider logos, bundled as text from
 * assets/logos and injected as inline SVG so they recolour through CSS
 * `color`. This is the only innerHTML in the app, and it only ever sees our
 * own files. Plain ssh is not a company, so it gets a generic terminal glyph.
 */
import claudeSvg from "../../assets/logos/claude.svg";
import commandcodeSvg from "../../assets/logos/commandcode.svg";
import codexSvg from "../../assets/logos/codex.svg";
import opencodeSvg from "../../assets/logos/opencode.svg";
import droidSvg from "../../assets/logos/droid.svg";
import geminiSvg from "../../assets/logos/gemini.svg";
import qwenSvg from "../../assets/logos/qwen.svg";
import cursorSvg from "../../assets/logos/cursor.svg";
import hermesSvg from "../../assets/logos/hermes.svg";
import daytonaSvg from "../../assets/logos/daytona.svg";
import boatSvg from "../../assets/logos/boat.svg";
import railwaySvg from "../../assets/logos/railway.svg";
import vercelSvg from "../../assets/logos/vercel.svg";
import { BRAND, HOST_BRAND, type AgentKind, type Host, type HostKind } from "../../src/shared/events.ts";
import { h } from "./dom.ts";

export type RemoteKind = Exclude<HostKind, "local">;

const SSH_GLYPH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm1 4v12h16V7zm2 2.5 1.4-1.4 4.4 4.4-4.4 4.4L6 15.5l3-3zM12 15h6v2h-6z"/></svg>`;

/** Strip the XML prolog, <title>/<metadata> and fixed pt sizes so CSS can size the mark. */
function clean(src: string): string {
  const s = src
    .slice(Math.max(0, src.indexOf("<svg")))
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<metadata>[\s\S]*?<\/metadata>/g, "");
  return s.replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(width|height)="[^"]*"/g, ""));
}

const SOURCES: Record<string, string> = {
  claude: claudeSvg, commandcode: commandcodeSvg, codex: codexSvg, opencode: opencodeSvg, droid: droidSvg,
  gemini: geminiSvg, qwen: qwenSvg, cursor: cursorSvg, hermes: hermesSvg,
  "host-ssh": SSH_GLYPH, "host-daytona": daytonaSvg, "host-boat": boatSvg, "host-railway": railwaySvg, "host-vercel": vercelSvg,
};
const templates = new Map<string, HTMLTemplateElement>();

function template(key: string): HTMLTemplateElement | null {
  let t = templates.get(key);
  if (!t && SOURCES[key]) {
    t = document.createElement("template");
    t.innerHTML = clean(SOURCES[key]);
    const svg = t.content.querySelector("svg");
    svg?.setAttribute("aria-hidden", "true");
    svg?.setAttribute("focusable", "false");
    templates.set(key, t);
  }
  return t ?? null;
}

/** A logo in its brand colour; unknown agents get a neutral pixel. */
export function logo(agent: AgentKind, extraClass = ""): HTMLSpanElement {
  const known = agent in BRAND;
  const span = h("span", { class: `logo logo-${known ? agent : "unknown"} ${extraClass}`.trim() });
  const t = known ? template(agent) : null;
  if (t) span.append(t.content.cloneNode(true));
  return span;
}

/** A sandbox provider's mark (or the ssh glyph), in its HOST_BRAND colour. */
export function hostLogo(kind: RemoteKind, extraClass = ""): HTMLSpanElement {
  const known = kind in HOST_BRAND;
  const span = h("span", { class: `logo host-logo host-${known ? kind : "unknown"} ${extraClass}`.trim() });
  const t = known ? template("host-" + kind) : null;
  if (t) span.append(t.content.cloneNode(true));
  return span;
}

export const agentName = (agent: AgentKind): string => BRAND[agent]?.name ?? String(agent);
export const agentColor = (agent: AgentKind): string => BRAND[agent]?.color ?? "#9a9a9a";
export const hostName = (kind: RemoteKind): string => HOST_BRAND[kind]?.name ?? String(kind);
export const isRemote = (host?: Host): host is Host & { kind: RemoteKind } => !!host && host.kind !== "local";

/** "Daytona · auth-refactor", "ssh · shubham". */
export function hostLabel(host: Host): string {
  if (host.kind === "local") return "this machine";
  const name = host.name || host.id;
  return host.kind === "ssh" ? `ssh · ${name}` : `${hostName(host.kind)} · ${name}`;
}

/** A compact badge for a remote host: its mark and its name. */
export function hostBadge(host: Host, extraClass = ""): HTMLSpanElement {
  const kind = host.kind === "local" ? "ssh" : host.kind;
  return h(
    "span",
    { class: `host-badge host-${kind} ${extraClass}`.trim(), attrs: { title: hostLabel(host) } },
    hostLogo(kind),
    h("span", { class: "host-name", text: host.name || host.id }),
  );
}

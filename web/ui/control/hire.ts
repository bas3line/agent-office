/*
 * The Hire dialog: pick an agent, where it works (a folder on this Mac, a
 * cloud sandbox, an ssh box), terminal or chat, how much it may do without
 * asking, an optional first prompt and, for a remote place, which stored keys
 * to hand it. On submit the server starts the agent; its worker walks out of
 * the lift and the session panel opens.
 */
import type { AgentAvailability, ControlMode, ControlSession, FsListing, HireRequest, PermissionMode, Place, ProviderStatus, SandboxInfo } from "../../../src/shared/control.ts";
import { BRAND, WATCH_ONLY_AGENTS, type AgentKind } from "../../../src/shared/events.ts";
import { h, setText } from "../dom.ts";
import { tidyPath } from "../format.ts";
import { glyph, icon } from "../icons.ts";
import { agentColor, agentName, hostLogo, logo } from "../logos.ts";
import { api, ControlError } from "./api.ts";
import { PERMISSIONS, PLACE_NAME, until } from "./format.ts";
import { railwayChoice, railwayLabel, railwayPicker, type RailwayPick } from "./railway.ts";
import { createSetupSection } from "./setup.ts";
import type { ControlStore } from "./store.ts";

export interface HireDialog {
  el: HTMLDialogElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** The store changed while open. */
  sync(): void;
  /** The pointer is on Hire: ask for "Your setup" now, so the dialog has it when it opens. */
  warm(): void;
}

type Where = "local" | "sandbox" | "ssh";
type Provider = "daytona" | "vercel" | "railway";
const AGENTS = (Object.keys(BRAND) as AgentKind[]).filter((a) => !WATCH_ONLY_AGENTS.includes(a));
const PROVIDERS: Provider[] = ["daytona", "vercel", "railway"];
const TIMEOUTS = [15, 30, 60, 120];
const HEADLESS: AgentKind[] = ["claude", "codex", "opencode"];

export function createHire(store: ControlStore, opts: { onHired(s: ControlSession): void; openSettings(tab: "keys" | "cloud" | "agents" | "logins"): void }): HireDialog {
  /* ---- state ---- */
  let agent: AgentKind = "claude";
  let where: Where = "local";
  let folder = "";
  let provider: Provider = "daytona";
  let sandbox = "new";
  let timeoutMin = 30;
  /** The Railway project · environment picked in this form (else the server's default). */
  let railwayPick: RailwayPick | undefined;
  let sshHost = "";
  let mode: ControlMode = "terminal";
  let permission: PermissionMode = "default";
  let keys = new Set<string>();
  let keysTouched = false;
  let browsing = false;
  let listing: FsListing | null = null;
  /** The real path of the folder being listed (listing.path is for display, with ~). */
  let fsAt: string | undefined;
  let busy = false;

  /* ---- persistent elements ---- */
  const agentGrid = h("div", { class: "hire-agents", attrs: { role: "radiogroup", "aria-label": "Agent" } });
  const agentNote = h("p", { class: "hire-note", attrs: { hidden: true } });

  const whereTab = (w: Where, label: string, ic: Parameters<typeof icon>[0]) =>
    h("button", { class: "hire-seg-btn", attrs: { type: "button", role: "tab", "aria-selected": "false", "data-where": w, id: `ao-hire-tab-${w}`, "aria-controls": `ao-hire-pane-${w}` } }, icon(ic, 1), h("span", { text: label }));
  const whereTabs = h("div", { class: "hire-seg", attrs: { role: "tablist", "aria-label": "Where it works" } }, whereTab("local", "This Mac", "folder"), whereTab("sandbox", "Sandbox", "cloud"), whereTab("ssh", "ssh", "server"));

  // this Mac
  const folderPath = h("span", { class: "hire-folder-path" });
  const browseBtn = h("button", { class: "btn btn-quiet", attrs: { type: "button" } }, icon("folder", 1), h("span", { text: "Browse" }));
  const recentList = h("div", { class: "hire-recent" });
  const fsPath = h("span", { class: "fs-path" });
  const fsUp = h("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Up one folder", title: "Up one folder" } }, icon("up", 1));
  const fsUse = h("button", { class: "btn btn-quiet", attrs: { type: "button" }, text: "Use this folder" });
  const fsList = h("ul", { class: "fs-list", attrs: { "aria-label": "Folders" } });
  const fsBox = h("div", { class: "fs", attrs: { hidden: true } }, h("div", { class: "fs-head" }, fsUp, fsPath, fsUse), fsList);
  const localPane = h(
    "div",
    { class: "hire-pane", attrs: { "data-pane": "local", role: "tabpanel", id: "ao-hire-pane-local", "aria-labelledby": "ao-hire-tab-local" } },
    h("div", { class: "hire-folder" }, icon("folder", 1), folderPath, browseBtn),
    recentList,
    fsBox,
  );

  // sandbox
  const provTabs = h("div", { class: "hire-provs", attrs: { role: "radiogroup", "aria-label": "Provider" } });
  const sbxList = h("div", { class: "hire-sbx", attrs: { role: "radiogroup", "aria-label": "Sandbox" } });
  const timeoutSel = h("select", { class: "field-select", attrs: { "aria-label": "Stop the new sandbox after" } });
  for (const m of TIMEOUTS) timeoutSel.append(h("option", { text: m < 60 ? `${m} min` : `${m / 60} h`, attrs: { value: m } }));
  const sandboxPane = h("div", { class: "hire-pane", attrs: { "data-pane": "sandbox", role: "tabpanel", id: "ao-hire-pane-sandbox", "aria-labelledby": "ao-hire-tab-sandbox" } }, provTabs, sbxList);

  // ssh
  const hostList = h("div", { class: "hire-hosts", attrs: { role: "radiogroup", "aria-label": "ssh host" } });
  const hostInput = h("input", { class: "field", attrs: { type: "text", placeholder: "user@host or an alias from ~/.ssh/config", autocomplete: "off", spellcheck: "false", "aria-label": "Other ssh host" } });
  const sshPane = h("div", { class: "hire-pane", attrs: { "data-pane": "ssh", role: "tabpanel", id: "ao-hire-pane-ssh", "aria-labelledby": "ao-hire-tab-ssh" } }, hostList, hostInput);

  const cwdInput = h("input", { class: "field", attrs: { type: "text", placeholder: "Home folder", autocomplete: "off", spellcheck: "false", "aria-label": "Working folder on the remote" } });
  const cwdRow = h("label", { class: "hire-row" }, h("span", { class: "hire-row-label", text: "Folder there" }), cwdInput);

  // mode + permissions
  const modeBtn = (m: ControlMode, label: string, sub: string) =>
    h("button", { class: "hire-mode", attrs: { type: "button", role: "radio", "aria-checked": "false", "data-mode": m } }, icon(m === "terminal" ? "terminal" : "chat", 1), h("span", { class: "hire-mode-text" }, h("b", { text: label }), h("small", { text: sub })));
  const termMode = modeBtn("terminal", "Terminal", "The agent's own TUI, live");
  const chatMode = modeBtn("chat", "Chat", "Messages, tool calls, approvals");
  const modes = h("div", { class: "hire-modes", attrs: { role: "radiogroup", "aria-label": "Mode" } }, termMode, chatMode);

  const permSel = h("select", { class: "field-select", attrs: { "aria-label": "Permissions" } });
  for (const p of PERMISSIONS) permSel.append(h("option", { text: p.label, attrs: { value: p.mode } }));
  const permHint = h("p", { class: "hire-hint" });
  const bypassWarn = h(
    "div",
    { class: "hire-warn", attrs: { hidden: true, role: "note" } },
    icon("warn", 1),
    h("span", { text: "The agent runs every command and edit without asking, including deleting files and pushing code. Use it only in a sandbox you can throw away." }),
  );

  const promptInput = h("textarea", { class: "field hire-prompt", attrs: { rows: 3, placeholder: "Optional. Sent as soon as the agent is ready.", "aria-label": "First prompt" } });

  const keyList = h("div", { class: "hire-keys" });
  const keysSection = h(
    "section",
    { class: "hire-section", attrs: { hidden: true } },
    h("h3", { class: "hire-h" }, h("span", { text: "Keys to pass" })),
    keyList,
    h("p", { class: "hire-hint", text: "Set in the agent's environment there, for this session only. The office never shows a stored key again." }),
  );

  const setupSec = createSetupSection(store, {
    openSettings: (t) => opts.openSettings(t),
    changed: () => {
      renderKeys();
      renderSummary();
    },
  });

  const err = h("p", { class: "hire-err", attrs: { hidden: true, role: "alert" } });
  const summary = h("span", { class: "hire-summary" });
  const cancelBtn = h("button", { class: "btn btn-quiet", attrs: { type: "button" }, text: "Cancel" });
  const hireBtn = h("button", { class: "btn btn-primary", attrs: { type: "submit" } }, icon("hire", 1), h("span", { class: "hire-btn-text", text: "Hire" }));
  const closeX = h("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Close" } }, glyph("close", 1));

  const section = (title: string, ...kids: (Node | null)[]) => h("section", { class: "hire-section" }, h("h3", { class: "hire-h", text: title }), ...kids);
  const whereSection = section("Where it works", whereTabs, localPane, sandboxPane, sshPane, cwdRow);
  // Two columns on a wide screen (who and where | how, and what comes along), one below the other elsewhere.
  const body = h(
    "div",
    { class: "dlg-body hire-body" },
    h("div", { class: "hire-col" }, section("Agent", agentGrid, agentNote), whereSection),
    h("div", { class: "hire-col" }, section("How you drive it", modes), section("Permissions", permSel, permHint, bypassWarn), section("First prompt", promptInput), setupSec.el, keysSection),
  );
  const scroller = scrollArea(body);
  const form = h(
    "form",
    { class: "hire-form", attrs: { method: "dialog" } },
    h("header", { class: "dlg-head" }, h("h2", { class: "dlg-title", text: "Hire an agent", attrs: { id: "ao-hire-title" } }), closeX),
    scroller.el,
    h("footer", { class: "dlg-foot" }, err, h("div", { class: "dlg-foot-row" }, summary, h("span", { class: "dlg-gap" }), cancelBtn, hireBtn)),
  );
  const el = h("dialog", { class: "dlg hire glass", attrs: { "aria-labelledby": "ao-hire-title" } }, form);
  roving(form);
  scroller.wheelFrom(el);

  /* ---- data helpers ---- */
  const avail = (a: AgentKind): AgentAvailability =>
    store.info?.agents.find((x) => x.agent === a) ?? { agent: a, installed: false, modes: HEADLESS.includes(a) ? ["terminal", "chat"] : ["terminal"], keyNames: [] };
  const prov = (k: string): ProviderStatus | undefined => store.info?.providers.find((p) => p.kind === k);
  const running = (p?: ProviderStatus): SandboxInfo[] => (p?.sandboxes ?? []).filter((s) => s.status === "running" || s.status === "starting");
  /** Modes this agent can be hired in, here. Remotely chat runs on every place's pipes (ssh, Railway's exec bridge, Daytona's sessions, Vercel's commands); opencode's server stays local. */
  const modesHere = (a: AgentKind): ControlMode[] => {
    const m = avail(a).modes.length ? avail(a).modes : ["terminal" as ControlMode];
    if (where === "local") return m;
    return HEADLESS.includes(a) && a !== "opencode" ? ["terminal", "chat"] : ["terminal"];
  };
  /** opencode runs on this machine only for now (the server answers 400 elsewhere). */
  const usableHere = (a: AgentKind) => (where === "local" ? avail(a).installed : a !== "opencode");
  const permsOf = (a: AgentKind): PermissionMode[] => avail(a).permissions ?? PERMISSIONS.map((p) => p.mode);

  function pickDefaults(): void {
    const info = store.info;
    const installed = info?.agents.filter((a) => a.installed).map((a) => a.agent) ?? [];
    if (!avail(agent).installed && installed.length) agent = installed[0]!;
    if (!folder) folder = info?.recentFolders[0] ?? "";
    const ready = PROVIDERS.find((p) => prov(p)?.ready);
    if (ready && !prov(provider)?.ready) provider = ready;
    if (!sshHost) sshHost = prov("ssh")?.hosts?.[0] ?? "";
  }

  /* ---- render ---- */
  function renderAgents(): void {
    agentGrid.replaceChildren();
    for (const a of AGENTS) {
      const av = avail(a);
      const usable = usableHere(a);
      const b = h(
        "button",
        {
          class: `hire-agent${usable ? "" : " is-missing"}`,
          attrs: { type: "button", role: "radio", "aria-checked": String(a === agent), "data-agent": a, title: av.installed ? `${agentName(a)}${av.version ? ` ${av.version}` : ""}` : `${agentName(a)} isn't installed on this Mac` },
        },
        logo(a, "hire-agent-logo"),
        h("span", { class: "hire-agent-name", text: agentName(a) }),
        h("small", { class: "hire-agent-sub", text: where !== "local" ? (a === "opencode" ? "this Mac only" : "installed there") : av.installed ? av.version || "installed" : "not installed" }),
      );
      b.style.setProperty("--accent", agentColor(a));
      b.addEventListener("click", () => {
        agent = a;
        if (!modesHere(a).includes(mode)) mode = "terminal";
        if (!permsOf(a).includes(permission)) permission = permsOf(a)[0] ?? "default";
        if (!keysTouched) keys = presetKeys();
        render();
      });
      agentGrid.append(b);
    }
    const av = avail(agent);
    if (where === "local" && !av.installed) {
      agentNote.hidden = false;
      agentNote.replaceChildren(h("span", { text: `${agentName(agent)} isn't on this Mac. Install it, then hire: ` }), h("code", { text: av.installCmd || "see its docs" }));
    } else if (where !== "local" && agent === "opencode") {
      agentNote.hidden = false;
      agentNote.replaceChildren(h("span", { text: "opencode runs on this Mac only for now." }));
    } else if (av.note) {
      agentNote.hidden = false;
      agentNote.replaceChildren(h("span", { text: av.note }));
    } else agentNote.hidden = true;
  }

  function renderWhere(): void {
    for (const t of whereTabs.querySelectorAll<HTMLElement>("[data-where]")) t.setAttribute("aria-selected", String(t.dataset.where === where));
    localPane.hidden = where !== "local";
    sandboxPane.hidden = where !== "sandbox";
    sshPane.hidden = where !== "ssh";
    cwdRow.hidden = where === "local";

    // this Mac
    setText(folderPath, folder ? tidyPath(folder) : "Pick a folder");
    folderPath.classList.toggle("is-empty", !folder);
    recentList.replaceChildren();
    const recent = (store.info?.recentFolders ?? []).slice(0, 6);
    if (recent.length) {
      recentList.append(h("span", { class: "hire-mini", text: "Recent" }));
      for (const f of recent) {
        const b = h("button", { class: "chip-btn", attrs: { type: "button", "aria-pressed": String(f === folder), title: tidyPath(f) }, text: f.split("/").filter(Boolean).pop() || f });
        b.addEventListener("click", () => {
          folder = f;
          browsing = false;
          render();
        });
        recentList.append(b);
      }
    }
    fsBox.hidden = !browsing;
    browseBtn.setAttribute("aria-expanded", String(browsing));

    // sandbox
    provTabs.replaceChildren();
    for (const p of PROVIDERS) {
      const ps = prov(p);
      const b = h(
        "button",
        { class: `hire-prov host-${p}`, attrs: { type: "button", role: "radio", "aria-checked": String(p === provider), title: ps?.ready ? `Ready${ps.via ? ` · via ${ps.via}` : ""}` : "Not logged in" } },
        hostLogo(p),
        h("span", { text: PLACE_NAME[p] }),
        h("span", { class: `ready-dot${ps?.ready ? " is-ready" : ""}`, attrs: { "aria-label": ps?.ready ? "ready" : "not logged in" } }),
      );
      b.addEventListener("click", () => {
        provider = p;
        sandbox = running(prov(p))[0]?.id ?? "new";
        render();
      });
      provTabs.append(b);
    }
    sbxList.replaceChildren();
    const ps = prov(provider);
    if (!ps?.ready) {
      sbxList.append(
        h(
          "div",
          { class: "hire-empty" },
          h("p", { text: `${PLACE_NAME[provider]} isn't logged in. Add its API key in Settings, or log in with its CLI and reopen this dialog.` }),
          h("button", { class: "btn btn-quiet", attrs: { type: "button" }, text: "Add a key", on: { click: () => opts.openSettings("keys") } }),
        ),
      );
    } else {
      const opt = (value: string, title: Node[], sub: Node[], extra?: Node) => {
        const b = h("button", { class: "hire-opt", attrs: { type: "button", role: "radio", "aria-checked": String(sandbox === value) } }, h("span", { class: "radio" }), h("span", { class: "hire-opt-main" }, h("span", { class: "hire-opt-title" }, ...title), h("span", { class: "hire-opt-sub" }, ...sub)), extra ?? null);
        b.addEventListener("click", (ev) => {
          if (ev.target instanceof HTMLSelectElement) return;
          sandbox = value;
          render();
        });
        return b;
      };
      for (const s of running(ps)) {
        sbxList.append(
          opt(
            s.id,
            [h("span", { text: s.name || s.id }), s.ours ? h("span", { class: "chip chip-ours", text: "ours" }) : null].filter(Boolean) as Node[],
            [h("span", { text: `${s.status}${s.workers ? ` · ${s.workers} working` : ""}${s.expiresAt ? ` · stops ${until(s.expiresAt)}` : ""}` })],
          ),
        );
      }
      if (ps.canCreate) {
        const row = opt("new", [icon("plus", 1), h("span", { text: "New sandbox" })], [h("span", { text: "Stops on its own after" }), timeoutSel]);
        sbxList.append(row);
        if (provider === "railway" && sandbox === "new") {
          const pickRow = railwayPicker(ps, railwayChoice(ps, railwayPick), (p) => {
            railwayPick = p;
            renderSummary();
          });
          if (pickRow) sbxList.append(pickRow);
        }
        sbxList.append(h("p", { class: "hire-hint hire-cost", text: `${PLACE_NAME[provider]} bills for the sandbox while it runs, on your account. It stops after the timeout, or when you delete it in Settings.` }));
      } else if (!running(ps).length) {
        sbxList.append(h("p", { class: "hire-empty", text: provider === "railway" && ps.note ? `${ps.note}.` : `No running ${PLACE_NAME[provider]} sandboxes, and this login can't create one.` }));
      }
    }
    timeoutSel.value = String(timeoutMin);

    // ssh
    hostList.replaceChildren();
    const hosts = prov("ssh")?.hosts ?? [];
    for (const host of hosts) {
      const b = h("button", { class: "hire-opt", attrs: { type: "button", role: "radio", "aria-checked": String(sshHost === host && !hostInput.value) } }, h("span", { class: "radio" }), h("span", { class: "hire-opt-title", text: host }));
      b.addEventListener("click", () => {
        sshHost = host;
        hostInput.value = "";
        render();
      });
      hostList.append(b);
    }
    if (!hosts.length) hostList.append(h("p", { class: "hire-hint", text: "No hosts in ~/.ssh/config or the office config. Type one below." }));
  }

  function renderMode(): void {
    const here = modesHere(agent);
    if (!here.includes(mode)) mode = "terminal";
    for (const b of [termMode, chatMode]) {
      const m = b.dataset.mode as ControlMode;
      const ok = here.includes(m);
      b.disabled = !ok;
      b.setAttribute("aria-checked", String(m === mode));
      // Why it's off, as text: a disabled button shows no tooltip in most browsers.
      const why = ok
        ? ""
        : !HEADLESS.includes(agent)
          ? `${agentName(agent)} has no headless protocol: terminal only`
          : where === "local"
            ? (avail(agent).note ?? "Terminal only on this Mac")
            : `${agentName(agent)} runs on this Mac only for now`;
      b.title = why;
      setText(b.querySelector("small")!, why || (m === "terminal" ? "The agent's own TUI, live" : "Messages, tool calls, approvals"));
    }
    const perms = permsOf(agent);
    if (!perms.includes(permission)) permission = perms[0] ?? "default";
    for (const o of permSel.options) o.disabled = !perms.includes(o.value as PermissionMode);
    permSel.value = permission;
    const p = PERMISSIONS.find((x) => x.mode === permission);
    setText(permHint, p?.hint ?? "");
    permHint.hidden = !p?.hint;
    bypassWarn.hidden = permission !== "bypass";
  }

  function presetKeys(): Set<string> {
    const names = new Set(avail(agent).keyNames);
    const out = new Set<string>();
    for (const k of store.info?.keys ?? []) if (names.has(k.name) || k.agents.includes(agent)) out.add(k.name);
    return out;
  }

  function renderKeys(): void {
    // With "Your setup" on, its Login row lists the keys (stored and from the shell).
    keysSection.hidden = where === "local" || setupSec.on;
    cwdInput.placeholder = (where !== "local" && setupSec.on && setupSec.cwdHint()) || "Home folder";
    if (keysSection.hidden) return;
    keyList.replaceChildren();
    const stored = store.info?.keys ?? [];
    if (!stored.length) {
      keyList.append(h("div", { class: "hire-empty" }, h("p", { text: `No keys stored. ${agentName(agent)} will need to log in by itself in the terminal.` }), h("button", { class: "btn btn-quiet", attrs: { type: "button" }, text: "Add a key", on: { click: () => opts.openSettings("keys") } })));
      return;
    }
    for (const k of stored) {
      const box = h("input", { attrs: { type: "checkbox" } });
      box.checked = keys.has(k.name);
      box.addEventListener("change", () => {
        keysTouched = true;
        if (box.checked) keys.add(k.name);
        else keys.delete(k.name);
        renderSummary();
      });
      keyList.append(
        h(
          "label",
          { class: "hire-key" },
          box,
          h("code", { class: "hire-key-name", text: k.name }),
          h("span", { class: "hire-key-preview", text: k.preview }),
          h("span", { class: "hire-key-agents" }, ...k.agents.slice(0, 4).map((a) => logo(a))),
        ),
      );
    }
  }

  function place(): Place | null {
    const cwd = cwdInput.value.trim() || undefined;
    if (where === "local") return folder ? { kind: "local", target: folder } : null;
    if (where === "sandbox") return prov(provider)?.ready ? { kind: provider, target: sandbox, cwd } : null;
    const host = hostInput.value.trim() || sshHost;
    return host ? { kind: "ssh", target: host, cwd } : null;
  }

  function problem(): string {
    if (where === "local" && !avail(agent).installed) return `${agentName(agent)} isn't installed on this Mac.`;
    if (where !== "local" && agent === "opencode") return "opencode runs on this Mac only for now.";
    if (where === "local" && !folder) return "Pick a folder for it to work in.";
    if (where === "sandbox" && !prov(provider)?.ready) return `Log in to ${PLACE_NAME[provider]} first.`;
    if (where === "sandbox" && sandbox === "new" && !prov(provider)?.canCreate) return "Pick a running sandbox.";
    if (where === "sandbox" && sandbox === "new" && provider === "railway" && !railwayChoice(prov("railway"), railwayPick)) return "Pick the Railway project for the new sandbox.";
    if (where === "ssh" && !(hostInput.value.trim() || sshHost)) return "Pick an ssh host.";
    return setupSec.problem();
  }

  function renderSummary(): void {
    const p = place();
    const inRailway = p?.kind === "railway" && p.target === "new" ? railwayLabel(prov("railway"), railwayChoice(prov("railway"), railwayPick)) : "";
    const whereText = !p ? "" : p.kind === "local" ? tidyPath(p.target) : p.kind === "ssh" ? `ssh ${p.target}` : `${PLACE_NAME[p.kind]} · ${p.target === "new" ? `new sandbox${inRailway ? ` in ${inRailway}` : ""}` : sbxName(p.target)}`;
    setText(summary, [agentName(agent), mode === "chat" ? "chat" : "terminal", whereText, setupSec.on ? "your setup" : ""].filter(Boolean).join(" · "));
    const why = problem();
    hireBtn.disabled = busy || !!why;
    hireBtn.title = why;
    setText(hireBtn.querySelector(".hire-btn-text")!, busy ? "Hiring…" : `Hire ${agentName(agent)}`);
    el.style.setProperty("--accent", agentColor(agent));
  }
  const sbxName = (id: string) => running(prov(provider)).find((s) => s.id === id)?.name ?? id;

  function render(): void {
    renderAgents();
    renderWhere();
    renderMode();
    setupSec.update({ agent, remote: where !== "local", mode });
    renderKeys();
    renderSummary();
  }

  /* ---- folder browser ---- */
  async function browse(path?: string): Promise<void> {
    browsing = true;
    fsBox.hidden = false;
    fsList.replaceChildren(h("li", { class: "fs-msg", text: "Loading…" }));
    try {
      listing = await api.fs(path);
      fsAt = path;
      setText(fsPath, listing.path);
      fsUp.disabled = !listing.parent;
      fsUse.disabled = !fsAt;
      fsList.replaceChildren();
      if (!listing.dirs.length) fsList.append(h("li", { class: "fs-msg", text: "No folders in here." }));
      for (const d of listing.dirs) {
        const row = h(
          "li",
          null,
          h(
            "button",
            { class: "fs-dir", attrs: { type: "button", title: `Open ${d.name}` }, on: { click: () => void browse(d.path) } },
            icon("folder", 1),
            h("span", { class: "fs-name", text: d.name }),
            d.git ? h("span", { class: "chip", text: "git" }) : null,
          ),
          h("button", { class: "fs-pick", attrs: { type: "button", "aria-label": `Use ${d.name}` }, text: "Use", on: { click: () => { folder = d.path; browsing = false; render(); } } }),
        );
        fsList.append(row);
      }
    } catch (e) {
      fsList.replaceChildren(h("li", { class: "fs-msg is-err", text: e instanceof ControlError ? e.message : "Couldn't list that folder." }));
    }
    render();
  }
  browseBtn.addEventListener("click", () => {
    if (browsing) {
      browsing = false;
      render();
    } else {
      // open next to the chosen folder, so its siblings are one click away
      const up = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
      void browse(up || undefined);
    }
  });
  fsUp.addEventListener("click", () => listing?.parent && void browse(listing.parent));
  fsUse.addEventListener("click", () => {
    if (!listing || !fsAt) return;
    folder = fsAt;
    browsing = false;
    render();
  });

  /* ---- inputs ---- */
  whereTabs.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-where]") : null;
    if (!t) return;
    where = t.dataset.where as Where;
    if (!keysTouched) keys = presetKeys();
    render();
  });
  modes.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target.closest<HTMLButtonElement>("[data-mode]") : null;
    if (!t || t.disabled) return;
    mode = t.dataset.mode as ControlMode;
    render();
  });
  permSel.addEventListener("change", () => {
    permission = permSel.value as PermissionMode;
    render();
    // The warning is what this choice is about: never leave it below the fold.
    if (permission === "bypass") scroller.reveal(bypassWarn);
  });
  timeoutSel.addEventListener("change", () => {
    timeoutMin = Number(timeoutSel.value) || 30;
  });
  hostInput.addEventListener("input", () => {
    if (hostInput.value.trim()) for (const b of hostList.querySelectorAll("[role=radio]")) b.setAttribute("aria-checked", "false");
    renderSummary();
  });
  cwdInput.addEventListener("input", renderSummary);
  cancelBtn.addEventListener("click", () => el.close());
  closeX.addEventListener("click", () => el.close());
  el.addEventListener("click", (ev) => {
    if (ev.target === el) el.close();
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void submit();
  });

  async function submit(): Promise<void> {
    const p = place();
    if (!p || problem() || busy) return;
    const req: HireRequest = { agent, place: p, mode, permission };
    const prompt = promptInput.value.trim();
    if (prompt) req.prompt = prompt;
    if (p.kind !== "local") {
      if (setupSec.on) setupSec.apply(req);
      else req.keys = [...keys];
    }
    if (p.kind !== "local" && p.kind !== "ssh" && p.target === "new") req.sandbox = { timeoutMin, ...(p.kind === "railway" ? railwayChoice(prov("railway"), railwayPick) : {}) };
    busy = true;
    err.hidden = true;
    renderSummary();
    try {
      const s = await api.hire(req);
      promptInput.value = "";
      el.close();
      opts.onHired(s);
    } catch (e) {
      err.hidden = false;
      setText(err, e instanceof ControlError ? e.message : "Couldn't hire the agent.");
    } finally {
      busy = false;
      renderSummary();
    }
  }

  return {
    el,
    open() {
      if (el.open) return;
      setupSec.refresh();
      pickDefaults();
      if (!keysTouched) keys = presetKeys();
      err.hidden = true;
      browsing = false;
      render();
      el.showModal();
      body.scrollTo({ top: 0, behavior: "instant" });
      scroller.sync();
      requestAnimationFrame(() => agentGrid.querySelector<HTMLElement>("[aria-checked=true]")?.focus());
    },
    close: () => el.close(),
    isOpen: () => el.open,
    sync() {
      if (el.open) render();
    },
    warm() {
      if (el.open) return;
      pickDefaults();
      setupSec.update({ agent, remote: where !== "local", mode });
    },
  };
}

interface ScrollArea {
  el: HTMLElement;
  /** Re-check the fades (content changed while hidden). */
  sync(): void;
  /** Scroll so `t` is in view, clear of the fades. */
  reveal(t: HTMLElement): void;
  /** Let the wheel or trackpad anywhere over `root` (header, footer, backdrop) scroll the body. */
  wheelFrom(root: HTMLElement): void;
}

/**
 * A dialog body as one obvious scroll area: a fade at the top and at the
 * bottom while there's more that way, and focus scrolled clear of them.
 */
function scrollArea(body: HTMLElement): ScrollArea {
  const top = h("div", { class: "scroll-fade is-top", attrs: { "aria-hidden": "true" } });
  const bottom = h("div", { class: "scroll-fade is-bottom", attrs: { "aria-hidden": "true" } });
  const el = h("div", { class: "dlg-scroll" }, body, top, bottom);
  const sync = () => {
    const max = body.scrollHeight - body.clientHeight;
    el.classList.toggle("can-up", body.scrollTop > 1);
    el.classList.toggle("can-down", body.scrollTop < max - 1);
  };
  body.addEventListener("scroll", sync, { passive: true });
  // The body resizes with the window; its columns grow as rows open or the setup loads.
  const ro = new ResizeObserver(sync);
  ro.observe(body);
  for (const c of body.children) ro.observe(c);
  const smooth = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reveal = (t: HTMLElement) => {
    if (!t.isConnected || t.hidden) return;
    t.scrollIntoView({ block: "nearest", behavior: smooth() ? "smooth" : "auto" });
  };
  // scroll-padding keeps what gets focus out from under the fades
  body.addEventListener("focusin", (ev) => {
    const t = ev.target;
    if (t instanceof HTMLElement && t !== body) reveal(t);
  });
  return {
    el,
    sync,
    reveal: (t) => requestAnimationFrame(() => reveal(t)),
    wheelFrom(root) {
      root.addEventListener(
        "wheel",
        (ev) => {
          if (ev.ctrlKey || ev.defaultPrevented) return; // pinch-zoom
          const t = ev.target instanceof Node ? ev.target : null;
          if (t && body.contains(t)) return; // the body, or a list inside it, scrolls itself
          const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * body.clientHeight : ev.deltaY;
          if (!dy) return;
          ev.preventDefault();
          body.scrollBy({ top: dy, behavior: "instant" });
        },
        { passive: false },
      );
    },
  };
}

/**
 * Radio groups and the tab list as one Tab stop each, the way the ARIA
 * pattern has it: the checked (or selected) item is the stop, arrow keys
 * move between the enabled items and pick them, Home and End jump. Groups
 * are re-rendered often, so the stops follow every change in `root`.
 */
function roving(root: HTMLElement): void {
  const GROUPS = '[role="radiogroup"], [role="tablist"]';
  const ITEMS = '[role="radio"], [role="tab"]';
  const items = (g: Element) => [...g.querySelectorAll<HTMLElement>(ITEMS)].filter((b) => b.closest(GROUPS) === g);
  const on = (b: HTMLElement) => b.getAttribute("aria-checked") === "true" || b.getAttribute("aria-selected") === "true";
  const usable = (b: HTMLElement) => !(b as HTMLButtonElement).disabled && b.getAttribute("aria-disabled") !== "true" && !b.hidden;
  const stops = () => {
    for (const g of root.querySelectorAll(GROUPS)) {
      const all = items(g);
      const stop = all.find((b) => on(b) && usable(b)) ?? all.find(usable);
      for (const b of all) {
        const want = b === stop ? "0" : "-1";
        if (b.getAttribute("tabindex") !== want) b.setAttribute("tabindex", want);
      }
    }
  };
  new MutationObserver(stops).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-checked", "aria-selected", "disabled", "hidden"] });
  stops();
  root.addEventListener("keydown", (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.matches?.(ITEMS) || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const g = t.closest(GROUPS);
    if (!g) return;
    const list = items(g).filter(usable);
    const i = list.indexOf(t);
    const n = list.length;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[ev.key];
    if (to === undefined || !n) return;
    ev.preventDefault();
    const next = list[(to + n) % n]!;
    next.focus();
    if (next === t) return;
    next.click();
    // Picking re-renders some groups: keep the focus on the item now picked.
    if (!next.isConnected) (items(g).find(on) ?? items(g).find(usable))?.focus();
  });
}

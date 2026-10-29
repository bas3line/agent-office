/*
 * The settings drawer: the keys the office keeps for your agents, the cloud
 * providers and sandboxes, the agents on this Mac and the office's MCP
 * install, and the background service. A key's value is typed into a
 * password field, sent once and cleared; the page never shows it again, keeps
 * no copy, and only ever sees a short preview from the server.
 */
import type { InstallPlan, KeyInfo, LoginFlow, ProviderStatus, SandboxInfo } from "../../../src/shared/control.ts";
import { BRAND, WATCH_ONLY_AGENTS, type AgentKind } from "../../../src/shared/events.ts";
import { h, setText } from "../dom.ts";
import { ago } from "../format.ts";
import { glyph, icon } from "../icons.ts";
import { agentName, hostLogo, logo } from "../logos.ts";
import { api, ControlError } from "./api.ts";
import { PLACE_NAME, until } from "./format.ts";
import { railwayWhere } from "./railway.ts";
import type { ControlStore } from "./store.ts";

export type SettingsTab = "logins" | "keys" | "cloud" | "agents" | "service";

export interface SettingsDrawer {
  el: HTMLElement;
  open(tab?: SettingsTab): void;
  close(): void;
  isOpen(): boolean;
  sync(): void;
}

const AGENTS = (Object.keys(BRAND) as AgentKind[]).filter((a) => !WATCH_ONLY_AGENTS.includes(a));
const TABS: [SettingsTab, string, Parameters<typeof icon>[0]][] = [
  ["logins", "Logins", "lock"],
  ["keys", "Keys", "key"],
  ["cloud", "Cloud", "cloud"],
  ["agents", "Agents", "terminal"],
  ["service", "Service", "power"],
];

export function createSettings(store: ControlStore, opts: { onClose(): void; toast(text: string, tone?: "plain" | "error" | "pass"): void }): SettingsDrawer {
  let tab: SettingsTab = "logins";
  const tabBar = h("div", { class: "set-tabs", attrs: { role: "tablist", "aria-label": "Settings" } });
  for (const [t, label, ic] of TABS) {
    const b = h("button", { class: "set-tab", attrs: { type: "button", role: "tab", "aria-selected": "false", "data-tab": t } }, icon(ic, 1), h("span", { text: label }));
    b.addEventListener("click", () => {
      tab = t;
      render();
    });
    tabBar.append(b);
  }
  const closeBtn = h("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Close settings", title: "Close  Esc" } }, glyph("close", 1));
  const body = h("div", { class: "set-body" });
  const el = h(
    "aside",
    { class: "settings glass", attrs: { hidden: true, "aria-label": "Settings" } },
    h("header", { class: "set-head" }, h("h2", { class: "set-title", text: "Settings" }), closeBtn),
    tabBar,
    body,
  );
  closeBtn.addEventListener("click", () => opts.onClose());

  /* ---------------------------------------------------------------- keys */
  const nameInput = h("input", { class: "field", attrs: { type: "text", placeholder: "ANTHROPIC_API_KEY", autocomplete: "off", spellcheck: "false", autocapitalize: "characters", "aria-label": "Key name", maxlength: 64 } });
  const valueInput = h("input", { class: "field", attrs: { type: "password", placeholder: "Paste the key", autocomplete: "new-password", spellcheck: "false", "aria-label": "Key value", "data-1p-ignore": "true", "data-lpignore": "true" } });
  const tagBox = h("div", { class: "set-tags", attrs: { role: "group", "aria-label": "For these agents" } });
  const tags = new Set<AgentKind>();
  for (const a of AGENTS) {
    const b = h("button", { class: "tag-btn", attrs: { type: "button", "aria-pressed": "false", title: agentName(a) } }, logo(a), h("span", { text: agentName(a).replace(/ (Code|CLI)$/, "") }));
    b.addEventListener("click", () => {
      if (tags.has(a)) tags.delete(a);
      else tags.add(a);
      b.setAttribute("aria-pressed", String(tags.has(a)));
    });
    tagBox.append(b);
  }
  const saveBtn = h("button", { class: "btn btn-primary", attrs: { type: "submit" }, text: "Save key" });
  const keyErr = h("p", { class: "set-err", attrs: { hidden: true, role: "alert" } });
  const keyForm = h(
    "form",
    { class: "set-card set-keyform", attrs: { autocomplete: "off" } },
    h("h3", { class: "set-h", text: "Add a key" }),
    h("label", { class: "set-field" }, h("span", { text: "Name" }), nameInput),
    h("label", { class: "set-field" }, h("span", { text: "Value" }), valueInput),
    h("div", { class: "set-field" }, h("span", { text: "For" }), tagBox),
    keyErr,
    h("div", { class: "set-row" }, h("p", { class: "set-hint", text: "Stored on this Mac only (owner-only file). Passed to a remote agent only when you tick it while hiring." }), saveBtn),
  );
  keyForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = nameInput.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      keyErr.hidden = false;
      setText(keyErr, "Use an environment variable name: letters, digits and _.");
      return;
    }
    if (!valueInput.value) {
      keyErr.hidden = false;
      setText(keyErr, "Paste the key's value.");
      return;
    }
    keyErr.hidden = true;
    saveBtn.disabled = true;
    // read once, clear the field at once; the page keeps no copy
    const req = { name, value: valueInput.value, agents: [...tags] };
    valueInput.value = "";
    api.addKey(req).then(
      (k) => {
        nameInput.value = "";
        tags.clear();
        for (const b of tagBox.querySelectorAll("[aria-pressed]")) b.setAttribute("aria-pressed", "false");
        opts.toast(`Saved ${k.name}`, "pass");
        void store.refresh();
      },
      (e: unknown) => {
        keyErr.hidden = false;
        setText(keyErr, e instanceof ControlError ? e.message : "Couldn't save the key.");
      },
    ).finally(() => {
      saveBtn.disabled = false;
    });
    req.value = "";
  });

  function keyRow(k: KeyInfo): HTMLElement {
    const del = h("button", { class: "icon-btn", attrs: { type: "button", "aria-label": `Delete ${k.name}`, title: "Delete" } }, icon("trash", 1));
    let armed = 0;
    del.addEventListener("click", () => {
      if (!armed) {
        del.classList.add("is-armed");
        del.title = "Click again to delete";
        armed = window.setTimeout(() => { armed = 0; del.classList.remove("is-armed"); del.title = "Delete"; }, 3000);
        return;
      }
      clearTimeout(armed);
      api.deleteKey(k.name).then(() => { opts.toast(`Deleted ${k.name}`); void store.refresh(); }, (e: Error) => opts.toast(`Couldn't delete: ${e.message}`, "error"));
    });
    return h(
      "li",
      { class: "set-key" },
      h("div", { class: "set-key-main" }, h("code", { class: "set-key-name", text: k.name }), h("span", { class: "set-key-preview", text: k.preview })),
      h("span", { class: "set-key-agents" }, ...k.agents.map((a) => logo(a))),
      h("time", { class: "ago", text: ago(Date.parse(k.addedAt)) }),
      del,
    );
  }

  const importBtn = h("button", { class: "btn btn-quiet", attrs: { type: "button" } }, icon("terminal", 1), h("span", { text: "Import from my shell" }));
  importBtn.addEventListener("click", () => {
    importBtn.disabled = true;
    api.importKeys().then(
      (r) => {
        opts.toast(r.imported.length ? `Imported ${r.imported.join(", ")}` : "No known keys in your shell's environment", r.imported.length ? "pass" : "plain");
        void store.refresh();
      },
      (e: Error) => opts.toast(`Import failed: ${e.message}`, "error"),
    ).finally(() => { importBtn.disabled = false; });
  });

  function renderKeys(): Node[] {
    const keys = store.info?.keys ?? [];
    const list = h("ul", { class: "set-list" }, ...keys.map(keyRow));
    return [
      h("p", { class: "set-lede", text: "agent office keeps these keys for your agents and passes the ones you choose into a sandbox or ssh box when you hire an agent there. Values never come back to this page." }),
      h("div", { class: "set-card" }, h("div", { class: "set-row" }, h("h3", { class: "set-h", text: `Stored keys${keys.length ? ` · ${keys.length}` : ""}` }), importBtn), keys.length ? list : h("p", { class: "set-empty", text: "No keys yet. Add one below, or import the ones your shell already exports." })),
      keyForm,
    ];
  }

  /* -------------------------------------------------------------- logins */
  const codeInput = h("input", { class: "field", attrs: { type: "text", placeholder: "Paste the code from the browser", autocomplete: "off", spellcheck: "false", "aria-label": "Code from the browser", "data-1p-ignore": "true" } });
  const codeSend = h("button", { class: "btn btn-quiet", attrs: { type: "submit" }, text: "Send code" });
  const codeForm = h("form", { class: "set-row login-code", attrs: { autocomplete: "off" } }, codeInput, codeSend);
  codeForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = codeInput.value.trim();
    if (!v) return;
    codeInput.value = "";
    api.loginInput(`${v}\r`).catch((e: Error) => opts.toast(`Couldn't send it: ${e.message}`, "error"));
  });
  let loginBusy = false;
  const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

  function startLogin(): void {
    loginBusy = true;
    render();
    api.loginStart().then(
      (f) => {
        if (store.info) store.info.logins = [f];
        opts.toast("Your browser opens to sign in to Claude", "plain");
      },
      (e: Error) => opts.toast(`Couldn't start it: ${e.message}`, "error"),
    ).finally(() => {
      loginBusy = false;
      render();
    });
  }

  function renderLogins(): Node[] {
    const f: LoginFlow = store.info?.logins?.find((x) => x.agent === "claude") ?? { agent: "claude", state: "idle" };
    const connected = f.state === "connected" || (f.state === "failed" && !!f.connectedAt);
    const status = f.state === "running"
      ? h("span", { class: "set-ready is-wait" }, h("span", { class: "ready-dot is-wait" }), h("span", { text: "Signing in…" }))
      : connected
        ? h("span", { class: "set-ready is-ready" }, h("span", { class: "ready-dot is-ready" }), h("span", { text: `Connected${f.expiresAt ? ` · expires ~${fmtDate(f.expiresAt)}` : ""}` }))
        : h("span", { class: "set-ready" }, h("span", { class: "ready-dot" }), h("span", { text: "Not connected" }));
    const actions = h("div", { class: "set-row login-actions" });
    if (f.state === "running") {
      actions.append(h("span", { class: "set-hint", text: "Approve it in the browser; the office takes the token from there." }), h("button", { class: "btn btn-quiet", attrs: { type: "button" }, text: "Cancel", on: { click: () => api.loginCancel().catch(() => {}) } }));
    } else if (connected) {
      const del = h("button", { class: "btn btn-quiet btn-danger", attrs: { type: "button" }, text: "Disconnect" });
      let armed = 0;
      del.addEventListener("click", () => {
        if (!armed) {
          setText(del, "Disconnect?");
          armed = window.setTimeout(() => { armed = 0; setText(del, "Disconnect"); }, 3000);
          return;
        }
        clearTimeout(armed);
        api.deleteKey("CLAUDE_CODE_OAUTH_TOKEN").then(() => { opts.toast("Disconnected Claude"); void store.refresh(); }, (e: Error) => opts.toast(`Couldn't: ${e.message}`, "error"));
      });
      const when = f.connectedAt ? ago(Date.parse(f.connectedAt)) : "";
      actions.append(h("span", { class: "set-hint", text: when ? `Connected ${/^now$|^0/.test(when) ? "just now" : `${when} ago`}.` : "" }), h("button", { class: "btn btn-quiet", attrs: { type: "button", disabled: loginBusy }, text: "Reconnect", on: { click: startLogin } }), del);
    } else {
      actions.append(h("span", { class: "dlg-gap" }), h("button", { class: "btn btn-primary", attrs: { type: "button", disabled: loginBusy }, text: loginBusy ? "Starting…" : "Connect Claude", on: { click: startLogin } }));
    }
    const running: Node[] = [];
    if (f.state === "running") {
      if (f.url) running.push(h("p", { class: "set-hint" }, h("span", { text: "Browser didn't open? " }), h("a", { class: "login-link", attrs: { href: f.url, target: "_blank", rel: "noopener noreferrer" }, text: "Open the sign-in page" })));
      if (f.screen) running.push(h("pre", { class: "set-diff login-screen", attrs: { "aria-label": "claude setup-token", tabindex: 0 }, text: f.screen }));
      if (f.wantsCode) running.push(codeForm);
    }
    return [
      h("p", { class: "set-lede", text: "Sign-ins for the agents you hire into a sandbox or onto an ssh box. They stay on this Mac; one goes to an agent only when you pick it in Your setup." }),
      h(
        "div",
        { class: "set-card set-login" },
        h("div", { class: "set-row" }, h("span", { class: "set-prov-name" }, logo("claude"), h("b", { text: "Claude subscription" })), status),
        h("p", { class: "set-hint", text: "Runs claude setup-token here. Your browser opens to sign in; the one-year token it prints is kept as CLAUDE_CODE_OAUTH_TOKEN and never shown." }),
        f.state === "failed" && f.error ? h("p", { class: "set-err", text: f.error }) : null,
        ...running,
        actions,
        h("p", { class: "set-hint set-muted-hint", text: "A setup-token can only make model requests: claude.ai connectors don't come along. MCP servers set up on this Mac do, through Your setup." }),
      ),
      h(
        "div",
        { class: "set-card set-login" },
        h("div", { class: "set-row" }, h("span", { class: "set-prov-name" }, logo("codex"), h("b", { text: "Codex" })), h("span", { class: "set-ready" }, h("span", { text: "Signs in there" }))),
        h("p", { class: "set-hint", text: "With an API key, with a device code shown in the session panel, or with this Mac's ChatGPT sign-in copied over (~/.codex/auth.json). You pick when you hire." }),
      ),
      h(
        "div",
        { class: "set-card set-login" },
        h("div", { class: "set-row" }, h("span", { class: "set-prov-name" }, icon("key", 1), h("b", { text: "Other agents" })), h("span", { class: "set-ready" }, h("span", { text: `${(store.info?.keys ?? []).length} stored key${(store.info?.keys ?? []).length === 1 ? "" : "s"}` }))),
        h("p", { class: "set-hint", text: "Stored keys, plus the known key names your login shell exports: those are read when you hire and handed over without being stored." }),
        h("div", { class: "set-row" }, h("span", { class: "dlg-gap" }), h("button", { class: "btn btn-quiet", attrs: { type: "button" }, text: "Manage keys", on: { click: () => { tab = "keys"; render(); } } })),
      ),
    ];
  }

  /* --------------------------------------------------------------- cloud */
  function sandboxRow(p: ProviderStatus, s: SandboxInfo): HTMLElement {
    const del = h("button", { class: "btn btn-quiet btn-danger btn-sm", attrs: { type: "button" }, text: "Delete" });
    let armed = 0;
    del.addEventListener("click", () => {
      if (!armed) {
        setText(del, "Delete?");
        del.classList.add("is-armed");
        armed = window.setTimeout(() => { armed = 0; setText(del, "Delete"); del.classList.remove("is-armed"); }, 3000);
        return;
      }
      clearTimeout(armed);
      del.disabled = true;
      api.deleteSandbox(p.kind, s.id).then(() => { opts.toast(`Deleting ${s.name || s.id}`); void store.refresh(); }, (e: Error) => { del.disabled = false; opts.toast(`Couldn't delete: ${e.message}`, "error"); });
    });
    const meta = [s.status, s.workers ? `${s.workers} working` : "", s.expiresAt ? `stops ${until(s.expiresAt)}` : "", s.createdAt ? `started ${ago(Date.parse(s.createdAt))} ago` : ""].filter(Boolean).join(" · ");
    return h(
      "li",
      { class: "set-sbx" },
      h("span", { class: `sbx-dot is-${s.status}` }),
      h("div", { class: "set-sbx-main" }, h("span", { class: "set-sbx-name" }, h("span", { text: s.name || s.id }), s.ours ? h("span", { class: "chip chip-ours", text: "ours" }) : null), h("span", { class: "set-sbx-meta", text: meta })),
      s.ours ? del : h("span", { class: "set-muted", attrs: { title: "Created outside the office: delete it with its own CLI" }, text: "not ours" }),
    );
  }

  function renderCloud(): Node[] {
    const provs = (store.info?.providers ?? []).filter((p) => p.kind !== "ssh");
    const ssh = store.info?.providers.find((p) => p.kind === "ssh");
    const cards = provs.map((p) =>
      h(
        "div",
        { class: `set-card set-prov host-${p.kind}` },
        h(
          "div",
          { class: "set-row" },
          h("span", { class: "set-prov-name" }, hostLogo(p.kind as "daytona"), h("b", { text: PLACE_NAME[p.kind as "daytona"] ?? p.name })),
          h("span", { class: `set-ready${p.ready ? " is-ready" : ""}` }, h("span", { class: "ready-dot" + (p.ready ? " is-ready" : "") }), h("span", { text: p.ready ? `Ready${p.via ? ` · ${p.via}` : ""}` : "Not logged in" })),
        ),
        p.sandboxes.length ? h("ul", { class: "set-list" }, ...p.sandboxes.map((s) => sandboxRow(p, s))) : h("p", { class: "set-empty", text: p.ready ? "No sandboxes running." : `Add a ${p.kind.toUpperCase()} key under Keys, or log in with the ${p.kind} CLI.` }),
        p.kind === "railway" && p.ready && railwayWhere(p) ? h("p", { class: "set-hint", text: railwayWhere(p) }) : null,
      ),
    );
    return [
      h("p", { class: "set-lede", text: "Sandboxes the office created are marked ours; only those can be deleted from here. Each provider bills you while its sandboxes run." }),
      ...cards,
      h("div", { class: "set-card" }, h("h3", { class: "set-h", text: "ssh hosts" }), ssh?.hosts?.length ? h("p", { class: "set-mono", text: ssh.hosts.join("  ·  ") }) : h("p", { class: "set-empty", text: "None found in ~/.ssh/config or the office config." })),
    ];
  }

  /* -------------------------------------------------------------- agents */
  let plan: InstallPlan | null = null;
  let planBusy = false;
  let planErr = "";
  async function loadPlan(apply: boolean): Promise<void> {
    planBusy = true;
    planErr = "";
    render();
    try {
      plan = apply ? await api.install() : await api.installPlan();
      if (apply) opts.toast("Installed the office MCP server and skill", "pass");
    } catch (e) {
      planErr = e instanceof ControlError ? e.message : "Couldn't reach the installer.";
    } finally {
      planBusy = false;
      render();
    }
  }

  function renderAgents(): Node[] {
    const rows = AGENTS.map((a) => {
      const av = store.info?.agents.find((x) => x.agent === a);
      return h(
        "li",
        { class: "set-agent" },
        logo(a),
        h("span", { class: "set-agent-name", text: agentName(a) }),
        av?.installed ? h("span", { class: "set-agent-ver", text: av.version || "installed" }) : h("code", { class: "set-agent-cmd", text: av?.installCmd || "not installed" }),
        h("span", { class: "set-agent-modes", text: av ? av.modes.join(" · ") : "" }),
      );
    });
    const planBox: Node[] = [];
    if (plan) {
      for (const p of plan.agents) {
        if (!p.found) continue;
        const files = p.files.length ? p.files.join(", ") : "";
        planBox.push(
          h(
            "details",
            { class: "set-plan" },
            h("summary", null, logo(p.agent), h("b", { text: agentName(p.agent) }), h("span", { class: `plan-chip is-${p.mcp}`, text: `MCP ${p.mcp}` }), h("span", { class: `plan-chip is-${p.skill}`, text: `skill ${p.skill}` }), p.error ? h("span", { class: "chip chip-error", text: "error" }) : null),
            files ? h("p", { class: "set-mono", text: files }) : null,
            p.error ? h("p", { class: "set-err", text: p.error }) : null,
            p.diff ? h("pre", { class: "set-diff", text: p.diff }) : null,
          ),
        );
      }
      if (!planBox.length) planBox.push(h("p", { class: "set-empty", text: "No agents found on this Mac." }));
    }
    const pending = plan && !plan.applied && plan.agents.some((p) => p.found && (p.mcp === "add" || p.mcp === "update" || p.skill === "add" || p.skill === "update"));
    const actions = h(
      "div",
      { class: "set-row" },
      h("p", { class: "set-hint", text: plan?.applied ? "Done. Restart running agents to pick it up." : plan ? (pending ? "Review the changes, then apply. Every changed file gets a backup first." : "Everything is up to date.") : "Registers the office MCP server and skill with every agent it finds. Shows the plan first." }),
      plan && pending
        ? h("button", { class: "btn btn-primary", attrs: { type: "button", disabled: planBusy }, text: planBusy ? "Applying…" : "Apply", on: { click: () => void loadPlan(true) } })
        : h("button", { class: "btn btn-quiet", attrs: { type: "button", disabled: planBusy }, text: planBusy ? "Checking…" : plan ? "Check again" : "Install MCP & skills", on: { click: () => void loadPlan(false) } }),
    );
    return [
      h("div", { class: "set-card" }, h("h3", { class: "set-h", text: "On this Mac" }), h("ul", { class: "set-list" }, ...rows)),
      h("div", { class: "set-card" }, h("h3", { class: "set-h", text: "Office MCP & skills" }), actions, planErr ? h("p", { class: "set-err", text: planErr }) : null, ...planBox),
    ];
  }

  /* ------------------------------------------------------------- service */
  let svcBusy = false;
  function renderService(): Node[] {
    const s = store.info?.service;
    const sw = h("button", { class: "switch", attrs: { type: "button", role: "switch", "aria-checked": String(!!s?.startAtLogin), disabled: !s?.supported || svcBusy, "aria-label": "Start at login" } }, h("span", { class: "switch-thumb" }));
    sw.addEventListener("click", () => {
      if (!s) return;
      svcBusy = true;
      render();
      api.service(!s.startAtLogin).then(
        (next) => {
          if (store.info) store.info.service = next;
          opts.toast(next.startAtLogin ? "The office starts at login now" : "The office no longer starts at login", "pass");
        },
        (e: Error) => opts.toast(`Couldn't change it: ${e.message}`, "error"),
      ).finally(() => { svcBusy = false; render(); });
    });
    const facts = s
      ? [["Platform", s.platform === "darwin" ? "macOS (launchd)" : s.platform === "linux" ? "Linux (systemd --user)" : s.platform], ["Installed", s.installed ? "yes" : "no"], ["Running", s.running ? "yes" : "no"]]
      : [];
    return [
      h(
        "div",
        { class: "set-card" },
        h("div", { class: "set-row" }, h("div", null, h("h3", { class: "set-h", text: "Start at login" }), h("p", { class: "set-hint", text: s?.supported ? "A background service owns the agents you hire, so they keep running when this tab or the terminal closes." : "Not supported on this platform. Hired agents live as long as the office process." })), sw),
        h("dl", { class: "set-facts" }, ...facts.map(([k, v]) => h("div", null, h("dt", { text: k }), h("dd", { text: v })))),
        h("p", { class: "set-hint", text: "Same as theagentoffice install --service from a terminal." }),
      ),
    ];
  }

  function render(): void {
    for (const b of tabBar.querySelectorAll<HTMLElement>("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    const keep = tab === "keys" ? keyForm : null;
    const kids = tab === "logins" ? renderLogins() : tab === "keys" ? renderKeys() : tab === "cloud" ? renderCloud() : tab === "agents" ? renderAgents() : renderService();
    // the key form keeps what is being typed across refreshes
    if (keep) keep.remove();
    body.replaceChildren(...kids);
  }

  return {
    el,
    open(t) {
      if (t) tab = t;
      render();
      if (el.hidden) {
        el.hidden = false;
        el.classList.remove("enter");
        void el.offsetWidth;
        el.classList.add("enter");
      }
      document.body.classList.add("has-settings");
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      valueInput.value = "";
      document.body.classList.remove("has-settings");
    },
    isOpen: () => !el.hidden,
    sync() {
      if (!el.hidden && document.activeElement !== nameInput && document.activeElement !== valueInput && document.activeElement !== codeInput) render();
    },
  };
}

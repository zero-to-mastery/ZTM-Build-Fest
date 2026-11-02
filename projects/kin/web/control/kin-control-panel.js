// The control panel page (ADR 0025 §11, story #718): decides what to show
// and keeps it current.
//
//   on this computer, no session      → <kin-control-sign-in>
//   on this computer, setting up      → <kin-control-setup>, and restoring a
//                                       backup when one waits in Kin's folder
//   set up (here, or as an admin)     → <kin-control-status> and <kin-control-settings>
//   through the household's address,
//   not signed in or not an admin     → a sentence and a link to Kin
//
// It asks again every few seconds while setup is connecting (and while Kin
// restarts, when requests fail for a moment), and every 30 seconds on the
// status page while the page is visible.
import { ControlApi } from "./control-api.js";
import { el } from "./dom.js";
import { explain } from "./explain.js";
import "./kin-control-move.js";
import "./kin-control-settings.js";
import "./kin-control-setup.js";
import "./kin-control-sign-in.js";
import "./kin-control-status.js";

export const FAST_POLL_MS = 2_000;
export const SLOW_POLL_MS = 30_000;
const PROGRESS_STEPS = new Set(["connecting", "certificate"]);

export class KinControlPanel extends HTMLElement {
  constructor() {
    super();
    this.api = null;
    this.state = null;
    this.timer = null;
    this.view = null;
    this.failures = 0;
    this.onVisibility = () => { if (globalThis.document?.visibilityState === "visible") this.refresh(); };
  }

  connectedCallback() {
    this.api ??= new ControlApi();
    // The notice is there from the start: the first request may fail too.
    if (!this.noticeElement) {
      this.noticeElement = el("p", { className: "control-notice", role: "status", hidden: true });
      this.replaceChildren(this.noticeElement, el("p", { text: "Loading…" }));
    }
    globalThis.document?.addEventListener?.("visibilitychange", this.onVisibility);
    this.addEventListener("signed-in", () => this.refresh());
    this.addEventListener("view", (event) => this.#setupView(event.detail));
    this.addEventListener("changed", () => this.refresh());
    this.refresh();
  }

  disconnectedCallback() {
    clearTimeout(this.timer);
    globalThis.document?.removeEventListener?.("visibilitychange", this.onVisibility);
  }

  #schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), ms);
  }

  async refresh() {
    clearTimeout(this.timer);
    let state;
    try {
      state = await this.api.state();
      this.failures = 0;
    } catch (error) {
      // Kin restarting (setup's last step) or briefly away: keep what is
      // shown, say so, and ask again soon.
      this.failures += 1;
      this.#notice(this.failures > 1 && error.code === "network" ? "Kin is restarting or not answering. This page tries again by itself." : explain(error.code));
      this.#schedule(FAST_POLL_MS);
      return;
    }
    this.#notice("");
    this.state = state;
    this.render();
    const progress = state.setup && (PROGRESS_STEPS.has(state.setup.step) || state.setup.step === "connecting");
    this.#schedule(progress ? FAST_POLL_MS : SLOW_POLL_MS);
  }

  #setupView(view) {
    if (!this.state) return;
    this.state = { ...this.state, setup: view };
    this.render();
    if (PROGRESS_STEPS.has(view.step)) this.#schedule(FAST_POLL_MS);
  }

  #notice(text) {
    if (!this.noticeElement) return;
    this.noticeElement.textContent = text;
    this.noticeElement.hidden = !text;
  }

  #part(tag, key = tag) {
    let node = this.parts?.get(key);
    if (!node) {
      node = document.createElement(tag);
      node.api = this.api;
      (this.parts ??= new Map()).set(key, node);
    }
    return node;
  }

  /** Moving to a new computer (#721): before a name is chosen, a backup
   * copied into Kin's backups folder can be restored, which brings the old
   * computer's name and keys with it. Null when there is none. */
  #moving(state) {
    if (state.configured || state.setup?.step !== "name" || !state.status?.backups?.backups?.length) return null;
    const restore = this.#part("kin-control-settings", "moving");
    restore.kinds = ["restore"];
    restore.heading = "Moving from another computer?";
    restore.status = state.status;
    return restore;
  }

  /** Which screen the state calls for. */
  screen(state = this.state) {
    if (!state) return "loading";
    if (state.remote) return !state.signedIn ? "remote-sign-in" : !state.admin ? "remote-not-admin" : "status";
    if (!state.signedIn) return "sign-in";
    if (state.setup && state.setup.step !== "done") return "setup";
    if (!state.status?.setupComplete) return "setup";
    return "status";
  }

  render() {
    const state = this.state;
    const screen = this.screen();
    this.noticeElement ??= el("p", { className: "control-notice", role: "status", hidden: true });
    if (screen === this.lastScreen) {
      // The same screen: update in place, so focus and a form being filled
      // in stay where they are.
      if (screen === "setup") {
        this.#part("kin-control-setup").view = state.setup;
        const moving = this.#moving(state);
        if (moving && !moving.isConnected) this.append(moving);
        if (!moving) this.parts?.get("moving")?.remove();
      }
      if (screen === "status") {
        this.#part("kin-control-status").status = state.status;
        this.#part("kin-control-settings").status = state.status;
        if (!state.remote) this.#part("kin-control-move").status = state.status;
      }
      return;
    }
    const children = [this.noticeElement];
    if (screen === "sign-in") {
      const signIn = this.#part("kin-control-sign-in");
      signIn.configured = state.configured;
      signIn.codeExpiresAt = state.codeExpiresAt;
      signIn.render();
      children.push(signIn);
    } else if (screen === "setup") {
      const setup = this.#part("kin-control-setup");
      setup.view = state.setup;
      children.push(setup);
      const moving = this.#moving(state);
      if (moving) children.push(moving);
    } else if (screen === "status") {
      const status = this.#part("kin-control-status");
      status.status = state.status;
      const settings = this.#part("kin-control-settings");
      settings.status = state.status;
      // Setup's last step: no household yet, so the way to Kin comes first.
      if (!state.remote && state.status.counts?.households === 0 && state.status.origin) {
        children.push(el("section", { className: "control-card control-ready", "aria-labelledby": "control-ready-title" },
          el("h2", { id: "control-ready-title", tabIndex: -1, text: "Kin is ready" }),
          el("p", { text: `Open Kin at ${state.status.origin} to create your household, on the phone or computer you'll use most. Add your other devices and people from there.` }),
          el("p", { className: "control-actions" }, el("a", { className: "control-button primary-action", href: state.status.origin, text: `Open ${state.status.origin}` })),
          el("p", { className: "control-hint", text: "Create the household there, not here: passkeys and each device's saved data belong to that address." })));
      }
      children.push(el("h2", { id: "control-status-title", tabIndex: -1, text: "Status" }), status, settings);
      if (!state.remote) {
        // A move code is printed on this computer, so only here (#739).
        const move = this.#part("kin-control-move");
        move.status = state.status;
        children.push(move);
        if (state.status.counts?.households > 0 && state.status.origin)
          children.push(el("p", { className: "control-hint" }, "Kin is at ", el("a", { href: state.status.origin, text: state.status.origin }), "."));
        children.push(el("p", { className: "control-actions" }, el("button", { type: "button", className: "secondary", text: "Sign out of the control panel", onclick: () => this.signOut() })));
      }
    } else if (screen === "remote-sign-in") {
      children.push(el("h2", { tabIndex: -1, text: "Sign in first" }), el("p", {}, "The control panel is for this home server's household admins. ", el("a", { href: "/", text: "Open Kin and sign in" }), ", then come back."));
    } else if (screen === "remote-not-admin") {
      children.push(el("h2", { tabIndex: -1, text: "For household admins" }), el("p", {}, "Only a household admin can use the control panel. ", el("a", { href: "/", text: "Back to Kin" })));
    } else {
      children.push(el("p", { text: "Loading…" }));
    }
    this.replaceChildren(...children);
    if (this.lastScreen && this.lastScreen !== "loading") this.querySelector("h2")?.focus();
    this.lastScreen = screen;
  }

  async signOut() {
    try { await this.api.post("sign-out"); } catch { /* the page asks again anyway */ }
    this.refresh();
  }
}

if (!customElements.get("kin-control-panel")) customElements.define("kin-control-panel", KinControlPanel);

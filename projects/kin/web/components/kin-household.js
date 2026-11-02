import { getActiveVault } from "../security/local-vault.js";
import { button, message, text } from "./shared/dom.js";
import { OperationGuard } from "./shared/operation.js";
import { HouseholdAccount } from "./household/account.js";
import { HouseholdApi } from "./household/api.js";
import { HouseholdAuth } from "./household/auth.js";
import { HouseholdLifecycle } from "./household/lifecycle.js";
import { HouseholdMove } from "./household/move.js";
import { HouseholdLink } from "./household/link.js";
import { HouseholdLinkApproval } from "./household/link-approval.js";
import { HouseholdMembership } from "./household/membership.js";
import { HouseholdPairing } from "./household/pairing.js";
import { HouseholdPrepared, printingSheet } from "./household/prepared.js";
import { HouseholdViews } from "./household/views.js";
import { consumeInvitationCode, takeInvitationCode } from "../pairing-link.js";

// The household element's parts (./household/), built once per element with
// one shared context { host, ...parts }; each part reaches the element as `this.host`.
const PARTS = {
  api: HouseholdApi,
  auth: HouseholdAuth,
  account: HouseholdAccount,
  pairing: HouseholdPairing,
  prepared: HouseholdPrepared,
  link: HouseholdLink,
  linkApproval: HouseholdLinkApproval,
  membership: HouseholdMembership,
  lifecycle: HouseholdLifecycle,
  move: HouseholdMove,
  views: HouseholdViews,
};

class KinHousehold extends HTMLElement {
  constructor() {
    super();
    this.ctx = { host: this };
    for (const [key, Part] of Object.entries(PARTS)) this.ctx[key] = new Part(this.ctx);
    this.identity = null;
    this.householdLifecycle = null;
    this.pairing = null;
    this.claim = null;
    this.timer = null;
    this.poll = null;
    // One authorization request at a time, only while the session is live.
    this.operations = new OperationGuard(this, {
      canStart: () => { try { this.assertConnection(); return true; } catch { return false; } },
      onError: (error) => this.renderError(["NotAllowedError", "AbortError"].includes(error?.name)
        ? new Error("The passkey was unavailable or the request was cancelled. No authorization change was made.")
        : error),
    });
    this.prefilledCode = "";
    this.routeCodeCaptured = false;
    this.syncKeyStore = null;
    this.verifiedFingerprint = null;
    this.verifiedInviterFingerprint = false;
    this.syncStatus = null;
    this.localFingerprint = null;
    this.syncKeyError = null;
    this.connectionVault = null;
    this.connectionGeneration = null;
    this.connectionAbort = new AbortController();
    // Presentation only: which "get started" path the person chose. The server
    // decides the real purpose of a code; this just selects the explanation.
    this.intent = null;
  }

  startIntent(kind) {
    if (kind === "phone" && !this.claim) {
      // Signing in with a phone (#100) starts a request at once.
      this.intent = "phone";
      return this.ctx.link.begin();
    }
    this.intent = ["create", "join", "device"].includes(kind) ? kind : null;
    this.render();
    requestAnimationFrame(() => {
      const target = this.querySelector("form input, button");
      target?.focus();
      this.scrollIntoView?.({ block: "start" });
    });
  }

  connectedCallback() {
    // A detached access controller cannot be reactivated by a later unlock.
    // Kin mounts a new household component for each unlocked lifetime.
    if (this.connectionAbort.signal.aborted) return;
    this.connectionVault ??= getActiveVault();
    this.connectionGeneration ??= this.connectionVault?.generation;
    this.className = "household-panel";
    if (!this.routeCodeCaptured) {
      this.routeCodeCaptured = true;
      if (location.pathname === "/pair") {
        // kin-app took the code from the address as it loaded; reading the
        // address here as well covers a code still in it.
        this.prefilledCode = consumeInvitationCode() || takeInvitationCode();
      }
    }
    // The first load, which the first run waits for before it signs up.
    this.loaded = this.load();
  }

  /** An invitation code arrived after this element connected (a same-page
   * jump to /pair#code=…): fill the join screen with it (#97). */
  offerInvitationCode() {
    const code = consumeInvitationCode();
    if (!code) return;
    this.prefilledCode = code;
    this.render();
  }

  disconnectedCallback() {
    printingSheet(false);
    this.ctx.account.stop();
    this.ctx.link.abandon();
    this.ctx.linkApproval.abandon();
    this.connectionAbort.abort();
    clearInterval(this.timer);
    clearTimeout(this.poll);
    this.syncKeyStore?.close();
    this.syncKeyStore = null;
    this.identity = null;
    this.pairing = null;
    this.claim = null;
    this.syncStatus = null;
  }

  set disabled(value) {
    this.toggleAttribute("data-disabled", Boolean(value));
    for (const control of this.querySelectorAll("button, input"))
      control.disabled =
        Boolean(value) || control.hasAttribute("data-gated");
  }

  get disabled() {
    return this.hasAttribute("data-disabled");
  }

  get busy() { return this.operations.busy; }

  // The control stays disabled until its own prerequisite clears, regardless of busy state.
  setControlDisabled(control, value) {
    control.toggleAttribute("data-gated", Boolean(value));
    control.disabled = this.disabled || Boolean(value);
  }

  run(action) { return this.operations.run(() => action()); }

  renderError(error) {
    if (!this.isConnected || this.connectionAbort.signal.aborted) return;
    this.message(
      error?.message || "Kin could not complete that request.",
      true,
    );
  }

  text(value) { return text(value, { parent: this }); }

  showFingerprint(prompt, fingerprint) {
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))
      return null;
    const paragraph = document.createElement("p");
    paragraph.className = "pairing-fingerprint";
    const value = document.createElement("code");
    value.textContent = fingerprint.match(/.{1,4}/g).join(" ");
    paragraph.append(document.createTextNode(`${prompt}: `), value);
    this.append(paragraph);
    return paragraph;
  }

  message(value, alert = false) { return message(this, value, { alert, className: "household-message" }); }

  makeButton(label, action, className = "") { return button(label, action, { className, disabled: this.disabled }); }

  button(label, action, className) { return button(label, action, { className, disabled: this.disabled, parent: this }); }

  // Called from outside the element (regression scripts, <kin-app>);
  // each delegates to its part.
  get account() { return this.ctx.account; }
  get prepared() { return this.ctx.prepared; }
  activateClaim(...args) { return this.ctx.pairing.activateClaim(...args); }
  api(...args) { return this.ctx.api.api(...args); }
  assertConnection(...args) { return this.ctx.api.assertConnection(...args); }
  authenticateRemoval(...args) { return this.ctx.membership.authenticateRemoval(...args); }
  createDevicePairing(...args) { return this.ctx.pairing.createDevicePairing(...args); }
  createPairing(...args) { return this.ctx.pairing.createPairing(...args); }
  enableSync(...args) { return this.ctx.api.enableSync(...args); }
  leave(...args) { return this.ctx.lifecycle.leave(...args); }
  load(...args) { return this.ctx.api.load(...args); }
  login(...args) { return this.ctx.auth.login(...args); }
  register(...args) { return this.ctx.auth.register(...args); }
  render(...args) { return this.ctx.views.render(...args); }
  renderMember(...args) { return this.ctx.views.renderMember(...args); }
  setHouseholdAdmin(...args) { return this.ctx.membership.setHouseholdAdmin(...args); }
  setSimpleView(...args) { return this.ctx.membership.setSimpleView(...args); }
  showDevices(...args) { return this.ctx.membership.showDevices(...args); }
  showHousehold(...args) { return this.ctx.membership.showHousehold(...args); }
}

customElements.define("kin-household", KinHousehold);

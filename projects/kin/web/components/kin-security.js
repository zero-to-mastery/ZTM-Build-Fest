import { EventStore } from "../storage/event-store.js";
import { discardValidatedHouseholdArchive } from "../security/archive.js";
import { takeStartOverSignIn } from "../security/start-over.js";
import { button, section, text } from "./shared/dom.js";
import { OperationGuard } from "./shared/operation.js";
import { SecurityAccount } from "./security/account.js";
import { SecurityArchive } from "./security/archive.js";
import { SecurityFirstRun } from "./security/first-run.js";
import { SecurityPrivateExport } from "./security/private-export.js";
import { SecurityProtection } from "./security/protection.js";
import { SecuritySignIn } from "./security/sign-in.js";
import { SecurityUnlock } from "./security/unlock.js";
import { SecurityViews } from "./security/views.js";

export function clearLegacyDrafts() {
  for (const key of ["kin.compose.draft", "kin.compose.classification", "kin.handoff.draft", "kin.talk.draft", "kin.routine.draft"]) {
    try { sessionStorage.removeItem(key); } catch { /* No fallback persistence. */ }
  }
}

// The security element's parts (./security/), built once per element with
// one shared context { host, ...parts }; each part reaches the element as `this.host`.
const PARTS = {
  views: SecurityViews,
  protection: SecurityProtection,
  unlock: SecurityUnlock,
  archive: SecurityArchive,
  firstRun: SecurityFirstRun,
  signIn: SecuritySignIn,
  account: SecurityAccount,
  privateExport: SecurityPrivateExport,
};

class KinSecurity extends HTMLElement {
  constructor() {
    super();
    this.ctx = { host: this };
    for (const [key, Part] of Object.entries(PARTS)) this.ctx[key] = new Part(this.ctx);
    this.phase = "locked";
    this.manifest = null;
    // One security operation at a time; locking cancels the current one.
    this.operations = new OperationGuard(this, {
      onBusy: (busy) => {
        if (busy) this.alert.textContent = "";
        for (const element of this.querySelectorAll("button,input,select")) element.disabled = busy;
      },
      onError: async (error, operation) => {
        if (this.phase !== "unlocked") {
          const manifest = await EventStore.securityStatus().catch(() => this.manifest);
          if (operation !== this.operation) return;
          this.manifest = manifest;
          this.render();
        }
        this.error(error);
      },
    });
    this.operationAbort = new AbortController();
    this.onUnlocked = null;
    this.onLockRequested = null;
    this.restoreStage = null;
    // Presentation only: whether the secondary recovery form is expanded on the lock screen.
    this.recoveryExpanded = false;
    // True from a completed setup until the next lock: the unlocked shell then
    // offers passkey unlock as setup's next step (#577).
    this.justSetUp = false;
    // Presentation only: the person chose "Set up with a passkey instead"
    // on the first run (#557), so the earlier backup-key setup shows.
    this.legacySetup = false;
    // Presentation only: the person chose "Sign in" on the first run (#568).
    this.signingIn = false;
    // A password changed on another device (#560 follow-up): `{ vault,
    // parameters, username }` while the new password is asked for, or
    // `{ keys, username }` while the previous one is.
    this.passwordChange = null;
  }

  get busy() { return this.operations.busy; }

  get operation() { return this.operations.current; }

  async initialize() {
    const operation = this.operation;
    clearLegacyDrafts();
    try {
      const manifest = await EventStore.securityStatus();
      if (operation !== this.operation) return;
      this.manifest = manifest;
      // Right after "Start over on this browser": straight to Sign in.
      if (!manifest && takeStartOverSignIn()) {
        this.signingIn = true;
        this.ctx.signIn.reset();
      }
      this.render();
      // A refresh of an unlocked tab picks up where it was (#351).
      const resumed = await this.services?.takeReloadResume?.(() => EventStore.securityStatus());
      if (!resumed) return;
      if (operation !== this.operation) { resumed.root.fill(0); return; }
      await this.run(() => this.ctx.unlock.resumeAfterReload(resumed));
    } catch (error) {
      if (operation === this.operation) { this.render(); this.error(error); }
    }
  }

  get passkeyWrappers() {
    return (this.manifest?.wrappers ?? []).filter((wrapper) => wrapper.type === "prf");
  }

  locked() {
    if (this.restoreStage) discardValidatedHouseholdArchive(this.restoreStage);
    this.restoreStage = null;
    this.operations.cancel();
    this.operationAbort.abort();
    this.operationAbort = new AbortController();
    this.phase = "locked";
    this.recoveryExpanded = false;
    this.justSetUp = false;
    // A vault the previous password opened while the new one was asked for.
    this.ctx.unlock.cancelPasswordChange();
    // An open account flow (a backup code on screen) ends with the lock.
    this.ctx.account.wipeFlow();
    this.ctx.account.security = null;
    const app = this.closest("kin-app");
    if (app) app.accountSecurity = null;
    this.setAttribute("aria-busy", "false");
    clearLegacyDrafts();
    this.render();
    this.heading.focus();
    // A lock that an unlock path's removal caused (a passkey removed from
    // this device) can land before this panel saw the new manifest: read it
    // again, so the lock screen never offers a way in that's gone.
    const shown = this.manifest;
    void EventStore.securityStatus().then((manifest) => {
      if (this.phase !== "locked" || this.busy || !manifest) return;
      if ((manifest.configRevision ?? 0) === (shown?.configRevision ?? 0) && manifest.vaultId === shown?.vaultId) return;
      this.manifest = manifest;
      this.render();
      this.heading.focus();
    }, () => {});
  }

  run(action) { return this.operations.run(action); }

  assertCurrentOperation(operation) {
    this.operations.assertCurrent(operation, "This security operation was cancelled.");
  }

  error(error) {
    this.alert.textContent = ["AbortError", "NotAllowedError"].includes(error.name)
      ? "Authentication was cancelled or the credential was unavailable. Your saved data was not changed."
      : error.userMessage ?? error.message ?? "Kin could not complete security setup.";
    // A wrong password leaves the person where they type it again.
    if (this.phase === "locked" && this.passwordInput?.isConnected) this.passwordInput.focus();
  }

  text(value, parent = this) { return text(value, { parent }); }

  section(title) { return section(title, { className: "security-section", parent: this }); }

  button(label, action, className = "", parent = this) { return button(label, action, { className, parent }); }

  // Called from outside the element (regression scripts, <kin-app>);
  // each delegates to its part.
  addPasskey(...args) { return this.ctx.protection.addPasskey(...args); }
  downloadArchive(...args) { return this.ctx.archive.downloadArchive(...args); }
  establishProtection(...args) { return this.ctx.protection.establishProtection(...args); }
  replaceProtection(...args) { return this.ctx.protection.replaceProtection(...args); }
  showReplacement(...args) { return this.ctx.protection.showReplacement(...args); }
  showRestore(...args) { return this.ctx.archive.showRestore(...args); }
  showSetup(...args) { return this.ctx.protection.showSetup(...args); }
  unlockPasskey(...args) { return this.ctx.unlock.unlockPasskey(...args); }
  unlockPassword(...args) { return this.ctx.unlock.unlockPassword(...args); }
  unlockNewPassword(...args) { return this.ctx.unlock.unlockNewPassword(...args); }
  get firstRun() { return this.ctx.firstRun; }
  get signIn() { return this.ctx.signIn; }
  get account() { return this.ctx.account; }
  get privateExport() { return this.ctx.privateExport; }
  unlockRecovery(...args) { return this.ctx.unlock.unlockRecovery(...args); }
  render(...args) { return this.ctx.views.render(...args); }
}

customElements.define("kin-security", KinSecurity);

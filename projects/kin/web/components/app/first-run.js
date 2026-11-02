// Finishing the first run (#557, #559) once this device's storage is open.
// The security panel made the encrypted storage from the new password and
// handed over `pending`: `{ mode: "create" | "join", displayName,
// householdName, code, signUp }`. Here the household panel signs up with the
// service (household/account.js) while Today already shows, and once sync
// is ready the member's name and the household's name are recorded the
// ordinary way (an event, and the shared household settings).
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { DEFAULT_HOUSEHOLD_BRAND, DEFAULT_HOUSEHOLD_NAME } from "../../appearance/household.js";
import { DEFAULT_APPEARANCE } from "../../appearance/store.js";
import { wipeSignUp } from "../../security/account-setup.js";
import { wipeSignIn } from "../../security/new-device.js";
import { normalizeUsername, usernameProblem } from "../../security/account-credentials.js";
import { EventStore } from "../../storage/event-store.js";

export class FirstRunController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.applying = false;
  }

  /** Signs up (create or join) and lands on Today, or on the approval wait.
   * A failure stays on Today's card with a way to try again. */
  async complete(pending) {
    const app = this.app;
    const session = this.ctx.session.captureSession();
    app.firstRun = { pending, state: "working", error: null };
    // Easy mode may have been turned on during the first run (#615).
    this.ctx.easy?.apply();
    this.ctx.status.renderOnboarding();
    try {
      const household = await this.household(session);
      if (pending.mode === "sign-in") {
        // Signed in on a new device (#568): register it, install the
        // household's keys from the vault, then Today. The keys are wiped
        // once the device has them; a failure keeps them for "Try again".
        await household.account.provisionNewDevice(pending.signIn);
        wipeSignIn(pending.signIn.opened);
        this.ctx.navigation.navigate("#today");
      } else if (pending.mode === "create") {
        await household.account.createHousehold(pending.signUp);
        wipeSignUp(pending.signUp);
        app.pendingProfile = { displayName: pending.displayName, householdName: pending.householdName };
        this.ctx.navigation.navigate("#today");
      } else {
        // The keys stay with the household panel until the approved claim
        // is finished (it wipes them then). Set up by someone else (#615):
        // the panel's waiting screen names them and the helper.
        household.preparedWelcome = pending.prepared ?? null;
        await household.account.joinHousehold(pending.signUp, pending.code);
        app.pendingProfile = { displayName: pending.displayName, householdName: "" };
        this.ctx.navigation.navigate("#household/people");
      }
      if (!this.ctx.session.isCurrentSession(session)) return;
      app.firstRun = null;
      void this.applyProfile();
    } catch (error) {
      if (!this.ctx.session.isCurrentSession(session)) return;
      app.firstRun = { pending, state: "failed", error };
    } finally {
      if (this.ctx.session.isCurrentSession(session)) this.ctx.status.renderOnboarding();
    }
  }

  /** Tries again after a failure, with a corrected username or code. */
  async retry({ username, code } = {}) {
    const pending = this.app.firstRun?.pending;
    if (!pending || this.app.firstRun.state === "working") return;
    const normalized = username ? normalizeUsername(username) : null;
    if (username && !normalized) {
      this.app.firstRun = { pending, state: "failed", error: Object.assign(new Error(usernameProblem(username)), { code: "username_invalid" }) };
      this.ctx.status.renderOnboarding();
      return;
    }
    if (normalized && normalized !== pending.signUp.username) {
      username = normalized;
      try {
        await this.renameLocalUsername(username);
      } catch (error) {
        this.app.firstRun = { pending, state: "failed", error };
        this.ctx.status.renderOnboarding();
        return;
      }
      pending.signUp.username = username;
    }
    if (code) pending.code = code;
    await this.complete(pending);
  }

  /** The lock screen offers the username to password managers and signs in
   * with it, so a username changed before sign-up finished is changed in
   * this device's password wrapper too (it isn't part of the wrapper's
   * authenticated data, so nothing is re-encrypted). */
  async renameLocalUsername(username) {
    const vault = this.app.vault;
    vault.assertUnlocked();
    const status = await EventStore.securityStatus();
    const manifest = {
      ...structuredClone(vault.manifest),
      configRevision: status.configRevision ?? 0,
      wrappers: vault.manifest.wrappers.map((wrapper) => (wrapper.type === "password" ? { ...wrapper, username } : wrapper)),
    };
    await EventStore.updateSecurityManifest(manifest, vault);
    vault.manifest = structuredClone(manifest);
    this.app.security.manifest = await EventStore.securityStatus();
  }

  /** The household panel of this unlocked session, once its first load ran. */
  async household(session) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      this.ctx.session.assertCurrentSession(session);
      const household = this.app.household;
      if (household?.isConnected && household.loaded) {
        await household.loaded;
        this.ctx.session.assertCurrentSession(session);
        return household;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Kin couldn't open the household panel. Try again.");
  }

  /**
   * Records the names typed at first run once this device syncs: the
   * member's own name (event 51, as Set my name does) and, for a new
   * household, its name in the shared settings. Retried on each ready sync
   * until both are saved; nothing is stored about them meanwhile.
   */
  async applyProfile() {
    const profile = this.app.pendingProfile;
    const coordinator = this.app.syncCoordinator;
    if (!profile || this.applying || !coordinator || this.app.syncState?.state !== "ready") return;
    this.applying = true;
    const session = this.ctx.session.captureSession();
    try {
      if (profile.displayName) {
        await this.ctx.sync.setMyName(profile.displayName);
        profile.displayName = "";
      }
      if (profile.householdName) {
        const current = this.app.householdSettings ?? { version: 1, revision: 0, name: DEFAULT_HOUSEHOLD_NAME,
          appearance: { ...DEFAULT_APPEARANCE, owner: "household" }, brand: { ...DEFAULT_HOUSEHOLD_BRAND } };
        let saved;
        try {
          saved = await coordinator.saveHouseholdSettings({ ...current, name: profile.householdName });
        } catch (error) {
          if (error.code !== "household_settings_cache_partial" || !error.savedValue) throw error;
          saved = error.savedValue;
        }
        this.ctx.session.assertCurrentSession(session);
        if ((this.app.householdSettings?.revision ?? -1) <= saved.revision) this.app.householdSettings = saved;
        this.ctx.appearance.applyEffectiveAppearance();
        profile.householdName = "";
      }
      if (this.app.pendingProfile === profile) this.app.pendingProfile = null;
    } catch {
      // Tried again on the next ready sync.
    } finally {
      this.applying = false;
    }
  }
}

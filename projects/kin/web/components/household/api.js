// The server connection: the session guard for every request, the JSON
// API helper, the device's sync key store, status loading and sync controls.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { SyncKeyStore } from "../../sync/key-store.js";
import { getActiveVault } from "../../security/local-vault.js";

export class HouseholdApi {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  assertConnection() {
    const vault = this.host.connectionVault;
    if (!this.host.isConnected || this.host.connectionAbort.signal.aborted || !vault ||
        getActiveVault() !== vault || vault.generation !== this.host.connectionGeneration)
      throw new Error("This household access operation ended when Kin locked.");
    vault.assertUnlocked();
    return vault;
  }

  async openSyncKeyStore() {
    this.host.assertConnection();
    if (this.host.syncKeyStore) return this.host.syncKeyStore;
    const store = await SyncKeyStore.open({ vault: this.host.connectionVault });
    try { this.host.assertConnection(); }
    catch (error) { store.close(); throw error; }
    this.host.syncKeyStore = store;
    return store;
  }

  async api(path, options = {}) {
    const vault = this.host.assertConnection();
    await vault.checkSecurityEpoch?.();
    this.host.assertConnection();
    const response = await fetch(path, {
      ...options, signal: this.host.connectionAbort.signal,
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
    this.host.assertConnection();
    await vault.checkSecurityEpoch?.();
    this.host.assertConnection();
    const value = await response.json().catch(() => ({ message: "Kin could not read the server response." }));
    this.host.assertConnection();
    await vault.checkSecurityEpoch?.();
    this.host.assertConnection();
    if (!response.ok) {
      const error = new Error(value.message);
      error.code = value.error;
      throw error;
    }
    return value;
  }

  async load() {
    // A refresh started under one view must not replace a view opened since
    // (People & devices): it still updates the state below and notifies,
    // and the next render (Back) shows it.
    const generation = this.host.viewGeneration;
    try {
      const status = await this.host.api("/api/status");
      this.host.identity = status.identity;
      this.host.householdLifecycle = status.householdLifecycle;
      this.host.claim = status.claim;
      if (this.host.identity) {
        try {
          const localKeys = await this.ctx.auth.ensureSyncDeviceKey(this.host.identity);
          this.host.localFingerprint = localKeys.fingerprint;
          this.host.syncKeyError = null;
          // Keeps the member's account vault current, where this device
          // holds its key (#558); otherwise it does nothing.
          this.ctx.account.startKeeper(this.host.identity);
        } catch {
          this.host.syncKeyError =
            "Secure device-key storage is unavailable here. Household information remains local, but device sync and new device pairing are unavailable.";
        }
        this.host.syncStatus = await this.host.api("/api/sync/status");
      } else if (this.host.claim) {
        await this.openSyncKeyStore();
        this.host.localFingerprint =
          (await this.host.syncKeyStore.getDevice("pending"))?.fingerprint ?? null;
      }
      if (this.host.claim?.state === "Claimed") this.ctx.pairing.schedulePoll();
      else clearTimeout(this.host.poll);
      if (this.host.identity) this.host.intent = null;
      if (this.host.viewGeneration === generation) this.host.render();
      this.notifyStatus();
      return { loaded: true, identity: this.host.identity };
    } catch (error) {
      // Only the view that asked reports the failure (#327).
      if (this.host.viewGeneration === generation) this.host.renderError(error);
      return { loaded: false, identity: this.host.identity };
    }
  }

  notifyStatus() {
    this.host.dispatchEvent(new CustomEvent("kin:household-status", {
      bubbles: true, composed: true,
      detail: {
        identity: Boolean(this.host.identity),
        claimState: this.host.claim?.state ?? null,
        memberKind: this.host.syncStatus?.memberKind ?? null,
        lifecycle: this.host.householdLifecycle?.state ?? null,
        // A household that moved to a home server (#737): its new address.
        movedTo: this.host.householdLifecycle?.movedTo ?? null,
        // Household features (#625, ADR 0021): the switched-off set.
        features: this.host.identity ? this.host.syncStatus?.features ?? null : null,
        // Whether adults may join the chore chart (#676).
        choreChart: this.host.identity ? this.host.syncStatus?.choreChart ?? null : null,
        householdId: this.host.identity?.householdId ?? null,
      },
    }));
  }

  async enableSync() {
    await this.host.run(async () => {
      await this.host.api("/api/sync/enable", { method: "POST", body: "{}" });
      this.host.syncStatus = await this.host.api("/api/sync/status");
      this.host.render();
      this.host.dispatchEvent(
        new CustomEvent("kin:sync-enabled", {
          bubbles: true,
          composed: true,
          detail: this.host.identity,
        }),
      );
    });
  }

  requestSync() {
    this.host.dispatchEvent(
      new CustomEvent("kin:sync-now", {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

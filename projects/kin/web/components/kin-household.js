import { SyncKeyStore } from "../sync/key-store.js";
import { getActiveVault } from "../security/local-vault.js";
import {
  createDeviceAuthorizationCertificate,
  deviceKeyFingerprint,
} from "../sync/crypto.js";


const decode = (value) =>
  Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );
const encode = (value) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const registrationOptions = (options) => ({
  ...options,
  extensions: { ...(options.extensions ?? {}), prf: {} },
  challenge: decode(options.challenge),
  user: { ...options.user, id: decode(options.user.id) },
  excludeCredentials: (options.excludeCredentials ?? []).map((item) => ({
    ...item,
    id: decode(item.id),
  })),
});
const authenticationOptions = (options) => ({
  ...options,
  challenge: decode(options.challenge),
  allowCredentials: options.allowCredentials.map((item) => ({
    ...item,
    id: decode(item.id),
  })),
});
const credentialJson = (credential) => ({
  id: credential.id,
  type: credential.type,
  response: {
    clientDataJSON: encode(credential.response.clientDataJSON),
    attestationObject: credential.response.attestationObject
      ? encode(credential.response.attestationObject)
      : undefined,
    authenticatorData: credential.response.authenticatorData
      ? encode(credential.response.authenticatorData)
      : undefined,
    signature: credential.response.signature
      ? encode(credential.response.signature)
      : undefined,
    userHandle: credential.response.userHandle
      ? encode(credential.response.userHandle)
      : null,
    transports: credential.response.getTransports?.() ?? [],
  },
});

class KinHousehold extends HTMLElement {
  constructor() {
    super();
    this.identity = null;
    this.pairing = null;
    this.claim = null;
    this.timer = null;
    this.poll = null;
    this.busy = false;
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
        this.prefilledCode =
          new URLSearchParams(location.search).get("code")?.slice(0, 9) ?? "";
        if (location.search) history.replaceState(null, "", "/pair");
      }
    }
    this.load();
  }
  disconnectedCallback() {
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
  assertConnection() {
    const vault = this.connectionVault;
    if (!this.isConnected || this.connectionAbort.signal.aborted || !vault ||
        getActiveVault() !== vault || vault.generation !== this.connectionGeneration)
      throw new Error("This household access operation ended when Kin locked.");
    vault.assertUnlocked();
    return vault;
  }

  async openSyncKeyStore() {
    this.assertConnection();
    if (this.syncKeyStore) return this.syncKeyStore;
    const store = await SyncKeyStore.open({ vault: this.connectionVault });
    try { this.assertConnection(); }
    catch (error) { store.close(); throw error; }
    this.syncKeyStore = store;
    return store;
  }

  async api(path, options = {}) {
    const vault = this.assertConnection();
    await vault.checkSecurityEpoch?.();
    this.assertConnection();
    const response = await fetch(path, {
      ...options, signal: this.connectionAbort.signal,
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
    this.assertConnection();
    await vault.checkSecurityEpoch?.();
    this.assertConnection();
    const value = await response.json().catch(() => ({ message: "Kin could not read the server response." }));
    this.assertConnection();
    await vault.checkSecurityEpoch?.();
    this.assertConnection();
    if (!response.ok) {
      const error = new Error(value.message);
      error.code = value.error;
      throw error;
    }
    return value;
  }

  set disabled(value) {
    this.toggleAttribute("data-disabled", Boolean(value));
    for (const control of this.querySelectorAll("button, input"))
      control.disabled = Boolean(value);
  }
  get disabled() {
    return this.hasAttribute("data-disabled");
  }

  async load() {
    try {
      const status = await this.api("/api/status");
      this.identity = status.identity;
      this.claim = status.claim;
      if (this.identity) {
        try {
          const localKeys = await this.ensureSyncDeviceKey(this.identity);
          this.localFingerprint = localKeys.fingerprint;
          this.syncKeyError = null;
        } catch {
          this.syncKeyError =
            "Secure device-key storage is unavailable here. Household information remains local, but device sync and new device pairing are unavailable.";
        }
        this.syncStatus = await this.api("/api/sync/status");
      } else if (this.claim) {
        await this.openSyncKeyStore();
        this.localFingerprint =
          (await this.syncKeyStore.getDevice("pending"))?.fingerprint ?? null;
      }
      if (this.claim?.state === "Claimed") this.schedulePoll();
      else clearTimeout(this.poll);
      this.render();
    } catch (error) {
      this.renderError(error);
    }
  }

  render() {
    clearInterval(this.timer);
    this.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent =
      location.pathname === "/pair" ? "Join a household" : "Household";
    this.append(heading);
    if (!window.PublicKeyCredential)
      return this.message(
        "Passkeys are unavailable in this browser. Use a current browser with a configured screen lock.",
        true,
      );
    if (location.pathname === "/pair" && !this.identity)
      return this.renderJoin();
    if (!this.identity) return this.renderSetup();
    this.renderMember();
    this.disabled = this.disabled;
  }

  renderSetup() {
    this.text(
      "Set up this adult and device with a passkey before pairing another adult.",
    );
    this.button("Set up household", () => this.register("bootstrap", {}));
    this.button("Log in with passkey", () => this.login(), "secondary");
  }

  renderJoin() {
    if (this.claim?.state === "Claimed") {
      this.message(
        this.claim.purpose === "device"
          ? "This device is ready. The same adult must approve it before sync access is added."
          : "Your identity is ready. The existing adult must approve this device before you can join.",
      );
      this.showFingerprint(
        "Compare this device key with the approving adult",
        this.localFingerprint,
      );
      this.showFingerprint(
        "Compare the approving device key",
        this.claim.inviterKeyFingerprint,
      );
      if (
        !this.localFingerprint ||
        this.claim.syncKeyFingerprint !== this.localFingerprint ||
        !this.claim.inviterKeyFingerprint
      )
        this.message(
          "This device key does not match the approval request. Cancel this request and try again.",
          true,
        );
      return;
    }
    if (this.claim?.state === "Confirmed") {
      if (!this.localFingerprint || this.claim.syncKeyFingerprint !== this.localFingerprint) {
        this.message("This device key changed during security migration. Cancel this pairing and request a new invitation before activation.", true);
        return;
      }
      this.message(
        "Approval succeeded. Use your passkey once more to activate this device.",
      );
      this.showFingerprint(
        "Compare the approving device key",
        this.claim.inviterKeyFingerprint,
      );
      const confirmation = document.createElement("input");
      confirmation.type = "checkbox";
      confirmation.checked = this.verifiedInviterFingerprint;
      const label = document.createElement("label");
      label.append(
        confirmation,
        document.createTextNode(
          " I compared this fingerprint on both devices.",
        ),
      );
      const activate = this.makeButton("Activate with passkey", () =>
        this.activateClaim(),
      );
      activate.disabled = !this.verifiedInviterFingerprint;
      confirmation.addEventListener("change", () => {
        this.verifiedInviterFingerprint = confirmation.checked;
        activate.disabled = !confirmation.checked;
      });
      this.append(label, activate);
      return;
    }
    if (this.claim) {
      const messages = {
        Expired: "This pairing request expired. Enter a new code to continue.",
        Revoked:
          "This pairing request was revoked. Enter a new code to continue.",
        Rejected:
          "This pairing request was rejected. Enter a new code to continue.",
      };
      this.message(
        messages[this.claim.state] ??
          "This pairing request is no longer available. Enter a new code to continue.",
        true,
      );
      this.claim = null;
      this.prefilledCode = "";
    }
    this.text(
      "A code proves you received an invitation. You must create a passkey, and an existing adult must still approve you. No household details are shown before approval.",
    );
    const form = document.createElement("form");
    const codeLabel = document.createElement("label");
    codeLabel.textContent = "Pairing code";
    const code = document.createElement("input");
    code.name = "code";
    code.required = true;
    code.autocomplete = "one-time-code";
    code.inputMode = "text";
    code.maxLength = 9;
    code.placeholder = "F7KM-Q2DX";
    code.value = this.prefilledCode;
    this.prefilledCode = "";
    code.setAttribute("aria-describedby", "pair-help");
    const help = document.createElement("p");
    help.id = "pair-help";
    help.className = "hint";
    help.textContent = "Codes ignore case and punctuation.";
    const deviceLabel = document.createElement("label");
    deviceLabel.textContent = "Name this device";
    const device = document.createElement("input");
    device.name = "deviceLabel";
    device.required = true;
    device.maxLength = 48;
    device.value = "This device";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Create passkey and request approval";
    codeLabel.append(code);
    deviceLabel.append(device);
    form.append(codeLabel, help, deviceLabel, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.register("claim", { code: code.value, deviceLabel: device.value });
    });
    this.append(form);
    requestAnimationFrame(() => code.focus());
  }

  renderMember() {
    this.text("This device belongs to an authenticated household adult.");
    if (this.syncKeyError) {
      this.message(this.syncKeyError, true);
    } else if (this.syncStatus?.enabled) {
      this.text(
        this.syncStatus.rotationPending
          ? "Device sync is paused while trusted-device access updates."
          : "Device sync is on for this household.",
      );
      this.button("Check sync", () => this.requestSync(), "secondary");
    } else {
      this.button("Enable device sync", () => this.enableSync());
    }
    if (!this.pairing) {
      if (!this.syncKeyError) {
        this.button("Pair another adult", () => this.createPairing());
        this.button(
          "Add another device",
          () => this.createDevicePairing(),
          "secondary",
        );
      }
      this.button("Trusted devices", () => this.showDevices(), "secondary");
      this.button("Household access", () => this.showHousehold(), "secondary");
      this.button("Log out", () => this.logout(), "secondary");
      return;
    }
    const state = document.createElement("p");
    state.className = "pairing-state";
    state.setAttribute("role", "status");
    state.textContent =
      this.pairing.state === "Pending"
        ? "Waiting for the other adult to claim this code."
        : this.pairing.state === "Claimed"
          ? this.pairing.purpose === "device"
            ? `${this.pairing.deviceLabel || "This device"} is awaiting approval for your account.`
            : `${this.pairing.deviceLabel || "The other device"} is awaiting your approval.`
          : typeof this.pairing.state === "string"
            ? `Pairing ${this.pairing.state.toLowerCase()}.`
            : "Kin could not read the pairing status. Revoke this request or reload before continuing.";
    this.append(state);
    if (["Pending", "Claimed"].includes(this.pairing.state)) {
      if (this.pairing.state === "Pending")
        this.showFingerprint(
          "Compare this household device key",
          this.localFingerprint,
        );
      if (this.pairing.code) {
        const code = document.createElement("output");
        code.className = "pairing-code";
        code.textContent = this.pairing.code;
        code.setAttribute(
          "aria-label",
          `Pairing code ${[...this.pairing.code].join(" ")}`,
        );
        this.append(code);
      }
      this.countdown = document.createElement("p");
      this.countdown.className = "pairing-countdown";
      this.append(this.countdown);
      this.updateCountdown();
      this.timer = setInterval(() => this.updateCountdown(), 1000);
      const actions = document.createElement("div");
      actions.className = "pairing-actions";
      if (this.pairing.code) {
        actions.append(
          this.makeButton("Copy code", () => this.copyCode()),
          this.makeButton("Share invitation", () => this.share(), "secondary"),
        );
      }
      if (this.pairing.state === "Claimed") {
        const fingerprint = this.pairing.syncKeyFingerprint;
        this.showFingerprint(
          "Confirm this matches the joining device",
          fingerprint,
        );
        const approve = this.makeButton("Approve with passkey", () =>
          this.approve(),
        );
        approve.disabled =
          !fingerprint || this.verifiedFingerprint !== fingerprint;
        if (fingerprint) {
          const label = document.createElement("label");
          const confirmation = document.createElement("input");
          confirmation.type = "checkbox";
          confirmation.checked = this.verifiedFingerprint === fingerprint;
          confirmation.addEventListener("change", () => {
            this.verifiedFingerprint = confirmation.checked
              ? fingerprint
              : null;
            approve.disabled = !confirmation.checked;
          });
          label.append(
            confirmation,
            document.createTextNode(
              " I compared this fingerprint on both devices.",
            ),
          );
          actions.append(label);
        } else {
          this.message(
            "This device has no verifiable sync key. Cancel this request and pair again with an updated Kin device.",
            true,
          );
        }
        actions.append(approve);
      }
      actions.append(this.makeButton("Revoke", () => this.revoke(), "danger"));
      this.append(actions);
      this.pollPairing();
    } else {
      this.button(
        "Back to household",
        () => {
          this.pairing = null;
          this.render();
        },
        "secondary",
      );
    }
  }

  async register(purpose, values) {
    await this.run(async () => {
      await this.openSyncKeyStore();
      const pendingKeys = await this.syncKeyStore.getOrCreatePendingDevice();
      this.localFingerprint = pendingKeys.fingerprint;
      const started = await this.api("/api/passkeys/register/options", {
        method: "POST",
        body: JSON.stringify({
          purpose,
          deviceLabel: values.deviceLabel ?? "This device",
          code: values.code,
        }),
      });
      const credential = await navigator.credentials.create({
        publicKey: registrationOptions(started.publicKey),
        signal: this.connectionAbort.signal,
      });
      const registered = await this.api("/api/passkeys/register/finish", {
        method: "POST",
        body: JSON.stringify({
          flow: started.flow,
          credential: credentialJson(credential),
          syncPublicKeys: pendingKeys.publicKeys,
        }),
      });
      if (purpose === "bootstrap")
        this.localFingerprint = (
          await this.syncKeyStore.bindPendingDevice({
            deviceId: registered.deviceId,
            householdId: registered.householdId,
            memberId: registered.memberId,
          })
        ).fingerprint;
      history.replaceState(null, "", purpose === "claim" ? "/pair" : "/");
      await this.load();
    });
  }

  async ensureSyncDeviceKey(identity) {
    this.assertConnection();
    await this.openSyncKeyStore();
    const existing = await this.syncKeyStore.getDevice(identity.deviceId);
    if (existing) return this.syncKeyStore.completePendingTransition(identity.deviceId, { signal: this.connectionAbort.signal });
    const pending = await this.syncKeyStore.getOrCreatePendingDevice();
    await this.api("/api/sync/device-keys", {
      method: "POST",
      body: JSON.stringify({ publicKeys: pending.publicKeys }),
    });
    return this.syncKeyStore.bindPendingDevice({
      deviceId: identity.deviceId,
      householdId: identity.householdId,
      memberId: identity.memberId,
    });
  }

  async login() {
    await this.run(async () => {
      const started = await this.api("/api/login/options", {
        method: "POST",
        body: "{}",
      });
      const credential = await navigator.credentials.get({
        publicKey: authenticationOptions(started.publicKey),
        signal: this.connectionAbort.signal,
      });
      await this.api("/api/login/finish", {
        method: "POST",
        body: JSON.stringify({
          flow: started.flow,
          credential: credentialJson(credential),
        }),
      });
      history.replaceState(null, "", "/");
      await this.load();
    });
  }

  async createPairing() {
    await this.run(async () => {
      this.pairing = await this.api("/api/pairings", { method: "POST", body: "{}" });
      if (
        !this.localFingerprint ||
        this.pairing.inviterKeyFingerprint !== this.localFingerprint
      )
        throw new Error(
          "This device's approved key does not match its local key.",
        );
      this.render();
    });
  }

  async createDevicePairing() {
    await this.run(async () => {
      this.pairing = await this.api("/api/devices/pairings", {
        method: "POST",
        body: "{}",
      });
      if (
        !this.localFingerprint ||
        this.pairing.inviterKeyFingerprint !== this.localFingerprint
      )
        throw new Error(
          "This device's approved key does not match its local key.",
        );
      this.render();
    });
  }

  async enableSync() {
    await this.run(async () => {
      await this.api("/api/sync/enable", { method: "POST", body: "{}" });
      this.syncStatus = await this.api("/api/sync/status");
      this.render();
      this.dispatchEvent(
        new CustomEvent("kin:sync-enabled", {
          bubbles: true,
          composed: true,
          detail: this.identity,
        }),
      );
    });
  }

  requestSync() {
    this.dispatchEvent(
      new CustomEvent("kin:sync-now", {
        bubbles: true,
        composed: true,
      }),
    );
  }
  async approve() {
    await this.run(async () => {
      if (
        !this.pairing?.syncKeyFingerprint ||
        this.verifiedFingerprint !== this.pairing.syncKeyFingerprint
      ) {
        throw new Error(
          "Compare the device fingerprint on both devices before approving.",
        );
      }
      const started = await this.api(
        `/api/pairings/${this.pairing.pairingId}/approve/options`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: this.pairing.version }),
        },
      );
      const credential = await navigator.credentials.get({
        publicKey: authenticationOptions(started.publicKey),
        signal: this.connectionAbort.signal,
      });
      const ownDevice = await this.syncKeyStore.getDevice(
        this.identity.deviceId,
      );
      const issuerFingerprint = await deviceKeyFingerprint(
        ownDevice.publicKeys,
      );
      if (issuerFingerprint !== this.localFingerprint)
        throw new Error(
          "This device's local sync key changed. Pairing was not approved.",
        );
      const deviceCertificate = await createDeviceAuthorizationCertificate({
        householdId: this.identity.householdId,
        memberId: this.pairing.memberId,
        deviceId: this.pairing.deviceId,
        issuerDeviceId: this.identity.deviceId,
        issuerFingerprint,
        publicKeys: this.pairing.syncPublicKeys,
        signingKey: ownDevice.keys.signingPrivateKey,
      });
      this.pairing = await this.api(
        `/api/pairings/${this.pairing.pairingId}/approve/finish`,
        {
          method: "POST",
          body: JSON.stringify({
            flow: started.flow,
            credential: credentialJson(credential),
            deviceCertificate,
          }),
        },
      );
      await this.syncKeyStore.pinTrustedDevice({
        householdId: this.identity.householdId,
        memberId: this.pairing.confirmedMemberId,
        deviceId: this.pairing.confirmedDeviceId,
        publicKeys: this.pairing.syncPublicKeys,
        fingerprint: this.pairing.syncKeyFingerprint,
      });
      this.render();
    });
  }
  async activateClaim() {
    await this.run(async () => {
      if (!this.localFingerprint || this.claim?.syncKeyFingerprint !== this.localFingerprint)
        throw new Error("This device key changed. Restart pairing before activating it.");
      if (
        !this.verifiedInviterFingerprint ||
        !this.claim?.inviterDeviceId ||
        !this.claim?.inviterKeyFingerprint
      )
        throw new Error(
          "Compare the approving device fingerprint on both devices before activation.",
        );
      const started = await this.api("/api/claim/activate/options", {
        method: "POST",
        body: "{}",
      });
      const credential = await navigator.credentials.get({
        publicKey: authenticationOptions(started.publicKey),
        signal: this.connectionAbort.signal,
      });
      const activated = await this.api("/api/claim/activate/finish", {
        method: "POST",
        body: JSON.stringify({
          flow: started.flow,
          credential: credentialJson(credential),
        }),
      });
      await this.openSyncKeyStore();
      const bound = await this.syncKeyStore.bindPendingDevice({
        deviceId: activated.deviceId,
        householdId: activated.householdId,
        memberId: activated.memberId,
      });
      this.localFingerprint = bound.fingerprint;
      const { devices } = await this.api("/api/sync/devices");
      const inviter = devices.find(
        (device) => device.deviceId === this.claim.inviterDeviceId,
      );
      if (
        !inviter?.publicKeys ||
        inviter.fingerprint !== this.claim.inviterKeyFingerprint ||
        (await deviceKeyFingerprint(inviter.publicKeys)) !==
          this.claim.inviterKeyFingerprint
      )
        throw new Error(
          "The approving device key does not match the compared fingerprint.",
        );
      await this.syncKeyStore.pinTrustedDevice({
        householdId: activated.householdId,
        memberId: inviter.memberId,
        deviceId: inviter.deviceId,
        publicKeys: inviter.publicKeys,
        fingerprint: inviter.fingerprint,
      });
      location.href = "/";
    });
  }
  async revoke() {
    await this.run(async () => {
      this.pairing = await this.api(`/api/pairings/${this.pairing.pairingId}`, {
        method: "DELETE",
        body: "{}",
      });
      this.render();
    });
  }
  async copyCode() {
    try {
      await navigator.clipboard.writeText(this.pairing.code);
      this.message("Pairing code copied.");
    } catch {
      this.message(
        "Copy is unavailable. Select and copy the code manually.",
        true,
      );
    }
  }
  async share() {
    const url = `${location.origin}/pair?code=${encodeURIComponent(this.pairing.code)}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Join my Kin household",
          text: "Open this invitation to request household access. Approval is still required.",
          url,
        });
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.message("Invitation link copied.");
    } catch {
      this.message(`Share this address: ${url}`, true);
    }
  }

  async showDevices() {
    await this.run(async () => {
      const { devices } = await this.api("/api/devices");
      let directoryDevices = [];
      if (!this.syncKeyError) {
        await this.openSyncKeyStore();
        directoryDevices = (await this.api("/api/sync/devices")).devices;
      }
      this.replaceChildren();
      const heading = document.createElement("h2");
      heading.textContent = "Trusted devices";
      this.append(heading);
      const list = document.createElement("ul");
      list.className = "device-list";
      for (const device of devices) {
        const item = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = `${device.label} — ${device.revokedAt ? "Revoked" : "Trusted"}`;
        item.append(text);
        const syncDevice = directoryDevices.find(
          (entry) => entry.deviceId === device.id,
        );
        if (syncDevice?.fingerprint) {
          if (
            device.id === this.identity.deviceId &&
            syncDevice.fingerprint !== this.localFingerprint
          ) {
            this.message(
              "This browser's saved device key does not match its trusted record. Device sync is paused.",
              true,
            );
            list.append(item);
            continue;
          }
          const displayedFingerprint =
            device.id === this.identity.deviceId
              ? this.localFingerprint
              : syncDevice.fingerprint;
          const keyCode = document.createElement("code");
          keyCode.className = "device-key-fingerprint";
          keyCode.textContent = displayedFingerprint.match(/.{1,4}/g).join(" ");
          keyCode.setAttribute(
            "aria-label",
            `Device sync code ${keyCode.textContent}`,
          );
          item.append(keyCode);
          const pinned =
            device.id === this.identity.deviceId ||
            (await this.syncKeyStore.getPinnedDevice(
              this.identity.householdId,
              device.id,
            ));
          if (!pinned && syncDevice.publicKeys) {
            const verify = this.makeButton("Verify device", () => {
              verify.hidden = true;
              const prompt = document.createElement("p");
              prompt.textContent =
                "Compare this code with the code shown on that device.";
              const label = document.createElement("label");
              const confirmation = document.createElement("input");
              confirmation.type = "checkbox";
              label.append(
                confirmation,
                document.createTextNode(" The codes match."),
              );
              const approve = this.makeButton("Trust this device", async () => {
                await this.syncKeyStore.pinTrustedDevice({
                  householdId: this.identity.householdId,
                  memberId: syncDevice.memberId,
                  deviceId: syncDevice.deviceId,
                  publicKeys: syncDevice.publicKeys,
                  fingerprint: syncDevice.fingerprint,
                });
                this.requestSync();
                await this.showDevices();
              });
              approve.disabled = true;
              confirmation.addEventListener("change", () => {
                approve.disabled = !confirmation.checked;
              });
              item.append(prompt, label, approve);
            });
            item.append(verify);
          }
        }
        if (!device.revokedAt && device.id !== this.identity.deviceId)
          item.append(
            this.makeButton(
              "Revoke device",
              async () => {
                await this.api(`/api/devices/${device.id}`, {
                  method: "DELETE",
                  body: "{}",
                });
                await this.showDevices();
              },
              "danger",
            ),
          );
        list.append(item);
      }
      this.append(
        list,
        this.makeButton("Back", () => this.render(), "secondary"),
      );
    });
  }
  async showHousehold() {
    await this.run(async () => {
      const household = await this.api("/api/household");
      this.replaceChildren();
      const heading = document.createElement("h2");
      heading.textContent = "Household access";
      this.append(heading);
      this.text(
        "Membership and device trust are separate. Removing an adult revokes that adult’s devices and sessions, but cannot erase information already copied.",
      );
      const list = document.createElement("ul");
      for (const member of household.members.filter((value) => value.active)) {
        const item = document.createElement("li");
        item.textContent = member.current
          ? "You — active adult"
          : "Other adult — active";
        if (!member.current)
          item.append(
            this.makeButton(
              "Remove other adult",
              () => this.removeMember(member.id),
              "danger",
            ),
          );
        list.append(item);
      }
      this.append(
        list,
        this.makeButton("Leave household", () => this.leave(), "danger"),
        this.makeButton("Back", () => this.render(), "secondary"),
      );
    });
  }
  async removeMember(memberId) {
    if (
      !confirm(
        "Remove the other adult and revoke all of their trusted devices? Previously copied information cannot be erased.",
      )
    )
      return;
    await this.run(async () => {
      const started = await this.api("/api/household/membership/remove/options", {
        method: "POST",
        body: JSON.stringify({ memberId }),
      });
      const credential = await navigator.credentials.get({
        publicKey: authenticationOptions(started.publicKey),
        signal: this.connectionAbort.signal,
      });
      await this.api("/api/household/membership/remove/finish", {
        method: "POST",
        body: JSON.stringify({
          flow: started.flow,
          credential: credentialJson(credential),
        }),
      });
    });
    await this.showHousehold();
  }
  async leave() {
    if (
      !confirm(
        "Leave this household and revoke this adult’s devices? This cannot be undone or recovered in this release.",
      )
    )
      return;
    await this.run(async () => {
      await this.api("/api/household/membership", { method: "DELETE", body: "{}" });
      location.href = "/";
    });
  }
  async logout() {
    // Local lock is immediate and independent of network availability.
    this.dispatchEvent(new CustomEvent("kin:lock", { bubbles: true, composed: true }));
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  }
  pollPairing() {
    if (!["Pending", "Claimed"].includes(this.pairing?.state)) return;
    clearTimeout(this.poll);
    this.poll = setTimeout(async () => {
      try {
        const latest = await this.api(`/api/pairings/${this.pairing.pairingId}`);
        const changed = latest.version !== this.pairing.version;
        this.pairing = { ...this.pairing, ...latest };
        if (changed) this.render();
        else this.pollPairing();
      } catch (error) {
        this.renderError(error);
      }
    }, 2000);
  }
  schedulePoll() {
    clearTimeout(this.poll);
    this.poll = setTimeout(async () => {
      try {
        this.claim = await this.api("/api/claim");
        this.render();
        if (this.claim.state === "Claimed") this.schedulePoll();
      } catch (error) {
        this.claim = null;
        this.renderError(error);
        if (location.pathname === "/pair") this.renderJoin();
      }
    }, 2000);
  }
  updateCountdown() {
    const seconds = Math.max(
      0,
      Math.ceil((this.pairing.expiresAt - Date.now()) / 1000),
    );
    this.countdown.textContent = seconds
      ? `Expires in ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : "Expired — request a new code.";
    if (!seconds) {
      clearInterval(this.timer);
      this.pollPairing();
    }
  }

  async run(action) {
    if (this.busy) return;
    try { this.assertConnection(); } catch { return; }
    this.busy = true;
    this.setAttribute("aria-busy", "true");
    try {
      await action();
    } catch (error) {
      if (["NotAllowedError", "AbortError"].includes(error?.name))
        error = new Error(
          "The passkey was unavailable or the request was cancelled. No authorization change was made.",
        );
      this.renderError(error);
    } finally {
      this.busy = false;
      this.setAttribute("aria-busy", "false");
    }
  }
  renderError(error) {
    if (!this.isConnected || this.connectionAbort.signal.aborted) return;
    this.message(
      error?.message || "Kin could not complete that request.",
      true,
    );
  }
  text(value) {
    const paragraph = document.createElement("p");
    paragraph.textContent = value;
    this.append(paragraph);
    return paragraph;
  }
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
  message(value, alert = false) {
    let region = this.querySelector(".household-message");
    if (!region) {
      region = document.createElement("p");
      region.className = "household-message";
      this.append(region);
    }
    region.setAttribute("role", alert ? "alert" : "status");
    region.textContent = value;
    return region;
  }
  makeButton(label, action, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = className;
    button.disabled = this.disabled;
    button.addEventListener("click", action);
    return button;
  }
  button(label, action, className) {
    const button = this.makeButton(label, action, className);
    this.append(button);
    return button;
  }
}

customElements.define("kin-household", KinHousehold);

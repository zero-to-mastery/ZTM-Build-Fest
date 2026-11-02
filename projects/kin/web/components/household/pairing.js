// Pairing codes: creating, approving, activating, revoking and sharing them,
// and polling and counting down while one is pending.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { createDeviceAuthorizationCertificate, deviceKeyFingerprint } from "../../sync/crypto.js";
import { authenticationOptions, credentialJson } from "./auth.js";
import { freshConfirmation } from "./fresh-confirmation.js";
import { invitationLink } from "../../pairing-link.js";

export class HouseholdPairing {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  async createPairing(kind = "adult", expiresAt) {
    await this.host.run(async () => {
      this.host.pairing = await this.host.api("/api/pairings", { method: "POST", body: JSON.stringify({ kind, ...(expiresAt === undefined ? {} : { expiresAt }) }) });
      if (
        !this.host.localFingerprint ||
        this.host.pairing.inviterKeyFingerprint !== this.host.localFingerprint
      )
        throw new Error(
          "This device's approved key does not match its local key.",
        );
      this.host.render();
    });
  }

  async createDevicePairing() {
    await this.host.run(async () => {
      this.host.pairing = await this.host.api("/api/devices/pairings", {
        method: "POST",
        body: "{}",
      });
      if (
        !this.host.localFingerprint ||
        this.host.pairing.inviterKeyFingerprint !== this.host.localFingerprint
      )
        throw new Error(
          "This device's approved key does not match its local key.",
        );
      this.host.render();
    });
  }

  async approve() {
    await this.host.run(async () => {
      if (
        !this.host.pairing?.syncKeyFingerprint ||
        this.host.verifiedFingerprint !== this.host.pairing.syncKeyFingerprint
      ) {
        throw new Error(
          "Compare the device fingerprint on both devices before approving.",
        );
      }
      const started = await this.host.api(
        `/api/pairings/${this.host.pairing.pairingId}/approve/options`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: this.host.pairing.version }),
        },
      );
      const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
      const ownDevice = await this.host.syncKeyStore.getDevice(
        this.host.identity.deviceId,
      );
      const issuerFingerprint = await deviceKeyFingerprint(
        ownDevice.publicKeys,
      );
      if (issuerFingerprint !== this.host.localFingerprint)
        throw new Error(
          "This device's local sync key changed. Pairing was not approved.",
        );
      const deviceCertificate = await createDeviceAuthorizationCertificate({
        householdId: this.host.identity.householdId,
        memberId: this.host.pairing.memberId,
        deviceId: this.host.pairing.deviceId,
        issuerDeviceId: this.host.identity.deviceId,
        issuerFingerprint,
        publicKeys: this.host.pairing.syncPublicKeys,
        signingKey: ownDevice.keys.signingPrivateKey,
      });
      this.host.pairing = await this.host.api(
        `/api/pairings/${this.host.pairing.pairingId}/approve/finish`,
        {
          method: "POST",
          body: JSON.stringify({
            flow: started.flow,
            ...proof,
            deviceCertificate,
          }),
        },
      );
      await this.host.syncKeyStore.pinTrustedDevice({
        householdId: this.host.identity.householdId,
        memberId: this.host.pairing.confirmedMemberId,
        deviceId: this.host.pairing.confirmedDeviceId,
        publicKeys: this.host.pairing.syncPublicKeys,
        fingerprint: this.host.pairing.syncKeyFingerprint,
      });
      this.host.render();
    });
  }

  async activateClaim() {
    await this.host.run(async () => {
      if (!this.host.localFingerprint || this.host.claim?.syncKeyFingerprint !== this.host.localFingerprint)
        throw new Error("This device key changed. Restart pairing before activating it.");
      if (
        !this.host.verifiedInviterFingerprint ||
        !this.host.claim?.inviterDeviceId ||
        !this.host.claim?.inviterKeyFingerprint
      )
        throw new Error(
          "Compare the approving device fingerprint on both devices before activation.",
        );
      const started = await this.host.api("/api/claim/activate/options", {
        method: "POST",
        body: "{}",
      });
      const credential = await navigator.credentials.get({
        publicKey: authenticationOptions(started.publicKey),
        signal: this.host.connectionAbort.signal,
      });
      const activated = await this.host.api("/api/claim/activate/finish", {
        method: "POST",
        body: JSON.stringify({
          flow: started.flow,
          credential: credentialJson(credential),
        }),
      });
      await this.ctx.api.openSyncKeyStore();
      const bound = await this.host.syncKeyStore.bindPendingDevice({
        deviceId: activated.deviceId,
        householdId: activated.householdId,
        memberId: activated.memberId,
      });
      this.host.localFingerprint = bound.fingerprint;
      const { devices } = await this.host.api("/api/sync/devices");
      const inviter = devices.find(
        (device) => device.deviceId === this.host.claim.inviterDeviceId,
      );
      if (
        !inviter?.publicKeys ||
        inviter.fingerprint !== this.host.claim.inviterKeyFingerprint ||
        (await deviceKeyFingerprint(inviter.publicKeys)) !==
          this.host.claim.inviterKeyFingerprint
      )
        throw new Error(
          "The approving device key does not match the compared fingerprint.",
        );
      await this.host.syncKeyStore.pinTrustedDevice({
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
    await this.host.run(async () => {
      this.host.pairing = await this.host.api(`/api/pairings/${this.host.pairing.pairingId}`, {
        method: "DELETE",
        body: "{}",
      });
      this.host.render();
    });
  }

  async copyCode() {
    try {
      await navigator.clipboard.writeText(this.host.pairing.code);
      this.host.message("Pairing code copied.");
    } catch {
      this.host.message(
        "Copy is unavailable. Select and copy the code manually.",
        true,
      );
    }
  }

  async share() {
    // The code rides in the fragment, which never reaches a server (#97).
    const url = invitationLink(location.origin, this.host.pairing.code);
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
      this.host.message("Invitation link copied.");
    } catch {
      this.host.message(`Share this address: ${url}`, true);
    }
  }

  pollPairing() {
    if (!["Pending", "Claimed"].includes(this.host.pairing?.state)) return;
    clearTimeout(this.host.poll);
    // The view this poll belongs to. If another view (People & devices) has
    // taken the panel by the time the answer arrives, the poll still records
    // the new pairing state but leaves that view alone; Back re-renders it.
    const generation = this.host.viewGeneration;
    this.host.poll = setTimeout(async () => {
      try {
        const latest = await this.host.api(`/api/pairings/${this.host.pairing.pairingId}`);
        const changed = latest.version !== this.host.pairing.version;
        this.host.pairing = { ...this.host.pairing, ...latest };
        if (this.host.viewGeneration !== generation) return;
        if (changed) this.host.render();
        else this.pollPairing();
      } catch (error) {
        if (this.host.viewGeneration !== generation) return;
        this.host.renderError(error);
      }
    }, 2000);
  }

  schedulePoll() {
    clearTimeout(this.host.poll);
    // Like pollPairing: a view that took over the panel meanwhile (an intent
    // switch, link approval) keeps it, and an unchanged claim doesn't repaint
    // (which would drop focus and anything typed every 2 s) (#327).
    const generation = this.host.viewGeneration;
    this.host.poll = setTimeout(async () => {
      const before = JSON.stringify(this.host.claim ?? null);
      try {
        const claim = await this.host.api("/api/claim");
        if (this.host.viewGeneration !== generation) return;
        this.host.claim = claim;
        if (JSON.stringify(claim) !== before) this.host.render();
        if (claim.state === "Claimed") this.schedulePoll();
      } catch (error) {
        if (this.host.viewGeneration !== generation) return;
        this.host.claim = null;
        this.host.renderError(error);
        if (location.pathname === "/pair") this.ctx.views.renderJoin();
      }
    }, 2000);
  }

  updateCountdown() {
    const seconds = Math.max(
      0,
      Math.ceil((this.host.pairing.expiresAt - Date.now()) / 1000),
    );
    this.host.countdown.textContent = seconds
      ? `Expires in ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : "Expired — request a new code.";
    if (!seconds) {
      clearInterval(this.host.timer);
      // Show the ended state now; the poll confirms it with the service.
      this.host.render();
      this.pollPairing();
    }
  }
}

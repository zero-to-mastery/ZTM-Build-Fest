// PairingService, pairing stage 2: the new device claims a pairing with its
// code and registers its credential.
import { validateSyncPublicKeys } from "./devices.mjs";
import {
  CLAIM_TTL_MS,
  cleanLabel,
  genericCodeError,
  hash,
  id,
  MAX_CODE_ATTEMPTS,
  PairingError,
  PREPARED_CLAIM_TTL_MS,
  terminalPairingError,
  token,
} from "./shared.mjs";

export const claimMethods = {
  validatePairingCode(code, { rateKey = "unknown" } = {}) {
    return this.rateLimitedAttempt(rateKey, () => this.checkPairingCode(code));
  },

  checkPairingCode(code) {
    const pairing = this.pairingByCode(code);
    if (!pairing) {
      this.audit("pairing_failed_attempt");
      throw genericCodeError();
    }
    const state = this.state(pairing);
    if (state !== "Pending") throw terminalPairingError(state);
    // A prepared invitation (#613) also tells whoever holds its code how to
    // start: in easy mode or not, and its sealed card, which only the key in
    // the link's fragment opens.
    return {
      valid: true,
      purpose: pairing.purpose ?? "adult",
      ...(pairing.prepared ? { prepared: {
        memberKind: pairing.admissionKind ?? "adult",
        easyMode: pairing.prepared.easyMode,
        card: pairing.prepared.card,
        expiresAt: pairing.prepared.invitationExpiresAt,
      } } : {}),
    };
  },

  claimPairing({
    code,
    credential,
    password,
    deviceLabel,
    syncPublicKeys,
    rateKey = "unknown",
  }) {
    return this.rateLimitedAttempt(rateKey, () =>
      this.claimPairingCode({ code, credential, password, deviceLabel, syncPublicKeys }));
  },

  /**
   * Claims a pairing with the new device's passkey `credential`, or (#558,
   * new members only) a `password` record from preparePassword. Adding a
   * device to an existing member, replacing one and recovery still need a
   * passkey: those devices join an identity that already exists.
   */
  claimPairingCode({ code, credential, password, deviceLabel, syncPublicKeys }) {
    const pairing = this.pairingByCode(code);
    if (!pairing) {
      this.audit("pairing_failed_attempt");
      throw genericCodeError();
    }
    const state = this.state(pairing);
    if (state !== "Pending") throw terminalPairingError(state);
    if (password && pairing.purpose)
      throw new PairingError("passkey_required", "Adding a device to an existing member still uses a passkey.", 409);
    if (password) this.assertUsernameAvailable(password.username);
    pairing.attempts += 1;
    if (pairing.attempts > MAX_CODE_ATTEMPTS) {
      pairing.state = "Revoked";
      pairing.terminalAt = this.now();
      pairing.version += 1;
      if (pairing.prepared) this.retireCode(pairing);
      this.audit("pairing_revoked", {
        pairingId: pairing.id,
        reason: "attempt_limit",
      });
      throw genericCodeError();
    }
    const claimToken = token();
    const deviceToken = token();
    const claimedAt = this.now();
    // A prepared invitation's helper may not be at hand when the person
    // opens it, so its claim waits up to a day for approval (#613).
    pairing.expiresAt = claimedAt + (pairing.prepared ? PREPARED_CLAIM_TTL_MS : CLAIM_TTL_MS);
    pairing.claimant = {
      credential: password ? null : credential,
      ...(password ? { password } : {}),
      deviceLabel: cleanLabel(deviceLabel),
      memberId: pairing.memberId ?? id(),
      deviceId: id(),
      ...(syncPublicKeys ? validateSyncPublicKeys(syncPublicKeys) : {}),
      tokenHash: hash(claimToken),
      deviceToken,
      deviceTokenHash: hash(deviceToken),
      claimedAt,
    };
    pairing.state = "Claimed";
    pairing.version += 1;
    this.claimTokens.set(hash(claimToken), pairing.id);
    this.audit("pairing_claimed", {
      householdId: pairing.householdId,
      pairingId: pairing.id,
    });
    return {
      claimToken,
      pairingId: pairing.id,
      purpose: pairing.purpose ?? "adult",
      state: pairing.state,
      deviceToken,
      expiresAt: pairing.expiresAt,
      version: pairing.version,
    };
  },

  pairingForClaim(claimToken) {
    const claimHash = hash(String(claimToken ?? ""));
    const pairing = this.pairings.get(this.claimTokens.get(claimHash));
    if (!pairing)
      throw new PairingError(
        "claim_unavailable",
        "This pairing request is unavailable.",
        404,
      );
    if (pairing.state === "Confirmed" && pairing.expiresAt <= this.now()) {
      this.claimTokens.delete(claimHash);
      this.prunePairingCapabilities();
      throw new PairingError(
        "claim_unavailable",
        "This pairing request is unavailable.",
        404,
      );
    }
    const view = this.pairingView(pairing);
    if (["Expired", "Revoked"].includes(view.state))
      this.claimTokens.delete(claimHash);
    this.prunePairingCapabilities();
    return view;
  },

  clearClaim(claimToken) {
    this.claimTokens.delete(hash(String(claimToken ?? "")));
  },

  claimCredential(claimToken) {
    this.prunePairingCapabilities();
    const pairing = this.pairings.get(
      this.claimTokens.get(hash(String(claimToken ?? ""))),
    );
    if (!pairing || this.state(pairing) !== "Confirmed")
      throw new PairingError(
        "claim_not_confirmed",
        "Approval is still required.",
        409,
      );
    if (!pairing.claimant.credential)
      throw new PairingError("password_required", "Use your password to finish joining.", 409);
    return this.credentials.get(pairing.claimant.credential.id);
  },

  activateClaim(claimToken) {
    this.prunePairingCapabilities();
    const pairing = this.pairings.get(
      this.claimTokens.get(hash(String(claimToken ?? ""))),
    );
    if (!pairing || this.state(pairing) !== "Confirmed")
      throw new PairingError(
        "claim_not_confirmed",
        "Approval is still required.",
        409,
      );
    this.claimTokens.delete(pairing.claimant.tokenHash);
    const device = this.devices.get(pairing.confirmedDeviceId);
    const result = {
      ...this.issueSession(
        pairing.confirmedMemberId,
        pairing.confirmedDeviceId,
      ),
      deviceToken: pairing.claimant.deviceToken,
      householdId: pairing.householdId,
      memberId: pairing.confirmedMemberId,
      deviceId: pairing.confirmedDeviceId,
    };
    this.persistHousehold(pairing.householdId);
    return result;
  },
};

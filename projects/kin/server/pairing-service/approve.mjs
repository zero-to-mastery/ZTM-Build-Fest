// PairingService, pairing stage 3: an adult approves or revokes a claimed
// pairing; pairing views and capability pruning.
import {
  MAX_ACTIVE_ADULTS,
  MAX_ACTIVE_LIMITED_MEMBERS,
  MAX_ACTIVE_MEMBERS,
  MAX_TRUSTED_DEVICES,
} from "../identity-limits.mjs";
import { validateDeviceAuthorizationCertificate } from "./devices.mjs";
import {
  CLAIM_TTL_MS,
  isHouseholdAdmin,
  PairingError,
  requireHouseholdAdmin,
  requireTrustAuthority,
  TERMINAL_PAIRING_RETENTION_MS,
  terminalPairingError,
} from "./shared.mjs";

export const approveMethods = {
  approvePairing(
    sessionToken,
    pairingId,
    expectedVersion,
    deviceAuthorizationCertificate,
  ) {
    const {
      member,
      household,
      device: approverDevice,
    } = this.authorize(sessionToken);
    requireTrustAuthority(member, "approve a pairing");
    const pairing = this.pairings.get(pairingId);
    if (
      !pairing ||
      pairing.householdId !== household.id ||
      pairing.inviterId !== member.id
    )
      throw new PairingError(
        "not_found",
        "That pairing request is unavailable.",
        404,
      );
    if (!pairing.purpose)
      this.requireManagementAuthority(member, household, "approve a household invitation");
    const state = this.state(pairing);
    if (state === "Confirmed") return this.pairingView(pairing);
    if (state !== "Claimed") throw terminalPairingError(state);
    if (pairing.version !== expectedVersion)
      throw new PairingError(
        "stale_pairing",
        "The pairing request changed. Review its latest status.",
        409,
      );
    // Authority is checked again now, not only when the pairing was created:
    // the target may have been promoted, or the approver demoted, since then.
    // Recovering an admin issues an admin device, so it needs an admin.
    if (
      pairing.purpose === "member-recovery" &&
      isHouseholdAdmin(this.members.get(pairing.memberId), this.now())
    )
      requireHouseholdAdmin(member, "recover a household admin", this.now());
    if (pairing.claimant.syncPublicKeys)
      validateDeviceAuthorizationCertificate(deviceAuthorizationCertificate, {
        householdId: household.id,
        memberId: pairing.claimant.memberId,
        deviceId: pairing.claimant.deviceId,
        claimantPublicKeys: pairing.claimant.syncPublicKeys,
        claimantFingerprint: pairing.claimant.syncKeyFingerprint,
        approverDevice,
      });
    else if (deviceAuthorizationCertificate)
      throw new PairingError(
        "device_certificate_invalid",
        "Kin could not verify this device approval.",
        400,
      );
    if (["device", "replacement", "member-recovery"].includes(pairing.purpose)) {
      const existingMember = this.members.get(pairing.memberId);
      const activeDevices = this.activeTrustedDeviceCount(household);
      const targetActiveDevices = [...this.devices.values()].filter(
        (device) =>
          device.householdId === household.id &&
          device.memberId === pairing.memberId &&
          !device.revokedAt,
      ).length;
      const postRecoveryDevices =
        pairing.purpose === "device"
          ? activeDevices + 1
          : pairing.purpose === "replacement"
            ? activeDevices
            : activeDevices - targetActiveDevices + 1;
      if (postRecoveryDevices > MAX_TRUSTED_DEVICES)
        throw new PairingError(
          "device_limit",
          "This household reached its trusted-device limit.",
          409,
        );
      if (
        !existingMember?.active ||
        existingMember.householdId !== household.id
      )
        throw new PairingError(
          "membership_removed",
          "This household membership is no longer active.",
          403,
        );
      const deviceId = pairing.claimant.deviceId;
      if (pairing.purpose === "replacement") {
        const lostDevice = this.devices.get(pairing.lostDeviceId);
        if (
          !lostDevice ||
          lostDevice.householdId !== household.id ||
          lostDevice.memberId !== existingMember.id ||
          lostDevice.revokedAt
        )
          throw new PairingError(
            "replacement_stale",
            "The device replacement changed. Start recovery again.",
            409,
          );
        lostDevice.revokedAt = this.now();
        if (lostDevice.tokenHash)
          this.deviceTokens.delete(lostDevice.tokenHash);
        for (const [sessionHash, activeSession] of this.sessions)
          if (activeSession.deviceId === lostDevice.id)
            this.sessions.delete(sessionHash);
        this.audit("device_revoked", {
          householdId: household.id,
          memberId: existingMember.id,
          deviceId: lostDevice.id,
          reason: "replacement",
        });
      }
      if (pairing.purpose === "member-recovery") {
        for (const oldDevice of this.devices.values())
          if (oldDevice.memberId === existingMember.id && !oldDevice.revokedAt) {
            oldDevice.revokedAt = this.now();
            if (oldDevice.tokenHash)
              this.deviceTokens.delete(oldDevice.tokenHash);
            this.audit("device_revoked", {
              householdId: household.id,
              memberId: existingMember.id,
              deviceId: oldDevice.id,
              reason: "member_recovery",
            });
          }
        for (const [sessionHash, activeSession] of this.sessions)
          if (activeSession.memberId === existingMember.id)
            this.sessions.delete(sessionHash);
        for (const credentialId of existingMember.credentials)
          this.credentials.delete(credentialId);
        existingMember.credentials.clear();
      }
      this.addCredential(existingMember.id, pairing.claimant.credential);
      existingMember.credentials.add(pairing.claimant.credential.id);
      this.devices.set(deviceId, {
        id: deviceId,
        memberId: existingMember.id,
        householdId: household.id,
        label: pairing.claimant.deviceLabel,
        trustedAt: this.now(),
        revokedAt: null,
        tokenHash: pairing.claimant.deviceTokenHash,
        ...(pairing.claimant.syncPublicKeys
          ? {
              syncPublicKeys: pairing.claimant.syncPublicKeys,
              syncKeyFingerprint: pairing.claimant.syncKeyFingerprint,
              deviceAuthorizationCertificate,
            }
          : {}),
      });
      this.deviceTokens.set(pairing.claimant.deviceTokenHash, deviceId);
      household.version += 1;
      pairing.confirmedMemberId = existingMember.id;
      pairing.confirmedDeviceId = deviceId;
      pairing.state = "Confirmed";
      pairing.terminalAt = this.now();
      pairing.expiresAt = this.now() + CLAIM_TTL_MS;
      pairing.version += 1;
      this.retireCode(pairing);
      this.audit("device_pairing_confirmed", {
        householdId: household.id,
        pairingId,
        memberId: existingMember.id,
        deviceId,
      });
      this.audit("device_trusted", {
        householdId: household.id,
        memberId: existingMember.id,
        deviceId,
      });
      if (pairing.purpose === "replacement")
        this.audit("device_replacement_completed", {
          householdId: household.id,
          pairingId,
          memberId: existingMember.id,
          lostDeviceId: pairing.lostDeviceId,
          deviceId,
        });
      if (pairing.purpose === "member-recovery")
        this.audit("member_recovery_completed", {
          householdId: household.id,
          pairingId,
          approverMemberId: pairing.inviterId,
          memberId: existingMember.id,
          deviceId,
        });
      this.persistHousehold(household.id);
      return this.pairingView(pairing);
    }
    if (this.activeMemberCount(household) >= MAX_ACTIVE_MEMBERS)
      throw new PairingError(
        "household_full",
        "This household has reached its member limit.",
        409,
      );
    if (pairing.admissionKind === "temporary" && pairing.admissionExpiresAt <= this.now())
      throw new PairingError("temporary_expiry_elapsed", "This temporary invitation has expired. Create a new invitation.", 409);
    if (pairing.admissionKind === "adult" && this.activeKindCount(household, "adult") >= MAX_ACTIVE_ADULTS ||
        pairing.admissionKind === "limited" && this.activeKindCount(household, "limited") >= MAX_ACTIVE_LIMITED_MEMBERS)
      throw new PairingError("household_full", "This household has reached that member type's limit.", 409);
    if (this.activeTrustedDeviceCount(household) >= MAX_TRUSTED_DEVICES)
      throw new PairingError(
        "device_limit",
        "This household reached its trusted-device limit.",
        409,
      );
    const memberId = pairing.claimant.memberId;
    const deviceId = pairing.claimant.deviceId;
    // A joiner who signed up with a password (#558) has a username and no
    // passkey yet. The claim reserved the username; it is checked again
    // before it is kept.
    const password = pairing.claimant.password ?? null;
    if (password && [...this.members.values()].some((other) => other.username === password.username && other.active))
      throw new PairingError("username_taken", "That username is taken. Ask them to join again with another.", 409);
    if (pairing.claimant.credential) this.addCredential(memberId, pairing.claimant.credential);
    this.members.set(memberId, {
      id: memberId,
      householdId: household.id,
      active: true,
      kind: pairing.admissionKind ?? "adult",
      ...(pairing.admissionKind === "temporary" ? { expiresAt: pairing.admissionExpiresAt } : {}),
      credentials: new Set(pairing.claimant.credential ? [pairing.claimant.credential.id] : []),
      ...(password ? { username: password.username, password } : {}),
    });
    this.devices.set(deviceId, {
      id: deviceId,
      memberId,
      householdId: household.id,
      label: pairing.claimant.deviceLabel,
      trustedAt: this.now(),
      revokedAt: null,
      tokenHash: pairing.claimant.deviceTokenHash,
      ...(pairing.claimant.syncPublicKeys
        ? {
            syncPublicKeys: pairing.claimant.syncPublicKeys,
            syncKeyFingerprint: pairing.claimant.syncKeyFingerprint,
            deviceAuthorizationCertificate,
          }
        : {}),
    });
    this.deviceTokens.set(pairing.claimant.deviceTokenHash, deviceId);
    household.members.add(memberId);
    household.version += 1;
    pairing.confirmedMemberId = memberId;
    pairing.confirmedDeviceId = deviceId;
    pairing.state = "Confirmed";
    pairing.terminalAt = this.now();
    pairing.expiresAt = this.now() + CLAIM_TTL_MS;
    pairing.version += 1;
    this.retireCode(pairing);
    this.audit("pairing_confirmed", {
      householdId: household.id,
      pairingId,
      memberId,
      deviceId,
    });
    this.audit("device_trusted", {
      householdId: household.id,
      memberId,
      deviceId,
    });
    this.persistHousehold(household.id);
    return this.pairingView(pairing);
  },

  revokePairing(sessionToken, pairingId) {
    const { member, household } = this.authorize(sessionToken);
    requireTrustAuthority(member, "revoke a household invitation");
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.householdId !== household.id)
      throw new PairingError(
        "not_found",
        "That pairing request is unavailable.",
        404,
      );
    const state = this.state(pairing);
    if (state === "Revoked") return this.pairingView(pairing);
    if (!["Pending", "Claimed"].includes(state))
      throw terminalPairingError(state);
    pairing.state = "Revoked";
    pairing.terminalAt = this.now();
    pairing.version += 1;
    this.retireCode(pairing);
    this.audit("pairing_revoked", { householdId: household.id, pairingId });
    return this.pairingView(pairing);
  },

  pairingForAdult(sessionToken, pairingId) {
    const { member, household } = this.authorize(sessionToken);
    requireTrustAuthority(member, "review a household invitation");
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.householdId !== household.id)
      throw new PairingError(
        "not_found",
        "That pairing request is unavailable.",
        404,
      );
    return this.pairingView(pairing);
  },

  prunePairingCapabilities(now = this.now()) {
    for (const pairing of this.pairings.values()) this.state(pairing);
    for (const [claimHash, pairingId] of this.claimTokens) {
      const pairing = this.pairings.get(pairingId);
      if (
        !pairing ||
        ["Expired", "Revoked"].includes(this.state(pairing)) ||
        (pairing.state === "Confirmed" && pairing.expiresAt <= now)
      )
        this.claimTokens.delete(claimHash);
    }
    const claimedPairings = new Set(this.claimTokens.values());
    for (const [pairingId, pairing] of this.pairings)
      if (
        pairing.terminalAt != null &&
        pairing.terminalAt + TERMINAL_PAIRING_RETENTION_MS <= now &&
        !claimedPairings.has(pairingId)
      )
        this.pairings.delete(pairingId);
  },

  pairingView(pairing) {
    return {
      pairingId: pairing.id,
      purpose: pairing.purpose ?? "adult",
      memberKind: pairing.admissionKind ?? "adult",
      ...(pairing.admissionExpiresAt == null ? {} : { memberExpiresAt: pairing.admissionExpiresAt }),
      inviterDeviceId: pairing.inviterDeviceId,
      inviterKeyFingerprint: pairing.inviterKeyFingerprint,
      state: this.state(pairing),
      expiresAt: pairing.expiresAt,
      version: pairing.version,
      deviceLabel:
        pairing.state === "Claimed" ? pairing.claimant.deviceLabel : undefined,
      syncKeyFingerprint:
        pairing.state === "Claimed" || pairing.state === "Confirmed"
          ? pairing.claimant?.syncKeyFingerprint
          : undefined,
      syncPublicKeys:
        pairing.state === "Claimed" || pairing.state === "Confirmed"
          ? pairing.claimant?.syncPublicKeys
          : undefined,
      memberId: pairing.claimant?.memberId,
      deviceId: pairing.claimant?.deviceId,
      // How the joiner finishes (#558): with their passkey, or their password.
      signIn: pairing.claimant ? (pairing.claimant.password ? "password" : "passkey") : undefined,
      confirmedMemberId: pairing.confirmedMemberId,
      confirmedDeviceId: pairing.confirmedDeviceId,
      lostDeviceId: pairing.lostDeviceId,
      // A prepared invitation (#613): whether it starts the person in easy
      // mode and when the invitation itself ends (`expiresAt` is the claim's
      // approval window once claimed). Its sealed card goes only to whoever
      // holds the code (checkPairingCode).
      ...(pairing.prepared ? {
        prepared: true,
        easyMode: pairing.prepared.easyMode,
        invitationExpiresAt: pairing.prepared.invitationExpiresAt,
      } : {}),
    };
  },
};

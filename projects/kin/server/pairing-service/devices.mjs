// PairingService devices: the device list, sync public keys and their
// signed transitions, and device revocation.
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalJson, id, PairingError, requireTrustAuthority } from "./shared.mjs";

export function validateSyncPublicKeys(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 2 ||
    !value.agreement ||
    !value.signing
  ) {
    throw new PairingError(
      "sync_device_key_invalid",
      "Kin could not verify this device's public keys.",
      400,
    );
  }
  try {
    for (const [name, key] of Object.entries(value)) {
      if (
        key.kty !== "EC" ||
        key.crv !== "P-256" ||
        typeof key.x !== "string" ||
        typeof key.y !== "string" ||
        "d" in key
      )
        throw new Error("invalid public key");
      if (createPublicKey({ key, format: "jwk" }).asymmetricKeyType !== "ec")
        throw new Error("invalid public key type");
      if (
        name === "signing" &&
        (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))
      )
        throw new Error("invalid signing usages");
    }
    const syncPublicKeys = structuredClone(value);
    return {
      syncPublicKeys,
      syncKeyFingerprint: createHash("sha256")
        .update(canonicalJson(syncPublicKeys))
        .digest("hex"),
    };
  } catch {
    throw new PairingError(
      "sync_device_key_invalid",
      "Kin could not verify this device's public keys.",
      400,
    );
  }
}

export function validateDeviceAuthorizationCertificate(certificate, expected) {
  try {
    if (
      !certificate ||
      certificate.version !== 1 ||
      certificate.householdId !== expected.householdId ||
      certificate.memberId !== expected.memberId ||
      certificate.deviceId !== expected.deviceId ||
      certificate.issuerDeviceId !== expected.approverDevice.id ||
      certificate.issuerFingerprint !==
        expected.approverDevice.syncKeyFingerprint ||
      certificate.fingerprint !== expected.claimantFingerprint ||
      canonicalJson(certificate.publicKeys) !==
        canonicalJson(expected.claimantPublicKeys) ||
      !/^[A-Za-z0-9_-]{86}$/.test(certificate.signature)
    )
      throw new Error("certificate fields do not match the pending enrollment");
    const { signature, ...unsigned } = certificate;
    const valid = verifySignature(
      "sha256",
      Buffer.from(canonicalJson(unsigned)),
      {
        key: createPublicKey({
          key: expected.approverDevice.syncPublicKeys.signing,
          format: "jwk",
        }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "base64url"),
    );
    if (!valid) throw new Error("certificate signature is invalid");
    return structuredClone(certificate);
  } catch {
    throw new PairingError(
      "device_certificate_invalid",
      "Kin could not verify this device approval.",
      400,
    );
  }
}

export const deviceMethods = {
  listDevices(sessionToken) {
    const { member, household } = this.authorize(sessionToken);
    requireTrustAuthority(member, "inspect trusted devices");
    return [...this.devices.values()]
      .filter((device) => device.householdId === household.id)
      .map(
        ({
          id,
          memberId,
          label,
          trustedAt,
          revokedAt,
          syncKeyFingerprint,
          carriedOver,
        }) => ({
          id,
          memberId,
          label,
          trustedAt,
          revokedAt,
          syncKeyFingerprint,
          carriedOver: carriedOver === true && !revokedAt,
        }),
      );
  },

  registerSyncPublicKeys(sessionToken, syncPublicKeys) {
    const { device } = this.authorize(sessionToken);
    const keyRecord = validateSyncPublicKeys(syncPublicKeys);
    if (device.syncPublicKeys) {
      if (device.syncKeyFingerprint !== keyRecord.syncKeyFingerprint)
        throw new PairingError(
          "sync_device_key_conflict",
          "This trusted device already has different sync keys.",
          409,
        );
      return { fingerprint: device.syncKeyFingerprint, registered: false };
    }
    Object.assign(device, keyRecord);
    this.persistHousehold(device.householdId);
    return { fingerprint: device.syncKeyFingerprint, registered: true };
  },

  transitionSyncPublicKeys(sessionToken, transition) {
    const { device, member, household } = this.authorize(sessionToken);
    const fail = () => { throw new PairingError("device_transition_invalid", "Kin could not verify this device key transition.", 409); };
    const t = transition;
    if (!t || t.version !== 1 || t.purpose !== "kin.sync.device-key-successor.v1" ||
        t.householdId !== household.id || t.memberId !== member.id || t.deviceId !== device.id ||
        !Number.isSafeInteger(t.generation) || t.generation < 1 || t.generation > 16 ||
        !/^[a-f0-9]{32}$/.test(t.transitionId) || !/^[A-Za-z0-9_-]{86}$/.test(t.signature) ||
        Buffer.from(t.signature, "base64url").toString("base64url") !== t.signature) fail();
    const transitions = device.syncKeyTransitions ?? [];
    const existing = transitions.find(value => value.transitionId === t.transitionId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(t)) fail();
      return { fingerprint: device.syncKeyFingerprint, generation: device.syncKeyGeneration, retried: true };
    }
    if (t.generation !== (device.syncKeyGeneration ?? 0) + 1 ||
        t.oldFingerprint !== device.syncKeyFingerprint || t.fingerprint === t.oldFingerprint) fail();
    const next = validateSyncPublicKeys(t.publicKeys);
    if (next.syncKeyFingerprint !== t.fingerprint) fail();
    const { signature, ...unsigned } = t;
    try {
      if (!verifySignature("sha256", Buffer.from(canonicalJson(unsigned)), {
        key: createPublicKey({ key: device.syncPublicKeys.signing, format: "jwk" }), dsaEncoding: "ieee-p1363",
      }, Buffer.from(signature, "base64url"))) fail();
    } catch { fail(); }
    device.syncKeyHistory ??= [{ publicKeys: structuredClone(device.syncPublicKeys), fingerprint: device.syncKeyFingerprint, generation: 0 }];
    device.syncKeyHistory.push({ publicKeys: structuredClone(t.publicKeys), fingerprint: t.fingerprint, generation: t.generation });
    device.syncKeyTransitions = [...transitions, structuredClone(t)];
    device.syncKeyGeneration = t.generation;
    Object.assign(device, next);
    this.persistHousehold(household.id);
    return { fingerprint: device.syncKeyFingerprint, generation: t.generation, retried: false };
  },

  deviceRevocationContext(sessionToken, deviceId) {
    const { member, household, device: actingDevice } = this.authorize(sessionToken);
    requireTrustAuthority(member, "revoke a trusted device");
    const target = this.devices.get(deviceId);
    if (!target || target.householdId !== household.id)
      throw new PairingError("not_found", "That device is unavailable.", 404);
    if (target.id === actingDevice.id)
      throw new PairingError("current_device", "Use another trusted device to revoke this device.", 409);
    if (target.memberId !== member.id)
      this.requireManagementAuthority(member, household, "revoke another member's device");
    if (!target.revokedAt) this.requireAdminAccessAfterRevocation(household, target.id);
    return { memberId: member.id, deviceId: actingDevice.id, credentialIds: [...member.credentials] };
  },

  // Devices carried over from the old address (ADR 0026 §6) that still
  // can't sign in here: marked at import, unrevoked and without a token.
  carriedOverDeviceIds(household, actingDeviceId) {
    return [...this.devices.values()]
      .filter((device) => device.householdId === household.id && device.id !== actingDeviceId &&
        device.carriedOver === true && !device.revokedAt && device.tokenHash === null)
      .map((device) => device.id);
  },

  carriedOverRevocationContext(sessionToken) {
    const { member, household, device: actingDevice } = this.authorize(sessionToken);
    this.requireManagementAuthority(member, household, "remove the devices from the old address");
    const deviceIds = this.carriedOverDeviceIds(household, actingDevice.id);
    if (!deviceIds.length)
      throw new PairingError("nothing_carried_over", "No devices from the old address are left to remove.", 409);
    this.requireAdminAccessAfterRevocation(household, deviceIds);
    return { memberId: member.id, deviceId: actingDevice.id, credentialIds: [...member.credentials], deviceIds };
  },

  // Revokes the devices confirmed at the options step that are still carried
  // over, all at one time. A device that re-joined meanwhile is left alone.
  // Returns the IDs it revoked.
  revokeCarriedOverDevices(sessionToken, deviceIds, reauthenticatedMemberId) {
    const { member, household, device: actingDevice } = this.authorize(sessionToken);
    this.requireManagementAuthority(member, household, "remove the devices from the old address");
    if (reauthenticatedMemberId !== member.id)
      throw new PairingError("fresh_auth_required", "Authenticate with your passkey again before revoking a device.", 401);
    const eligible = new Set(this.carriedOverDeviceIds(household, actingDevice.id));
    const ids = [...new Set(deviceIds)].filter((deviceId) => eligible.has(deviceId));
    // Saved even with nothing to remove: the confirmation raised the
    // passkey's verified signature counter, and that must outlast a restart.
    if (!ids.length) {
      this.persistHousehold(household.id);
      return [];
    }
    // Recheck at mutation time; state may have changed since the options step.
    this.requireAdminAccessAfterRevocation(household, ids);
    const now = this.now();
    for (const deviceId of ids) {
      const device = this.devices.get(deviceId);
      device.revokedAt = now;
      this.audit("device_revoked", { householdId: household.id, memberId: device.memberId, deviceId, reason: "carried_over" });
    }
    for (const [sessionHash, activeSession] of this.sessions)
      if (ids.includes(activeSession.deviceId)) this.sessions.delete(sessionHash);
    this.persistHousehold(household.id);
    return ids;
  },

  // An invitation is bound to its author. Once that member loses authority,
  // pending claims must not remain stranded or become approvable later.
  revokeInviterPairings(household, memberId, reason, include = () => true) {
    for (const pairing of this.pairings.values()) {
      if (
        pairing.householdId !== household.id ||
        pairing.inviterId !== memberId ||
        !["Pending", "Claimed"].includes(this.state(pairing)) ||
        !include(pairing)
      ) continue;
      pairing.state = "Revoked";
      pairing.terminalAt = this.now();
      pairing.version += 1;
      this.retireCode(pairing);
      for (const [claimHash, storedPairingId] of this.claimTokens)
        if (storedPairingId === pairing.id) this.claimTokens.delete(claimHash);
      this.audit("pairing_revoked", {
        householdId: household.id,
        pairingId: pairing.id,
        reason,
      });
    }
  },

  revokeDevice(sessionToken, deviceId, reauthenticatedMemberId) {
    const { member, household, device: actingDevice } = this.authorize(sessionToken);
    requireTrustAuthority(member, "revoke a trusted device");
    if (reauthenticatedMemberId !== member.id)
      throw new PairingError("fresh_auth_required", "Authenticate with your passkey again before revoking a device.", 401);
    const device = this.devices.get(deviceId);
    if (!device || device.householdId !== household.id)
      throw new PairingError("not_found", "That device is unavailable.", 404);
    if (device.id === actingDevice.id)
      throw new PairingError(
        "current_device",
        "Use another trusted device to revoke this device.",
        409,
      );
    if (device.memberId !== member.id)
      this.requireManagementAuthority(member, household, "revoke another member's device");
    if (!device.revokedAt) {
      // Recheck at mutation time; state may have changed since the options step.
      this.requireAdminAccessAfterRevocation(household, device.id);
      device.revokedAt = this.now();
      this.audit("device_revoked", {
        householdId: household.id,
        memberId: device.memberId,
        deviceId,
      });
    }
    for (const [sessionHash, activeSession] of this.sessions)
      if (activeSession.deviceId === device.id)
        this.sessions.delete(sessionHash);
    this.persistHousehold(household.id);
    return { id: device.id, revokedAt: device.revokedAt };
  },
};

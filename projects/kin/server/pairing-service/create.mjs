// PairingService, pairing stage 1: an adult creates a pairing (new member,
// new device, replacement device or member recovery) within household limits.
import {
  MAX_ACTIVE_ADULTS,
  MAX_ACTIVE_LIMITED_MEMBERS,
  MAX_ACTIVE_MEMBERS,
  MAX_TRUSTED_DEVICES,
} from "../identity-limits.mjs";
import {
  canParticipate,
  codeValue,
  MAX_PREPARED_INVITATIONS,
  PREPARED_DAY_MS,
  PREPARED_INVITATION_MAX_DAYS,
  preparedVerifier,
  validPreparedCard,
  id,
  isHouseholdAdmin,
  normalizeMemberKind,
  PAIRING_TTL_MS,
  PairingError,
  requireHouseholdAdmin,
  requireTrustAuthority,
} from "./shared.mjs";

export const createMethods = {
  activeMemberCount(household) {
    return [...household.members].filter((memberId) => {
      const member = this.members.get(memberId);
      return member && canParticipate(member, this.now());
    }).length;
  },

  activeTrustedDeviceCount(household) {
    return [...this.devices.values()].filter(
      (device) =>
        device.householdId === household.id &&
        !device.revokedAt &&
        this.members.get(device.memberId) &&
        canParticipate(this.members.get(device.memberId), this.now()),
    ).length;
  },

  activeKindCount(household, kind) {
    return [...household.members].filter((memberId) => {
      const candidate = this.members.get(memberId);
      return canParticipate(candidate, this.now()) && normalizeMemberKind(candidate.kind) === kind;
    }).length;
  },

  /** The checks every new-member invitation makes: a supported kind, an
   * expiry exactly for Temporary access, and room in the household. */
  checkAdmission(household, kind, expiresAt) {
    if (! ["adult", "limited", "temporary"].includes(kind))
      throw new PairingError("member_kind_invalid", "Choose a supported member type.");
    if (kind === "temporary" && (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()))
      throw new PairingError("temporary_expiry_required", "Temporary access needs a valid future expiry.");
    if (kind !== "temporary" && expiresAt !== undefined)
      throw new PairingError("temporary_expiry_unexpected", "Only temporary access can have an expiry.");
    this.prunePairingCapabilities();
    if (this.activeMemberCount(household) >= MAX_ACTIVE_MEMBERS ||
        kind === "adult" && this.activeKindCount(household, "adult") >= MAX_ACTIVE_ADULTS ||
        kind === "limited" && this.activeKindCount(household, "limited") >= MAX_ACTIVE_LIMITED_MEMBERS)
      throw new PairingError(
        "household_full",
        "This household has reached its member limit.",
        409,
      );
  },

  /** A fresh code whose verifier is unused in either form (ordinary codes
   * use the process secret, prepared ones a stable hash). */
  freshCode() {
    for (;;) {
      const code = codeValue();
      if (!this.codeIndex.has(this.verifier(code)) && !this.codeIndex.has(preparedVerifier(code))) return code;
    }
  },

  /** The pairing a typed or scanned code names, or undefined. */
  pairingByCode(code) {
    return this.pairings.get(this.codeIndex.get(this.verifier(code)) ?? this.codeIndex.get(preparedVerifier(code)));
  },

  /** A code stops working (claimed and approved, revoked, expired, ended
   * with the household): it leaves the index and, for a prepared
   * invitation, the service's database, so a restart can't bring it back. */
  retireCode(pairing) {
    this.codeIndex.delete(pairing.verifier);
    if (pairing.prepared) this.store?.deletePreparedInvitation?.(pairing.id);
  },

  createPairing(sessionToken, { kind = "adult", expiresAt } = {}) {
    const { member, household, device } = this.authorize(sessionToken);
    this.requireManagementAuthority(member, household, "invite a new household member");
    this.checkAdmission(household, kind, expiresAt);
    for (const pairing of this.pairings.values()) {
      if (
        pairing.householdId === household.id &&
        !pairing.prepared &&
        ["Pending", "Claimed"].includes(this.state(pairing))
      )
        this.revokePairing(sessionToken, pairing.id);
    }
    const code = this.freshCode();
    const verifier = this.verifier(code);
    const pairing = {
      id: id(),
      householdId: household.id,
      inviterId: member.id,
      admissionKind: kind,
      ...(kind === "temporary" ? { admissionExpiresAt: expiresAt } : {}),
      inviterDeviceId: device.id,
      inviterKeyFingerprint: device.syncKeyFingerprint,
      verifier,
      createdAt: this.now(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      state: "Pending",
      version: 1,
      attempts: 0,
      claimant: null,
      confirmedMemberId: null,
    };
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(verifier, pairing.id);
    this.audit("pairing_created", {
      householdId: household.id,
      pairingId: pairing.id,
      inviterDeviceId: device.id,
      inviterKeyFingerprint: device.syncKeyFingerprint,
    });
    // The inviting client checks this against its local key before showing
    // the code; it is the same value pairingView() returns to the inviter.
    return {
      pairingId: pairing.id,
      code,
      state: pairing.state,
      expiresAt: pairing.expiresAt,
      memberKind: pairing.admissionKind,
      inviterDeviceId: pairing.inviterDeviceId,
      inviterKeyFingerprint: pairing.inviterKeyFingerprint,
      version: pairing.version,
    };
  },

  /**
   * "Set up Kin for someone" (#613): an invitation an admin prepares for one
   * person, to hand over or post on a printed sheet. Like any new-member
   * invitation it is single-use and the inviter still approves the claim
   * after comparing fingerprints; it differs in lasting `days` (1 to 7),
   * surviving a restart, not ending other invitations, and carrying
   * `easyMode` (shown to whoever holds the code, who then starts in easy
   * mode) and `card`, sealed on the admin's device (the person's name, the
   * helper's name and a note) under a key that only the link's fragment
   * carries, so the service stores it but can't read it.
   */
  createPreparedPairing(sessionToken, { kind = "adult", expiresAt, easyMode = true, card = null, days = PREPARED_INVITATION_MAX_DAYS } = {}) {
    const { member, household, device } = this.authorize(sessionToken);
    this.requireManagementAuthority(member, household, "set up Kin for someone");
    if (!Number.isSafeInteger(days) || days < 1 || days > PREPARED_INVITATION_MAX_DAYS)
      throw new PairingError("prepared_expiry_invalid", `A prepared invitation lasts 1 to ${PREPARED_INVITATION_MAX_DAYS} days.`);
    if (typeof easyMode !== "boolean")
      throw new PairingError("prepared_invalid", "That invitation is invalid.");
    if (!validPreparedCard(card))
      throw new PairingError("prepared_card_invalid", "That invitation's details are invalid.");
    this.checkAdmission(household, kind, expiresAt);
    const waiting = [...this.pairings.values()].filter((pairing) => pairing.prepared &&
      pairing.householdId === household.id && ["Pending", "Claimed"].includes(this.state(pairing))).length;
    if (waiting >= MAX_PREPARED_INVITATIONS)
      throw new PairingError("prepared_limit", `At most ${MAX_PREPARED_INVITATIONS} prepared invitations can wait at once. Cancel one first.`, 409);
    const code = this.freshCode();
    const createdAt = this.now();
    const invitationExpiresAt = createdAt + days * PREPARED_DAY_MS;
    const pairing = {
      id: id(),
      householdId: household.id,
      inviterId: member.id,
      admissionKind: kind,
      ...(kind === "temporary" ? { admissionExpiresAt: expiresAt } : {}),
      inviterDeviceId: device.id,
      inviterKeyFingerprint: device.syncKeyFingerprint,
      verifier: preparedVerifier(code),
      prepared: { easyMode, card, invitationExpiresAt },
      createdAt,
      expiresAt: invitationExpiresAt,
      state: "Pending",
      version: 1,
      attempts: 0,
      claimant: null,
      confirmedMemberId: null,
    };
    this.store?.insertPreparedInvitation?.(preparedRow(pairing));
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(pairing.verifier, pairing.id);
    this.audit("prepared_invitation_created", {
      householdId: household.id,
      pairingId: pairing.id,
      inviterDeviceId: device.id,
      days,
    });
    return { ...this.pairingView(pairing), code };
  },

  /** The prepared invitations this member made that still wait (#613). */
  preparedPairings(sessionToken) {
    const { member, household } = this.authorize(sessionToken);
    requireTrustAuthority(member, "review a household invitation");
    this.prunePairingCapabilities();
    return [...this.pairings.values()]
      .filter((pairing) => pairing.prepared && pairing.householdId === household.id && pairing.inviterId === member.id &&
        ["Pending", "Claimed"].includes(this.state(pairing)))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((pairing) => this.pairingView(pairing));
  },

  /** Prepared invitations kept by the service, back in memory after a
   * restart. Claims are not kept (they are process-local, like every
   * pairing ceremony), so one that was claimed is Pending again. */
  restorePreparedPairings(rows) {
    for (const row of rows) {
      if (row.expiresAt <= this.now() || this.pairings.has(row.id) || this.codeIndex.has(row.verifier)) continue;
      this.pairings.set(row.id, {
        id: row.id,
        householdId: row.householdId,
        inviterId: row.inviterMemberId,
        admissionKind: row.memberKind,
        ...(row.memberKind === "temporary" ? { admissionExpiresAt: row.memberExpiresAt } : {}),
        inviterDeviceId: row.inviterDeviceId,
        inviterKeyFingerprint: row.inviterKeyFingerprint,
        verifier: row.verifier,
        prepared: { easyMode: row.easyMode, card: row.card, invitationExpiresAt: row.expiresAt },
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        state: "Pending",
        version: 1,
        attempts: 0,
        claimant: null,
        confirmedMemberId: null,
      });
      this.codeIndex.set(row.verifier, row.id);
    }
  },

  createDevicePairing(sessionToken) {
    const { member, household, device } = this.authorize(sessionToken);
    requireTrustAuthority(member, "manage this device");
    this.prunePairingCapabilities();
    if (this.activeTrustedDeviceCount(household) >= MAX_TRUSTED_DEVICES)
      throw new PairingError(
        "device_limit",
        "This household reached its trusted-device limit.",
        409,
      );
    for (const pairing of this.pairings.values()) {
      if (
        pairing.householdId === household.id &&
        !pairing.prepared &&
        ["Pending", "Claimed"].includes(this.state(pairing))
      )
        this.revokePairing(sessionToken, pairing.id);
    }
    const code = this.freshCode();
    const verifier = this.verifier(code);
    const pairing = {
      id: id(),
      purpose: "device",
      householdId: household.id,
      inviterId: member.id,
      inviterDeviceId: device.id,
      inviterKeyFingerprint: device.syncKeyFingerprint,
      memberId: member.id,
      verifier,
      createdAt: this.now(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      state: "Pending",
      version: 1,
      attempts: 0,
      claimant: null,
      confirmedMemberId: null,
    };
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(verifier, pairing.id);
    this.audit("device_pairing_created", {
      householdId: household.id,
      pairingId: pairing.id,
      inviterDeviceId: device.id,
      inviterKeyFingerprint: device.syncKeyFingerprint,
      memberId: member.id,
    });
    return {
      pairingId: pairing.id,
      code,
      purpose: pairing.purpose,
      state: pairing.state,
      expiresAt: pairing.expiresAt,
      inviterDeviceId: pairing.inviterDeviceId,
      inviterKeyFingerprint: pairing.inviterKeyFingerprint,
      version: pairing.version,
    };
  },

  createReplacementPairing(sessionToken, lostDeviceId) {
    const { member, household, device: approverDevice } =
      this.authorize(sessionToken);
    requireTrustAuthority(member, "replace a trusted device");
    this.prunePairingCapabilities();
    const lostDevice = this.devices.get(lostDeviceId);
    if (
      !lostDevice ||
      lostDevice.householdId !== household.id ||
      lostDevice.memberId !== member.id ||
      lostDevice.id === approverDevice.id ||
      lostDevice.revokedAt
    )
      throw new PairingError(
        "replacement_unavailable",
        "That device cannot be replaced from this trusted device.",
        404,
      );
    for (const pairing of this.pairings.values())
      if (
        pairing.householdId === household.id &&
        !pairing.prepared &&
        ["Pending", "Claimed"].includes(this.state(pairing))
      )
        this.revokePairing(sessionToken, pairing.id);
    const code = this.freshCode();
    const verifier = this.verifier(code);
    const pairing = {
      id: id(),
      purpose: "replacement",
      householdId: household.id,
      inviterId: member.id,
      inviterDeviceId: approverDevice.id,
      inviterKeyFingerprint: approverDevice.syncKeyFingerprint,
      memberId: member.id,
      lostDeviceId,
      verifier,
      createdAt: this.now(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      state: "Pending",
      version: 1,
      attempts: 0,
      claimant: null,
      confirmedMemberId: null,
    };
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(verifier, pairing.id);
    this.audit("device_replacement_created", {
      householdId: household.id,
      pairingId: pairing.id,
      memberId: member.id,
      lostDeviceId,
      approverDeviceId: approverDevice.id,
    });
    return {
      pairingId: pairing.id,
      code,
      purpose: pairing.purpose,
      state: pairing.state,
      expiresAt: pairing.expiresAt,
      version: pairing.version,
    };
  },

  createMemberRecoveryPairing(sessionToken, targetMemberId) {
    const { member: approver, household, device: approverDevice } =
      this.authorize(sessionToken);
    requireTrustAuthority(approver, "approve member recovery");
    this.prunePairingCapabilities();
    const target = this.members.get(targetMemberId);
    // Recovery issues a device for the target member, so recovering an admin
    // must not let a non-admin Adult acquire admin authority.
    if (isHouseholdAdmin(target, this.now()))
      requireHouseholdAdmin(approver, "recover a household admin", this.now());
    if (
      !target ||
      target.householdId !== household.id ||
      !target.active ||
      target.id === approver.id
    )
      throw new PairingError(
        "recovery_unavailable",
        "That household member cannot use assisted recovery.",
        404,
      );
    for (const pairing of this.pairings.values())
      if (
        pairing.householdId === household.id &&
        !pairing.prepared &&
        ["Pending", "Claimed"].includes(this.state(pairing))
      )
        this.revokePairing(sessionToken, pairing.id);
    const code = this.freshCode();
    const verifier = this.verifier(code);
    const pairing = {
      id: id(),
      purpose: "member-recovery",
      householdId: household.id,
      inviterId: approver.id,
      inviterDeviceId: approverDevice.id,
      inviterKeyFingerprint: approverDevice.syncKeyFingerprint,
      memberId: target.id,
      verifier,
      createdAt: this.now(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      state: "Pending",
      version: 1,
      attempts: 0,
      claimant: null,
      confirmedMemberId: null,
    };
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(verifier, pairing.id);
    this.audit("member_recovery_created", {
      householdId: household.id,
      pairingId: pairing.id,
      approverMemberId: approver.id,
      targetMemberId: target.id,
      approverDeviceId: approverDevice.id,
    });
    return {
      pairingId: pairing.id,
      code,
      purpose: pairing.purpose,
      targetMemberId: target.id,
      state: pairing.state,
      expiresAt: pairing.expiresAt,
      version: pairing.version,
    };
  },

  expireHouseholdPairings(householdId) {
    for (const [pairingId, pairing] of this.pairings)
      if (pairing.householdId === householdId) {
        this.retireCode(pairing);
        for (const [claimHash, storedPairingId] of this.claimTokens)
          if (storedPairingId === pairingId) this.claimTokens.delete(claimHash);
        this.pairings.delete(pairingId);
      }
  },
};

/** The durable row for a prepared invitation (durable-store/prepared-invitations.mjs). */
export function preparedRow(pairing) {
  return {
    id: pairing.id,
    householdId: pairing.householdId,
    inviterMemberId: pairing.inviterId,
    inviterDeviceId: pairing.inviterDeviceId,
    inviterKeyFingerprint: pairing.inviterKeyFingerprint ?? null,
    verifier: pairing.verifier,
    memberKind: pairing.admissionKind,
    memberExpiresAt: pairing.admissionExpiresAt ?? null,
    easyMode: pairing.prepared.easyMode,
    card: pairing.prepared.card,
    createdAt: pairing.createdAt,
    expiresAt: pairing.prepared.invitationExpiresAt,
  };
}

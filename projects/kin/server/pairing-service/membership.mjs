// PairingService membership: who may manage the household, leaving,
// removing another adult, the household admin, and Temporary expiry.
import {
  CHAT_ACCESS,
  canManageTrust,
  canParticipate,
  boardPolicyOf,
  chatPolicyOf,
  choreChartOf,
  featuresOf,
  KNOWN_FEATURE_MASK,
  privatePolicyOf,
  isHouseholdAdmin,
  normalizeMemberKind,
  PairingError,
  requireHouseholdAdmin,
  requireTrustAuthority,
} from "./shared.mjs";

export const membershipMethods = {
  hasHouseholdAdmin(household) {
    return [...household.members].some((memberId) =>
      isHouseholdAdmin(this.members.get(memberId), this.now()),
    );
  },

  // Households that predate household admins keep Adult-level management
  // until an admin is recorded; Kin never infers one from existing members.
  canManageMembers(member, household) {
    return this.hasHouseholdAdmin(household)
      ? isHouseholdAdmin(member, this.now())
      : canManageTrust(member, this.now());
  },

  requireManagementAuthority(member, household, action) {
    if (this.hasHouseholdAdmin(household))
      requireHouseholdAdmin(member, action, this.now());
    else requireTrustAuthority(member, action, this.now());
  },

  expireTemporaryMemberships(now = this.now()) {
    const expired = [];
    for (const member of this.members.values()) {
      if (member.active !== true || normalizeMemberKind(member.kind) !== "temporary" ||
          !Number.isSafeInteger(member.expiresAt) || member.expiresAt > now) continue;
      const household = this.households.get(member.householdId);
      if (!household) continue;
      member.active = false;
      member.memberStatus = "expired";
      household.version += 1;
      const deviceIds = [];
      for (const device of this.devices.values())
        if (device.memberId === member.id && !device.revokedAt) {
          device.revokedAt = now;
          deviceIds.push(device.id);
        }
      for (const [sessionHash, session] of this.sessions)
        if (session.memberId === member.id) this.sessions.delete(sessionHash);
      this.audit("temporary_access_expired", { householdId: household.id, memberId: member.id });
      this.persistHousehold(household.id);
      expired.push({ householdId: household.id, memberId: member.id, deviceIds });
    }
    return expired;
  },

  householdView(sessionToken) {
    const { member, household } = this.authorize(sessionToken);
    return {
      householdId: household.id,
      currentMemberId: member.id,
      adminRecorded: this.hasHouseholdAdmin(household),
      canManageMembers: this.canManageMembers(member, household),
      members: [...household.members].map((memberId) => ({
        id: memberId,
        current: memberId === member.id,
        active: canParticipate(this.members.get(memberId), this.now()),
        kind: normalizeMemberKind(this.members.get(memberId)?.kind),
        admin: isHouseholdAdmin(this.members.get(memberId), this.now()),
        // Simple view (#343, ADR 0013): a layout, reported for Limited members.
        ...(normalizeMemberKind(this.members.get(memberId)?.kind) === "limited" ? { simpleView: this.members.get(memberId)?.simpleView === true } : {}),
        ...(this.members.get(memberId)?.expiresAt == null ? {} : { expiresAt: this.members.get(memberId).expiresAt }),
      })),
    };
  },

  leaveHousehold(sessionToken, reauthenticatedMemberId) {
    const { member, household } = this.authorize(sessionToken);
    if (reauthenticatedMemberId !== member.id)
      throw new PairingError(
        "fresh_auth_required",
        "Authenticate with your passkey again before leaving the household.",
        401,
      );
    if (!canParticipate(member, this.now()))
      throw new PairingError(
        "membership_not_active",
        "This household member is no longer active.",
        403,
      );
    const hasTrustedAdult = this.hasOtherUsableTrustedAdult(household, member.id);
    if (!hasTrustedAdult)
      throw new PairingError(
        "last_adult",
        "The only active trusted adult cannot leave. Household deletion and recovery are not available.",
        409,
      );
    if (isHouseholdAdmin(member, this.now()) && !this.hasOtherUsableAdmin(household, member.id))
      throw new PairingError(
        "last_household_admin",
        "Make another Adult a household admin before leaving.",
        409,
      );
    return this.removeMembership(household, member.id, member.id);
  },

  removalContext(sessionToken, memberId, { allowSelf = false } = {}) {
    const { member, household, device } = this.authorize(sessionToken);
    if (memberId !== member.id)
      this.requireManagementAuthority(member, household, "remove a household member");
    if (memberId === member.id && !allowSelf)
      throw new PairingError(
        "use_leave",
        "Use Leave household to remove your own membership.",
        409,
      );
    if (!household.members.has(memberId) || !this.members.get(memberId)?.active)
      throw new PairingError(
        "not_found",
        "That household member is unavailable.",
        404,
      );
    return {
      memberId: member.id,
      deviceId: device.id,
      credentialIds: [...member.credentials],
    };
  },

  removeOtherAdult(sessionToken, memberId, reauthenticatedMemberId) {
    const context = this.removalContext(sessionToken, memberId);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError(
        "fresh_auth_required",
        "Authenticate with your passkey again before removing a household member.",
        401,
      );
    const household = this.households.get(
      this.members.get(context.memberId).householdId,
    );
    const target = this.members.get(memberId);
    if (canManageTrust(target, this.now()) && !this.hasOtherUsableTrustedAdult(household, memberId))
      throw new PairingError("last_adult", "Keep another Adult with a usable trusted device and passkey before removing this Adult.", 409);
    if (isHouseholdAdmin(target, this.now()) && !this.hasOtherUsableAdmin(household, memberId))
      throw new PairingError("last_household_admin", "Keep another household admin with a usable trusted device and passkey before removing this admin.", 409);
    return this.removeMembership(household, memberId, context.memberId);
  },

  householdAdminContext(sessionToken, memberId) {
    const { member, household, device } = this.authorize(sessionToken);
    requireHouseholdAdmin(member, "change household admins", this.now());
    const target = this.members.get(memberId);
    if (!target || target.householdId !== household.id || !canParticipate(target, this.now()))
      throw new PairingError("not_found", "That household member is unavailable.", 404);
    if (normalizeMemberKind(target.kind) !== "adult")
      throw new PairingError("household_admin_adult_required", "Only Adults can be household admins.", 409);
    return {
      memberId: member.id,
      deviceId: device.id,
      credentialIds: [...member.credentials],
    };
  },

  setHouseholdAdmin(sessionToken, memberId, admin, reauthenticatedMemberId) {
    if (typeof admin !== "boolean")
      throw new PairingError("household_admin_invalid", "Choose whether this Adult is a household admin.");
    const context = this.householdAdminContext(sessionToken, memberId);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError(
        "fresh_auth_required",
        "Authenticate with your passkey again before changing household admins.",
        401,
      );
    const target = this.members.get(memberId);
    const household = this.households.get(target.householdId);
    if (isHouseholdAdmin(target, this.now()) === admin)
      return { memberId, admin, changed: false };
    if (!admin && !this.hasOtherUsableAdmin(household, memberId))
      throw new PairingError(
        "last_household_admin",
        "Make another Adult a household admin before removing this admin.",
        409,
      );
    if (admin) target.householdAdmin = true;
    else {
      delete target.householdAdmin;
      // A demoted admin loses the invitations and member recoveries they
      // started; their own device pairings stay theirs.
      this.revokeInviterPairings(household, memberId, "admin_revoked",
        (pairing) => !pairing.purpose || pairing.purpose === "member-recovery");
    }
    household.version += 1;
    this.audit(admin ? "household_admin_granted" : "household_admin_revoked", {
      householdId: household.id,
      memberId,
      actorId: context.memberId,
    });
    this.persistHousehold(household.id);
    return { memberId, admin, changed: true };
  },

  // Simple view (#343, ADR 0013): an admin, with a fresh passkey, turns a
  // calmer layout on or off for one active Limited member. It hides the rest
  // of Kin on that member's devices; it is not a permission.
  simpleViewContext(sessionToken, memberId) {
    const { member, household, device } = this.authorize(sessionToken);
    requireHouseholdAdmin(member, "change Simple view", this.now());
    const target = this.members.get(memberId);
    if (!target || target.householdId !== household.id || !canParticipate(target, this.now()))
      throw new PairingError("not_found", "That household member is unavailable.", 404);
    if (normalizeMemberKind(target.kind) !== "limited")
      throw new PairingError("simple_view_limited_required", "Simple view is for children and other Limited members.", 409);
    return { memberId: member.id, deviceId: device.id, credentialIds: [...member.credentials] };
  },

  setSimpleView(sessionToken, memberId, simpleView, reauthenticatedMemberId) {
    if (typeof simpleView !== "boolean")
      throw new PairingError("simple_view_invalid", "Choose whether Simple view is on.");
    const context = this.simpleViewContext(sessionToken, memberId);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError("fresh_auth_required", "Authenticate with your passkey again before changing Simple view.", 401);
    const target = this.members.get(memberId);
    const household = this.households.get(target.householdId);
    if ((target.simpleView === true) === simpleView) return { memberId, simpleView, changed: false };
    if (simpleView) target.simpleView = true;
    else delete target.simpleView;
    household.version += 1;
    this.audit(simpleView ? "simple_view_on" : "simple_view_off", { householdId: household.id, memberId, actorId: context.memberId });
    this.persistHousehold(household.id);
    return { memberId, simpleView, changed: true };
  },

  // Chat access policy (#123): admin only, fresh passkey. Legacy households
  // with no admin fail closed and keep the default (everyone posts).
  chatPolicyContext(sessionToken) {
    const { member, household, device } = this.authorize(sessionToken);
    requireHouseholdAdmin(member, "change who can chat", this.now());
    return { memberId: member.id, deviceId: device.id, householdId: household.id, credentialIds: [...member.credentials] };
  },

  setChatPolicy(sessionToken, policy, reauthenticatedMemberId) {
    if (!CHAT_ACCESS.includes(policy?.limited) || !CHAT_ACCESS.includes(policy?.temporary))
      throw new PairingError("chat_policy_invalid", "Choose read and post, read only or no access for each group.");
    const context = this.chatPolicyContext(sessionToken);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError("fresh_auth_required", "Authenticate with your passkey again before changing who can chat.", 401);
    const household = this.households.get(context.householdId);
    const current = chatPolicyOf(household);
    if (current.limited === policy.limited && current.temporary === policy.temporary)
      return { ...current, changed: false };
    household.chatPolicy = { limited: policy.limited, temporary: policy.temporary, revision: current.revision + 1 };
    household.version += 1;
    this.audit("chat_policy_changed", {
      householdId: household.id, actorId: context.memberId,
      limited: policy.limited, temporary: policy.temporary, revision: household.chatPolicy.revision,
    });
    this.persistHousehold(household.id);
    return { ...household.chatPolicy, changed: true };
  },

  // Fridge access policy (#317, ADR 0011): admin only, fresh passkey, like
  // the chat policy. Legacy households with no admin keep the default.
  boardPolicyContext(sessionToken) {
    const { member, household, device } = this.authorize(sessionToken);
    requireHouseholdAdmin(member, "change who can use the fridge", this.now());
    return { memberId: member.id, deviceId: device.id, householdId: household.id, credentialIds: [...member.credentials] };
  },

  setBoardPolicy(sessionToken, policy, reauthenticatedMemberId) {
    if (!CHAT_ACCESS.includes(policy?.limited) || !CHAT_ACCESS.includes(policy?.temporary))
      throw new PairingError("board_policy_invalid", "Choose draw, look only or no access for each group.");
    const context = this.boardPolicyContext(sessionToken);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError("fresh_auth_required", "Authenticate with your passkey again before changing who can use the fridge.", 401);
    const household = this.households.get(context.householdId);
    const current = boardPolicyOf(household);
    if (current.limited === policy.limited && current.temporary === policy.temporary)
      return { ...current, changed: false };
    household.boardPolicy = { limited: policy.limited, temporary: policy.temporary, revision: current.revision + 1 };
    household.version += 1;
    this.audit("board_policy_changed", {
      householdId: household.id, actorId: context.memberId,
      limited: policy.limited, temporary: policy.temporary, revision: household.boardPolicy.revision,
    });
    this.persistHousehold(household.id);
    return { ...household.boardPolicy, changed: true };
  },

  // Private storage for Limited members (ADR 0019): admin only, fresh
  // passkey, like the chat policy. Off means the service refuses Limited
  // members' private streams; nobody can read them either way.
  privatePolicyContext(sessionToken) {
    const { member, household, device } = this.authorize(sessionToken);
    requireHouseholdAdmin(member, "change private storage for children and teens", this.now());
    return { memberId: member.id, deviceId: device.id, householdId: household.id, credentialIds: [...member.credentials] };
  },

  setPrivatePolicy(sessionToken, policy, reauthenticatedMemberId) {
    if (typeof policy?.limited !== "boolean")
      throw new PairingError("private_policy_invalid", "Choose whether children and teens have private storage.");
    const context = this.privatePolicyContext(sessionToken);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError("fresh_auth_required", "Authenticate with your passkey again before changing private storage.", 401);
    const household = this.households.get(context.householdId);
    const current = privatePolicyOf(household);
    if (current.limited === policy.limited) return { ...current, changed: false };
    household.privatePolicy = { limited: policy.limited, revision: current.revision + 1 };
    household.version += 1;
    this.audit("private_policy_changed", {
      householdId: household.id, actorId: context.memberId,
      limited: policy.limited, revision: household.privatePolicy.revision,
    });
    this.persistHousehold(household.id);
    return { ...household.privatePolicy, changed: true };
  },

  // Household features (ADR 0021 §2, #624): admin only, fresh passkey (or
  // password for an admin without one), like the policies above. The change
  // names the revision it was made from, so two admins can't overwrite each
  // other's choice unseen.
  featuresContext(sessionToken) {
    const { member, household, device } = this.authorize(sessionToken);
    requireHouseholdAdmin(member, "turn household features on or off", this.now());
    return { memberId: member.id, deviceId: device.id, householdId: household.id, credentialIds: [...member.credentials] };
  },

  /** Throws unless `change` is `{ off, expectedRevision }` with only known
   * feature bits, and the revision is the household's current one. */
  checkFeatureChange(household, change) {
    const { off, expectedRevision } = change ?? {};
    // Bitwise operators see 32 bits; the range check catches larger values.
    if (!Number.isSafeInteger(off) || off < 0 || (off & ~KNOWN_FEATURE_MASK) !== 0 || off > KNOWN_FEATURE_MASK ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new PairingError("features_invalid", "Choose which features are on.");
    if (featuresOf(household).revision !== expectedRevision)
      throw new PairingError("features_stale", "Household features changed on another device. Look again and try once more.", 409);
  },

  setFeatures(sessionToken, change, reauthenticatedMemberId) {
    const context = this.featuresContext(sessionToken);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError("fresh_auth_required", "Authenticate again before turning household features on or off.", 401);
    const household = this.households.get(context.householdId);
    this.checkFeatureChange(household, change);
    const current = featuresOf(household);
    if (current.off === change.off) return { ...current, changed: false };
    household.features = { off: change.off, revision: current.revision + 1 };
    household.version += 1;
    this.audit("household_features_changed", {
      householdId: household.id, actorId: context.memberId, off: change.off, revision: household.features.revision,
    });
    this.persistHousehold(household.id);
    return { ...household.features, changed: true };
  },

  // Adults on the chore chart (ADR 0022 §6, #676): a service setting changed
  // like household features — admin only, fresh passkey or password, with
  // the revision it was made from.
  choreChartContext(sessionToken) {
    const { member, household, device } = this.authorize(sessionToken);
    requireHouseholdAdmin(member, "choose whether adults can join the chore chart", this.now());
    return { memberId: member.id, deviceId: device.id, householdId: household.id, credentialIds: [...member.credentials] };
  },

  /** Throws unless `change` is `{ adults, expectedRevision }` with a boolean
   * and the household's current revision. */
  checkChoreChartChange(household, change) {
    const { adults, expectedRevision } = change ?? {};
    if (typeof adults !== "boolean" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new PairingError("chore_chart_invalid", "Choose whether adults can join the chore chart.");
    if (choreChartOf(household).revision !== expectedRevision)
      throw new PairingError("chore_chart_stale", "The chore chart setting changed on another device. Look again and try once more.", 409);
  },

  setChoreChart(sessionToken, change, reauthenticatedMemberId) {
    const context = this.choreChartContext(sessionToken);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError("fresh_auth_required", "Authenticate again before changing the chore chart setting.", 401);
    const household = this.households.get(context.householdId);
    this.checkChoreChartChange(household, change);
    const current = choreChartOf(household);
    if (current.adults === change.adults) return { ...current, changed: false };
    household.choreChart = { adults: change.adults, revision: current.revision + 1 };
    household.version += 1;
    this.audit("chore_chart_adults_changed", {
      householdId: household.id, actorId: context.memberId, adults: change.adults, revision: household.choreChart.revision,
    });
    this.persistHousehold(household.id);
    return { ...household.choreChart, changed: true };
  },

  // A usable device is unrevoked and can sign in here. One carried over from
  // the old address (ADR 0026 §6) has no token until it re-joins, so it
  // doesn't count (#778).
  canSignInHere(device) {
    return !device.revokedAt && (device.carriedOver !== true || Boolean(device.tokenHash));
  },

  hasUsableTrustedDevice(memberId) {
    return [...this.devices.values()].some((device) =>
      device.memberId === memberId && this.canSignInHere(device),
    );
  },

  hasOtherUsableAdmin(household, excludingMemberId) {
    return [...household.members].some((memberId) => {
      if (memberId === excludingMemberId) return false;
      const other = this.members.get(memberId);
      return isHouseholdAdmin(other, this.now()) &&
        this.canConfirmFreshly(other) && this.hasUsableTrustedDevice(other.id);
    });
  },

  // Usable admin access needs a recorded admin who can confirm freshly (a
  // passkey, or a password until they add one, #558) and an unrevoked
  // trusted device that can sign in here; the admin flag alone is not enough.
  hasUsableAdminAccess(household, excludingDeviceIds = []) {
    return [...household.members].some((memberId) => {
      const admin = this.members.get(memberId);
      return isHouseholdAdmin(admin, this.now()) && this.canConfirmFreshly(admin) &&
        [...this.devices.values()].some((device) =>
          device.memberId === memberId && this.canSignInHere(device) &&
          !excludingDeviceIds.includes(device.id));
    });
  },

  // A household that records admins must keep one who can still act.
  // Legacy households without an admin are unaffected. Takes one device ID
  // or several. Only a revocation that takes the last usable admin access
  // away is refused: right after a move no admin may have re-joined yet, and
  // other devices can still be revoked then (#778).
  requireAdminAccessAfterRevocation(household, deviceIds) {
    if (this.hasHouseholdAdmin(household) && this.hasUsableAdminAccess(household) &&
      !this.hasUsableAdminAccess(household, [deviceIds].flat()))
      throw new PairingError(
        "last_household_admin",
        "Keep a household admin with a usable trusted device and passkey before revoking this device.",
        409,
      );
  },

  hasOtherUsableTrustedAdult(household, excludingMemberId) {
    return [...household.members].some((memberId) => {
      if (memberId === excludingMemberId) return false;
      const other = this.members.get(memberId);
      return other?.active && canManageTrust(other, this.now()) &&
        this.canConfirmFreshly(other) && this.hasUsableTrustedDevice(other.id);
    });
  },

  removeMembership(household, memberId, actorId) {
    const target = this.members.get(memberId);
    this.revokeInviterPairings(household, memberId, "inviter_removed");
    target.active = false;
    target.memberStatus = "removed";
    household.version += 1;
    for (const device of this.devices.values())
      if (device.memberId === memberId && !device.revokedAt) {
        device.revokedAt = this.now();
        this.audit("device_revoked", {
          householdId: household.id,
          memberId,
          deviceId: device.id,
        });
      }
    for (const [sessionHash, session] of this.sessions)
      if (session.memberId === memberId) this.sessions.delete(sessionHash);
    this.audit("membership_removed", {
      householdId: household.id,
      memberId,
      actorId,
    });
    // Their sign-in and account vault go with them (ADR 0018/0019): the
    // username can be chosen again, and the service keeps no verifier,
    // vault or wrappers for someone who is no longer a member. Copies on
    // their own devices stay, as for household data.
    delete target.username;
    delete target.password;
    this.onAccountRemoved?.(household.id, memberId);
    this.persistHousehold(household.id);
    // Their private stream goes with them (ADR 0019); copies on their own
    // devices stay, as for household data.
    this.onMemberRemoved?.(household.id, memberId);
    return { memberId, removed: true };
  },
};

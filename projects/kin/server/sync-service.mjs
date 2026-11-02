import { createHash, randomBytes } from "node:crypto";
import { DurableConflictError, MAX_ATTACHMENT_BYTES, MAX_HOUSEHOLD_ALBUM_ATTACHMENTS, MAX_HOUSEHOLD_ALBUM_BYTES, MAX_HOUSEHOLD_ATTACHMENT_BYTES, MAX_HOUSEHOLD_ATTACHMENTS, isAlbumAttachmentId } from "./durable-store.mjs";
import { boardAccess, boardPolicyOf, canManageTrust, canParticipate, chatAccess, chatPolicyOf, choreChartOf, featuresOf, isHouseholdAdmin, PairingError, privatePolicyOf, requireTrustAuthority } from "./pairing-service.mjs";
import { INSTALL_ICONS, installContentTag, installIconUrl, validateInstallIdentity } from "./install-identity.mjs";
import {
  canonicalEventEnvelope,
  canonicalJson,
  isEventEnvelopeValid,
  isProvisioningPackageValid,
  isSyncId,
  MAX_BINDINGS,
  MAX_HOUSEHOLD_EVENTS,
  MAX_KEY_EPOCHS,
  MAX_LOGICAL_TIME_ADVANCE,
  MAX_ROTATION_PACKAGES,
} from "./sync-contract.mjs";

export const MAX_EVENTS_PER_BATCH = 20;
const MAX_REQUEST_BYTES = 200_000;
const MAX_PROVISIONING_GRANTS = 128;
const MAX_PROVISIONING_BATCH = 20;
const MAX_COMMITTED_ROTATION_GRANTS = MAX_KEY_EPOCHS * MAX_ROTATION_PACKAGES;
const MAX_SYNC_RATE_BUCKETS = 4096;
const SYNC_RATE_WINDOW_MS = 60_000;
const SYNC_RATE_LIMIT = 256;
const GRANT_TTL_MS = 10 * 60_000;
const MAX_CURSOR = 100_000_000;

export class EncryptedSyncService {
  constructor(pairingService, { now = () => Date.now(), store } = {}) {
    this.pairingService = pairingService;
    this.now = now;
    this.store = store;
    this.households = new Map();
    this.rateBuckets = new Map();
    this.attachments = new Map();
  }

  /**
   * Tells a household's connected devices (but `exceptDeviceId`) to sync now
   * over the live channel (#107/#108), for changes that aren't events: keys,
   * provisioning grants, bindings and rotations. Deferred past the current
   * request, so it never runs before the change it announces commits.
   */
  hintHousehold(householdId, exceptDeviceId = null) {
    if (!this.liveService) return;
    setImmediate(() => {
      try { this.liveService?.eventsAccepted(householdId, exceptDeviceId); } catch { /* best effort */ }
    });
  }

  /** The admin changed who can chat: members online learn it now, and the
   * chat signals they may no longer see stop. */
  chatPolicyChanged(householdId) {
    this.liveService?.revalidate(householdId);
    this.hintHousehold(householdId);
  }

  forgetHousehold(householdId) {
    this.households.delete(householdId);
    this.pushService?.removeUntrusted(householdId);
    this.chatBlobService?.forgetHousehold(householdId);
    this.chatRelayService?.forgetHousehold(householdId);
    this.boardRelayService?.forgetHousehold(householdId);
    this.privateRelayService?.forgetHousehold(householdId);
    this.privateBlobService?.forgetHousehold(householdId);
    this.calendarSyncService?.forgetHousehold(householdId);
    this.feedbackService?.forgetHousehold(householdId);
    this.liveService?.revalidate(householdId);
  }

  status(sessionToken) {
    const auth = this.authorize(sessionToken);
    const state = this.state(auth.household.id);
    const policy = chatPolicyOf(auth.household);
    return {
      memberKind: auth.member.kind ?? "adult",
      // Simple view (#343, ADR 0013): this member's layout, Limited only.
      simpleView: (auth.member.kind ?? "adult") === "limited" && auth.member.simpleView === true,
      ...(auth.member.expiresAt == null ? {} : { memberExpiresAt: auth.member.expiresAt }),
      // Chat access (#123): this member's own, and the policy for an admin.
      chat: {
        access: chatAccess(auth.member, auth.household, this.now()),
        policyRevision: policy.revision,
        key: this.chatRelayService?.keySummary(auth) ?? { epoch: 0, pending: false, action: null, held: 0, since: 0, lost: [] },
        ...(isHouseholdAdmin(auth.member, this.now()) ? { policy: { limited: policy.limited, temporary: policy.temporary } } : {}),
      },
      // The fridge (#323): this member's own access, and the policy for an admin.
      board: {
        access: boardAccess(auth.member, auth.household, this.now()),
        ...(isHouseholdAdmin(auth.member, this.now()) ? { policy: (({ limited, temporary }) => ({ limited, temporary }))(boardPolicyOf(auth.household)) } : {}),
      },
      // Private storage (#491, ADR 0019): whether this member may have a
      // private stream, and the Limited setting for an admin.
      private: this.privateRelayService?.summary(auth) ?? { access: "none" },
      // Household features (ADR 0021 §2): the switched-off set every member's
      // devices hide, its revision, and whether this member may change it.
      features: { ...featuresOf(auth.household), admin: isHouseholdAdmin(auth.member, this.now()) },
      // The chore chart (ADR 0022 §6, #676): whether an admin allows adults
      // to join, its revision, and whether this member may change it.
      choreChart: { ...choreChartOf(auth.household), admin: isHouseholdAdmin(auth.member, this.now()) },
      currentEpoch: state.currentEpoch,
      enabled: state.enabled,
      rotationPending: state.rotationPending,
      pendingEpoch: state.rotationPending ? state.currentEpoch + 1 : null,
      lastRotationProposalId: state.lastRotation?.proposalId ?? null,
      latestCursor: encodeCursor(state.nextSequence - 1),
      eventCount: state.eventCount,
      acceptance: this.store ? "durable" : "process-local",
    };
  }

  deviceDirectory(sessionToken) {
    const { household } = this.authorize(sessionToken);
    return [...this.pairingService.devices.values()]
      .filter((device) => device.householdId === household.id)
      .map((device) => {
        const member = this.pairingService.members.get(device.memberId);
        return {
          householdId: household.id,
          deviceId: device.id,
          memberId: device.memberId,
          memberKind: member?.kind ?? "adult",
          memberActive: canParticipate(member, this.now()),
          ...(member?.expiresAt == null ? {} : { memberExpiresAt: member.expiresAt }),
          // Chat (#111): whose removals count as an admin's, by the same
          // rule the service uses to let them delete others' content.
          householdAdmin: Boolean(member && isHouseholdAdmin(member, this.now())),
          // Chat (#130): whether this member can read chat under the admin's
          // policy ("none", "read" or "write"), for who can be mentioned.
          chatAccess: member ? chatAccess(member, household, this.now()) : "none",
          publicKeys: device.syncPublicKeys ?? null,
          fingerprint: device.syncKeyFingerprint ?? null,
          certificate: device.deviceAuthorizationCertificate ?? null,
          keyHistory: device.syncKeyHistory ?? undefined,
          keyTransitions: device.syncKeyTransitions ?? [],
          revokedAt: device.revokedAt,
          historyFromEpoch: device.syncHistoryFromEpoch ?? 1,
          provisionedEpochs: [...(device.syncProvisionedEpochs ?? [])],
        };
      });
  }

  membershipDirectory(sessionToken) {
    const { household } = this.authorize(sessionToken);
    const now = this.now();
    return [...this.pairingService.members.values()]
      .filter((member) => member.householdId === household.id)
      .map((member) => ({
        memberId: member.id,
        memberKind: member.kind ?? "adult",
        memberActive: canParticipate(member, now),
        memberStatus: portableMemberStatus(member, now),
        ...(member.expiresAt == null ? {} : { memberExpiresAt: member.expiresAt }),
      }))
      .sort((left, right) => left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0);
  }

  householdSettings(sessionToken) {
    const auth = this.authorize(sessionToken);
    const row = this.store?.getHouseholdSettings(auth.household.id) ?? auth.household.settings ?? null;
    const admin = isHouseholdAdmin(auth.member, this.now());
    const policy = chatPolicyOf(auth.household);
    // The chat policy (#123) rides along for admins, who alone may see it.
    const board = boardPolicyOf(auth.household);
    return { admin, ...(admin ? { chatPolicy: { limited: policy.limited, temporary: policy.temporary }, boardPolicy: { limited: board.limited, temporary: board.temporary }, privatePolicy: { limited: privatePolicyOf(auth.household).limited } } : {}), adminRecorded: this.pairingService.hasHouseholdAdmin(auth.household), settings: row ? { ...row, ciphertext: Buffer.from(row.ciphertext).toString("base64url") } : null };
  }

  updateHouseholdSettings(sessionToken, value) {
    const auth = this.authorize(sessionToken);
    // Unlike member management, shared settings have no legacy Adult fallback.
    if (!isHouseholdAdmin(auth.member, this.now()))
      throw new PairingError("household_admin_required", "Only household admins can change shared settings.", 403);
    const expectedRevision = value?.expectedRevision;
    const keyEpoch = value?.keyEpoch;
    const ciphertext = Buffer.isBuffer(value?.ciphertext) ? value.ciphertext : typeof value?.ciphertext === "string" ? Buffer.from(value.ciphertext, "base64url") : null;
    const digest = value?.digest;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(keyEpoch) || keyEpoch < 1 || keyEpoch > 128 || !ciphertext || ciphertext.length < 29 || ciphertext.length > 4_198_400 || !/^[a-f0-9]{64}$/.test(digest ?? "") || createHash("sha256").update(ciphertext).digest("hex") !== digest)
      throw new PairingError("household_settings_invalid", "Those household settings could not be verified.", 400);
    this.settingsWriteState(auth, keyEpoch);
    const record = { keyEpoch, ciphertext, digest, memberId: auth.member.id, deviceId: auth.device.id, updatedAt: this.now() };
    let revision;
    if (this.store) revision = this.store.putHouseholdSettings(auth.household.id, expectedRevision, record);
    else {
      const current = auth.household.settings;
      if ((current?.revision ?? 0) !== expectedRevision) throw new PairingError("household_settings_stale", "Household settings changed on another device. Reload and try again.", 409);
      revision = expectedRevision + 1;
      auth.household.settings = { ...record, revision };
    }
    this.pairingService.audit("household_settings_updated", { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id, revision });
    this.pairingService.persistHousehold(auth.household.id);
    return { revision, accepted: true };
  }

  // ---- Install identity (#78): published, unencrypted, admin-only --------

  /** The published install identity for this member's household, without
   * icon bytes, and whether this member may change it. */
  installIdentity(sessionToken) {
    const auth = this.authorize(sessionToken);
    const identity = this.publishedInstallIdentity(auth.household);
    return {
      admin: isHouseholdAdmin(auth.member, this.now()),
      published: identity ? {
        rev: identity.rev, name: identity.name, shortName: identity.shortName, description: identity.description,
        iconSource: identity.iconSource, updatedAt: identity.updatedAt,
        icons: Object.fromEntries(INSTALL_ICONS.map(({ key, file }) => [key, installIconUrl(file, identity)])),
      } : null,
    };
  }

  /** Session, trusted device and active member (authorize), then admin.
   * A legacy household with no recorded admin has nobody who passes. */
  installIdentityWriter(sessionToken) {
    const auth = this.authorize(sessionToken);
    if (!isHouseholdAdmin(auth.member, this.now()))
      throw new PairingError("household_admin_required", "Only household admins can change what home screens show.", 403);
    return auth;
  }

  publishInstallIdentity(sessionToken, value) {
    const auth = this.installIdentityWriter(sessionToken);
    const checked = validateInstallIdentity(value);
    const record = { ...checked, contentTag: installContentTag(checked), memberId: auth.member.id, deviceId: auth.device.id, updatedAt: this.now() };
    let rev;
    if (this.store) {
      try { rev = this.store.putInstallIdentity(auth.household.id, checked.expectedRev, record); }
      catch (error) { throw staleInstallIdentity(error); }
    } else {
      if ((auth.household.installIdentity?.rev ?? 0) !== checked.expectedRev) throw staleInstallIdentity();
      rev = Math.max(auth.household.installIdentityLastRev ?? 0, checked.expectedRev) + 1;
      auth.household.installIdentity = { ...record, rev };
      auth.household.installIdentityLastRev = rev;
    }
    this.pairingService.audit("install_identity_published", { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id, revision: rev });
    this.pairingService.persistHousehold(auth.household.id);
    return { rev, accepted: true };
  }

  withdrawInstallIdentity(sessionToken, expectedRev) {
    const auth = this.installIdentityWriter(sessionToken);
    if (!Number.isSafeInteger(expectedRev) || expectedRev < 1)
      throw new PairingError("install_identity_invalid", "Those home screen details are invalid.", 400);
    let withdrawn;
    if (this.store) {
      try { withdrawn = this.store.deleteInstallIdentity(auth.household.id, expectedRev); }
      catch (error) { throw staleInstallIdentity(error); }
    } else {
      const current = auth.household.installIdentity;
      if (current && current.rev !== expectedRev) throw staleInstallIdentity();
      withdrawn = Boolean(current);
      delete auth.household.installIdentity;
    }
    if (withdrawn) {
      this.pairingService.audit("install_identity_withdrawn", { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id, revision: expectedRev });
      this.pairingService.persistHousehold(auth.household.id);
    }
    return { withdrawn };
  }

  /** The published identity's metadata (no icon bytes), or null. */
  publishedInstallIdentity(household) {
    if (!household || household.lifecycleState === "deleted") return null;
    if (this.store) return this.store.getInstallIdentity(household.id);
    const { icons, ...identity } = household.installIdentity ?? {};
    return icons ? identity : null;
  }

  /** One published icon's bytes for the household, or null. */
  publishedInstallIcon(householdId, key) {
    if (this.store) return this.store.getInstallIcon(householdId, key);
    return this.pairingService.households.get(householdId)?.installIdentity?.icons?.[key] ?? null;
  }

  /** The identity a browser's kin_device cookie may see: only a trusted,
   * active device of an active household that published one. Any failure is
   * null, so the caller serves the built-in Kin manifest and icons. Not rate
   * limited per device: it never reveals more than the device already has. */
  installIdentityForDevice(deviceToken) {
    if (typeof deviceToken !== "string" || !deviceToken) return null;
    try {
      const { device } = this.pairingService.trustedDevice(deviceToken);
      const household = this.pairingService.households.get(device.householdId);
      const identity = this.publishedInstallIdentity(household);
      return identity ? { householdId: household.id, identity } : null;
    } catch (error) {
      if (error instanceof PairingError) return null;
      throw error;
    }
  }

  settingsWriteState(auth, keyEpoch) {
    const state = this.state(auth.household.id);
    const provisioned = auth.device.syncProvisionedEpochs ?? [];
    if (!state.enabled || state.rotationPending || keyEpoch !== state.currentEpoch || !provisioned.includes(state.currentEpoch))
      throw new PairingError("household_settings_key_unavailable", "Shared settings are unavailable until this device finishes household key setup.", 409);
    return state;
  }

  enable(sessionToken) {
    const auth = this.authorize(sessionToken);
    requireTrustAuthority(auth.member, "enable household sync");
    const state = this.state(auth.household.id);
    state.enabled = true;
    auth.device.syncProvisionedEpochs ??= [state.currentEpoch];
    this.persistState(auth.household.id, state);
    return { enabled: true };
  }

  push(sessionToken, envelopes) {
    const auth = this.authorize(sessionToken);
    const state = this.state(auth.household.id);
    if (state.rotationPending)
      throw new PairingError(
        "sync_rotation_pending",
        "Device sync is paused until key access is updated.",
        409,
      );
    if (
      !Array.isArray(envelopes) ||
      envelopes.length < 1 ||
      envelopes.length > MAX_EVENTS_PER_BATCH
    )
      throw new PairingError(
        "sync_batch_invalid",
        "That sync batch is invalid.",
        400,
      );

    const staged = [];
    const seen = new Map();
    const nextDeviceSequence = new Map(state.deviceSequence);
    let maxLogicalTime = BigInt(state.maxLogicalTime ?? 0);
    let requestBytes = 0;
    for (const envelope of envelopes) {
      validateEventEnvelope(envelope, auth, state.currentEpoch);
      const canonical = canonicalEventEnvelope(envelope);
      requestBytes += Buffer.byteLength(canonical);
      if (requestBytes > MAX_REQUEST_BYTES)
        throw new PairingError(
          "sync_batch_too_large",
          "That sync batch is too large.",
          413,
        );
      const existing =
        state.byEventId.get(envelope.eventId) ??
        this.store?.findEvent(auth.household.id, envelope.eventId) ??
        seen.get(envelope.eventId);
      if (existing) {
        if (existing.canonical !== canonical)
          throw new PairingError(
            "event_duplicate_conflict",
            "A synchronized event conflicts with an event already received.",
            409,
          );
        continue;
      }
      const logicalTime = BigInt(envelope.logicalTime);
      if (logicalTime - maxLogicalTime > MAX_LOGICAL_TIME_ADVANCE)
        throw new PairingError(
          "logical_time_invalid",
          "That household change is outside Kin's supported event-order range.",
          400,
        );
      if (logicalTime > maxLogicalTime) maxLogicalTime = logicalTime;
      const previousSequence = nextDeviceSequence.get(auth.device.id) ?? 0;
      if (envelope.deviceSequence !== previousSequence + 1)
        throw new PairingError(
          "sync_sequence_gap",
          "This device must synchronize its earlier events first.",
          409,
        );
      if (
        (this.store
          ? this.store.eventCount(auth.household.id)
          : state.eventCount) +
          staged.length >=
        MAX_HOUSEHOLD_EVENTS
      )
        throw new PairingError(
          "sync_limit",
          "This household reached its sync limit.",
          413,
        );
      const record = {
        sequence: state.nextSequence + staged.length,
        canonical,
        envelope: structuredClone(envelope),
      };
      staged.push(record);
      seen.set(envelope.eventId, record);
      nextDeviceSequence.set(auth.device.id, envelope.deviceSequence);
    }

    // Publish counters and acknowledge only after the durable batch commits.
    if (this.store && staged.length) {
      try {
        this.store.commitEvents(
          auth.household.id,
          state.nextSequence,
          auth.device.id,
          state.deviceSequence.get(auth.device.id) ?? 0,
          staged,
        );
      } catch (error) {
        if (error instanceof DurableConflictError)
          this.households.delete(auth.household.id);
        throw error;
      }
    }
    if (!this.store)
      for (const record of staged) {
        state.records.push(record);
        state.byEventId.set(record.envelope.eventId, record);
      }
    state.nextSequence += staged.length;
    state.deviceSequence = nextDeviceSequence;
    state.eventCount += staged.length;
    // Keep the cached clock serializable: household state is also inspected by
    // diagnostics and tests that JSON-encode it.
    state.maxLogicalTime = maxLogicalTime.toString();
    // After the commit: tell other members' devices that something is new.
    // It runs in the background and can never fail or delay this response.
    if (staged.length) {
      try { this.pushService?.eventsAccepted(auth.household.id, auth.member.id); } catch { /* best effort */ }
      // And to connected devices at once, over the live channel (#107).
      try { this.liveService?.eventsAccepted(auth.household.id, auth.device.id); } catch { /* best effort */ }
    }
    return {
      accepted: envelopes.length,
      latestCursor: encodeCursor(state.nextSequence - 1),
      durable: Boolean(this.store),
    };
  }

  pull(sessionToken, cursorValue = "", limitValue = "20") {
    const auth = this.authorize(sessionToken);
    const state = this.state(auth.household.id);
    const cursor = decodeCursor(cursorValue);
    const limit = Number(limitValue);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_EVENTS_PER_BATCH ||
      cursor > state.nextSequence - 1
    )
      throw new PairingError(
        "sync_cursor_invalid",
        "Kin could not continue from that sync position.",
        400,
      );
    if (this.store)
      return this.store.readEvents(
        auth.household.id,
        cursor,
        limit,
        auth.device.syncHistoryFromEpoch ?? 1,
      );
    const scanned = state.records
      .filter((record) => record.sequence > cursor)
      .slice(0, limit);
    const visible = scanned.filter(
      (record) =>
        record.envelope.keyEpoch >= (auth.device.syncHistoryFromEpoch ?? 1),
    );
    const lastScanned = scanned.at(-1)?.sequence ?? cursor;
    return {
      events: visible.map((record) => ({
        cursor: encodeCursor(record.sequence),
        envelope: structuredClone(record.envelope),
      })),
      nextCursor: encodeCursor(lastScanned),
      hasMore: lastScanned < state.nextSequence - 1,
    };
  }

  pushAttachment(sessionToken, { attachmentId, keyEpoch, ciphertext, digest }) {
    const auth = this.authorize(sessionToken);
    this.attachmentState(auth, keyEpoch);
    if (!isSyncId(attachmentId) || !Buffer.isBuffer(ciphertext) || ciphertext.length < 29 || ciphertext.length > MAX_ATTACHMENT_BYTES || !/^[a-f0-9]{64}$/.test(digest) || createHash("sha256").update(ciphertext).digest("hex") !== digest)
      throw new PairingError("attachment_invalid", "That attachment could not be verified.", 400);
    const existing = this.store?.getAttachment(auth.household.id, attachmentId) ?? this.attachments.get(`${auth.household.id}:${attachmentId}`);
    if (existing) {
      if (existing.keyEpoch !== keyEpoch || existing.digest !== digest || !Buffer.from(existing.ciphertext).equals(ciphertext))
        throw new PairingError("attachment_conflict", "That attachment ID already has different encrypted content.", 409);
      return { accepted: false, size: ciphertext.length, digest };
    }
    if (!this.store) {
      // Album photos (#673) and other attachments each have their own quota.
      const album = isAlbumAttachmentId(attachmentId);
      const householdRows = [...this.attachments.entries()].filter(([key, row]) => key.startsWith(`${auth.household.id}:`) && isAlbumAttachmentId(row.attachmentId) === album);
      const total = householdRows.reduce((sum, [, row]) => sum + row.ciphertext.length, 0);
      if (album ? householdRows.length >= MAX_HOUSEHOLD_ALBUM_ATTACHMENTS || total + ciphertext.length > MAX_HOUSEHOLD_ALBUM_BYTES
        : householdRows.length >= MAX_HOUSEHOLD_ATTACHMENTS || total + ciphertext.length > MAX_HOUSEHOLD_ATTACHMENT_BYTES)
        throw new PairingError("attachment_limit", album ? "This household's family photos are full." : "This household reached its encrypted attachment limit.", 409);
      this.attachments.set(`${auth.household.id}:${attachmentId}`, { attachmentId, keyEpoch, ciphertext: Buffer.from(ciphertext), size: ciphertext.length, digest, uploaderMemberId: auth.member.id });
    } else {
      this.store.putAttachment(auth.household.id, attachmentId, keyEpoch, ciphertext, digest, this.now(), auth.member.id);
    }
    return { accepted: true, size: ciphertext.length, digest };
  }

  getAttachment(sessionToken, attachmentId) {
    const auth = this.authorize(sessionToken);
    const row = this.store?.getAttachment(auth.household.id, attachmentId) ?? this.attachments.get(`${auth.household.id}:${attachmentId}`);
    if (!row) throw new PairingError("attachment_missing", "This attachment is no longer available.", 404);
    this.attachmentState(auth, row.keyEpoch);
    const ciphertext = Buffer.from(row.ciphertext);
    if (ciphertext.length !== row.size || createHash("sha256").update(ciphertext).digest("hex") !== row.digest)
      throw new PairingError("attachment_corrupt", "This attachment could not be verified.", 410);
    return { ...row, ciphertext };
  }

  /** The household's encrypted attachments. Album photos (#673) are listed
   * only to devices that ask for them (`album`): an older device would take
   * a blob no kind-39 binding names for an orphan and delete it. */
  listAttachments(sessionToken, { album = false } = {}) {
    const auth = this.authorize(sessionToken);
    this.attachmentState(auth);
    const rows = this.store?.listAttachments(auth.household.id, { album }) ?? [...this.attachments.entries()].filter(([key, row]) => key.startsWith(`${auth.household.id}:`) && (album || !isAlbumAttachmentId(row.attachmentId))).map(([, row]) => ({ attachmentId: row.attachmentId, keyEpoch: row.keyEpoch, size: row.size, digest: row.digest }));
    return rows.filter((row) => {
      try { this.attachmentState(auth, row.keyEpoch); return true; } catch { return false; }
    });
  }

  removeAttachment(sessionToken, attachmentId) {
    const auth = this.authorize(sessionToken);
    this.attachmentState(auth);
    if (!isSyncId(attachmentId)) throw new PairingError("attachment_invalid", "That attachment could not be found.", 400);
    const key = `${auth.household.id}:${attachmentId}`;
    const existing = this.store
      ? this.store.attachmentUploader(auth.household.id, attachmentId)
      : this.attachments.has(key) ? { uploaderMemberId: this.attachments.get(key).uploaderMemberId ?? null } : null;
    if (!existing) return { removed: true };
    // The uploader or an Adult may delete encrypted attachment bytes.
    // Attachments stored before uploaders were recorded are Adult-only.
    const uploader = existing.uploaderMemberId !== null && existing.uploaderMemberId === auth.member.id;
    if (!uploader && !canManageTrust(auth.member, this.now()))
      throw new PairingError("attachment_delete_forbidden", "Only the person who added this attachment or an Adult can delete it.", 403);
    if (this.store) this.store.removeAttachment(auth.household.id, attachmentId);
    else this.attachments.delete(key);
    this.pairingService.audit("attachment_deleted", { householdId: auth.household.id, attachmentId, memberId: auth.member.id, deviceId: auth.device.id });
    this.pairingService.persistHousehold(auth.household.id);
    return { removed: true };
  }

  attachmentState(auth, keyEpoch = null) {
    const state = this.state(auth.household.id);
    const provisioned = auth.device.syncProvisionedEpochs ?? [];
    if (!state.enabled || state.rotationPending || !provisioned.includes(state.currentEpoch))
      throw new PairingError("attachment_sync_unavailable", "Attachments are unavailable until this device finishes household sync setup.", 409);
    if (keyEpoch !== null && (keyEpoch > state.currentEpoch || keyEpoch < (auth.device.syncHistoryFromEpoch ?? 1) || !provisioned.includes(keyEpoch)))
      throw new PairingError("attachment_epoch_unavailable", "This attachment is unavailable to this device.", 403);
    return state;
  }

  pushBindings(sessionToken, envelopes) {
    const auth = this.authorize(sessionToken);
    const state = this.state(auth.household.id);
    if (
      !Array.isArray(envelopes) ||
      envelopes.length < 1 ||
      envelopes.length > 20
    )
      throw new PairingError(
        "sync_batch_invalid",
        "That sync batch is invalid.",
        400,
      );
    const staged = new Map();
    for (const envelope of envelopes) {
      validateEventEnvelope(envelope, auth, state.currentEpoch);
      const canonical = canonicalEventEnvelope(envelope);
      const existing =
        state.bindings.get(envelope.eventId) ?? staged.get(envelope.eventId);
      if (existing && existing.canonical !== canonical)
        throw new PairingError(
          "event_duplicate_conflict",
          "A synchronized identity record conflicts with one already received.",
          409,
        );
      if (!existing)
        staged.set(envelope.eventId, {
          canonical,
          envelope: structuredClone(envelope),
        });
    }
    if (state.bindings.size + staged.size > MAX_BINDINGS)
      throw new PairingError(
        "sync_limit",
        "This household reached its sync limit.",
        413,
      );
    for (const [eventId, binding] of staged)
      state.bindings.set(eventId, binding);
    this.persistState(auth.household.id, state);
    if (staged.size) this.hintHousehold(auth.household.id, auth.device.id);
    return { accepted: envelopes.length, durable: Boolean(this.store) };
  }

  pullBindings(sessionToken, cursorValue = "") {
    const auth = this.authorize(sessionToken);
    const state = this.state(auth.household.id);
    if (cursorValue !== "" && !/^[a-f0-9]{32}$/.test(cursorValue))
      throw new PairingError(
        "sync_cursor_invalid",
        "Kin could not continue from that sync position.",
        400,
      );
    const candidates = [...state.bindings.values()]
      .map(({ envelope }) => envelope)
      .filter(
        (envelope) =>
          envelope.keyEpoch >= (auth.device.syncHistoryFromEpoch ?? 1) &&
          envelope.eventId > cursorValue,
      )
      .sort((left, right) =>
        left.eventId < right.eventId
          ? -1
          : left.eventId > right.eventId
            ? 1
            : 0,
      );
    const page = candidates.slice(0, MAX_PROVISIONING_BATCH);
    return {
      bindings: page.map((envelope) => structuredClone(envelope)),
      nextCursor: page.at(-1)?.eventId ?? cursorValue,
      hasMore: page.length < candidates.length,
    };
  }

  createProvisioningGrant(
    sessionToken,
    { recipientDeviceId, keyEpoch, requestId },
  ) {
    const auth = this.authorize(sessionToken);
    requireTrustAuthority(auth.member, "provision household key access");
    const state = this.state(auth.household.id);
    const stableRequestId = requestId ?? randomBytes(16).toString("hex");
    if (!isSyncId(stableRequestId))
      throw new PairingError(
        "provisioning_invalid",
        "That key transfer request is invalid.",
        400,
      );
    this.pruneGrants(state);
    const requestKey = `${auth.device.id}:${stableRequestId}`;
    const existingGrantId = state.grantRequests.get(requestKey);
    if (existingGrantId) {
      const existingGrant = state.grants.get(existingGrantId);
      if (
        !existingGrant ||
        existingGrant.recipientDeviceId !== recipientDeviceId ||
        existingGrant.keyEpoch !== keyEpoch
      )
        throw new PairingError(
          "provisioning_conflict",
          "That key transfer request ID is already in use.",
          409,
        );
      const existingRecipient =
        this.pairingService.devices.get(recipientDeviceId);
      return {
        ...publicGrant(existingGrant),
        recipientPublicKeys: structuredClone(existingRecipient.syncPublicKeys),
      };
    }
    if (state.rotationPending)
      throw new PairingError(
        "sync_rotation_pending",
        "Device sync is paused until key access is updated.",
        409,
      );
    const recipient = this.pairingService.devices.get(recipientDeviceId);
    const maximumEpoch = state.currentEpoch + Number(state.rotationPending);
    if (
      !recipient ||
      recipient.householdId !== auth.household.id ||
      recipient.revokedAt ||
      !this.pairingService.members.get(recipient.memberId)?.active ||
      !recipient.syncPublicKeys ||
      !Number.isSafeInteger(keyEpoch) ||
      keyEpoch < 1 ||
      keyEpoch > MAX_KEY_EPOCHS ||
      keyEpoch > maximumEpoch ||
      keyEpoch < (recipient.syncHistoryFromEpoch ?? 1) ||
      keyEpoch < (auth.device.syncHistoryFromEpoch ?? 1)
    )
      throw new PairingError(
        "provisioning_device_mismatch",
        "That device cannot receive this household key.",
        403,
      );
    if (
      [...state.grants.values()].filter((grant) => !grant.committedRotation)
        .length >= MAX_PROVISIONING_GRANTS
    )
      throw new PairingError(
        "provisioning_capacity",
        "Too many active key transfers.",
        503,
      );
    const grant = {
      grantId: randomBytes(16).toString("hex"),
      requestId: stableRequestId,
      householdId: auth.household.id,
      senderDeviceId: auth.device.id,
      recipientDeviceId,
      recipientFingerprint: recipient.syncKeyFingerprint,
      keyEpoch,
      expiresAt: this.now() + GRANT_TTL_MS,
      state: "pending",
      package: null,
      canonicalPackage: null,
    };
    state.grants.set(grant.grantId, grant);
    state.grantRequests.set(requestKey, grant.grantId);
    this.persistState(auth.household.id, state);
    return {
      ...publicGrant(grant),
      recipientPublicKeys: structuredClone(recipient.syncPublicKeys),
    };
  }

  submitProvisioning(sessionToken, grantId, keyPackage) {
    const auth = this.authorize(sessionToken);
    const state = this.state(auth.household.id);
    const grant = state.grants.get(grantId);
    if (!grant || grant.expiresAt <= this.now())
      throw new PairingError(
        "provisioning_expired",
        "That key transfer expired.",
        410,
      );
    if (grant.senderDeviceId !== auth.device.id)
      throw new PairingError(
        "provisioning_device_mismatch",
        "That key transfer is unavailable.",
        403,
      );
    validateProvisioningPackage(keyPackage, grant, this.now());
    const canonicalPackage = canonicalJson(keyPackage);
    if (grant.canonicalPackage && grant.canonicalPackage !== canonicalPackage)
      throw new PairingError(
        "provisioning_conflict",
        "A different key transfer already uses this grant.",
        409,
      );
    grant.package ??= structuredClone(keyPackage);
    grant.canonicalPackage ??= canonicalPackage;
    this.persistState(auth.household.id, state);
    this.hintHousehold(auth.household.id, auth.device.id);
    return { accepted: true, grantId, durable: Boolean(this.store) };
  }

  pendingProvisioning(sessionToken) {
    const auth = this.authorize(sessionToken);
    const state = this.state(auth.household.id);
    const grantCount = state.grants.size;
    this.pruneGrants(state);
    if (state.grants.size !== grantCount)
      this.persistState(auth.household.id, state);
    return [...state.grants.values()]
      .filter(
        (grant) =>
          grant.recipientDeviceId === auth.device.id &&
          grant.package &&
          grant.state !== "acknowledged",
      )
      .slice(0, MAX_PROVISIONING_BATCH)
      .map((grant) => ({
        ...publicGrant(grant),
        package: structuredClone(grant.package),
      }));
  }

  acknowledgeProvisioning(sessionToken, grantId) {
    const auth = this.authorize(sessionToken);
    const state = this.state(auth.household.id);
    const grant = state.grants.get(grantId);
    if (!grant || grant.recipientDeviceId !== auth.device.id)
      throw new PairingError(
        "provisioning_device_mismatch",
        "That key transfer is unavailable.",
        403,
      );
    if (grant.state === "acknowledged")
      return { acknowledged: true, grantId };
    if (
      !grant.package ||
      (grant.expiresAt <= this.now() && !grant.committedRotation)
    )
      throw new PairingError(
        "provisioning_expired",
        "That key transfer expired.",
        410,
      );
    grant.state = "acknowledged";
    delete grant.committedRotation;
    const device = this.pairingService.devices.get(auth.device.id);
    device.syncProvisionedEpochs ??= [];
    if (!device.syncProvisionedEpochs.includes(grant.keyEpoch))
      device.syncProvisionedEpochs.push(grant.keyEpoch);
    device.syncProvisionedEpochs.sort((left, right) => left - right);
    this.persistState(auth.household.id, state);
    return { acknowledged: true, grantId };
  }

  /**
   * Commits household epoch `expectedEpoch + 1` with its key packages. An
   * optional `vaultChange` (`{ expectedVersion, ciphertext }`, #791) is the
   * committer's own account vault re-sealed with the new key: it is stored
   * compare-and-set in the same step, after every check below and before
   * anything else changes, so the caller's transaction (server.mjs) keeps
   * both or neither. Every existing refusal comes first. A retried proposal
   * never touches the vault. Without a linked vault service the field is
   * ignored, as an older service would. The answer's `vault` is
   * `{ version }` when the change was stored, otherwise null.
   */
  rotateEpoch(sessionToken, { expectedEpoch, packages, proposalId, vaultChange }) {
    const auth = this.authorize(sessionToken);
    requireTrustAuthority(auth.member, "change household key access");
    const state = this.state(auth.household.id);
    const nextEpoch = expectedEpoch + 1;
    if (nextEpoch > MAX_KEY_EPOCHS)
      throw new PairingError(
        "sync_epoch_limit",
        "This household reached its key-rotation limit.",
        409,
      );
    if (
      state.currentEpoch === nextEpoch &&
      state.lastRotation?.expectedEpoch === expectedEpoch
    ) {
      const canonical = canonicalJson(packages);
      if (
        state.lastRotation.canonical === canonical &&
        state.lastRotation.proposalId === proposalId
      )
        return {
          currentEpoch: state.currentEpoch,
          rotationPending: state.rotationPending,
          retried: true,
          proposalId,
          vault: null,
        };
      throw new PairingError(
        "stale_key_epoch",
        "A different key rotation already committed.",
        409,
      );
    }
    if (
      expectedEpoch !== state.currentEpoch ||
      !isSyncId(proposalId) ||
      !Array.isArray(packages) ||
      packages.length > MAX_ROTATION_PACKAGES
    )
      throw new PairingError(
        "stale_key_epoch",
        "The household key epoch changed. Retry with the current epoch.",
        409,
      );
    const recipients = [...this.pairingService.devices.values()].filter(
      (device) =>
        device.householdId === auth.household.id &&
        device.id !== auth.device.id &&
        !device.revokedAt &&
        this.pairingService.members.get(device.memberId)?.active,
    );
    if (packages.length !== recipients.length)
      throw new PairingError(
        "provisioning_device_mismatch",
        "The rotation does not cover every trusted device.",
        409,
      );
    const byRecipient = new Map();
    for (const keyPackage of packages) {
      const recipient = recipients.find(
        (device) => device.id === keyPackage.recipientDeviceId,
      );
      if (
        !recipient ||
        byRecipient.has(recipient.id) ||
        !recipient.syncKeyFingerprint
      )
        throw new PairingError(
          "provisioning_device_mismatch",
          "The rotation contains an invalid recipient.",
          409,
        );
      const grant = {
        householdId: auth.household.id,
        senderDeviceId: auth.device.id,
        recipientDeviceId: recipient.id,
        recipientFingerprint: recipient.syncKeyFingerprint,
        keyEpoch: nextEpoch,
        grantId: keyPackage.grantId,
        expiresAt: keyPackage.expiresAt,
      };
      validateProvisioningPackage(keyPackage, grant, this.now());
      byRecipient.set(recipient.id, keyPackage);
    }
    const retainedRotationGrants = [...state.grants.values()].filter(
      (grant) => grant.committedRotation,
    ).length;
    if (
      retainedRotationGrants + byRecipient.size >
      MAX_COMMITTED_ROTATION_GRANTS
    )
      throw new PairingError(
        "provisioning_capacity",
        "Too many unacknowledged rotation key transfers.",
        503,
      );
    const vaults = vaultChange === undefined ? null : this.accountVaultService ?? null;
    const change = vaults ? vaults.parseVaultChange(vaultChange) : null;
    const canonical = canonicalJson(packages);
    const rotationId = randomBytes(16).toString("hex");
    // The vault change is the first write and only touches the database: a
    // conflict, a missing vault or a full write window refuses the whole
    // commit before the in-memory state below changes.
    const vault = change ? { version: vaults.applyVaultChange(auth, change) } : null;
    state.currentEpoch = nextEpoch;
    state.rotationPending = false;
    state.lastRotation = { expectedEpoch, canonical, rotationId, proposalId };
    auth.device.syncProvisionedEpochs ??= [];
    if (!auth.device.syncProvisionedEpochs.includes(nextEpoch))
      auth.device.syncProvisionedEpochs.push(nextEpoch);
    auth.device.syncProvisionedEpochs.sort((left, right) => left - right);
    for (const [recipientDeviceId, keyPackage] of byRecipient) {
      state.grants.set(keyPackage.grantId, {
        ...keyPackage,
        requestId: null,
        state: "pending",
        package: structuredClone(keyPackage),
        canonicalPackage: canonicalJson(keyPackage),
        recipientDeviceId,
        senderDeviceId: auth.device.id,
        householdId: auth.household.id,
        keyEpoch: nextEpoch,
        committedRotation: true,
      });
    }
    this.persistState(auth.household.id, state);
    this.hintHousehold(auth.household.id, auth.device.id);
    return {
      currentEpoch: nextEpoch,
      rotationPending: false,
      retried: false,
      proposalId,
      vault,
    };
  }

  onDeviceKeyTransition(householdId, deviceId) {
    const state = this.state(householdId);
    // Every package binds a recipient fingerprint or an issuer signing key.
    // A committed package can still be verified against the sender's historical
    // signing key. A recipient key transition, however, makes it unusable.
    for (const [id, grant] of state.grants) {
      if (
        grant.recipientDeviceId !== deviceId &&
        (grant.senderDeviceId !== deviceId || grant.committedRotation)
      )
        continue;
      state.grants.delete(id);
      for (const [request, grantId] of state.grantRequests)
        if (grantId === id) state.grantRequests.delete(request);
    }
    this.persistState(householdId, state);
  }

  onAccessChange(householdId, excludedDeviceIds = []) {
    // Devices that lost access stop getting notifications at once (#85).
    this.pushService?.removeUntrusted(householdId, excludedDeviceIds);
    // Live sockets of devices that lost access close at once (#107).
    this.liveService?.revalidate(householdId);
    // The remaining devices have a rotation (and maybe a new device's keys)
    // to act on.
    this.hintHousehold(householdId);
    const state = this.state(householdId);
    state.rotationPending = true;
    // Keep committed packages only for recipients who still hold trust.
    for (const [grantId, grant] of state.grants) {
      const recipient = this.pairingService.devices.get(
        grant.recipientDeviceId,
      );
      const recipientMember = recipient &&
        this.pairingService.members.get(recipient.memberId);
      const recipientTrusted =
        recipient &&
        !recipient.revokedAt &&
        canParticipate(recipientMember, this.now()) &&
        !excludedDeviceIds.includes(recipient.id);
      const senderExcluded = excludedDeviceIds.includes(
        grant.senderDeviceId,
      );
      const recipientExcluded = excludedDeviceIds.includes(
        grant.recipientDeviceId,
      );
      const shouldDelete =
        recipientExcluded ||
        (grant.committedRotation
          ? !recipientTrusted
          : senderExcluded);
      if (shouldDelete) {
        state.grants.delete(grantId);
        for (const [requestKey, requestedGrantId] of state.grantRequests)
          if (requestedGrantId === grantId)
            state.grantRequests.delete(requestKey);
      }
    }
    this.persistState(householdId, state);
    return state.currentEpoch + 1;
  }

  onDeviceAdded(householdId, deviceId, { historyFromEpoch } = {}) {
    const device = this.pairingService.devices.get(deviceId);
    if (device)
      device.syncHistoryFromEpoch =
        historyFromEpoch ?? this.state(householdId).currentEpoch + 1;
    return this.onAccessChange(householdId);
  }

  authorize(sessionToken) {
    const auth = this.pairingService.authorize(sessionToken);
    this.rateLimit(auth.device.id);
    return auth;
  }

  rateLimit(deviceId) {
    const now = this.now();
    const cutoff = now - SYNC_RATE_WINDOW_MS;
    for (const [key, entries] of this.rateBuckets) {
      const recent = entries.filter((timestamp) => timestamp > cutoff);
      if (recent.length) this.rateBuckets.set(key, recent);
      else this.rateBuckets.delete(key);
    }
    let bucket = this.rateBuckets.get(deviceId);
    if (!bucket) {
      if (this.rateBuckets.size >= MAX_SYNC_RATE_BUCKETS)
        throw new PairingError(
          "sync_rate_limited",
          "Too many sync requests. Wait and try again.",
          429,
        );
      bucket = [];
    }
    bucket.push(now);
    this.rateBuckets.set(deviceId, bucket);
    if (bucket.length > SYNC_RATE_LIMIT)
      throw new PairingError(
        "sync_rate_limited",
        "Too many sync requests. Wait and try again.",
        429,
      );
  }

  state(householdId) {
    this.store?.assertAvailable();
    let state = this.households.get(householdId);
    if (!state) {
      state = this.store
        ? this.store.loadSyncState(householdId)
        : {
            currentEpoch: 1,
            enabled: false,
            rotationPending: false,
            nextSequence: 1,
            records: [],
            eventCount: 0,
            byEventId: new Map(),
            deviceSequence: new Map(),
            grants: new Map(),
            bindings: new Map(),
            lastRotation: null,
            grantRequests: new Map(),
          };
      if (state.maxLogicalTime == null) {
        const maximum = this.store
          ? this.store.maxLogicalTime(householdId)
          : state.records.reduce((maximum, record) => {
              const value = BigInt(record.envelope.logicalTime);
              return value > maximum && value - maximum <= MAX_LOGICAL_TIME_ADVANCE ? value : maximum;
            }, 0n);
        state.maxLogicalTime = maximum.toString();
      }
      this.households.set(householdId, state);
    }
    return state;
  }

  persistState(householdId, state) {
    this.store?.saveSyncState(householdId, state, this.pairingService);
  }

  pruneGrants(state) {
    for (const [grantId, grant] of state.grants)
      if (
        grant.expiresAt <= this.now() &&
        (!grant.committedRotation || grant.state === "acknowledged")
      ) {
        state.grants.delete(grantId);
        for (const [requestKey, requestedGrantId] of state.grantRequests)
          if (requestedGrantId === grantId)
            state.grantRequests.delete(requestKey);
      }
  }
}

function portableMemberStatus(member, now) {
  const status = member.memberStatus ?? (member.active === false ? "removed" : "active");
  if (status === "active" && member.kind === "temporary" &&
      Number.isSafeInteger(member.expiresAt) && member.expiresAt <= now)
    return "expired";
  return status;
}

export function validateEventEnvelope(envelope, auth, currentEpoch) {
  const invalid = () =>
    new PairingError(
      "event_envelope_invalid",
      "That encrypted event is invalid.",
      400,
    );
  if (
    !isEventEnvelopeValid(envelope) ||
    envelope.householdId !== auth.household.id ||
    envelope.deviceId !== auth.device.id ||
    envelope.keyEpoch < (auth.device.syncHistoryFromEpoch ?? 1) ||
    envelope.keyEpoch > currentEpoch
  )
    throw invalid();
}

function validateProvisioningPackage(value, expected, now = Date.now()) {
  if (
    !isProvisioningPackageValid(value, expected) || value.expiresAt <= now
  )
    throw new PairingError(
      "provisioning_invalid",
      "That key transfer is invalid.",
      400,
    );
}

function publicGrant(grant) {
  return {
    grantId: grant.grantId,
    requestId: grant.requestId,
    householdId: grant.householdId,
    senderDeviceId: grant.senderDeviceId,
    recipientDeviceId: grant.recipientDeviceId,
    recipientFingerprint: grant.recipientFingerprint,
    keyEpoch: grant.keyEpoch,
    expiresAt: grant.expiresAt,
    ...(grant.committedRotation ? { committedRotation: true } : {}),
  };
}

export function encodeCursor(sequence) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(sequence));
  return bytes.toString("base64url");
}

export function decodeCursor(value) {
  if (value === "") return 0;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(value))
    throw new PairingError(
      "sync_cursor_invalid",
      "Kin could not continue from that sync position.",
      400,
    );
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 8 || bytes.toString("base64url") !== value)
    throw new PairingError(
      "sync_cursor_invalid",
      "Kin could not continue from that sync position.",
      400,
    );
  const cursor = Number(bytes.readBigUInt64BE());
  if (!Number.isSafeInteger(cursor) || cursor > MAX_CURSOR)
    throw new PairingError(
      "sync_cursor_invalid",
      "Kin could not continue from that sync position.",
      400,
    );
  return cursor;
}

function staleInstallIdentity(error) {
  if (error && !(error instanceof DurableConflictError)) return error;
  return new PairingError("install_identity_stale", "The home screen details changed on another device. Reload and try again.", 409);
}

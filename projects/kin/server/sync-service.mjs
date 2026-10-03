import { randomBytes } from "node:crypto";
import { DurableConflictError } from "./durable-store.mjs";
import { PairingError } from "./pairing-service.mjs";
import {
  canonicalEventEnvelope,
  canonicalJson,
  isEventEnvelopeValid,
  isProvisioningPackageValid,
  isSyncId,
  MAX_BINDINGS,
  MAX_HOUSEHOLD_EVENTS,
  MAX_KEY_EPOCHS,
  MAX_ROTATION_PACKAGES,
} from "./sync-contract.mjs";

const MAX_EVENTS_PER_BATCH = 20;
const MAX_REQUEST_BYTES = 200_000;
const MAX_PROVISIONING_GRANTS = 128;
const MAX_PROVISIONING_BATCH = 20;
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
  }

  status(sessionToken) {
    const auth = this.authorize(sessionToken);
    const state = this.state(auth.household.id);
    return {
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
      .map((device) => ({
        householdId: household.id,
        deviceId: device.id,
        memberId: device.memberId,
        publicKeys: device.syncPublicKeys ?? null,
        fingerprint: device.syncKeyFingerprint ?? null,
        certificate: device.deviceAuthorizationCertificate ?? null,
        keyHistory: device.syncKeyHistory ?? undefined,
        keyTransitions: device.syncKeyTransitions ?? [],
        revokedAt: device.revokedAt,
        historyFromEpoch: device.syncHistoryFromEpoch ?? 1,
        provisionedEpochs: [...(device.syncProvisionedEpochs ?? [])],
      }));
  }

  enable(sessionToken) {
    const auth = this.authorize(sessionToken);
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
    if (state.grants.size >= MAX_PROVISIONING_GRANTS)
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
    const grant = this.state(auth.household.id).grants.get(grantId);
    if (!grant || grant.recipientDeviceId !== auth.device.id)
      throw new PairingError(
        "provisioning_device_mismatch",
        "That key transfer is unavailable.",
        403,
      );
    if (!grant.package || grant.expiresAt <= this.now())
      throw new PairingError(
        "provisioning_expired",
        "That key transfer expired.",
        410,
      );
    grant.state = "acknowledged";
    const device = this.pairingService.devices.get(auth.device.id);
    device.syncProvisionedEpochs ??= [];
    if (!device.syncProvisionedEpochs.includes(grant.keyEpoch))
      device.syncProvisionedEpochs.push(grant.keyEpoch);
    device.syncProvisionedEpochs.sort((left, right) => left - right);
    this.persistState(auth.household.id, this.state(auth.household.id));
    return { acknowledged: true, grantId };
  }

  rotateEpoch(sessionToken, { expectedEpoch, packages, proposalId }) {
    const auth = this.authorize(sessionToken);
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
    const canonical = canonicalJson(packages);
    const rotationId = randomBytes(16).toString("hex");
    state.currentEpoch = nextEpoch;
    state.rotationPending = false;
    state.lastRotation = { expectedEpoch, canonical, rotationId, proposalId };
    for (const [recipientDeviceId, keyPackage] of byRecipient) {
      state.grants.set(keyPackage.grantId, {
        ...keyPackage,
        state: "pending",
        package: structuredClone(keyPackage),
        canonicalPackage: canonicalJson(keyPackage),
        recipientDeviceId,
        senderDeviceId: auth.device.id,
        householdId: auth.household.id,
        keyEpoch: nextEpoch,
      });
    }
    this.persistState(auth.household.id, state);
    return {
      currentEpoch: nextEpoch,
      rotationPending: false,
      retried: false,
      proposalId,
    };
  }

  onDeviceKeyTransition(householdId, deviceId) {
    const state = this.state(householdId);
    // Every package binds a recipient fingerprint or an issuer signing key.
    // Remove obsolete packages and their retry mappings without altering events.
    for (const [id, grant] of state.grants) {
      if (grant.senderDeviceId !== deviceId && grant.recipientDeviceId !== deviceId) continue;
      state.grants.delete(id);
      for (const [request, grantId] of state.grantRequests)
        if (grantId === id) state.grantRequests.delete(request);
    }
    this.persistState(householdId, state);
  }

  onAccessChange(householdId, excludedDeviceIds = []) {
    const state = this.state(householdId);
    state.rotationPending = true;
    // Keep the latest committed proposal recoverable after a lost response,
    // even when an access change already requires the following rotation.
    for (const [grantId, grant] of state.grants)
      if (
        excludedDeviceIds.includes(grant.senderDeviceId) ||
        excludedDeviceIds.includes(grant.recipientDeviceId)
      ) {
        state.grants.delete(grantId);
        for (const [requestKey, requestedGrantId] of state.grantRequests)
          if (requestedGrantId === grantId)
            state.grantRequests.delete(requestKey);
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
      this.households.set(householdId, state);
    }
    return state;
  }

  persistState(householdId, state) {
    this.store?.saveSyncState(householdId, state, this.pairingService);
  }

  pruneGrants(state) {
    for (const [grantId, grant] of state.grants)
      if (grant.expiresAt <= this.now()) {
        state.grants.delete(grantId);
        for (const [requestKey, requestedGrantId] of state.grantRequests)
          if (requestedGrantId === grantId)
            state.grantRequests.delete(requestKey);
      }
  }
}

function validateEventEnvelope(envelope, auth, currentEpoch) {
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
  };
}

function encodeCursor(sequence) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(sequence));
  return bytes.toString("base64url");
}

function decodeCursor(value) {
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

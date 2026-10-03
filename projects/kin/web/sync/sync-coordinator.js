import {
  createHouseholdEpochKey,
  createProvisionedHouseholdEpoch,
  decryptWithDeviceHistory,
  verifiedDeviceKeyHistory,
  decryptIdentityBinding,
  deviceKeyFingerprint,
  encryptEvent,
  encryptIdentityBinding,
  importDevicePublicKeys,
  provisionSealedEpochKey,
  restoreHouseholdEpochKey,
  unwrapEpochKey,
  verifyDeviceAuthorizationCertificate,
} from "./crypto.js";
import { SyncKeyStore } from "./key-store.js";
import { idToHex } from "../wasm/kin-engine.js";

const MAX_PUSH_BATCH = 20;
const MAX_PULL_PASSES = 5;
const KEY_GRANT_TTL_MS = 10 * 60_000;

export class SyncCoordinator {
  constructor({ store, engine, identity, onState = () => {} }) {
    this.store = store;
    this.engine = engine;
    this.identity = identity;
    this.onState = value => {
      if (this.stopped) return;
      try { this.keyStore?.vault.assertUnlocked(); } catch { return; }
      onState(value);
    };
    this.keyStore = null;
    this.deviceKeys = null;
    this.timer = null;
    this.running = null;
    this.stopped = false;
    this.abortController = new AbortController();
  }

  async start() {
    if (!this.identity) return;
    if (this.stopped) return;
    const keyStore = this.keyStore ?? await SyncKeyStore.open();
    if (this.stopped) { keyStore.close(); return; }
    this.keyStore = keyStore;
    const deviceKeys = await keyStore.getDevice(this.identity.deviceId);
    if (this.stopped) return;
    this.deviceKeys = deviceKeys;
    if (!this.deviceKeys) {
      const pending = await this.keyStore.getOrCreatePendingDevice();
      await this.request("/api/sync/device-keys", {
        method: "POST",
        body: JSON.stringify({ publicKeys: pending.publicKeys }),
      });
      this.deviceKeys = await this.keyStore.bindPendingDevice({
        deviceId: this.identity.deviceId,
        householdId: this.identity.householdId,
        memberId: this.identity.memberId,
      });
    }
    if (this.stopped) return;
    await this.syncNow();
    if (this.stopped) return;
    this.timer = setInterval(() => void this.syncNow(), 5_000);
  }

  async syncNow() {
    if (this.stopped || !this.identity) return;
    if (this.running) return this.running;
    this.running = this.runOnce()
      .catch((error) => {
        if (this.stopped) return;
        this.onState({
          state: "paused",
          message: error.message || "Device sync is paused.",
        });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async runOnce() {
    this.keyStore.vault.assertUnlocked();
    if (this.deviceKeys.pendingTransition) {
      const device = await this.keyStore.completePendingTransition(this.identity.deviceId, { signal: this.abortController.signal });
      if (this.stopped) return;
      this.deviceKeys = device;
    }
    if (this.stopped) return;
    let status = await this.request("/api/sync/status");
    if (!status.enabled) {
      this.onState({ state: "disabled", message: "Device sync is off." });
      return;
    }
    await this.store.requeueAfterRelayReset(status.latestCursor);
    await this.store.updateSyncServerState(status);
    this.onState({ state: "syncing", message: "Syncing this device…" });
    let devices = await this.loadDeviceDirectory();
    await this.receiveProvisioning(devices);
    status = await this.request("/api/sync/status");
    await this.store.updateSyncServerState(status);

    const storedSyncState = await this.store.getSyncState();
    const localRotation = storedSyncState?.pendingRotation;
    if (localRotation && status.currentEpoch >= localRotation.epoch)
      await this.reconcilePendingRotation(localRotation, status);

    let currentKey = await this.keyStore.getEpoch(
      this.identity.householdId,
      status.currentEpoch,
    );
    const ownDevice = devices.find(
      (device) => device.deviceId === this.identity.deviceId,
    );
    if (
      !currentKey &&
      status.currentEpoch === 1 &&
      status.eventCount === 0 &&
      (ownDevice?.historyFromEpoch ?? 1) <= status.currentEpoch
    ) {
      const initial = await createHouseholdEpochKey({
        householdId: this.identity.householdId,
        keyEpoch: 1,
        deviceKeys: this.deviceKeys.keys,
      });
      currentKey = await this.keyStore.saveEpoch({
        householdId: this.identity.householdId,
        keyEpoch: 1,
        ...initial,
      });
    }
    if (
      !currentKey &&
      ownDevice?.historyFromEpoch > status.currentEpoch &&
      status.rotationPending
    ) {
      throw new Error(
        "An existing trusted device needs to finish setting up household sync first.",
      );
    }
    if (status.rotationPending && currentKey) {
      await this.commitRotation();
      status = await this.request("/api/sync/status");
      await this.store.updateSyncServerState(status);
      devices = await this.loadDeviceDirectory();
      currentKey = await this.keyStore.getEpoch(
        this.identity.householdId,
        status.currentEpoch,
      );
    }
    if (!currentKey) {
      throw new Error(
        "This device needs an authorized household key before sync can continue.",
      );
    }

    const bootstrap = await this.store.getSyncBootstrap();
    const remoteBindings = await this.fetchBindings(devices);
    const needsLegacyBinding = bootstrap.events.some(
      (row) =>
        idToHex(row.household_id) !== this.identity.householdId ||
        idToHex(row.actor_id) !== this.identity.memberId ||
        idToHex(row.device_id) !== this.identity.deviceId,
    );
    let legacyBindingEnvelope = null;
    if (
      needsLegacyBinding &&
      !remoteBindings.some((record) =>
        sameLegacyTuple(record.binding, bootstrap.legacyIdentity),
      )
    ) {
      const binding = {
        legacyHouseholdId: bootstrap.legacyIdentity.householdId,
        legacyActorId: bootstrap.legacyIdentity.actorId,
        legacyDeviceId: bootstrap.legacyIdentity.deviceId,
        householdId: this.identity.householdId,
        actorId: this.identity.memberId,
        deviceId: this.identity.deviceId,
      };
      legacyBindingEnvelope = await encryptIdentityBinding({
        binding,
        householdId: this.identity.householdId,
        deviceId: this.identity.deviceId,
        deviceSequence: 1,
        logicalTime: (bootstrap.maxLogicalTime + 1n).toString(),
        keyEpoch: status.currentEpoch,
        householdKey: currentKey.householdKey,
        signingKey: this.deviceKeys.keys.signingPrivateKey,
      });
      remoteBindings.push({ binding, envelope: legacyBindingEnvelope });
    }

    let syncState = await this.store.getSyncState();
    if (!syncState) {
      await this.store.initializeSync({
        identity: this.identity,
        serverStatus: status,
        identityBindings: remoteBindings,
        legacyBindingEnvelope,
      });
    } else if (remoteBindings.length) {
      await this.store.installIdentityBindings(remoteBindings, this.identity);
    }

    await this.provisionMemberHistory(status.currentEpoch, devices);
    await this.pushIdentityBindings();
    await this.pushPendingEvents();
    let passes = 0;
    let hasMore = true;
    while (hasMore && passes < MAX_PULL_PASSES) {
      const syncStateBefore = await this.store.getSyncState();
      const page = await this.request(
        `/api/sync/events?cursor=${encodeURIComponent(syncStateBefore.syncCursor)}&limit=${MAX_PUSH_BATCH}`,
      );
      const verified = [];
      for (const item of page.events) {
        const envelope = item.envelope;
        const signer = devices.find(
          (device) => device.deviceId === envelope.deviceId,
        );
        if (!signer?.publicKeys)
          throw new Error(
            "A synchronized event came from an unknown trusted device.",
          );
        if (signer.revokedAt && envelope.keyEpoch >= status.currentEpoch)
          throw new Error(
            "A revoked device cannot author events in the current key epoch.",
          );
        if (envelope.keyEpoch < signer.historyFromEpoch)
          throw new Error(
            "This device is not authorized to receive that event history.",
          );
        const epoch = await this.keyStore.getEpoch(
          this.identity.householdId,
          envelope.keyEpoch,
        );
        if (!epoch)
          throw new Error(
            `This device is missing key epoch ${envelope.keyEpoch}; sync is paused.`,
          );
        const encodedEvent = await decryptWithDeviceHistory({
          device: signer,
          envelope,
          householdKey: epoch.householdKey,
        });
        validateCanonicalIdentity({
          encodedEvent,
          envelope,
          signer,
          householdId: this.identity.householdId,
          bindings: remoteBindings.map((record) => record.binding),
          engine: this.engine,
        });
        verified.push({ encodedEvent });
      }
      const committed = await this.store.commitRemoteBatch({
        received: verified,
        nextCursor: page.nextCursor,
        engine: this.engine,
      });
      this.onState({
        state: "syncing",
        message: committed.added
          ? "Household changes received."
          : "Device sync is up to date.",
        projection: committed.state,
        snapshotBoundary: committed.snapshotBoundary,
      });
      hasMore = page.hasMore;
      passes += 1;
    }

    const pendingOutbox = await this.store.getPendingOutbox(1);
    const pendingBindings = await this.store.getPendingBindings();
    if (!hasMore && pendingOutbox.length === 0 && pendingBindings.length === 0)
      await this.store.markSyncInitialized();
    this.onState({
      state: hasMore ? "syncing" : "ready",
      message: hasMore
        ? "Sync will continue in the background."
        : "Device sync is up to date.",
    });
  }

  async loadDeviceDirectory() {
    const { devices } = await this.request("/api/sync/devices");
    const byId = new Map(devices.map((device) => [device.deviceId, device]));
    const verified = new Set();
    const checking = new Set();
    const verify = async (deviceId) => {
      if (verified.has(deviceId)) return;
      if (checking.has(deviceId))
        throw new Error(
          "Kin found a cycle in the trusted-device approval chain.",
        );
      const device = byId.get(deviceId);
      if (!device?.publicKeys || !device.fingerprint)
        throw new Error(
          "A trusted device must register its sync key before synchronization.",
        );
      if (device.householdId !== this.identity.householdId)
        throw new Error(
          "A trusted-device directory entry belongs to another household.",
        );
      if (
        (await deviceKeyFingerprint(device.publicKeys)) !== device.fingerprint
      )
        throw new Error(
          "A trusted device key does not match its approved fingerprint.",
        );
      const keyHistory = await verifiedDeviceKeyHistory(device);
      device.verifiedKeyHistory = keyHistory;
      if (deviceId === this.identity.deviceId) {
        if (
          device.memberId !== this.identity.memberId ||
          device.fingerprint !== this.deviceKeys.fingerprint
        )
          throw new Error(
            "This browser's local sync key does not match its trusted-device record.",
          );
        verified.add(deviceId);
        return;
      }
      const pin = await this.keyStore.getPinnedDevice(
        this.identity.householdId,
        deviceId,
      );
      if (pin) {
        if (
          pin.memberId !== device.memberId ||
          !keyHistory.some(entry => entry.fingerprint === pin.fingerprint)
        )
          throw new Error(
            "A trusted device key changed after it was approved.",
          );
        if (pin.fingerprint !== device.fingerprint)
          await this.keyStore.advanceTrustedDevice({ ...pin, publicKeys: device.publicKeys, fingerprint: device.fingerprint }, pin.fingerprint);
        verified.add(deviceId);
        return;
      }
      const certificate = device.certificate;
      const issuer = byId.get(certificate?.issuerDeviceId);
      if (!certificate || !issuer)
        throw new Error(
          "A trusted device has no verifiable approval certificate.",
        );
      checking.add(deviceId);
      await verify(issuer.deviceId);
      const issuerKey = issuer.verifiedKeyHistory.find(entry => entry.fingerprint === certificate.issuerFingerprint);
      if (!issuerKey) throw new Error("The device approval issuer key is not in its verified history.");
      await verifyDeviceAuthorizationCertificate({
        certificate,
        issuerPublicKeys: issuerKey.publicKeys,
        issuerDeviceId: issuer.deviceId,
        device: { ...device, ...keyHistory[0] },
      });
      checking.delete(deviceId);
      verified.add(deviceId);
    };
    for (const device of devices)
      if (device.publicKeys || device.deviceId === this.identity.deviceId)
        await verify(device.deviceId);
    return devices;
  }

  async receiveProvisioning(devices) {
    while (true) {
      const { grants } = await this.request("/api/sync/provisioning");
      if (grants.length === 0) return;
      for (const grant of grants) {
        const sender = devices.find(
          (device) => device.deviceId === grant.senderDeviceId,
        );
        if (!sender?.publicKeys)
          throw new Error(
            "A key transfer came from an unknown trusted device.",
          );
        let received;
        for (const entry of [...sender.verifiedKeyHistory].reverse()) {
          const signer = await importDevicePublicKeys(entry.publicKeys);
          try {
            received = await unwrapEpochKey({ package: grant.package, deviceKeys: this.deviceKeys.keys,
              householdId: this.identity.householdId, deviceId: this.identity.deviceId,
              deviceFingerprint: this.deviceKeys.fingerprint, senderSigningKey: signer.signing });
            break;
          } catch (error) { if (error.code !== "provisioning_signature_invalid") throw error; }
        }
        if (!received) throw new Error("A household key transfer has no valid historical signer.");
        await this.keyStore.saveEpoch({
          householdId: this.identity.householdId,
          keyEpoch: grant.keyEpoch,
          ...received,
        });
        await this.request(`/api/sync/provisioning/${grant.grantId}/ack`, {
          method: "POST",
          body: "{}",
        });
      }
    }
  }

  async commitRotation() {
    // A previous submission may have committed even when its response was lost.
    // Reconcile before changing its packages, keeping the proposal's exact key.
    const status = await this.request("/api/sync/status");
    let pending = (await this.store.getSyncState())?.pendingRotation;
    if (pending && await this.reconcilePendingRotation(pending, status)) return;
    if (!status.rotationPending) return;
    const expectedEpoch = status.currentEpoch;
    const epoch = expectedEpoch + 1;
    const devices = await this.loadDeviceDirectory();
    const recipients = devices.filter((device) =>
      device.deviceId !== this.identity.deviceId && !device.revokedAt && device.publicKeys);
    if (!pending) {
      const currentKey = await this.keyStore.getEpoch(
        this.identity.householdId,
        expectedEpoch,
      );
      if (!currentKey)
        throw new Error(
          "The current household key is unavailable for rotation.",
        );
      const rotation = await createProvisionedHouseholdEpoch({
        householdId: this.identity.householdId,
        keyEpoch: epoch,
        deviceKeys: this.deviceKeys.keys,
        senderDeviceId: this.identity.deviceId,
        recipients,
        expiresAt: Date.now() + KEY_GRANT_TTL_MS,
      });
      pending = await this.store.savePendingRotation({
        expectedEpoch,
        epoch,
        proposalId: randomIdHex(),
        sealed: rotation.sealed,
        fingerprint: rotation.fingerprint,
        packages: rotation.packages,
        issuerFingerprint: this.deviceKeys.fingerprint,
      });
    } else if (pending.issuerFingerprint !== this.deviceKeys.fingerprint ||
        pending.packages.length !== recipients.length ||
        recipients.some((recipient) => !pending.packages.some((keyPackage) =>
          keyPackage.recipientDeviceId === recipient.deviceId &&
          keyPackage.recipientFingerprint === recipient.fingerprint &&
          keyPackage.expiresAt > Date.now()))) {
      const expiresAt = Date.now() + KEY_GRANT_TTL_MS;
      const packages = await Promise.all(recipients.map((recipient) =>
        provisionSealedEpochKey({
          sealed: pending.sealed, deviceKeys: this.deviceKeys.keys,
          grant: {
            householdId: this.identity.householdId, keyEpoch: pending.epoch,
            senderDeviceId: this.identity.deviceId,
            recipientDeviceId: recipient.deviceId,
            recipientPublicKeys: recipient.publicKeys,
            recipientFingerprint: recipient.fingerprint,
            grantId: randomIdHex(), expiresAt,
            signingKey: this.deviceKeys.keys.signingPrivateKey,
          },
        })));
      pending = await this.store.replacePendingRotationPackages({
        expected: pending, packages, issuerFingerprint: this.deviceKeys.fingerprint,
      });
    }
    const result = await this.request("/api/sync/epochs", {
      method: "POST",
      body: JSON.stringify({
        expectedEpoch: pending.expectedEpoch,
        packages: pending.packages,
        proposalId: pending.proposalId,
      }),
    });
    if (result.currentEpoch !== pending.epoch || result.proposalId !== pending.proposalId)
      throw new Error("Kin could not match the accepted key rotation.");
    await this.acceptPendingRotation(pending);
    await this.provisionMemberHistory(
      result.currentEpoch,
      await this.loadDeviceDirectory(),
    );
  }

  async reconcilePendingRotation(pending, status) {
    if (status.currentEpoch === pending.expectedEpoch) return false;
    if (status.currentEpoch === pending.epoch && status.lastRotationProposalId === pending.proposalId) {
      await this.acceptPendingRotation(pending);
      return true;
    }
    if (status.currentEpoch < pending.epoch ||
        !await this.keyStore.getEpoch(this.identity.householdId, status.currentEpoch))
      throw new Error("Another trusted device completed key rotation. This device needs its approved key transfer.");
    await this.store.clearPendingRotation(pending.proposalId);
    return true;
  }

  async acceptPendingRotation(pending) {
    const householdKey = await restoreHouseholdEpochKey({
      sealed: pending.sealed,
      deviceKeys: this.deviceKeys.keys,
    });
    await this.keyStore.saveEpoch({
      householdId: this.identity.householdId,
      keyEpoch: pending.epoch,
      householdKey,
      sealed: pending.sealed,
      fingerprint: pending.fingerprint,
    });
    await this.store.commitPendingRotation({
      expectedEpoch: pending.expectedEpoch,
      currentEpoch: pending.epoch,
      proposalId: pending.proposalId,
    });
  }

  async provisionMemberHistory(currentEpoch, devices) {
    let prepared = 0;
    for (const recipient of devices) {
      if (
        recipient.deviceId === this.identity.deviceId ||
        recipient.revokedAt ||
        (recipient.historyFromEpoch ?? 1) > currentEpoch ||
        !recipient.publicKeys
      )
        continue;
      for (
        let keyEpoch = recipient.historyFromEpoch ?? 1;
        keyEpoch <= currentEpoch;
        keyEpoch += 1
      ) {
        if (recipient.provisionedEpochs?.includes(keyEpoch)) continue;
        const request = await this.store.getProvisioningRequest(
          recipient.deviceId,
          keyEpoch,
        );
        if (request.accepted && request.package?.expiresAt > Date.now() &&
            request.package.recipientFingerprint === recipient.fingerprint &&
            request.issuerFingerprint === this.deviceKeys.fingerprint) continue;
        if (prepared >= MAX_PUSH_BATCH) return;
        const key = await this.keyStore.getEpoch(
          this.identity.householdId,
          keyEpoch,
        );
        // Another authorized device may hold this entitled epoch. A local
        // absence must not prevent this device from syncing the keys it has.
        if (!key) continue;
        const grant = await this.request("/api/sync/provisioning/grants", {
          method: "POST",
          body: JSON.stringify({
            recipientDeviceId: recipient.deviceId,
            keyEpoch,
            requestId: request.requestId,
          }),
        });
        let keyPackage = request.package;
        if (
          !keyPackage ||
          keyPackage.grantId !== grant.grantId ||
          keyPackage.expiresAt <= Date.now() ||
          keyPackage.recipientFingerprint !== recipient.fingerprint ||
          request.issuerFingerprint !== this.deviceKeys.fingerprint
        ) {
          keyPackage = await provisionSealedEpochKey({
            sealed: key.sealed,
            deviceKeys: this.deviceKeys.keys,
            grant: {
              ...grant,
              recipientPublicKeys: grant.recipientPublicKeys,
              signingKey: this.deviceKeys.keys.signingPrivateKey,
            },
          });
          await this.store.updateProvisioningRequest(request.requestId, {
            package: keyPackage,
            issuerFingerprint: this.deviceKeys.fingerprint,
            accepted: false,
          });
        }
        await this.request(`/api/sync/provisioning/grants/${grant.grantId}`, {
          method: "POST",
          body: JSON.stringify({ package: keyPackage }),
        });
        await this.store.updateProvisioningRequest(request.requestId, {
          accepted: true,
        });
        prepared++;
      }
    }
  }

  async fetchBindings(devices) {
    const result = [];
    let cursor = "";
    while (true) {
      const page = await this.request(
        `/api/sync/bindings?cursor=${encodeURIComponent(cursor)}`,
      );
      for (const envelope of page.bindings) {
        const sender = devices.find(
          (device) => device.deviceId === envelope.deviceId,
        );
        if (!sender?.publicKeys)
          throw new Error(
            "A household identity record came from an unknown device.",
          );
        const epoch = await this.keyStore.getEpoch(
          this.identity.householdId,
          envelope.keyEpoch,
        );
        if (!epoch)
          throw new Error(
            `A historical identity key for epoch ${envelope.keyEpoch} is missing.`,
          );
        let binding;
        for (const entry of [...sender.verifiedKeyHistory].reverse()) {
          const signer = await importDevicePublicKeys(entry.publicKeys);
          try {
            binding = await decryptIdentityBinding({ envelope, householdKey: epoch.householdKey,
              signingKey: signer.signing, expectedHouseholdId: this.identity.householdId });
            break;
          } catch (error) { if (error.code !== "event_signature_invalid") throw error; }
        }
        if (!binding) throw new Error("A household identity record has no valid historical signer.");
        if (
          binding.actorId !== sender.memberId ||
          binding.deviceId !== sender.deviceId
        )
          throw new Error(
            "A household identity record does not match its trusted signer.",
          );
        result.push({ binding, envelope });
      }
      if (!page.hasMore) break;
      if (page.nextCursor === cursor)
        throw new Error("Kin could not advance the household identity cursor.");
      cursor = page.nextCursor;
    }
    return result;
  }

  async pushIdentityBindings() {
    const pending = await this.store.getPendingBindings();
    for (const record of pending) {
      await this.request("/api/sync/bindings", {
        method: "POST",
        body: JSON.stringify({ bindings: [record.controlEnvelope] }),
      });
      await this.store.markBindingUploaded(record.legacy_key);
    }
  }

  async pushPendingEvents() {
    while (true) {
      const pending = await this.store.getPendingOutbox(MAX_PUSH_BATCH);
      if (!pending.length) return;
      const envelopes = [];
      for (const row of pending) {
        if (row.envelope) {
          envelopes.push(row.envelope);
          continue;
        }
        if (row.keyEpoch == null)
          throw new Error(
            "Device sync is paused until household key rotation completes.",
          );
        const keyEpoch = row.keyEpoch;
        const epoch = await this.keyStore.getEpoch(
          this.identity.householdId,
          keyEpoch,
        );
        if (!epoch)
          throw new Error(
            `The current household key epoch ${keyEpoch} is missing.`,
          );
        const metadata = this.engine.eventMetadata(row.canonical_event);
        const envelope = await encryptEvent({
          eventId: row.event_id,
          householdId: row.householdId,
          deviceId: row.deviceId,
          deviceSequence: row.deviceSequence,
          logicalTime: metadata.logicalTime.toString(),
          keyEpoch,
          plaintext: row.canonical_event,
          householdKey: epoch.householdKey,
          signingKey: this.deviceKeys.keys.signingPrivateKey,
        });
        await this.store.storeOutboxEnvelope(row.event_id, envelope, keyEpoch);
        envelopes.push(envelope);
      }
      const acknowledgement = await this.request("/api/sync/events", {
        method: "POST",
        body: JSON.stringify({ events: envelopes }),
      });
      for (const envelope of envelopes)
        await this.store.markOutboxAccepted(
          envelope.eventId,
          acknowledgement.latestCursor,
        );
    }
  }

  async request(path, options = {}) {
    if (this.stopped) throw new Error("Device sync was stopped.");
    this.keyStore?.vault.assertUnlocked();
    await this.keyStore?.vault.checkSecurityEpoch?.();
    const result = await api(path, { ...options, signal: this.abortController.signal });
    if (this.stopped) throw new Error("Device sync was stopped.");
    // A peer may advance the durable lock/root epoch while this response is in
    // flight even when its broadcast is missed. Reject before using private keys
    // to process provisioning or exposing the response to the sync continuation.
    await this.keyStore?.vault.checkSecurityEpoch?.();
    if (this.stopped) throw new Error("Device sync was stopped.");
    this.keyStore?.vault.assertUnlocked();
    return result;
  }

  stop() {
    this.stopped = true;
    this.abortController.abort();
    clearInterval(this.timer);
    this.timer = null;
    this.keyStore?.close();
    this.keyStore = null;
    this.deviceKeys = null;
    this.engine = null;
    this.store = null;
  }
}

function validateCanonicalIdentity({ encodedEvent, envelope, signer, householdId, bindings, engine }) {
  const metadata = engine.eventMetadata(encodedEvent);
  const eventId = idToHex(metadata.eventId);
  const embeddedHousehold = idToHex(metadata.householdId);
  const embeddedActor = idToHex(metadata.actorId);
  const embeddedDevice = idToHex(metadata.deviceId);
  if (eventId !== envelope.eventId || envelope.householdId !== householdId ||
      metadata.logicalTime.toString() !== envelope.logicalTime)
    throw new Error("The encrypted envelope does not match its canonical event bytes.");
  const directIdentity =
    embeddedHousehold === householdId &&
    embeddedActor === signer.memberId &&
    embeddedDevice === envelope.deviceId;
  if (directIdentity) return;
  const binding = bindings.find(
    (candidate) =>
      candidate.legacyHouseholdId === embeddedHousehold &&
      candidate.legacyActorId === embeddedActor &&
      candidate.legacyDeviceId === embeddedDevice,
  );
  if (
    !binding ||
    binding.householdId !== householdId ||
    binding.actorId !== signer.memberId ||
    binding.deviceId !== envelope.deviceId
  )
    throw new Error(
      "A synchronized event's embedded identity could not be verified.",
    );
}

function sameLegacyTuple(binding, identity) {
  return (
    binding.legacyHouseholdId === identity.householdId &&
    binding.legacyActorId === identity.actorId &&
    binding.legacyDeviceId === identity.deviceId
  );
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      value.message || "Kin could not synchronize this device.",
    );
    error.code = value.error;
    throw error;
  }
  return value;
}

function randomIdHex() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

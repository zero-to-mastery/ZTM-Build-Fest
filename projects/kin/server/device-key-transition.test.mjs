import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingService } from './pairing-service.mjs';
import { EncryptedSyncService } from './sync-service.mjs';
import { DurableStore } from './durable-store.mjs';
import {
  generateDeviceKeys, generateProtectedDeviceKeys, exportDevicePublicKeys, deviceKeyFingerprint,
  createDeviceKeyTransition, verifiedDeviceKeyHistory, decryptWithDeviceHistory,
  createHouseholdEpochKey, resealHouseholdEpoch, restoreHouseholdEpochKey, encryptEvent,
} from '../web/sync/crypto.js';

async function fixture() {
  const service = new PairingService();
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  const adult = service.bootstrap({ credential: { id: 'adult', publicKey: 'key', algorithm: -7 }, syncPublicKeys: publicKeys });
  const sync = new EncryptedSyncService(service);
  const next = await generateProtectedDeviceKeys();
  const transition = await createDeviceKeyTransition({ ...adult, generation: 1,
    oldFingerprint: await deviceKeyFingerprint(publicKeys), publicKeys: await exportDevicePublicKeys(next.keys),
    signingKey: keys.signingPrivateKey });
  return { service, sync, adult, keys, publicKeys, next, transition };
}

test('device successor requires exact identity, old signature and expected generation, then retries once', async () => {
  const f = await fixture();
  const { service, adult, transition } = f;
  for (const patch of [{ memberId: 'f'.repeat(32) }, { generation: 2 }, { oldFingerprint: 'f'.repeat(64) },
    { signature: transition.signature.slice(0, -1) + (transition.signature.at(-1) === 'A' ? 'B' : 'A') }]) {
    assert.throws(() => service.transitionSyncPublicKeys(adult.sessionToken, { ...transition, ...patch }));
    assert.equal(service.devices.get(adult.deviceId).syncKeyGeneration, undefined);
  }
  assert.equal(service.transitionSyncPublicKeys(adult.sessionToken, transition).retried, false);
  assert.equal(service.transitionSyncPublicKeys(adult.sessionToken, transition).retried, true);
  assert.equal(service.devices.get(adult.deviceId).syncKeyHistory.length, 2);
  assert.throws(() => service.transitionSyncPublicKeys(adult.sessionToken, { ...transition, transitionId: 'f'.repeat(32) }));
});

test('signed directory history preserves exact historic envelopes and rejects substituted keys', async () => {
  const f = await fixture();
  const epoch = await createHouseholdEpochKey({ householdId: f.adult.householdId, keyEpoch: 1, deviceKeys: f.keys });
  const plaintext = new TextEncoder().encode('protected canonical history');
  const envelope = await encryptEvent({ eventId: '1'.repeat(32), householdId: f.adult.householdId,
    deviceId: f.adult.deviceId, deviceSequence: 1, logicalTime: 1, keyEpoch: 1,
    plaintext, householdKey: epoch.householdKey, signingKey: f.keys.signingPrivateKey });
  f.service.transitionSyncPublicKeys(f.adult.sessionToken, f.transition);
  const device = f.sync.deviceDirectory(f.adult.sessionToken)[0];
  assert.equal((await verifiedDeviceKeyHistory(device)).length, 2);
  assert.deepEqual(await decryptWithDeviceHistory({ device, envelope, householdKey: epoch.householdKey }), plaintext);
  const tampered = structuredClone(device);
  tampered.keyTransitions[0].memberId = 'f'.repeat(32);
  await assert.rejects(verifiedDeviceKeyHistory(tampered));
  const stripped = { ...device, keyHistory: device.keyHistory.slice(1) };
  await assert.rejects(verifiedDeviceKeyHistory(stripped));
});

test('new runtime private keys are nonextractable and old self-seals move to successor without changing epoch', async () => {
  const f = await fixture();
  assert.equal(f.next.keys.agreementPrivateKey.extractable, false);
  assert.equal(f.next.keys.signingPrivateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', f.next.keys.signingPrivateKey));
  const epoch = await createHouseholdEpochKey({ householdId: f.adult.householdId, keyEpoch: 1, deviceKeys: f.keys });
  const sealed = await resealHouseholdEpoch({ sealed: epoch.sealed, oldDeviceKeys: f.keys, newDeviceKeys: f.next.keys });
  await assert.rejects(restoreHouseholdEpochKey({ sealed, deviceKeys: f.keys }));
  const restored = await restoreHouseholdEpochKey({ sealed, deviceKeys: f.next.keys });
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, epoch.householdKey, new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, restored, ciphertext)), new Uint8Array([1, 2, 3]));
});

test('key transition purges obsolete provisioning and retry maps, preserving relay history and epochs', async () => {
  const f = await fixture();
  const state = f.sync.state(f.adult.householdId);
  const envelope = { ciphertext: 'opaque' };
  state.records.push(envelope);
  state.grants.set('old', { senderDeviceId: f.adult.deviceId, recipientDeviceId: 'other' });
  state.grantRequests.set('request', 'old');
  state.grants.set('unrelated', { senderDeviceId: 'other', recipientDeviceId: 'third' });
  f.service.transitionSyncPublicKeys(f.adult.sessionToken, f.transition);
  f.sync.onDeviceKeyTransition(f.adult.householdId, f.adult.deviceId);
  assert.equal(state.grants.has('old'), false);
  assert.equal(state.grantRequests.size, 0);
  assert.equal(state.grants.has('unrelated'), true);
  assert.equal(state.records[0], envelope);
  assert.equal(state.currentEpoch, 1);
  assert.equal(state.rotationPending, false);
});

test('logged-out sessions cannot install successors', async () => {
  const f = await fixture();
  f.service.logout(f.adult.sessionToken);
  assert.throws(() => f.service.transitionSyncPublicKeys(f.adult.sessionToken, f.transition));
  assert.equal(f.service.devices.get(f.adult.deviceId).syncKeyGeneration, undefined);
});
import { createKinServer } from './server.mjs';

test('HTTP key successor authenticates and applies idempotently without dropping device identity', async () => {
  const f = await fixture();
  const app = createKinServer({
    service: f.service,
    syncService: f.sync,
    store: new DurableStore(':memory:'),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}/api/sync/device-keys/successor`;
  try {
    const call = token => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { Cookie: `kin_session=${token}` } : {}) }, body: JSON.stringify({ transition: f.transition }) });
    assert.equal((await call(null)).status, 401);
    const first = await call(f.adult.sessionToken);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).retried, false);
    const retry = await call(f.adult.sessionToken);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).retried, true);
    const authorized = f.service.authorize(f.adult.sessionToken);
    assert.equal(authorized.device.id, f.adult.deviceId);
    assert.equal(authorized.member.id, f.adult.memberId);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
});
import { SyncCoordinator } from '../web/sync/sync-coordinator.js';
import { provisionSealedEpochKey, unwrapEpochKey } from '../web/sync/crypto.js';

test('successor provisioning repairs accepted packages discarded by the server for an older fingerprint', async () => {
  const f = await fixture();
  const recipientKeys = await generateDeviceKeys();
  const recipientPublicKeys = await exportDevicePublicKeys(recipientKeys);
  const recipient = { deviceId: 'e'.repeat(32), memberId: f.adult.memberId, householdId: f.adult.householdId,
    historyFromEpoch: 1, publicKeys: recipientPublicKeys, fingerprint: await deviceKeyFingerprint(recipientPublicKeys), provisionedEpochs: [] };
  const epoch = await createHouseholdEpochKey({ householdId: f.adult.householdId, keyEpoch: 1, deviceKeys: f.keys });
  const sealed = await resealHouseholdEpoch({ sealed: epoch.sealed, oldDeviceKeys: f.keys, newDeviceKeys: f.next.keys });
  const grant = { householdId: f.adult.householdId, keyEpoch: 1, senderDeviceId: f.adult.deviceId,
    recipientDeviceId: recipient.deviceId, recipientFingerprint: recipient.fingerprint, recipientPublicKeys,
    grantId: 'f'.repeat(32), expiresAt: Date.now() + 60000 };
  const oldPackage = await provisionSealedEpochKey({ sealed: epoch.sealed, deviceKeys: f.keys,
    grant: { ...grant, signingKey: f.keys.signingPrivateKey } });
  const request = { requestId: '9'.repeat(32), accepted: true, package: oldPackage,
    issuerFingerprint: await deviceKeyFingerprint(f.publicKeys) };
  const coordinator = new SyncCoordinator({ identity: f.adult, engine: {}, store: {
    async getProvisioningRequest() { return structuredClone(request); },
    async updateProvisioningRequest(id, values) { Object.assign(request, values); },
  } });
  coordinator.deviceKeys = { keys: f.next.keys, fingerprint: f.transition.fingerprint };
  coordinator.keyStore = { async getEpoch() { return { ...epoch, sealed }; } };
  let submitted;
  coordinator.request = async (path, options) => {
    if (path === '/api/sync/provisioning/grants') return { ...grant, grantId: '8'.repeat(32) };
    submitted = JSON.parse(options.body).package;
    return { accepted: true };
  };
  await coordinator.provisionMemberHistory(1, [recipient]);
  assert.ok(submitted);
  assert.notEqual(submitted.signature, oldPackage.signature);
  assert.equal(request.issuerFingerprint, f.transition.fingerprint);
  assert.equal(request.accepted, true);
  const restored = await unwrapEpochKey({ package: submitted, deviceKeys: recipientKeys,
    householdId: f.adult.householdId, deviceId: recipient.deviceId, deviceFingerprint: recipient.fingerprint,
    senderSigningKey: f.next.keys.signingPublicKey });
  assert.equal(restored.fingerprint, epoch.fingerprint);
});
import { createDeviceAuthorizationCertificate } from '../web/sync/crypto.js';

test('cross-adult grant repair retains post-join epochs and rejects pre-join history for recipient and sender', async () => {
  const f = await fixture();
  const recipientKeys = await generateDeviceKeys();
  const recipientPublicKeys = await exportDevicePublicKeys(recipientKeys);
  const invite = f.service.createPairing(f.adult.sessionToken);
  const claim = f.service.claimPairing({ code: invite.code, deviceLabel: 'Partner device', credential: { id: 'partner', publicKey: 'partner-key', algorithm: -7 },
    syncPublicKeys: recipientPublicKeys });
  const pending = f.service.pairings.get(invite.pairingId).claimant;
  const certificate = await createDeviceAuthorizationCertificate({ householdId: f.adult.householdId,
    memberId: pending.memberId, deviceId: pending.deviceId, issuerDeviceId: f.adult.deviceId,
    issuerFingerprint: await deviceKeyFingerprint(f.publicKeys), publicKeys: recipientPublicKeys,
    signingKey: f.keys.signingPrivateKey });
  f.service.approvePairing(f.adult.sessionToken, invite.pairingId, claim.version, certificate);
  const recipient = f.service.activateClaim(claim.claimToken);
  const state = f.sync.state(f.adult.householdId);
  state.currentEpoch = 3;
  const recipientDevice = f.service.devices.get(recipient.deviceId);
  recipientDevice.syncHistoryFromEpoch = 2;
  const request = { recipientDeviceId: recipient.deviceId, keyEpoch: 2, requestId: '7'.repeat(32) };
  const oldGrant = f.sync.createProvisioningGrant(f.adult.sessionToken, request);
  f.sync.onDeviceKeyTransition(f.adult.householdId, recipient.deviceId);
  const repaired = f.sync.createProvisioningGrant(f.adult.sessionToken, request);
  assert.notEqual(repaired.grantId, oldGrant.grantId);
  assert.equal(repaired.keyEpoch, 2);
  assert.throws(() => f.sync.createProvisioningGrant(f.adult.sessionToken, { ...request, requestId: '6'.repeat(32), keyEpoch: 1 }),
    error => error.code === 'provisioning_device_mismatch');
  assert.throws(() => f.sync.createProvisioningGrant(recipient.sessionToken, {
    recipientDeviceId: f.adult.deviceId, keyEpoch: 1, requestId: '5'.repeat(32),
  }), error => error.code === 'provisioning_device_mismatch');
  assert.equal(state.grants.size, 1);
});

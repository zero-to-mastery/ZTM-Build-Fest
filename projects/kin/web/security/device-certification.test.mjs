// Member certification keys (ADR 0018 section 3, #568/#570): endorsements,
// version 2 device certificates, and household devices accepting a device
// certified through its member's account (sync-coordinator's directory check).
import assert from "node:assert/strict";
import test from "node:test";
import { generateCertificationKey } from "./account-vault.js";
import {
  certificationKeyPair,
  createCertificationEndorsement,
  createMemberCertificate,
  verifyMemberCertificate,
  verifyOwnEndorsement,
} from "./device-certification.js";
import {
  createDeviceAuthorizationCertificate,
  deviceKeyFingerprint,
  exportDevicePublicKeys,
  generateDeviceKeys,
} from "../sync/crypto.js";
import { SyncCoordinator } from "../sync/sync-coordinator.js";

const HOUSEHOLD = "a".repeat(32);
const MEMBER = "b".repeat(32);
const OTHER_MEMBER = "c".repeat(32);

async function device(deviceId, memberId = MEMBER) {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  return { deviceId, memberId, householdId: HOUSEHOLD, keys, publicKeys, fingerprint: await deviceKeyFingerprint(publicKeys) };
}

async function fixture() {
  const certification = await certificationKeyPair((await generateCertificationKey()).pkcs8);
  const endorser = await device("1".repeat(32));
  const endorsement = await createCertificationEndorsement({
    householdId: HOUSEHOLD, memberId: MEMBER, certification,
    device: { deviceId: endorser.deviceId, fingerprint: endorser.fingerprint, signingKey: endorser.keys.signingPrivateKey },
    anchors: [{ deviceId: "9".repeat(32), fingerprint: "f".repeat(64) }],
  });
  const fresh = await device("2".repeat(32));
  const certificate = await createMemberCertificate({ householdId: HOUSEHOLD, memberId: MEMBER, endorsement, certification, device: fresh });
  return { certification, endorser, endorsement, fresh, certificate };
}

test("a device certificate signed by the member's certification key verifies against the endorsing device", async () => {
  const { endorser, fresh, certificate, certification } = await fixture();
  const fingerprint = await verifyMemberCertificate({ certificate, device: fresh, issuerPublicKeys: endorser.publicKeys, issuerMemberId: MEMBER });
  assert.equal(fingerprint, certification.fingerprint);
});

test("a certificate is refused when its endorser is another member's, another key, or anything changed", async () => {
  const { endorser, fresh, certificate } = await fixture();
  const refuse = (overrides) => assert.rejects(verifyMemberCertificate({ certificate, device: fresh, issuerPublicKeys: endorser.publicKeys, issuerMemberId: MEMBER, ...overrides }),
    (error) => error.code === "device_certificate_invalid");
  await refuse({ issuerMemberId: OTHER_MEMBER });
  await refuse({ issuerPublicKeys: (await device("3".repeat(32))).publicKeys });
  await refuse({ device: { ...fresh, deviceId: "4".repeat(32) } });
  await refuse({ certificate: { ...certificate, deviceId: "4".repeat(32) } });
  await refuse({ certificate: { ...certificate, endorsement: { ...certificate.endorsement, anchors: [{ deviceId: endorser.deviceId, fingerprint: endorser.fingerprint }] } } });
  // A certificate signed by a key the endorsement doesn't name.
  const stranger = await certificationKeyPair((await generateCertificationKey()).pkcs8);
  const forged = await createMemberCertificate({ householdId: HOUSEHOLD, memberId: MEMBER, endorsement: certificate.endorsement,
    certification: { ...stranger, fingerprint: certificate.endorsement.fingerprint }, device: fresh });
  await refuse({ certificate: forged });
});

test("a new device trusts the service's endorsement only when it is this vault's certification key", async () => {
  const { endorsement, certification } = await fixture();
  const anchors = await verifyOwnEndorsement(endorsement, { householdId: HOUSEHOLD, memberId: MEMBER, certification });
  assert.deepEqual(anchors.map((anchor) => anchor.deviceId), ["1".repeat(32), "9".repeat(32)], "the endorser and its anchors");
  const other = await certificationKeyPair((await generateCertificationKey()).pkcs8);
  await assert.rejects(verifyOwnEndorsement(endorsement, { householdId: HOUSEHOLD, memberId: MEMBER, certification: other }),
    (error) => error.code === "certification_mismatch");
  // An endorsement for the right key but made without it (only the service
  // and a device key) has no valid certification signature.
  const tampered = { ...endorsement, anchors: [...endorsement.anchors, { deviceId: "a".repeat(32), fingerprint: "e".repeat(64) }]
    .sort((left, right) => (left.deviceId < right.deviceId ? -1 : 1)) };
  await assert.rejects(verifyOwnEndorsement(tampered, { householdId: HOUSEHOLD, memberId: MEMBER, certification }),
    (error) => error.code === "certification_invalid");
});

/** A coordinator for device H (`self`) with an in-memory pin store. */
function coordinatorFor(self, directory, pins) {
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: HOUSEHOLD, memberId: self.memberId, deviceId: self.deviceId } });
  coordinator.deviceKeys = { fingerprint: self.fingerprint };
  coordinator.request = async (path) => {
    assert.equal(path, "/api/sync/devices");
    return { devices: structuredClone(directory) };
  };
  coordinator.keyStore = {
    async getPinnedDevice(_householdId, deviceId) { return pins.get(deviceId) ?? null; },
    async getPinnedCertificationKey(_householdId, memberId) { return pins.get(`certification:${memberId}`) ?? null; },
    async pinCertificationKey({ memberId, fingerprint }) { pins.set(`certification:${memberId}`, { memberId, fingerprint }); },
    async advanceTrustedDevice() {},
  };
  return coordinator;
}

const entry = (value, certificate = null) => ({
  householdId: HOUSEHOLD, deviceId: value.deviceId, memberId: value.memberId, publicKeys: value.publicKeys,
  fingerprint: value.fingerprint, certificate, keyTransitions: [], revokedAt: null,
});

test("household devices accept a device certified through its member's account, and pin that key", async () => {
  // F founded the household; H is another member's device that pinned F;
  // X is the member's device, approved by F; N signed in with no other
  // device and certified itself with the certification key X endorsed.
  const founder = await device("5".repeat(32), OTHER_MEMBER);
  const self = await device("6".repeat(32), OTHER_MEMBER);
  const certification = await certificationKeyPair((await generateCertificationKey()).pkcs8);
  const endorser = await device("7".repeat(32));
  const endorserCertificate = await createDeviceAuthorizationCertificate({ householdId: HOUSEHOLD, memberId: MEMBER, deviceId: endorser.deviceId,
    issuerDeviceId: founder.deviceId, issuerFingerprint: founder.fingerprint, publicKeys: endorser.publicKeys, signingKey: founder.keys.signingPrivateKey });
  const endorsement = await createCertificationEndorsement({ householdId: HOUSEHOLD, memberId: MEMBER, certification,
    device: { deviceId: endorser.deviceId, fingerprint: endorser.fingerprint, signingKey: endorser.keys.signingPrivateKey },
    anchors: [{ deviceId: founder.deviceId, fingerprint: founder.fingerprint }] });
  const fresh = await device("8".repeat(32));
  const freshCertificate = await createMemberCertificate({ householdId: HOUSEHOLD, memberId: MEMBER, endorsement, certification, device: fresh });
  const directory = [entry(founder), entry(self), entry(endorser, endorserCertificate), entry(fresh, freshCertificate)];
  const pins = new Map([[founder.deviceId, { memberId: founder.memberId, fingerprint: founder.fingerprint }]]);
  const devices = await coordinatorFor(self, directory, pins).loadDeviceDirectory();
  assert.equal(devices.length, 4);
  assert.equal(pins.get(`certification:${MEMBER}`).fingerprint, certification.fingerprint, "the member's certification key is pinned");

  // Later, a device certified by a different certification key for the same
  // member (say, the service colluding with a stolen device key) is refused.
  const swapped = await certificationKeyPair((await generateCertificationKey()).pkcs8);
  const swappedEndorsement = await createCertificationEndorsement({ householdId: HOUSEHOLD, memberId: MEMBER, certification: swapped,
    device: { deviceId: endorser.deviceId, fingerprint: endorser.fingerprint, signingKey: endorser.keys.signingPrivateKey } });
  const intruder = await device("9".repeat(32));
  const intruderCertificate = await createMemberCertificate({ householdId: HOUSEHOLD, memberId: MEMBER, endorsement: swappedEndorsement, certification: swapped, device: intruder });
  await assert.rejects(coordinatorFor(self, [...directory, entry(intruder, intruderCertificate)], pins).loadDeviceDirectory(),
    /certification key changed/);

  // An endorsement from another member's device doesn't certify this member's devices.
  const crossEndorsement = await createCertificationEndorsement({ householdId: HOUSEHOLD, memberId: MEMBER, certification,
    device: { deviceId: founder.deviceId, fingerprint: founder.fingerprint, signingKey: founder.keys.signingPrivateKey } });
  const cross = await device("4".repeat(32));
  const crossCertificate = await createMemberCertificate({ householdId: HOUSEHOLD, memberId: MEMBER, endorsement: crossEndorsement, certification, device: cross });
  await assert.rejects(coordinatorFor(self, [entry(founder), entry(self), entry(cross, crossCertificate)], new Map(pins)).loadDeviceDirectory(),
    /no verifiable endorsement/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import {
  decryptEvent,
  encryptEvent,
  generateDeviceKeys,
  generateHouseholdKey,
  SyncCryptoError,
} from "../web/sync/crypto.js";
import { encodeAddedRecord, idFromHex, loadKinEngine } from "../web/wasm/kin-engine.js";

globalThis.crypto ??= webcrypto;
const wasm = await readFile(new URL("../web/wasm/kin_engine.wasm", import.meta.url));
const wasmUrl = `data:application/wasm;base64,${wasm.toString("base64")}`;
await loadKinEngine(wasmUrl);

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

test("two trusted devices exchange an opaque canonical Kin event through the relay", async () => {
  const pairing = new PairingService();
  const deviceA = pairing.bootstrap({
    credential: credential("adult-a"),
    deviceLabel: "Device A",
  });
  const invitation = pairing.createPairing(deviceA.sessionToken);
  const claim = pairing.claimPairing({
    code: invitation.code,
    credential: credential("adult-b"),
    deviceLabel: "Device B",
  });
  pairing.approvePairing(
    deviceA.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const deviceB = pairing.activateClaim(claim.claimToken);
  const sync = new EncryptedSyncService(pairing);
  const [householdKey, deviceKeys] = await Promise.all([
    generateHouseholdKey(),
    generateDeviceKeys(),
  ]);
  const eventId = "01".repeat(16);
  const eventBytes = encodeAddedRecord({
    eventId: idFromHex(eventId),
    householdId: idFromHex(deviceA.householdId),
    actorId: idFromHex(deviceA.memberId),
    deviceId: idFromHex(deviceA.deviceId),
    timestamp: 1_760_000_000_000,
    logicalTime: 1n,
    itemId: idFromHex("02".repeat(16)),
    text: "Pick up the prescription",
    classification: "need",
  });
  const envelope = await encryptEvent({
    eventId,
    householdId: deviceA.householdId,
    deviceId: deviceA.deviceId,
    deviceSequence: 1,
    logicalTime: 1n,
    keyEpoch: 1,
    plaintext: eventBytes,
    householdKey,
    signingKey: deviceKeys.signingPrivateKey,
  });

  const engine = await loadKinEngine(wasmUrl);
  const areaEventId = "03".repeat(16);
  const areaId = "04".repeat(16);
  const areaResult = engine.executeCommand(
    { type: "create-area", areaId, name: "Secret Garden" },
    {
      eventId: idFromHex(areaEventId),
      householdId: idFromHex(deviceA.householdId),
      actorId: idFromHex(deviceA.memberId),
      deviceId: idFromHex(deviceA.deviceId),
      timestamp: 1_760_000_000_002,
      logicalTime: 2n,
      entityId: idFromHex(areaId),
    },
    [eventBytes],
    1_760_000_000_002,
    null,
    20261004,
  );
  const areaEnvelope = await encryptEvent({
    eventId: areaEventId,
    householdId: deviceA.householdId,
    deviceId: deviceA.deviceId,
    deviceSequence: 2,
    logicalTime: 2n,
    keyEpoch: 1,
    plaintext: areaResult.encodedEvent,
    householdKey,
    signingKey: deviceKeys.signingPrivateKey,
  });
  engine.dispose();

  const acknowledgement = sync.push(deviceA.sessionToken, [envelope, areaEnvelope]);
  assert.equal(acknowledgement.durable, false);
  assert.equal(
    sync.push(deviceA.sessionToken, [envelope, areaEnvelope]).latestCursor,
    "AAAAAAAAAAI",
  );
  const page = sync.pull(deviceB.sessionToken, "", "20");
  assert.equal(page.events.length, 2);
  assert.deepEqual(page.events[0].envelope, envelope);
  assert.deepEqual(page.events[1].envelope, areaEnvelope);
  assert.equal(
    JSON.stringify(page).includes("Pick up the prescription"),
    false,
  );
  assert.equal(
    JSON.stringify(sync.state(deviceA.householdId)).includes(
      "Pick up the prescription",
    ),
    false,
  );

  assert.deepEqual(
    await decryptEvent({
      envelope: page.events[0].envelope,
      householdKey,
      signingKey: deviceKeys.signingPublicKey,
    }),
    eventBytes,
  );
  const areaBytes = await decryptEvent({
    envelope: page.events[1].envelope,
    householdKey,
    signingKey: deviceKeys.signingPublicKey,
  });
  const receiver = await loadKinEngine(wasmUrl);
  assert.equal(
    receiver.applyEvents([eventBytes, areaBytes], 1_760_000_000_002, null, 20261004).areas[0].name,
    "Secret Garden",
  );
  receiver.dispose();
  await assert.rejects(
    decryptEvent({
      envelope: page.events[0].envelope,
      householdKey: await generateHouseholdKey(),
      signingKey: deviceKeys.signingPublicKey,
    }),
    (error) =>
      error instanceof SyncCryptoError && error.code === "decrypt_failed",
  );
  await assert.rejects(
    decryptEvent({
      envelope: { ...page.events[0].envelope, deviceId: deviceB.deviceId },
      householdKey,
      signingKey: deviceKeys.signingPublicKey,
    }),
    (error) =>
      error instanceof SyncCryptoError &&
      error.code === "event_signature_invalid",
  );
});

test("two devices completing one repeating occurrence offline converge without duplicates", async () => {
  const pairing = new PairingService();
  const deviceA = pairing.bootstrap({ credential: credential("adult-a"), deviceLabel: "Device A" });
  const invitation = pairing.createPairing(deviceA.sessionToken);
  const claim = pairing.claimPairing({ code: invitation.code, credential: credential("adult-b"), deviceLabel: "Device B" });
  pairing.approvePairing(deviceA.sessionToken, invitation.pairingId, claim.version);
  const deviceB = pairing.activateClaim(claim.claimToken);
  const sync = new EncryptedSyncService(pairing);
  const [householdKey, keysA, keysB] = await Promise.all([generateHouseholdKey(), generateDeviceKeys(), generateDeviceKeys()]);
  const signing = new Map([[deviceA.deviceId, keysA], [deviceB.deviceId, keysB]]);
  const engine = await loadKinEngine(wasmUrl);
  const monday = 20261005;
  const asOf = 1_791_172_800_000;
  const routineId = "05".repeat(16);
  const context = (device, eventByte, logicalTime) => ({
    eventId: idFromHex(eventByte.repeat(16)),
    householdId: idFromHex(deviceA.householdId),
    actorId: idFromHex(device.memberId),
    deviceId: idFromHex(device.deviceId),
    timestamp: asOf + logicalTime,
    logicalTime: BigInt(logicalTime),
  });
  const seal = (device, sequence, logicalTime, eventByte, plaintext) => encryptEvent({
    eventId: eventByte.repeat(16), householdId: deviceA.householdId, deviceId: device.deviceId, deviceSequence: sequence,
    logicalTime: BigInt(logicalTime), keyEpoch: 1, plaintext, householdKey, signingKey: signing.get(device.deviceId).signingPrivateKey,
  });
  const created = engine.executeCommand({ type: "create-routine", routineId, text: "Pack lunches", cadence: "weekdays" }, context(deviceA, "11", 1), [], asOf, null, monday).encodedEvent;
  sync.push(deviceA.sessionToken, [await seal(deviceA, 1, 1, "11", created)]);
  // Both devices see the same open occurrence and complete it before syncing.
  const complete = { type: "complete-routine-occurrence", routineId, occurrenceKey: monday };
  const doneA = engine.executeCommand(complete, context(deviceA, "12", 2), [created], asOf, null, monday).encodedEvent;
  const doneB = engine.executeCommand(complete, context(deviceB, "13", 2), [created], asOf, null, monday).encodedEvent;
  const envelopeB = await seal(deviceB, 1, 2, "13", doneB);
  sync.push(deviceA.sessionToken, [await seal(deviceA, 2, 2, "12", doneA)]);
  const cursor = sync.push(deviceB.sessionToken, [envelopeB]).latestCursor;
  // Re-sending the same envelope (a retry after a lost acknowledgement) adds nothing.
  assert.equal(sync.push(deviceB.sessionToken, [envelopeB]).latestCursor, cursor);
  const pulled = sync.pull(deviceB.sessionToken, "", "20").events;
  assert.equal(pulled.length, 3);
  const plain = await Promise.all(pulled.map(({ envelope }) => decryptEvent({ envelope, householdKey, signingKey: signing.get(envelope.deviceId).signingPublicKey })));
  for (const records of [plain, [...plain, plain[2]]]) {
    const state = engine.applyEvents(records, asOf, null, monday);
    assert.equal(state.routines.length, 1);
    assert.deepEqual([state.routines[0].occurrenceStatus, state.routines[0].nextOn], ["completed", 20261006]);
  }
  // Tuesday's occurrence is independent of Monday's two completions.
  assert.equal(engine.applyEvents(plain, asOf + 86_400_000, null, 20261006).routines[0].occurrenceStatus, "open");
  // A device that has merged both completions cannot record a third.
  assert.throws(() => engine.executeCommand(complete, context(deviceB, "14", 3), plain, asOf, null, monday), (error) => error.code === 4);
  engine.dispose();
});

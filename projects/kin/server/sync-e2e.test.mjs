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
await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);

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

  const acknowledgement = sync.push(deviceA.sessionToken, [envelope]);
  assert.equal(acknowledgement.durable, false);
  assert.equal(
    sync.push(deviceA.sessionToken, [envelope]).latestCursor,
    "AAAAAAAAAAE",
  );
  const page = sync.pull(deviceB.sessionToken, "", "20");
  assert.equal(page.events.length, 1);
  assert.deepEqual(page.events[0].envelope, envelope);
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

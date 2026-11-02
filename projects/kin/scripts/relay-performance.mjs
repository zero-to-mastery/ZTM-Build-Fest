// Cold relay-history benchmark at Kin's realistic (1,000) and local maximum
// (10,000) event counts. It uses the real relay service, binary wire codec,
// Web Crypto envelope verification/decryption and release WASM replay. The
// browser's IndexedDB commit is intentionally outside this Node measurement.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PairingService } from "../server/pairing-service.mjs";
import { EncryptedSyncService, MAX_EVENTS_PER_BATCH } from "../server/sync-service.mjs";
import { decryptEvent, encryptEvent, generateDeviceKeys, generateHouseholdKey } from "../web/sync/crypto.js";
import { decodeEventPage, encodeEventPage } from "../web/sync/envelope-wire.js";
import { encodeAddedRecord, idFromHex, loadKinEngine } from "../web/wasm/kin-engine.js";

globalThis.crypto ??= webcrypto;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasm = await readFile(resolve(projectRoot, "web/wasm/kin_engine.wasm"));
const wasmUrl = `data:application/wasm;base64,${wasm.toString("base64")}`;
const fixtureCodec = await loadKinEngine(wasmUrl);
const counts = [1_000, 10_000];
const hexId = (value) => BigInt(value).toString(16).padStart(32, "0");
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

async function measure(eventCount) {
  const pairing = new PairingService();
  const source = pairing.bootstrap({ credential: credential(`source-${eventCount}`), deviceLabel: "Source" });
  const invitation = pairing.createPairing(source.sessionToken);
  const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`target-${eventCount}`), deviceLabel: "Target" });
  pairing.approvePairing(source.sessionToken, invitation.pairingId, claim.version);
  const target = pairing.activateClaim(claim.claimToken);
  const relay = new EncryptedSyncService(pairing);
  relay.enable(source.sessionToken);
  const [householdKey, deviceKeys] = await Promise.all([generateHouseholdKey(), generateDeviceKeys()]);

  const buildStarted = performance.now();
  let batch = [];
  for (let index = 1; index <= eventCount; index += 1) {
    const eventId = hexId(index);
    const encoded = encodeAddedRecord({
      eventId: idFromHex(eventId), itemId: idFromHex(hexId(eventCount + index)),
      householdId: idFromHex(source.householdId), actorId: idFromHex(source.memberId),
      deviceId: idFromHex(source.deviceId), timestamp: 1_760_000_000_000 + index,
      logicalTime: BigInt(index), text: `Relay history item ${index}`, classification: "need",
    });
    batch.push(await encryptEvent({
      eventId, householdId: source.householdId, deviceId: source.deviceId,
      deviceSequence: index, logicalTime: BigInt(index), keyEpoch: 1,
      plaintext: encoded, householdKey, signingKey: deviceKeys.signingPrivateKey,
    }));
    if (batch.length === MAX_EVENTS_PER_BATCH || index === eventCount) {
      // The fixture represents history accumulated across normal rate windows.
      relay.rateBuckets.clear();
      assert.equal(relay.push(source.sessionToken, batch).accepted, batch.length);
      batch = [];
    }
  }
  const fixtureBuildMs = performance.now() - buildStarted;

  const records = [];
  let cursor = "";
  let pages = 0;
  let wireBytes = 0;
  let rateLimitWaitMs = 0;
  let peakRequestsPerMinute = 0;
  let pullRequestTimes = [];
  const syncStarted = performance.now();
  while (true) {
    const budgetNow = performance.now();
    pullRequestTimes = pullRequestTimes.filter((timestamp) => timestamp > budgetNow - 60_000);
    if (pullRequestTimes.length >= 200) {
      const waitStarted = performance.now();
      const delay = Math.max(1, pullRequestTimes[0] + 60_000 - waitStarted + 1);
      await new Promise((resolveWait) => setTimeout(resolveWait, delay));
      rateLimitWaitMs += performance.now() - waitStarted;
      const resumedAt = performance.now();
      pullRequestTimes = pullRequestTimes.filter((timestamp) => timestamp > resumedAt - 60_000);
    }
    pullRequestTimes.push(performance.now());
    peakRequestsPerMinute = Math.max(peakRequestsPerMinute, pullRequestTimes.length);
    const serverPage = relay.pull(target.sessionToken, cursor, String(MAX_EVENTS_PER_BATCH));
    const bytes = encodeEventPage(serverPage);
    wireBytes += bytes.byteLength;
    const page = decodeEventPage(bytes);
    const opened = await Promise.all(page.events.map(({ envelope }) => decryptEvent({
      envelope, householdKey, signingKey: deviceKeys.signingPublicKey,
    })));
    records.push(...opened);
    pages += 1;
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  const pullWallClockMs = performance.now() - syncStarted;
  const replayStarted = performance.now();
  const projection = fixtureCodec.applyEvents(records, 1_760_100_000_000, null, 20261016);
  const replayMs = performance.now() - replayStarted;
  const wallClockMs = performance.now() - syncStarted;
  assert.equal(records.length, eventCount);
  assert.equal(projection.items.length, eventCount);
  const coordinatorCycles = Math.ceil(pages / 5); // production MAX_PULL_PASSES
  return {
    events: eventCount, pages, wireBytes, fixtureBuildMs, pullWallClockMs, replayMs,
    wallClockMs, rateLimitWaitMs, peakRequestsPerMinute, coordinatorCycles,
  };
}

const results = [];
for (const count of counts) {
  const result = await measure(count);
  results.push(result);
  console.error(`relay ${count}: ${JSON.stringify(result)}`);
}
fixtureCodec.dispose();
const report = {
  scope: "Real process-local relay, 20-event binary pages, Web Crypto decrypt/signature verification, the 200-request client sliding-window budget and one release-WASM replay. Pull requests do not clear relay rate buckets. Excludes real network latency and IndexedDB commit; fixture construction is separate and may clear rate buckets between source pushes.",
  node: process.version,
  results,
};
const outputIndex = process.argv.indexOf("--json");
if (outputIndex !== -1) await writeFile(process.argv[outputIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

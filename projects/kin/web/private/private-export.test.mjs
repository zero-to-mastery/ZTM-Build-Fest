// A member's own export of their private things (#494/#495): sealed under
// the member key, opened on their devices or with their backup code, never
// for another member, restored without duplicates.
import assert from "node:assert/strict";
import test from "node:test";
import { backupCodeKek, generateVaultKey } from "../security/account-vault.js";
import { makeWrapper } from "../security/account-wrappers.js";
import { generateBackupCode } from "../security/backup-code.js";
import { toBase64Url } from "../security/local-vault.js";
import { encryptPrivateEvent } from "./private-envelope.js";
import { sealPrivateBlob } from "./private-blobs.js";
import {
  choosePrivateBlobs,
  describePrivateArchive,
  exportPrivateArchive,
  openPrivateArchive,
  privateExportFileName,
  restorePrivateArchive,
} from "./private-export.js";

const householdId = "a".repeat(32);
const memberId = "b".repeat(32);
const otherMember = "c".repeat(32);
const deviceId = "d".repeat(32);
const identity = { householdId, memberId };

async function memberKeys() {
  const raw = [1, 2].map((epoch) => ({ epoch, key: crypto.getRandomValues(new Uint8Array(32)), revokedThrough: epoch === 2 ? 5 : 0 }));
  const keys = new Map();
  for (const entry of raw) keys.set(entry.epoch, await crypto.subtle.importKey("raw", entry.key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
  return { raw, keys };
}

async function envelope(keys, { epoch, sequence, member = memberId }) {
  const signing = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])).privateKey;
  const eventId = crypto.getRandomValues(new Uint8Array(16)).reduce((text, byte) => text + byte.toString(16).padStart(2, "0"), "");
  return encryptPrivateEvent({ eventId, householdId, memberId: member, deviceId, deviceSequence: sequence, logicalTime: String(sequence), keyEpoch: epoch,
    plaintext: new TextEncoder().encode(`private event ${sequence}`), memberKey: keys.get(epoch), signingKey: signing });
}

/** A private log double: the ring's keys and a store keyed by event ID. */
function fakeLog(keys, { have = [] } = {}) {
  const stored = new Map(have.map((entry) => [entry.eventId, entry]));
  let refreshed = 0;
  return {
    identity: { ...identity, deviceId },
    stored,
    get refreshed() { return refreshed; },
    ring: {
      key: async (epoch) => { if (!keys.has(epoch)) throw Object.assign(new Error("missing"), { code: "private_key_missing" }); return keys.get(epoch); },
      revokedThrough: (epoch) => (keys.has(epoch) ? 0 : null),
    },
    store: {
      eventById: async (id) => stored.get(id) ?? null,
      addImported: async (envelopes) => { let added = 0; for (const entry of envelopes) if (!stored.has(entry.eventId)) { stored.set(entry.eventId, entry); added += 1; } return added; },
    },
    refresh: async () => { refreshed += 1; },
  };
}

function fakeBlobStore() {
  const blobs = new Map();
  return { blobs, get: async (ref) => blobs.get(ref)?.ciphertext ?? null, put: async (ref, ciphertext, { pending }) => { blobs.set(ref, { ciphertext, pending }); } };
}

test("the export is sealed under the member key, names only its member, and opens again on their device", async () => {
  const { keys } = await memberKeys();
  const envelopes = [await envelope(keys, { epoch: 1, sequence: 1 }), await envelope(keys, { epoch: 2, sequence: 2 })];
  const photo = await sealPrivateBlob(new Uint8Array(1000).fill(3), { householdId, memberId });
  const { bytes, header } = await exportPrivateArchive({ identity, envelopes, memberKey: { epoch: 2, key: keys.get(2) },
    blobs: [{ ref: photo.ref, ciphertext: photo.ciphertext, storedAt: 1 }], now: Date.parse("2026-10-21T08:00:00Z") });
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "KPEX");
  assert.equal(header.keyEpoch, 2);
  assert.equal(header.backupCode, null);
  assert.equal(privateExportFileName(header.exportedAt), "kin-private-2026-10-21.kinp");
  assert.deepEqual(describePrivateArchive(bytes), { exportedAt: "2026-10-21T08:00:00.000Z", householdId, memberId, eventCount: 2, blobCount: 1, blobsLeftOut: 0, backupCode: false });
  // Nothing readable: the photo's sealed bytes and the envelopes' ciphertext never appear as they are.
  assert.equal(Buffer.from(bytes).indexOf(Buffer.from(photo.ciphertext.subarray(0, 64))), -1);
  assert.equal(Buffer.from(bytes).includes(Buffer.from(envelopes[0].ciphertext)), false);

  const opened = await openPrivateArchive(bytes, { identity, memberKey: async (epoch) => keys.get(epoch) ?? null });
  assert.deepEqual(opened.envelopes, envelopes);
  assert.equal(opened.blobs[0].ref, photo.ref);
  assert.equal(opened.memberKeys, null);

  // Another member (or household) is refused before anything is opened.
  await assert.rejects(openPrivateArchive(bytes, { identity: { householdId, memberId: otherMember }, memberKey: async (epoch) => keys.get(epoch) }),
    { code: "private_export_other_member" });
  // The header can't change: one changed byte, and the file doesn't open.
  const tampered = bytes.slice();
  const text = new TextDecoder().decode(tampered.subarray(9, 9 + new DataView(tampered.buffer).getUint32(5)));
  const at = 9 + text.indexOf('"blobsLeftOut":0') + '"blobsLeftOut":'.length;
  tampered[at] = "1".charCodeAt(0);
  await assert.rejects(openPrivateArchive(tampered, { identity, memberKey: async (epoch) => keys.get(epoch) }), { code: "private_export_invalid" });
  // Without this member's key: the device can't, and says so.
  await assert.rejects(openPrivateArchive(bytes, { identity, memberKey: async () => null }), { code: "private_export_key_missing" });
});

test("photos go in newest first while they fit; the rest are counted, not silently dropped", async () => {
  const big = { ref: "1".repeat(64), ciphertext: new Uint8Array(3000), storedAt: 1 };
  const newer = { ref: "2".repeat(64), ciphertext: new Uint8Array(3000), storedAt: 2 };
  const { chosen, leftOut } = choosePrivateBlobs([big, newer], 4500);
  assert.deepEqual(chosen.map((blob) => blob.ref), [newer.ref]);
  assert.equal(leftOut, 1);
  const { keys } = await memberKeys();
  const photos = [];
  for (let index = 0; index < 3; index += 1) {
    const sealed = await sealPrivateBlob(new Uint8Array(40_000).fill(index + 1), { householdId, memberId });
    photos.push({ ref: sealed.ref, ciphertext: sealed.ciphertext, storedAt: index });
  }
  const { header } = await exportPrivateArchive({ identity, envelopes: [await envelope(keys, { epoch: 1, sequence: 1 })], memberKey: { epoch: 1, key: keys.get(1) },
    blobs: photos, maxBytes: 64 * 1024 + 120_000 });
  assert.ok(header.blobCount >= 1 && header.blobCount < 3);
  assert.equal(header.blobCount + header.blobsLeftOut, 3);
});

test("with a backup code, the code alone opens the file and gives the member keys", async () => {
  const { raw, keys } = await memberKeys();
  const vaultKey = generateVaultKey();
  const code = await generateBackupCode();
  const kek = await backupCodeKek(code.bytes);
  const wrapper = await makeWrapper({ vaultKey, kek, householdId, memberId, type: "backup-code", params: { verifier: toBase64Url(new Uint8Array(32)) } });
  const envelopes = [await envelope(keys, { epoch: 1, sequence: 1 })];
  const { bytes, header } = await exportPrivateArchive({ identity, envelopes, memberKey: { epoch: 2, key: keys.get(2) },
    backupCode: { vaultKey, wrapper: { ...wrapper, wrapped: toBase64Url(wrapper.wrapped) }, memberKeys: raw } });
  assert.ok(header.backupCode);
  assert.equal(JSON.stringify(header).includes(toBase64Url(raw[0].key)), false, "the member keys aren't in the open");
  assert.equal(describePrivateArchive(bytes).backupCode, true);
  // No key on this device: the code is asked for, a wrong one is refused.
  await assert.rejects(openPrivateArchive(bytes, { identity }), { code: "private_export_needs_code" });
  const wrong = await generateBackupCode();
  await assert.rejects(openPrivateArchive(bytes, { identity, code: wrong.text }), { code: "private_export_code_mismatch" });
  const opened = await openPrivateArchive(bytes, { identity, code: code.text.toLowerCase() });
  assert.deepEqual(opened.envelopes, envelopes);
  assert.deepEqual(opened.memberKeys.map((entry) => entry.epoch), [1, 2]);
  assert.ok(opened.memberKeys.every((entry, index) => Buffer.from(entry.key).equals(Buffer.from(raw[index].key))));
  // Still only for its own member.
  await assert.rejects(openPrivateArchive(bytes, { identity: { householdId, memberId: otherMember }, code: code.text }), { code: "private_export_other_member" });
});

test("restoring merges by event ID: nothing duplicated, photos kept as pending uploads, a second restore adds nothing", async () => {
  const { keys } = await memberKeys();
  const envelopes = [await envelope(keys, { epoch: 1, sequence: 1 }), await envelope(keys, { epoch: 2, sequence: 2 }), await envelope(keys, { epoch: 2, sequence: 3 })];
  const photo = await sealPrivateBlob(new Uint8Array(500).fill(9), { householdId, memberId });
  const { bytes } = await exportPrivateArchive({ identity, envelopes, memberKey: { epoch: 2, key: keys.get(2) }, blobs: [{ ref: photo.ref, ciphertext: photo.ciphertext }] });
  const log = fakeLog(keys, { have: [envelopes[0]] });
  const blobStore = fakeBlobStore();
  const opened = await openPrivateArchive(bytes, { identity, memberKey: async (epoch) => keys.get(epoch) });
  const first = await restorePrivateArchive({ opened, log, blobStore });
  assert.deepEqual(first, { added: 2, alreadyHere: 1, blobsAdded: 1, blobsSkipped: 0 });
  assert.equal(log.stored.size, 3);
  assert.equal(blobStore.blobs.get(photo.ref).pending, true, "the photo uploads on the next pass");
  assert.equal(log.refreshed, 1);
  const again = await restorePrivateArchive({ opened: await openPrivateArchive(bytes, { identity, memberKey: async (epoch) => keys.get(epoch) }), log, blobStore });
  assert.deepEqual(again, { added: 0, alreadyHere: 3, blobsAdded: 0, blobsSkipped: 0 });
});

test("a file whose envelopes aren't this member's is refused as a whole", async () => {
  const { keys } = await memberKeys();
  // Sealed under the same key but bound to another member: it can't open for this one.
  const foreign = await envelope(keys, { epoch: 1, sequence: 1, member: otherMember });
  const { bytes } = await exportPrivateArchive({ identity, envelopes: [foreign], memberKey: { epoch: 1, key: keys.get(1) } });
  const log = fakeLog(keys);
  const opened = await openPrivateArchive(bytes, { identity, memberKey: async (epoch) => keys.get(epoch) });
  await assert.rejects(restorePrivateArchive({ opened, log }), { code: "private_export_invalid" });
  assert.equal(log.stored.size, 0, "nothing was stored");
});

test("epochs the backup code opened that the vault lacks are added first", async () => {
  const { raw, keys } = await memberKeys();
  const envelopes = [await envelope(keys, { epoch: 2, sequence: 1 })];
  const known = new Map([[1, keys.get(1)]]);
  const log = fakeLog(known);
  const added = [];
  const opened = { envelopes, blobs: [], memberKeys: raw.map((entry) => ({ ...entry, key: entry.key.slice() })) };
  await restorePrivateArchive({ opened, log, addMemberKeys: async (memberKeys) => { added.push(...memberKeys.map((entry) => entry.epoch)); known.set(2, keys.get(2)); } });
  assert.deepEqual(added, [1, 2]);
  assert.equal(log.stored.size, 1);
  assert.ok(opened.memberKeys.every((entry) => entry.key.every((byte) => byte === 0)), "the raw keys are zeroed");
});

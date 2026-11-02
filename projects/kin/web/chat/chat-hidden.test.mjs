// "Delete for me" records (#119): sealed to the member's own devices,
// signed by one of them, bound to household, member and revision.
import assert from "node:assert/strict";
import test from "node:test";
import { exportDevicePublicKeys, generateDeviceKeys } from "../sync/crypto.js";
import { openHiddenRecord, openHiddenState, sealHiddenRecord } from "./chat-hidden.js";

const HOUSEHOLD = "aa".repeat(16), ME = "bb".repeat(16), OTHER = "cc".repeat(16);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);

async function device(deviceId, memberId) {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  return { keys, entry: { deviceId, memberId, publicKeys, fingerprint: `f${deviceId.slice(0, 4)}`, verifiedKeyHistory: [{ publicKeys }] } };
}

test("a record opens on each of the member's devices and nowhere else", async () => {
  const phone = await device(id(1), ME), laptop = await device(id(2), ME), theirs = await device(id(3), OTHER), later = await device(id(4), ME);
  const record = await sealHiddenRecord({
    ids: [id(9), id(8), id(9)], householdId: HOUSEHOLD, memberId: ME, revision: 3, senderDeviceId: id(1),
    signingKey: phone.keys.signingPrivateKey, recipients: [phone.entry, laptop.entry],
  });
  assert.equal(JSON.stringify(record).includes(id(9)), false, "the IDs are sealed");
  const senders = [phone.entry, laptop.entry, later.entry];
  const open = (who, extra = {}) => openHiddenRecord({ record, householdId: HOUSEHOLD, memberId: ME, revision: 3, deviceId: who.entry.deviceId, deviceFingerprint: who.entry.fingerprint, agreementPrivateKey: who.keys.agreementPrivateKey, senders, ...extra });
  assert.deepEqual(await open(phone), [id(8), id(9)], "sorted, once each");
  assert.deepEqual(await open(laptop), [id(8), id(9)]);
  // A device added since, or rekeyed since, can't open it until another
  // device writes again.
  await assert.rejects(open(later), (error) => error.code === "chat_hidden_not_for_me");
  await assert.rejects(open(laptop, { deviceFingerprint: "rekeyed" }), (error) => error.code === "chat_hidden_not_for_me");
  // Another member's device has nothing to open (and their key can't pose as a recipient).
  await assert.rejects(open({ ...theirs, entry: { ...theirs.entry, deviceId: id(2), fingerprint: laptop.entry.fingerprint } }), (error) => error.code === "chat_hidden_invalid");
  // Moved to another member, revision or household, or signed by a stranger: refused.
  await assert.rejects(open(phone, { revision: 4 }), (error) => error.code === "chat_hidden_invalid");
  await assert.rejects(open(phone, { memberId: OTHER }), (error) => error.code === "chat_hidden_invalid");
  await assert.rejects(open(phone, { householdId: id(7) }), (error) => error.code === "chat_hidden_invalid");
  // A writer no longer trusted (gone, revoked, another member's, or since
  // rekeyed): the member's devices write afresh.
  await assert.rejects(open(phone, { senders: [laptop.entry] }), (error) => error.code === "chat_hidden_untrusted_sender", "sender not a trusted device of the member");
  await assert.rejects(open(phone, { senders: [{ ...phone.entry, revokedAt: 1 }, laptop.entry] }), (error) => error.code === "chat_hidden_untrusted_sender", "revoked sender");
  await assert.rejects(open(phone, { senders: [{ ...phone.entry, memberId: OTHER }] }), (error) => error.code === "chat_hidden_untrusted_sender");
  const rekeyed = await device(id(1), ME);
  await assert.rejects(open(phone, { senders: [{ ...rekeyed.entry, verifiedKeyHistory: [{ publicKeys: phone.entry.publicKeys }, { publicKeys: rekeyed.entry.publicKeys }] }, laptop.entry] }),
    (error) => error.code === "chat_hidden_untrusted_sender", "signed with the sender's earlier key");
  // Signed by a key the sender never had: forged.
  await assert.rejects(open(phone, { senders: [{ ...rekeyed.entry }, laptop.entry] }), (error) => error.code === "chat_hidden_invalid");
  // Tampering anywhere breaks the signature.
  for (const change of [
    { ciphertext: record.ciphertext.slice(0, -2) + (record.ciphertext.endsWith("AA") ? "BA" : "AA") },
    { recipients: [record.recipients[1], record.recipients[0]] },
    { recipients: [record.recipients[0]] },
  ])
    await assert.rejects(openHiddenRecord({ record: { ...record, ...change }, householdId: HOUSEHOLD, memberId: ME, revision: 3, deviceId: id(1), deviceFingerprint: phone.entry.fingerprint, agreementPrivateKey: phone.keys.agreementPrivateKey, senders }), (error) => error.code === "chat_hidden_invalid");
});

test("a record must include its sender and stay within its bound", async () => {
  const phone = await device(id(1), ME), laptop = await device(id(2), ME);
  const seal = (extra) => sealHiddenRecord({ ids: [id(9)], householdId: HOUSEHOLD, memberId: ME, revision: 1, senderDeviceId: id(1), signingKey: phone.keys.signingPrivateKey, recipients: [phone.entry], ...extra });
  await assert.rejects(seal({ recipients: [laptop.entry] }), (error) => error.code === "chat_hidden_invalid");
  await assert.rejects(seal({ ids: ["not an id"] }), (error) => error.code === "chat_hidden_full");
  await assert.rejects(seal({ ids: Array.from({ length: 10_001 }, (_, index) => index.toString(16).padStart(32, "0")) }), (error) => error.code === "chat_hidden_full");
  assert.ok(await seal({}));
});

test("a full record (10,000 IDs, 64 devices) fits the service's bound", { timeout: 60_000 }, async () => {
  const { isHiddenRecordValid } = await import("../../server/chat-relay-service.mjs");
  const phone = await device(id(1), ME);
  const recipients = [phone.entry];
  for (let index = 2; recipients.length < 64; index += 1) recipients.push((await device(index.toString(16).padStart(32, "0"), ME)).entry);
  const ids = Array.from({ length: 10_000 }, (_, index) => (index + 1).toString(16).padStart(32, "0"));
  const record = await sealHiddenRecord({ ids, householdId: HOUSEHOLD, memberId: ME, revision: 1, senderDeviceId: id(1), signingKey: phone.keys.signingPrivateKey, recipients });
  const bytes = Buffer.byteLength(JSON.stringify({ expectedRevision: 0, record }));
  assert.ok(bytes <= 256 * 1024, `${bytes} bytes`);
  assert.equal(isHiddenRecordValid(record, { householdId: HOUSEHOLD, memberId: ME, deviceId: id(1), revision: 1 }), true);
  assert.equal((await openHiddenRecord({ record, householdId: HOUSEHOLD, memberId: ME, revision: 1, deviceId: id(1), deviceFingerprint: phone.entry.fingerprint, agreementPrivateKey: phone.keys.agreementPrivateKey, senders: [phone.entry] })).length, 10_000);
});

test("the private read position travels in the record and nowhere in the clear (#133)", async () => {
  const phone = await device(id(1), ME), laptop = await device(id(2), ME);
  const read = { postedAt: 1_700_000_123_456, messageId: id(7) };
  const seal = (extra) => sealHiddenRecord({ ids: [id(9)], householdId: HOUSEHOLD, memberId: ME, revision: 2, senderDeviceId: id(1), signingKey: phone.keys.signingPrivateKey, recipients: [phone.entry, laptop.entry], ...extra });
  const open = (record, who = laptop) => openHiddenState({ record, householdId: HOUSEHOLD, memberId: ME, revision: 2, deviceId: who.entry.deviceId, deviceFingerprint: who.entry.fingerprint, agreementPrivateKey: who.keys.agreementPrivateKey, senders: [phone.entry, laptop.entry] });
  const withRead = await seal({ read });
  assert.equal(JSON.stringify(withRead).includes(id(7)), false);
  assert.deepEqual(await open(withRead), { ids: [id(9)], read });
  assert.deepEqual(await open(await seal({})), { ids: [id(9)], read: null }, "no position yet");
  assert.deepEqual(await open(await seal({ ids: [], read })), { ids: [], read }, "a position without hidden messages");
  assert.deepEqual(await openHiddenRecord({ record: withRead, householdId: HOUSEHOLD, memberId: ME, revision: 2, deviceId: id(2), deviceFingerprint: laptop.entry.fingerprint, agreementPrivateKey: laptop.keys.agreementPrivateKey, senders: [phone.entry, laptop.entry] }), [id(9)], "the ID list alone still opens");
  await assert.rejects(seal({ read: { postedAt: -1, messageId: id(7) } }), (error) => error.code === "chat_hidden_invalid");
  await assert.rejects(seal({ read: { postedAt: 5, messageId: "nope" } }), (error) => error.code === "chat_hidden_invalid");
});

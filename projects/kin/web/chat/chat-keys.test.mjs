// Opening events sealed under the dedicated chat key (#123): the seal and its
// binding, plain events before and after the key began, epochs that don't
// exist or can never be opened, and cursors.
import assert from "node:assert/strict";
import test from "node:test";
import { ChatKeys, cursorSequence } from "./chat-keys.js";

const identity = { householdId: "a".repeat(32), memberId: "b".repeat(32), deviceId: "c".repeat(32) };

async function keys(held = [1]) {
  const store = new Map();
  for (const epoch of held) store.set(epoch, { keyEpoch: epoch, householdKey: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) });
  const chatKeys = new ChatKeys({
    identity, request: async () => ({}),
    keyStore: { getEpoch: async (_family, epoch) => store.get(epoch) ?? null, listEpochs: async () => [...store.values()] },
  });
  chatKeys.epoch = Math.max(0, ...held);
  return chatKeys;
}

const event = () => new TextEncoder().encode("KINE-an-engine-event");

test("an event sealed under the chat key opens for the event it was sealed for, and no other", async () => {
  const chatKeys = await keys();
  const sealed = await chatKeys.seal(event(), "11".repeat(16));
  assert.equal(sealed.keyEpoch, 1);
  assert.notDeepEqual([...sealed.bytes.slice(0, 4)], [...event().slice(0, 4)]);
  const copy = sealed.bytes.slice();
  const opened = await chatKeys.open(sealed.bytes, "11".repeat(16));
  assert.equal(new TextDecoder().decode(opened.plaintext), "KINE-an-engine-event");
  assert.equal(opened.keyEpoch, 1);
  await assert.rejects(chatKeys.open(copy, "22".repeat(16)), (error) => error.code === "chat_event_refused", "bound to its event");
});

test("without a chat key, events stay plain", async () => {
  const chatKeys = await keys([]);
  const sealed = await chatKeys.seal(event(), "11".repeat(16));
  assert.equal(sealed.keyEpoch, 0);
  assert.deepEqual([...(await chatKeys.open(event(), "11".repeat(16), { sequence: 5 })).plaintext], [...event()]);
});

test("once the key began, a plain event at or after that position is refused", async () => {
  const chatKeys = await keys();
  chatKeys.since = 10;
  await assert.rejects(chatKeys.open(event(), "11".repeat(16), { sequence: 10 }), (error) => error.code === "chat_event_refused");
  assert.equal((await chatKeys.open(event(), "11".repeat(16), { sequence: 9 })).keyEpoch, 0, "before it, plain events are history");
});

test("a chat key epoch that doesn't exist yet, or that nobody can open, doesn't stall chat", async () => {
  const chatKeys = await keys();
  const other = await keys([1, 2, 7]);
  const future = (await other.seal(event(), "11".repeat(16))).bytes;
  await assert.rejects(chatKeys.open(future.slice(), "11".repeat(16), { sequence: 3 }), (error) => error.code === "chat_key_future", "newer than the household's");
  const lost = await keys([1]);
  lost.epoch = 2;
  lost.lost = new Set([2]);
  const sealedAtTwo = new Uint8Array(future);
  new DataView(sealedAtTwo.buffer).setUint32(4, 2);
  await assert.rejects(lost.open(sealedAtTwo, "11".repeat(16), { sequence: 3 }), (error) => error.code === "chat_key_lost", "no holder left (looked at twice)");
  lost.lost = new Set();
  await assert.rejects(lost.open(new Uint8Array(sealedAtTwo), "11".repeat(16), { sequence: 3 }), (error) => error.code === "chat_key_missing", "held by someone: wait for it");
});

test("a pull cursor names its relay position", () => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, 1234n);
  const cursor = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(cursorSequence(cursor), 1234);
  assert.equal(cursorSequence(""), 0);
});

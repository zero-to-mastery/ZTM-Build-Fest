import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  encodePulseSetRecord,
  encodePulseClearedRecord,
  encodeTalkAddedRecord,
  encodeTalkResolvedRecord,
  encodeTalkReopenedRecord,
  encodeTalkArchivedRecord,
  encodeAddedRecord,
  encodeCompletedRecord,
  encodeReopenedRecord,
  encodeArchivedRecord,
  encodeHandoffAddedRecord,
  encodeHandoffAcknowledgedRecord,
  encodeHandoffArchivedRecord,
  encodeNoteCreatedRecord,
  encodeNoteUpdatedRecord,
  encodeNoteArchivedRecord,
  loadKinEngine as loadCurrentEngine,
} from "./kin-engine.js";
import { replayRequest } from "./abi-test-support.mjs";

// Existing scenarios use a fixed explicit civil context; raw legacy fixtures stay unchanged.
async function loadKinEngine(...args) {
  const engine = await loadCurrentEngine(...args);
  return {
    applyEvents: (
      records,
      asOf,
      cursor = null,
      civilDate = 20261002,
      syncIdentity = null,
    ) => engine.applyEvents(records, asOf, cursor, civilDate, syncIdentity),
  };
}

const initialWasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);

const zeroId = new Uint8Array(16);

function encodeText(text) {
  return encodeAddedRecord({
    eventId: zeroId,
    householdId: zeroId,
    actorId: zeroId,
    deviceId: zeroId,
    timestamp: 1,
    logicalTime: 1,
    itemId: zeroId,
    text,
  });
}

test("leading BOM and Unicode are preserved in event text", () => {
  const text = "\uFEFFmilk 🥛";
  const record = encodeText(text);
  const textBytes = new TextEncoder().encode(text);

  assert.deepEqual(record.subarray(112), textBytes);
  assert.equal(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(record.subarray(112)),
    text,
  );
  assert.equal(new DataView(record.buffer).getUint16(0, true), 2);
  assert.equal(record[104], 1);
});

test("unpaired surrogate input is rejected instead of silently replaced", () => {
  assert.throws(() => encodeText("\uD800"), /valid Unicode/);
});

test("planning dates roundtrip as civil dates and can be cleared", async () => {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadCurrentEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const hex = (value) =>
    [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const context = (sequence) => ({
    eventId: new Uint8Array(16).fill(sequence),
    householdId: new Uint8Array(16).fill(0xaa),
    actorId: new Uint8Array(16).fill(0xbb),
    deviceId: new Uint8Array(16).fill(0xcc),
    timestamp: 1_791_475_200_000 + sequence,
    logicalTime: BigInt(sequence),
  });
  const itemId = new Uint8Array(16).fill(0x42);
  const asOf = 1_791_475_200_000;
  const civilDate = 20261003;
  const records = [
    encodeAddedRecord({
      ...context(1),
      itemId,
      text: "Schedule dinner",
      classification: "need",
    }),
  ];
  const plan = (planningDate, sequence) => engine.executeCommand(
    {
      type: "set-item-planning-date",
      itemId: hex(itemId),
      planningDate,
    },
    context(sequence),
    records,
    asOf,
    null,
    civilDate,
  );

  const planned = plan(20261004, 2);
  assert.equal(planned.state.items[0].planningDate, 20261004);
  assert.equal(planned.state.items[0].lastChangedAt, context(2).timestamp);
  assert.equal(new DataView(planned.encodedEvent.buffer).getUint16(2, true), 30);
  records.push(planned.encodedEvent);

  const cleared = plan(null, 3);
  assert.equal(cleared.state.items[0].planningDate, null);
  assert.equal(cleared.state.items[0].lastChangedAt, context(3).timestamp);
  records.push(cleared.encodedEvent);
  assert.equal(engine.applyEvents(records, asOf, null, civilDate).items[0].planningDate, null);

  assert.throws(
    () => plan(20261301, 4),
    (error) => error.code === 2,
  );
});

test("Pins persist, deduplicate, unpin and replay with stable targets", async () => {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const context = (sequence) => ({
    eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa),
    actorId: new Uint8Array(16).fill(0xbb), deviceId: new Uint8Array(16).fill(0xcc),
    timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence),
  });
  const itemId = new Uint8Array(16).fill(0x43);
  const asOf = 1_791_475_200_000;
  const civilDate = 20261003;
  const records = [encodeAddedRecord({ ...context(1), itemId, text: "Check filter", classification: "need" })];
  const pin = (type, sequence) => engine.executeCommand(
    { type, targetKind: "item", targetId: hex(itemId) }, context(sequence), records, asOf, null, civilDate,
  );
  const first = pin("pin", 2);
  assert.equal(new DataView(first.encodedEvent.buffer).getUint16(2, true), 31);
  assert.deepEqual(first.state.pins, [{ targetKind: "item", targetId: hex(itemId) }]);
  records.push(first.encodedEvent);
  const duplicate = pin("pin", 3);
  assert.equal(duplicate.state.pins.length, 1);
  records.push(duplicate.encodedEvent);
  const removed = pin("unpin", 4);
  assert.deepEqual(removed.state.pins, []);
  records.push(removed.encodedEvent);
  const replayed = engine.applyEvents(records, asOf, null, civilDate);
  assert.deepEqual(replayed.pins, []);
  assert.throws(() => engine.executeCommand(
    { type: "pin", targetKind: "item", targetId: "99".repeat(16) }, context(5), records, asOf, null, civilDate,
  ));
});

test("Responsibility events encode, clear and replay", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const context = (sequence) => ({ eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId: new Uint8Array(16).fill(0xbb), deviceId: new Uint8Array(16).fill(0xcc), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) });
  const itemId = new Uint8Array(16).fill(0x47), memberId = new Uint8Array(16).fill(0x48);
  const records = [encodeAddedRecord({ ...context(1), itemId, text: "Pharmacy pickup", classification: "need" })];
  const change = (member, sequence) => engine.executeCommand({ type: "change-responsibility", targetKind: "item", targetId: hex(itemId), memberId: member ? hex(member) : null }, context(sequence), records, 1_791_475_200_000, null, 20261009);
  const assigned = change(memberId, 2);
  assert.equal(new DataView(assigned.encodedEvent.buffer).getUint16(2, true), 41);
  assert.deepEqual(assigned.state.responsibilities, [{ targetKind: "item", targetId: hex(itemId), memberId: hex(memberId) }]);
  records.push(assigned.encodedEvent);
  const cleared = change(null, 3);
  assert.equal(cleared.state.responsibilities[0].memberId, null);
  records.push(cleared.encodedEvent);
  assert.deepEqual(engine.applyEvents(records, 1_791_475_200_010, null, 20261009).responsibilities, cleared.state.responsibilities);
});

test("device names describe, nickname, clear and replay outside the projection (#71)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const member = new Uint8Array(16).fill(0xbb), phone = new Uint8Array(16).fill(0xcc), laptop = new Uint8Array(16).fill(0xcd);
  const context = (sequence, deviceId = phone, actorId = member) => ({ eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId, deviceId, timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) });
  const asOf = 1_791_475_200_100, day = 20261009;
  const records = [];
  const run = (command, ctx) => {
    const result = engine.executeCommand(command, ctx, records, asOf, null, day);
    records.push(result.encodedEvent);
    return result;
  };
  const described = run({ type: "describe-device", autoName: " Chrome on iPhone " }, context(1));
  assert.equal(new DataView(described.encodedEvent.buffer).getUint16(2, true), 42);
  run({ type: "describe-device", autoName: "Firefox on Windows" }, context(2, laptop));
  const named = run({ type: "nickname-device", targetDeviceId: hex(phone), nickname: "Kitchen phone" }, context(3, laptop));
  assert.equal(new DataView(named.encodedEvent.buffer).getUint16(2, true), 43);
  assert.deepEqual(engine.deviceNames(records, asOf, day), [
    { deviceId: hex(phone), memberId: hex(member), autoName: "Chrome on iPhone", nickname: "Kitchen phone" },
    { deviceId: hex(laptop), memberId: hex(member), autoName: "Firefox on Windows", nickname: null },
  ]);
  // The same name again records nothing; another member cannot name it.
  assert.throws(() => engine.executeCommand({ type: "describe-device", autoName: "Chrome on iPhone" }, context(4), records, asOf, null, day), (error) => error.code === 4);
  assert.throws(() => engine.executeCommand({ type: "nickname-device", targetDeviceId: hex(phone), nickname: "Mine" }, context(4, new Uint8Array(16).fill(0xee), new Uint8Array(16).fill(0xef)), records, asOf, null, day), (error) => error.code === 4);
  assert.throws(() => engine.executeCommand({ type: "nickname-device", nickname: "No target" }, context(4), records, asOf, null, day), (error) => error.code === 2);
  run({ type: "nickname-device", targetDeviceId: hex(phone), nickname: null }, context(4));
  assert.equal(engine.deviceNames(records, asOf, day)[0].nickname, null);
  assert.deepEqual(engine.eventMetadata(records[3]).kind, "DEVICE_NICKNAMED");
  assert.equal(engine.applyEvents(records, asOf, null, day).items.length, 0);
});

test("members set, rename and clear only their own name outside the projection (#224)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const mikey = new Uint8Array(16).fill(0xbb), sam = new Uint8Array(16).fill(0xbe);
  const context = (sequence, actorId = mikey, device = 0xcc) => ({ eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId, deviceId: new Uint8Array(16).fill(device), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) });
  const asOf = 1_791_475_200_100, day = 20261009;
  const records = [];
  const run = (command, ctx) => {
    const result = engine.executeCommand(command, ctx, records, asOf, null, day);
    records.push(result.encodedEvent);
    return result;
  };
  const named = run({ type: "name-member", name: "  Mikey " }, context(1));
  assert.equal(new DataView(named.encodedEvent.buffer).getUint16(2, true), 51);
  assert.equal(engine.eventMetadata(named.encodedEvent).kind, "MEMBER_NAMED");
  run({ type: "name-member", name: "Sam" }, context(2, sam, 0xdd));
  assert.deepEqual(engine.memberNames(records, asOf, day), [
    { memberId: hex(mikey), name: "Mikey" },
    { memberId: hex(sam), name: "Sam" },
  ]);
  // The same name again records nothing; an invalid name is refused.
  assert.throws(() => engine.executeCommand({ type: "name-member", name: "Mikey" }, context(3, mikey, 0xcd), records, asOf, null, day), (error) => error.code === 4);
  assert.throws(() => engine.executeCommand({ type: "name-member", name: "M".repeat(33) }, context(3), records, asOf, null, day), (error) => error.code === 4);
  // Another device of the same member renames; clearing falls back.
  run({ type: "name-member", name: "Michael" }, context(3, mikey, 0xcd));
  run({ type: "name-member", name: "" }, context(4, sam, 0xdd));
  assert.deepEqual(engine.memberNames(records, asOf, day), [{ memberId: hex(mikey), name: "Michael" }]);
  assert.equal(engine.applyEvents(records, asOf, null, day).items.length, 0);
});

test("chat posts, edits, deletes and pages from its own log through real WASM (#109)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const member = new Uint8Array(16).fill(0xbb), other = new Uint8Array(16).fill(0xbe), admin = new Uint8Array(16).fill(0xbf);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const context = (sequence, actorId = member) => ({ eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId, deviceId: new Uint8Array(16).fill(actorId[0] - 0x10), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) });
  const asOf = 1_791_475_200_100, day = 20261009;
  const blob = (byte) => byte.toString(16).padStart(2, "0").repeat(32);
  const chat = [];
  const run = (command, ctx) => {
    const result = engine.executeChatCommand(command, ctx, chat, asOf, day);
    chat.push(result.encodedEvent);
    return result;
  };
  const posted = run({ type: "post-chat-message", messageId: "01".repeat(16), blobRef: blob(0xa1), blobKey: blob(0xc1) }, context(1));
  assert.equal(new DataView(posted.encodedEvent.buffer).getUint16(2, true), 44);
  assert.equal(posted.metadata.kind, "CHAT_MESSAGE_POSTED");
  run({ type: "post-chat-message", messageId: "02".repeat(16), blobRef: blob(0xa2), blobKey: blob(0xc2) }, context(2, other));
  run({ type: "edit-chat-message", messageId: "01".repeat(16), blobRef: blob(0xa3), blobKey: blob(0xc3) }, context(3));
  // Only the author edits; your own message is not deleted "as admin".
  assert.throws(() => engine.executeChatCommand({ type: "edit-chat-message", messageId: "01".repeat(16), blobRef: blob(0xa4), blobKey: blob(0xc4) }, context(4, other), chat, asOf, day), (error) => error.code === 4);
  assert.throws(() => engine.executeChatCommand({ type: "delete-chat-message", messageId: "01".repeat(16), byAdmin: true }, context(4), chat, asOf, day, null, [hex(member)]), (error) => error.code === 4);
  // A removal needs its actor among the admins the host names.
  assert.throws(() => engine.executeChatCommand({ type: "delete-chat-message", messageId: "02".repeat(16), byAdmin: true }, context(4, admin), chat, asOf, day), (error) => error.code === 4);
  chat.push(engine.executeChatCommand({ type: "delete-chat-message", messageId: "02".repeat(16), byAdmin: true }, context(4, admin), chat, asOf, day, null, [hex(admin)]).encodedEvent);
  assert.deepEqual(engine.putChatTexts([{ blobRef: blob(0xa3), text: "Dinner at 6" }, { blobRef: blob(0xa2), text: "\u0007" }]), [true, false]);
  const page = engine.chatPage(chat, { includeRetired: true, admins: [hex(admin)] }, asOf, day);
  assert.equal(page.total, 2);
  assert.deepEqual(page.messages.map(({ status, text }) => [status, text]), [["edited", "Dinner at 6"], ["removed-by-admin", null]]);
  assert.equal(page.messages[0].blobRef, blob(0xa3));
  assert.deepEqual(page.messages[0].blobKey, new Uint8Array(32).fill(0xc3));
  assert.deepEqual(page.retired, [blob(0xa1), blob(0xa2)]);
  // Without that admin named, the removal doesn't count.
  assert.equal(engine.chatPage(chat, {}, asOf, day).messages[1].status, "live");
  run({ type: "delete-chat-message", messageId: "01".repeat(16) }, context(5));
  assert.equal(engine.chatPage(chat, { limit: 1, before: 1 }, asOf, day).messages[0].status, "deleted");
  // The logs stay apart: chat events never enter the household history, and
  // chat commands never run against it.
  assert.throws(() => engine.applyEvents(chat, asOf, null, day), (error) => error.code === 4);
  assert.throws(() => engine.executeCommand({ type: "post-chat-message", messageId: "09".repeat(16), blobRef: blob(0xa9), blobKey: blob(0xc9) }, context(6), [], asOf, null, day), (error) => error.code === 4);
  assert.throws(() => engine.executeChatCommand({ type: "add", text: "Milk" }, context(6), chat, asOf, day), (error) => error.code === 2);
  assert.equal(engine.applyEvents([], asOf, null, day).items.length, 0);
  // Texts last until lock, or until cleared.
  engine.putChatTexts([{ blobRef: blob(0xa5), text: "kept" }]);
  engine.clearChatTexts();
  assert.equal(engine.chatPage(chat, {}, asOf, day).messages.some((message) => message.text !== null), false);
});

test("chat reactions toggle, list and drop with their message through real WASM (#127)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const member = new Uint8Array(16).fill(0xbb), other = new Uint8Array(16).fill(0xbe);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const context = (sequence, actorId = member) => ({ eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId, deviceId: new Uint8Array(16).fill(actorId[0] - 0x10), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) });
  const asOf = 1_791_475_200_100, day = 20261009;
  const blob = (byte) => byte.toString(16).padStart(2, "0").repeat(32);
  const chat = [];
  const run = (command, ctx) => {
    const result = engine.executeChatCommand(command, ctx, chat, asOf, day);
    chat.push(result.encodedEvent);
    return result;
  };
  const message = "01".repeat(16);
  run({ type: "post-chat-message", messageId: message, blobRef: blob(0xa1), blobKey: blob(0xc1) }, context(1));
  const reacted = run({ type: "react-chat-message", messageId: message, emoji: "\u{1F44D}", on: true }, context(2, other));
  assert.equal(new DataView(reacted.encodedEvent.buffer).getUint16(2, true), 47);
  assert.equal(reacted.metadata.kind, "CHAT_REACTION_SET");
  run({ type: "react-chat-message", messageId: message, emoji: "\u{1F44D}", on: true }, context(3));
  run({ type: "react-chat-message", messageId: message, emoji: "\u2764\uFE0F", on: true }, context(4));
  // Redundant, unknown and malformed reactions are refused.
  for (const command of [
    { type: "react-chat-message", messageId: message, emoji: "\u{1F44D}", on: true },
    { type: "react-chat-message", messageId: message, emoji: "\u{1F602}", on: false },
    { type: "react-chat-message", messageId: "09".repeat(16), emoji: "\u{1F44D}", on: true },
    { type: "react-chat-message", messageId: message, emoji: "hi", on: true },
  ]) assert.throws(() => engine.executeChatCommand(command, context(9), chat, asOf, day), (error) => error.code === 4);
  assert.throws(() => engine.executeChatCommand({ type: "react-chat-message", messageId: message, emoji: "\u{1F44D}" }, context(9), chat, asOf, day), (error) => error.code === 2);
  // Pages carry reactions only when asked.
  assert.deepEqual(engine.chatPage(chat, {}, asOf, day).messages[0].reactions, []);
  const page = engine.chatPage(chat, { includeReactions: true }, asOf, day);
  assert.deepEqual(page.messages[0].reactions, [
    { emoji: "\u{1F44D}", actors: [hex(other), hex(member)] },
    { emoji: "\u2764\uFE0F", actors: [hex(member)] },
  ]);
  // Taking one back; deleting the message drops them all.
  run({ type: "react-chat-message", messageId: message, emoji: "\u{1F44D}", on: false }, context(5, other));
  assert.deepEqual(engine.chatPage(chat, { includeReactions: true }, asOf, day).messages[0].reactions.map(({ emoji }) => emoji), ["\u{1F44D}", "\u2764\uFE0F"]);
  assert.deepEqual(engine.chatPage(chat, { includeReactions: true }, asOf, day).messages[0].reactions[0].actors, [hex(member)]);
  run({ type: "delete-chat-message", messageId: message }, context(6));
  assert.deepEqual(engine.chatPage(chat, { includeReactions: true }, asOf, day).messages[0].reactions, []);
});

test("a chat reply quotes its original through real WASM (#129)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const member = new Uint8Array(16).fill(0xbb), other = new Uint8Array(16).fill(0xbe);
  const context = (sequence, actorId = member) => ({ eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId, deviceId: new Uint8Array(16).fill(actorId[0] - 0x10), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) });
  const asOf = 1_791_475_200_100, day = 20261009;
  const blob = (byte) => byte.toString(16).padStart(2, "0").repeat(32);
  const chat = [];
  const run = (command, ctx) => {
    const result = engine.executeChatCommand(command, ctx, chat, asOf, day);
    chat.push(result.encodedEvent);
    return result;
  };
  const original = "01".repeat(16), answer = "02".repeat(16);
  run({ type: "post-chat-message", messageId: original, blobRef: blob(0xa1), blobKey: blob(0xc1) }, context(1));
  // A reply to nothing, or to itself, is refused.
  for (const replyTo of ["09".repeat(16), answer])
    assert.throws(() => engine.executeChatCommand({ type: "post-chat-message", messageId: answer, blobRef: blob(0xa2), blobKey: blob(0xc2), replyTo }, context(2, other), chat, asOf, day), (error) => error.code === 4 || error.code === 2);
  assert.throws(() => engine.executeChatCommand({ type: "post-chat-message", messageId: answer, blobRef: blob(0xa2), blobKey: blob(0xc2), replyTo: "00".repeat(16) }, context(2, other), chat, asOf, day), (error) => error.code === 2);
  const posted = run({ type: "post-chat-message", messageId: answer, blobRef: blob(0xa2), blobKey: blob(0xc2), replyTo: original }, context(2, other));
  assert.equal(posted.encodedEvent.length, 88 + 100);
  engine.putChatTexts([{ blobRef: blob(0xa1), text: "Dinner at 6" }]);
  let page = engine.chatPage(chat, {}, asOf, day);
  assert.equal(page.messages[0].replyTo, null);
  assert.deepEqual(
    { ...page.messages[1].replyTo, blobKey: [...page.messages[1].replyTo.blobKey].every((byte) => byte === 0xc1) },
    { messageId: original, state: "live", contentKind: "text", authorId: "bb".repeat(16), index: 0, blobRef: blob(0xa1), blobKey: true, text: "Dinner at 6" },
  );
  // Without texts the quote has none; once the original is deleted it has no blob either.
  assert.equal(engine.chatPage(chat, { includeText: false }, asOf, day).messages[1].replyTo.text, null);
  run({ type: "delete-chat-message", messageId: original }, context(3));
  page = engine.chatPage(chat, {}, asOf, day);
  assert.deepEqual([page.messages[1].replyTo.state, page.messages[1].replyTo.blobRef, page.messages[1].replyTo.text], ["deleted", null, null]);
  // Replying to a deleted message is refused.
  assert.throws(() => engine.executeChatCommand({ type: "post-chat-message", messageId: "03".repeat(16), blobRef: blob(0xa3), blobKey: blob(0xc3), replyTo: original }, context(4), chat, asOf, day), (error) => error.code === 4);
});

test("Attachment bind and remove intent payloads roundtrip through real WASM", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const context = (sequence) => ({ eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId: new Uint8Array(16).fill(0xbb), deviceId: new Uint8Array(16).fill(0xcc), timestamp: 1_791_475_000_000 + sequence, logicalTime: BigInt(sequence) });
  const itemId = new Uint8Array(16).fill(0x51), attachmentId = new Uint8Array(16).fill(0x52);
  const records = [encodeAddedRecord({ ...context(1), itemId, text: "Photo", classification: "need" })];
  const bound = engine.executeCommand({ type: "bind-attachment", id: hex(attachmentId), parentKind: "item", parentId: hex(itemId) }, context(2), records, 1_791_475_000_000, null, 20261009);
  assert.equal(new DataView(bound.encodedEvent.buffer).getUint16(2, true), 39);
  assert.deepEqual(bound.state.attachments, [{ attachmentId: hex(attachmentId), parentKind: "item", parentId: hex(itemId), removed: false }]);
  records.push(bound.encodedEvent);
  const removed = engine.executeCommand({ type: "remove-attachment", id: hex(attachmentId) }, context(3), records, 1_791_475_000_000, null, 20261009);
  assert.equal(new DataView(removed.encodedEvent.buffer).getUint16(2, true), 40);
  assert.equal(removed.state.attachments[0].removed, true);
});

test("bridge rejects invalid or truncated Item history timestamps and recovers", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let mutateResult = () => {};
  let exposedResultLength = null;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args);
    const abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_project(pointer, length) {
            const status = abi.kin_project(pointer, length);
            if (status === 0) {
              mutateResult(
                new Uint8Array(
                  abi.memory.buffer,
                  abi.kin_result_ptr(),
                  abi.kin_result_len(),
                ),
              );
            }
            return status;
          },
          kin_result_len() {
            return exposedResultLength ?? abi.kin_result_len();
          },
        },
      },
    };
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadCurrentEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const records = [encodeText("history")];
  const apply = () => engine.applyEvents(records, 0, null, 20261003);

  mutateResult = (bytes) => {
    new DataView(bytes.buffer, bytes.byteOffset).setBigInt64(
      147,
      8_640_000_000_000_001n,
      true,
    );
  };
  assert.throws(apply, (error) => error.code === 6);
  mutateResult = () => {};
  exposedResultLength = 154;
  assert.throws(apply, (error) => error.code === 6);
  exposedResultLength = null;
  assert.equal(apply().items[0].lastChangedAt, 1);
});

test("item text is bounded by UTF-8 bytes rather than character count", () => {
  const maximum = "🥛".repeat(1024);
  const record = encodeText(maximum);

  assert.equal(record.length, 88 + 24 + 4096);
  assert.throws(() => encodeText(`${maximum}x`), /4096 UTF-8 bytes/);
});

test("invalid classification is rejected", () => {
  assert.throws(
    () =>
      encodeAddedRecord({
        eventId: zeroId,
        householdId: zeroId,
        actorId: zeroId,
        deviceId: zeroId,
        timestamp: 1,
        logicalTime: 1,
        itemId: zeroId,
        text: "Milk",
        classification: "later",
      }),
    /valid list/,
  );
});

test("current real WASM replays Shopping classification and summary", async () => {
  const engine = await loadCurrentEngine(
    `data:application/wasm;base64,${initialWasm.toString("base64")}`,
  );
  const record = encodeAddedRecord({
    eventId: zeroId,
    householdId: new Uint8Array(16).fill(1),
    actorId: new Uint8Array(16).fill(2),
    deviceId: new Uint8Array(16).fill(3),
    timestamp: 1,
    logicalTime: 1,
    itemId: new Uint8Array(16).fill(4),
    text: "Buy wipes",
    classification: "shopping",
  });
  assert.equal(record[104], 2);
  const state = engine.applyEvents([record], 1234, null, 20261003);
  assert.equal(state.items[0].classification, "shopping");
  assert.deepEqual(
    state.summary.entries.map((entry) => entry.classification),
    ["shopping"],
  );
});

test("real WASM replays Staples classification and summary", async () => {
  const engine = await loadCurrentEngine(
    `data:application/wasm;base64,${initialWasm.toString("base64")}`,
  );
  const record = encodeAddedRecord({
    eventId: zeroId,
    householdId: new Uint8Array(16).fill(1),
    actorId: new Uint8Array(16).fill(2),
    deviceId: new Uint8Array(16).fill(3),
    timestamp: 1,
    logicalTime: 1,
    itemId: new Uint8Array(16).fill(5),
    text: "Laundry detergent",
    classification: "staple",
  });
  assert.equal(record[104], 3);
  const state = engine.applyEvents([record], 1234, null, 20261003);
  assert.equal(state.items[0].classification, "staple");
  assert.deepEqual(
    state.summary.entries.map((entry) => entry.classification),
    ["staple"],
  );
});

test("real WASM exposes item lifecycle destinations in the catch-up summary", async () => {
  const engine = await loadCurrentEngine(
    `data:application/wasm;base64,${initialWasm.toString("base64")}`,
  );
  const bytes = (value) => new Uint8Array(16).fill(value);
  const itemId = bytes(0x44);
  const identity = (sequence) => ({
    eventId: bytes(sequence),
    householdId: bytes(0xaa),
    actorId: bytes(0xbb),
    deviceId: bytes(0xcc),
    timestamp: 1_760_000_000_000 + sequence,
    logicalTime: BigInt(sequence),
    itemId,
  });
  const records = [
    encodeAddedRecord({ ...identity(1), text: "Milk", classification: "shopping" }),
    encodeCompletedRecord(identity(2)),
    encodeReopenedRecord(identity(3)),
    encodeArchivedRecord(identity(4)),
  ];

  const state = engine.applyEvents(records, 1_760_000_000_010, bytes(1), 20261003);

  assert.deepEqual(
    state.summary.entries.map(({ kind, classification }) => [kind, classification]),
    [
      ["item-completed", "shopping"],
      ["item-reopened", "shopping"],
      ["item-archived", "shopping"],
    ],
  );
});

test("real WASM replays stable Note create update and terminal archive", async () => {
  const engine = await loadKinEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const bytes = (value) => new Uint8Array(16).fill(value);
  const identity = (sequence) => ({ eventId: bytes(sequence), householdId: bytes(200), actorId: bytes(sequence), deviceId: bytes(201), timestamp: 1_760_000_000_000 + sequence, logicalTime: sequence, noteId: bytes(9) });
  const created = encodeNoteCreatedRecord({ ...identity(1), title: " Wi-Fi ", body: "Router details\nGuest network" });
  const updated = encodeNoteUpdatedRecord({ ...identity(2), title: "Wi-Fi", body: "Router details" });
  const archived = encodeNoteArchivedRecord(identity(3));
  const state = engine.applyEvents([created, updated, archived], 1_760_000_000_010, null, 20261005);
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].noteId, "09".repeat(16));
  assert.equal(state.notes[0].title, "Wi-Fi");
  assert.equal(state.notes[0].body, "Router details");
  assert.equal(state.notes[0].archived, true);
  assert.deepEqual(engine.applyEvents([], 1_760_000_000_010, null, 20261005).notes, []);
});

test("real WASM keeps ordered Step lifecycle separate from its Item", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const bytes = (value) => new Uint8Array(16).fill(value);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const context = (sequence) => ({
    eventId: bytes(sequence),
    householdId: bytes(200),
    actorId: bytes(2),
    deviceId: bytes(201),
    timestamp: 1_791_475_200_000 + sequence,
    logicalTime: BigInt(sequence),
  });
  const itemId = bytes(10);
  const firstStepId = bytes(20);
  const secondStepId = bytes(21);
  const item = encodeAddedRecord({
    ...context(1),
    itemId,
    text: "Clean kitchen",
    classification: "need",
  });
  const records = [item];
  const run = (type, sequence, stepId, text) =>
    engine.executeCommand(
      {
        type,
        itemId: hex(itemId),
        stepId: hex(stepId),
        ...(text === undefined ? {} : { text }),
      },
      context(sequence),
      records,
      1_791_475_200_000,
      null,
      20261008,
    );

  for (const [sequence, stepId, text] of [
    [2, firstStepId, "Clear counters"],
    [3, secondStepId, "Wipe stove"],
  ]) {
    const result = run("add-item-step", sequence, stepId, text);
    records.push(result.encodedEvent);
  }
  const completedFirst = run("complete-item-step", 4, firstStepId);
  records.push(completedFirst.encodedEvent);
  let state = completedFirst.state;
  assert.equal(state.items[0].status, "active");
  assert.deepEqual(
    state.items[0].steps.map((step) => [step.stepId, step.text, step.completed]),
    [
      [hex(firstStepId), "Clear counters", true],
      [hex(secondStepId), "Wipe stove", false],
    ],
  );
  const completedSecond = run("complete-item-step", 5, secondStepId);
  records.push(completedSecond.encodedEvent);
  state = completedSecond.state;
  assert.equal(state.items[0].status, "active");
  assert.equal(state.items[0].steps.filter((step) => step.completed).length, 2);

  const reopened = run("reopen-item-step", 6, firstStepId);
  records.push(reopened.encodedEvent);
  const archived = engine.executeCommand(
    { type: "archive-item-step", itemId: hex(itemId), stepId: hex(firstStepId) },
    context(7),
    records,
    1_791_475_200_000,
    null,
    20261008,
  );
  records.push(archived.encodedEvent);
  assert.equal(archived.state.items[0].status, "active");
  assert.deepEqual(
    archived.state.items[0].steps.map((step) => [step.stepId, step.completed, step.archived]),
    [
      [hex(firstStepId), false, true],
      [hex(secondStepId), true, false],
    ],
  );
  assert.deepEqual(engine.applyEvents([], 1_791_475_200_000, null, 20261008).items, []);
  assert.throws(
    () => run("complete-item-step", 8, firstStepId),
    (error) => error.code === 4,
  );
});

// Independent v0.1 wire fixtures: do not use the current event writer to
// define the historical record layout that these compatibility tests protect.
// A protocol-24 record: schema-2 ITEM_ADDED ("Milk", Today) for kind 1,
// otherwise a schema-1 record whose payload is one entity ID.
function legacyRecord(kind, sequence) {
  const record = new Uint8Array(kind === 1 ? 116 : 104);
  const view = new DataView(record.buffer);
  view.setUint16(0, kind === 1 ? 2 : 1, true);
  view.setUint16(2, kind, true);
  record.fill(sequence, 4, 20);
  record.fill(0xaa, 20, 36);
  record.fill(0xbb, 36, 52);
  record.fill(0xcc, 52, 68);
  view.setBigInt64(68, BigInt(sequence), true);
  view.setBigUint64(76, BigInt(sequence), true);
  view.setUint32(84, record.length - 88, true);
  record.fill(0x11, 88, 104);
  if (kind === 1) {
    view.setUint32(108, 4, true);
    record.set([77, 105, 108, 107], 112); // Milk
  }
  return record;
}

function expectedState(version, status = null, classification = 0) {
  const bytes = new Uint8Array(status === null ? 12 : 64);
  bytes.set([
    75,
    73,
    78,
    83,
    version,
    0,
    0,
    0,
    status === null ? 0 : 1,
    0,
    0,
    0,
  ]);
  if (status !== null) {
    bytes.fill(0x11, 12, 28);
    bytes.fill(0xbb, 28, 44);
    bytes[44] = 1; // created_at:i64 little endian
    bytes[52] = version === 1 ? status : classification;
    bytes[53] = version === 1 ? 0 : status;
    bytes[56] = 4; // text_length:u32 little endian
    bytes.set([77, 105, 108, 107], 60);
  }
  return bytes;
}

function emptyV7State() {
  return {
    items: [],
    handoffs: [],
    talks: [],
    pulses: [],
    routines: [],
    areas: [],
    notes: [],
    pins: [],
    playbooks: [],
    referenceRecords: [],
    maintenanceEvents: [],
    summary: { entries: [], totalCount: 0, throughEventId: null },
  };
}

test("identity bindings resolve placeholder history without rewriting records", async () => {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const first = legacyRecord(1, 1);
  const second = legacyRecord(1, 2);
  second.fill(0xdd, 20, 36);
  second.fill(0xee, 36, 52);
  second.fill(0xff, 52, 68);
  second.fill(0x22, 88, 104);
  new DataView(second.buffer).setBigUint64(76, 1n, true);
  new DataView(first.buffer).setBigUint64(76, 1n, true);
  const firstBytes = first.slice();
  const secondBytes = second.slice();
  const householdId = "99".repeat(16);
  const syncIdentity = {
    householdId,
    bindings: [
      {
        legacyHouseholdId: "aa".repeat(16),
        legacyActorId: "bb".repeat(16),
        legacyDeviceId: "cc".repeat(16),
        householdId,
        actorId: "22".repeat(16),
        deviceId: "02".repeat(16),
      },
      {
        legacyHouseholdId: "dd".repeat(16),
        legacyActorId: "ee".repeat(16),
        legacyDeviceId: "ff".repeat(16),
        householdId,
        actorId: "33".repeat(16),
        deviceId: "01".repeat(16),
      },
    ],
  };

  const state = engine.applyEvents(
    [first, second],
    0,
    null,
    20261002,
    syncIdentity,
  );
  assert.deepEqual(
    state.items.map((item) => item.createdBy),
    ["33".repeat(16), "22".repeat(16)],
  );
  assert.deepEqual(first, firstBytes);
  assert.deepEqual(second, secondBytes);
  assert.throws(
    () =>
      engine.applyEvents([first], 0, null, 20261002, {
        householdId,
        bindings: [],
      }),
    (error) => error.code === 4,
  );
});

test("10,000 equal-time events replay through real WASM deterministically", async () => {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const id = (value) => value.toString(16).padStart(32, "0");
  const idBytes = (value) =>
    Uint8Array.from(
      Array.from({ length: 16 }, (_, index) =>
        Number.parseInt(id(value).slice(index * 2, index * 2 + 2), 16),
      ),
    );
  const records = Array.from({ length: 10_000 }, (_, index) =>
    encodeAddedRecord({
      eventId: idBytes(index + 1),
      householdId: new Uint8Array(16).fill(0xaa),
      actorId: new Uint8Array(16).fill(0xbb),
      deviceId: new Uint8Array(16).fill(0xcc),
      timestamp: 1,
      logicalTime: 7n,
      itemId: idBytes(index + 10_001),
      text: "x",
      classification: "need",
    }),
  );
  const householdId = "dd".repeat(16);
  const syncIdentity = {
    householdId,
    bindings: [
      {
        legacyHouseholdId: "aa".repeat(16),
        legacyActorId: "bb".repeat(16),
        legacyDeviceId: "cc".repeat(16),
        householdId,
        actorId: "ee".repeat(16),
        deviceId: "ff".repeat(16),
      },
    ],
  };
  const state = engine.applyEvents(records, 0, null, 20261002, syncIdentity);
  assert.equal(state.items.length, 10_000);
  assert.equal(state.items[0].createdBy, "ee".repeat(16));
  assert.equal(state.summary.totalCount, 10_000);
  assert.equal(state.summary.throughEventId, id(10_000));
  assert.equal(state.summary.entries.length, 8);
});

async function rawEngine() {
  const { instance } = await WebAssembly.instantiate(
    await readFile(new URL("./kin_engine.wasm", import.meta.url)),
    {},
  );
  const abi = instance.exports;
  // Protocol-24 requests; the version argument is kept for call-site clarity.
  return (version, records, expectedStatus = 0, asOf = 0) => {
    assert.equal(version, 24);
    const headerSize = 64;
    const request = new Uint8Array(
      headerSize + records.reduce((size, row) => size + row.length, 0),
    );
    request.set([75, 73, 78, 69, 24, 0, 0, 0]);
    new DataView(request.buffer).setUint32(8, records.length, true);
    new DataView(request.buffer).setBigInt64(12, BigInt(asOf), true);
    new DataView(request.buffer).setUint32(40, 20261002, true);
    let offset = headerSize;
    for (const record of records) {
      request.set(record, offset);
      offset += record.length;
    }
    assert.equal(replayRequest(abi, request), expectedStatus);
    const success = expectedStatus === 0;
    assert.equal(success ? abi.kin_error_ptr() : abi.kin_result_ptr(), 0);
    assert.equal(success ? abi.kin_error_len() : abi.kin_result_len(), 0);
    const result = new Uint8Array(
      abi.memory.buffer,
      success ? abi.kin_result_ptr() : abi.kin_error_ptr(),
      success ? abi.kin_result_len() : abi.kin_error_len(),
    ).slice();
    if (!success) {
      assert.deepEqual(
        result.subarray(0, 8),
        new Uint8Array([75, 69, 82, 82, 1, 0, expectedStatus, 0]),
      );
      assert.equal(
        result.length,
        12 + new DataView(result.buffer).getUint32(8, true),
      );
    }
    return result;
  };
}

test("real WASM projection accepts only an exact live input allocation", async () => {
  const { instance } = await WebAssembly.instantiate(
    await readFile(new URL("./kin_engine.wasm", import.meta.url)),
    {},
  );
  const abi = instance.exports;
  const request = new Uint8Array(64);
  request.set([75, 73, 78, 69, 24, 0, 0, 0]);
  new DataView(request.buffer).setUint32(40, 20261002, true);
  const pointer = abi.kin_alloc(request.length);
  assert.notEqual(pointer, 0);
  new Uint8Array(abi.memory.buffer, pointer, request.length).set(request);

  try {
    assert.equal(abi.kin_project(pointer, request.length), 0);
    const resultPointer = abi.kin_result_ptr();
    const resultLength = abi.kin_result_len();
    assert.equal(abi.kin_project(resultPointer, resultLength), 1);
    const errorPointer = abi.kin_error_ptr();
    const errorLength = abi.kin_error_len();
    assert.equal(abi.kin_project(errorPointer, errorLength), 1);
    assert.equal(abi.kin_project(pointer + 1, request.length - 1), 1);
    assert.equal(abi.kin_project(pointer, request.length - 1), 1);
    assert.equal(abi.kin_project(pointer, request.length + 1), 1);
    assert.equal(abi.kin_project(1, request.length), 1);
    assert.equal(abi.kin_project(0, 0), 2);

    // Rejected calls do not consume the legitimate input allocation.
    assert.equal(abi.kin_project(pointer, request.length), 0);
  } finally {
    assert.equal(abi.kin_free(pointer, request.length), 0);
  }
});

test("bridge accepts KERR version 1 and rejects other or malformed versions", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let mutateError = () => {};
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args);
    const abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_project(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(pointer + 4, 99, true);
            const status = abi.kin_project(pointer, length);
            mutateError(
              new Uint8Array(
                abi.memory.buffer,
                abi.kin_error_ptr(),
                abi.kin_error_len(),
              ),
            );
            return status;
          },
        },
      },
    };
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );

  for (const [label, mutation, expectedCode] of [
    ["version 1", () => {}, 3],
    ["version 2", (bytes) => (bytes[4] = 2), 6],
    ["version 7", (bytes) => (bytes[4] = 7), 6],
    [
      "malformed length",
      (bytes) =>
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(8, 0, true),
      6,
    ],
  ]) {
    mutateError = mutation;
    assert.throws(
      () => engine.applyEvents([], 0),
      (error) => error.code === expectedCode,
      label,
    );
  }
});

function handoff(sequence, kind = 5, text = "Dishwasher running") {
  const identity = {
    eventId: new Uint8Array(16).fill(sequence),
    householdId: new Uint8Array(16).fill(0xaa),
    actorId: new Uint8Array(16).fill(0xbb),
    deviceId: new Uint8Array(16).fill(0xcc),
    timestamp: sequence,
    logicalTime: sequence,
    handoffId: new Uint8Array(16).fill(0x22),
    text,
  };
  return (
    kind === 5
      ? encodeHandoffAddedRecord
      : kind === 6
        ? encodeHandoffAcknowledgedRecord
        : encodeHandoffArchivedRecord
  )(identity);
}

test("Handoff text encoder preserves Unicode and enforces byte bounds", () => {
  const text = "\uFEFF" + "🥛".repeat(1023) + "x";
  const record = handoff(1, 5, text);
  assert.equal(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(record.subarray(108)),
    text,
  );
  assert.equal(record.length, 108 + 4096);
  assert.throws(() => handoff(1, 5, text + "x"), /4096/);
  assert.throws(() => handoff(1, 5, "\uD800"), /valid Unicode/);
});

test("large Handoff replay grows WASM memory and preserves independent repeated results", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let memory;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args);
    memory = result.instance.exports.memory;
    return result;
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const initial = memory.buffer.byteLength;
  const id = (number) => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, number, true);
    return bytes;
  };
  const records = Array.from({ length: 10000 }, (_, index) =>
    encodeHandoffAddedRecord({
      eventId: id(index + 1),
      handoffId: id(index + 1),
      householdId: zeroId,
      actorId: zeroId,
      deviceId: zeroId,
      timestamp: index,
      logicalTime: index + 1,
      text: index < 1000 ? "x".repeat(4096) : "x",
    }),
  );
  const state = engine.applyEvents(records, 0);
  assert.ok(memory.buffer.byteLength > initial, "real memory growth occurred");
  assert.equal(state.handoffs.length, 10000);
  assert.equal(state.handoffs[999].text.length, 4096);
  for (let iteration = 0; iteration < 4; iteration++) {
    const bad = handoff(1);
    new DataView(bad.buffer).setUint16(2, 99, true);
    assert.throws(
      () => engine.applyEvents([bad], 0),
      (error) => error.code === 3,
    );
    assert.deepEqual(engine.applyEvents([], 0), emptyV7State());
    assert.deepEqual(engine.applyEvents(records, 0), state);
  }
  assert.equal(
    state.handoffs[0].text.length,
    4096,
    "host-owned result survives later calls",
  );
  assert.throws(
    () => engine.applyEvents([...records, records[0]], 0),
    (error) => error.code === 5,
  );
});

function talk(sequence, kind = 8, text = "Weekend plans") {
  const values = {
    eventId: new Uint8Array(16).fill(sequence),
    householdId: new Uint8Array(16).fill(0xaa),
    actorId: new Uint8Array(16).fill(0xbb),
    deviceId: new Uint8Array(16).fill(0xcc),
    timestamp: sequence,
    logicalTime: sequence,
    talkId: new Uint8Array(16).fill(0x33),
    text,
  };
  return {
    8: encodeTalkAddedRecord,
    9: encodeTalkResolvedRecord,
    10: encodeTalkReopenedRecord,
    11: encodeTalkArchivedRecord,
  }[kind](values);
}

test("Talk payload codes, schemas, Unicode and byte limits", () => {
  const text = "\uFEFF" + "\u{1f95b}".repeat(1023) + "x";
  for (const kind of [8, 9, 10, 11]) {
    const row = talk(1, kind, text),
      view = new DataView(row.buffer);
    assert.equal(view.getUint16(0, true), 1);
    assert.equal(view.getUint16(2, true), kind);
    assert.equal(row.length, kind === 8 ? 108 + 4096 : 104);
  }
  assert.throws(() => talk(1, 8, text + "x"), /4096/);
  assert.throws(() => talk(1, 8, "\uD800"), /valid Unicode/);
});

test("large Talk replay grows WASM memory and preserves independent repeated results", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let memory;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args);
    memory = result.instance.exports.memory;
    return result;
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const initial = memory.buffer.byteLength;
  const id = (number) => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, number, true);
    return bytes;
  };
  const records = Array.from({ length: 10000 }, (_, index) =>
    encodeTalkAddedRecord({
      eventId: id(index + 1),
      talkId: id(index + 1),
      householdId: zeroId,
      actorId: zeroId,
      deviceId: zeroId,
      timestamp: index,
      logicalTime: index + 1,
      text: index < 1000 ? "x".repeat(4096) : "x",
    }),
  );
  const state = engine.applyEvents(records, 0);
  assert.ok(memory.buffer.byteLength > initial, "real memory growth occurred");
  assert.equal(state.talks.length, 10000);
  assert.equal(state.talks[999].text.length, 4096);
  for (let iteration = 0; iteration < 4; iteration++) {
    const bad = talk(1);
    new DataView(bad.buffer).setUint16(2, 99, true);
    assert.throws(
      () => engine.applyEvents([bad], 0),
      (error) => error.code === 3,
    );
    assert.deepEqual(engine.applyEvents([], 0), emptyV7State());
    assert.deepEqual(engine.applyEvents(records, 0), state);
  }
  assert.equal(
    state.talks[0].text.length,
    4096,
    "host-owned result survives later calls",
  );
  assert.throws(
    () => engine.applyEvents([...records, records[0]], 0),
    (error) => error.code === 5,
  );
});

function pulseRecord(
  sequence,
  value = "drained",
  expiresAt = 2000,
  actor = 0xbb,
) {
  const identity = {
    eventId: new Uint8Array(16).fill(sequence),
    householdId: new Uint8Array(16).fill(0xaa),
    actorId: new Uint8Array(16).fill(actor),
    deviceId: new Uint8Array(16).fill(0xcc),
    timestamp: 1000,
    logicalTime: sequence,
  };
  return value === null
    ? encodePulseClearedRecord(identity)
    : encodePulseSetRecord({ ...identity, value, expiresAt });
}

async function pulseEngine() {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  return loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
}

test("Pulse real WASM explicit-time boundary, replacement, actors and clear", async () => {
  const engine = await pulseEngine();
  const records = [pulseRecord(1)];
  for (const time of [1999, 2000, 2001, 1000]) {
    assert.equal(
      engine.applyEvents(records, time).pulses[0].status,
      time < 2000 ? "active" : "expired",
    );
  }
  records.push(
    pulseRecord(2, "good", 3000, 0xaa),
    pulseRecord(3, "need-quiet", 4000),
  );
  assert.deepEqual(
    engine.applyEvents(records, 2000).pulses.map((p) => p.value),
    ["good", "need-quiet"],
  );
  records.push(pulseRecord(4, null), pulseRecord(5, null));
  assert.equal(engine.applyEvents(records, 2000).pulses.length, 1);
  records.push(pulseRecord(6, "okay", 5000));
  assert.equal(engine.applyEvents(records, 2000).pulses[1].value, "okay");
  assert.throws(
    () => engine.applyEvents(records),
    (error) => error.code === 2,
  );
  for (const time of [NaN, Infinity, 0.5, 8640000000000001])
    assert.throws(
      () => engine.applyEvents(records, time),
      (error) => error.code === 2,
    );
});

test("Pulse encoding is fixed and both kinds replay", async () => {
  const set = pulseRecord(1, "need-quiet");
  assert.equal(set.length, 104);
  assert.deepEqual([...set.subarray(88, 96)], [4, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(new DataView(set.buffer).getBigInt64(96, true), 2000n);
  const clear = pulseRecord(2, null);
  assert.equal(clear.length, 88);
  assert.equal(clear[2], 13);
  const apply = await rawEngine();
  assert.equal(new DataView(apply(24, [set], 0, 1500).buffer).getUint32(20, true), 1);
  assert.equal(new DataView(apply(24, [set, clear], 0, 1500).buffer).getUint32(20, true), 0);
  assert.throws(
    () => pulseRecord(1, "custom"),
    (error) => error.code === 2,
  );
});

test("bridge rejects every truncated projection header and Pulse record boundary", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let resultLength;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args),
      abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_result_len: () => resultLength ?? abi.kin_result_len(),
        },
      },
    };
  });
  const engine = await pulseEngine();
  // Generate canonical input before fault injection alters the result-buffer ABI.
  const canonicalInput = pulseRecord(1);
  for (resultLength = 0; resultLength < 92; resultLength++)
    assert.throws(
      () => engine.applyEvents([canonicalInput], 0),
      (e) => e.code === 6,
    );
  resultLength = 93;
  assert.throws(
    () => engine.applyEvents([canonicalInput], 0),
    (e) => e.code === 6,
  );
  resultLength = undefined;
  assert.equal(engine.applyEvents([canonicalInput], 0).pulses.length, 1);
});

test("10,000 mixed events grow memory and retain copied results across success error empty", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let memory;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args);
    memory = result.instance.exports.memory;
    return result;
  });
  const engine = await pulseEngine();
  const initialBytes = memory.buffer.byteLength;
  const records = [];
  for (let n = 1; n <= 10000; n++) {
    const id = new Uint8Array(16);
    new DataView(id.buffer).setUint32(0, n, true);
    const identity = {
      eventId: id,
      householdId: zeroId,
      actorId: id,
      deviceId: zeroId,
      timestamp: 1000,
      logicalTime: n,
    };
    const text = n <= 1000 ? "x".repeat(4096) : "x";
    records.push(
      n % 4 === 0
        ? encodePulseSetRecord({
            ...identity,
            value: "need-quiet",
            expiresAt: 2000,
          })
        : n % 4 === 1
          ? encodeAddedRecord({ ...identity, itemId: id, text })
          : n % 4 === 2
            ? encodeHandoffAddedRecord({ ...identity, handoffId: id, text })
            : encodeTalkAddedRecord({ ...identity, talkId: id, text }),
    );
  }
  const state = engine.applyEvents(records, 1999),
    snapshot = structuredClone(state);
  assert.deepEqual(
    [
      state.items.length,
      state.handoffs.length,
      state.talks.length,
      state.pulses.length,
    ],
    [2500, 2500, 2500, 2500],
  );
  assert.ok(
    memory.buffer.byteLength > initialBytes,
    "real memory growth observed",
  );
  const expired = engine.applyEvents(records, 2000);
  assert.ok(expired.pulses.every((p) => p.status === "expired"));
  assert.deepEqual(state, snapshot, "old host-owned state survives next call");
  for (let n = 0; n < 8; n++) {
    const bad = pulseRecord(1);
    bad[2] = 99;
    assert.throws(
      () => engine.applyEvents([bad], 0),
      (e) => e.code === 3,
    );
    assert.deepEqual(engine.applyEvents([], 0), emptyV7State());
    assert.deepEqual(engine.applyEvents(records, 1999), snapshot);
  }
  assert.throws(
    () => engine.applyEvents([...records, records[0]], 0),
    (e) => e.code === 5,
  );
  assert.deepEqual(state, snapshot);
});

test("copied result bytes outlive subsequent success, error and empty calls", async () => {
  const apply = await rawEngine(),
    copy = apply(24, [legacyRecord(1, 1), pulseRecord(2)], 0, 1999),
    snapshot = copy.slice();
  const header = new DataView(copy.buffer);
  assert.equal(header.getUint16(4, true), 24);
  assert.equal(header.getUint32(24, true), 1, "copied result has a summary record");
  assert.equal(header.getUint32(28, true), 1);
  assert.equal(new TextDecoder().decode(copy.subarray(-4)), "Milk");
  for (let n = 0; n < 8; n++) {
    apply(24, [pulseRecord(1)], 0, 2000);
    apply(24, [pulseRecord(1, "good", 1000)], 4);
    assert.equal(apply(24, []).length, 208, "empty header and section table");
    assert.deepEqual(copy, snapshot);
  }
});

test("10,000-event history permits bounded summary records and copied results", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let memory;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args);
    memory = result.instance.exports.memory;
    return result;
  });
  const engine = await pulseEngine();
  const initialMemoryBytes = memory.buffer.byteLength;
  const makeId = (number) => {
    const value = new Uint8Array(16);
    new DataView(value.buffer).setUint32(0, number, true);
    return value;
  };
  const records = Array.from({ length: 10_000 }, (_, index) => {
    const eventNumber = index + 1;
    return encodeAddedRecord({
      eventId: makeId(eventNumber),
      householdId: zeroId,
      actorId: zeroId,
      deviceId: zeroId,
      timestamp: 1_760_000_000_000 + eventNumber,
      logicalTime: eventNumber,
      itemId: makeId(eventNumber + 10_000),
      text: "x",
    });
  });
  const state = engine.applyEvents(records, 1_760_000_020_000);
  const snapshot = structuredClone(state);
  const toHex = (bytes) =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.ok(
    memory.buffer.byteLength > initialMemoryBytes,
    "real WASM memory growth occurred",
  );
  assert.equal(state.items.length, 10_000);
  assert.equal(state.summary.entries.length, 8);
  assert.equal(state.summary.totalCount, 10_000);
  assert.equal(state.items.length + state.summary.entries.length, 10_008);
  assert.equal(state.summary.entries[0].eventId, toHex(makeId(9_993)));
  assert.equal(state.summary.throughEventId, toHex(makeId(10_000)));

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const invalid = records[0].slice();
    new DataView(invalid.buffer).setUint16(2, 99, true);
    assert.throws(
      () => engine.applyEvents([invalid], 0),
      (error) => error.code === 3,
    );
    assert.deepEqual(engine.applyEvents([], 0), emptyV7State());
    assert.deepEqual(engine.applyEvents(records, 1_760_000_020_000), snapshot);
  }
  assert.deepEqual(state, snapshot, "host-owned summary survives later calls");
});

test("the chat search folds case and accents over the real text arena (#124)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const member = new Uint8Array(16).fill(0xbb), other = new Uint8Array(16).fill(0xbe);
  const context = (sequence, actorId = member) => ({ eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId, deviceId: new Uint8Array(16).fill(actorId[0] - 0x10), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) });
  const asOf = 1_791_475_200_100, day = 20261009;
  const blob = (byte) => byte.toString(16).padStart(2, "0").repeat(32);
  const chat = [];
  const post = (byte, actorId, text, held = true) => {
    const result = engine.executeChatCommand({ type: "post-chat-message", messageId: byte.toString(16).padStart(2, "0").repeat(16), blobRef: blob(0xa0 + byte), blobKey: blob(0xc0 + byte) }, context(byte, actorId), chat, asOf, day);
    chat.push(result.encodedEvent);
    if (held) engine.putChatTexts([{ blobRef: blob(0xa0 + byte), text }]);
  };
  post(1, member, "The Café opens at 9");
  post(2, other, "pick up the CAFE order 👍");
  post(3, member, "not here");
  post(4, other, "cafe after lunch", false);
  const search = (options) => engine.chatSearch(chat, { limit: 10, ...options }, asOf, day);
  const found = search({ query: "cafe" });
  assert.equal(found.total, 2);
  assert.deepEqual(found.results.map((result) => result.messageId), ["02".repeat(16), "01".repeat(16)]);
  // "Café" is bytes 4..9: the accent takes two.
  assert.deepEqual(found.results[1].ranges, [[4, 9]]);
  assert.equal(found.results[1].excerpt, "The Café opens at 9");
  // The fourth message's text isn't in the arena yet: listed for the host.
  assert.equal(found.unsearched, 1);
  assert.deepEqual(found.missing.map((entry) => [entry.messageId, entry.blobRef]), [["04".repeat(16), blob(0xa4)]]);
  assert.equal(search({ query: "CAFÉ" }).total, 2);
  assert.equal(search({ query: "👍" }).total, 1);
  assert.equal(search({ query: "cafe", authors: ["be".repeat(16)] }).total, 1);
  assert.equal(search({ query: "cafe", excluded: ["02".repeat(16)] }).total, 1);
  assert.equal(search({ query: "", attachmentsOnly: true }).total, 0);
  // Deleting a message forgets its text: it never matches again.
  const deleted = engine.executeChatCommand({ type: "delete-chat-message", messageId: "01".repeat(16) }, context(9), chat, asOf, day);
  chat.push(deleted.encodedEvent);
  assert.deepEqual(search({ query: "cafe" }).results.map((result) => result.messageId), ["02".repeat(16)]);
});

test("chat mentions are checked against the readers and come back in pages and search (#130)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const member = new Uint8Array(16).fill(0xbb), friend = new Uint8Array(16).fill(0xbe);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const context = (sequence) => ({ eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId: member, deviceId: new Uint8Array(16).fill(0xab), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) });
  const asOf = 1_791_475_200_100, day = 20261009;
  const blob = (byte) => byte.toString(16).padStart(2, "0").repeat(32);
  const post = (mentions, members) => engine.executeChatCommand(
    { type: "post-chat-message", messageId: "01".repeat(16), blobRef: blob(0xa1), blobKey: blob(0xc1), mentions }, context(1), [], asOf, day, null, [], members);
  // Someone who cannot read chat cannot be mentioned.
  assert.throws(() => post({ everyone: false, members: [hex(friend)] }, []), (error) => error.code === 4);
  const posted = post({ everyone: true, members: [hex(friend)] }, [hex(friend)]);
  const page = engine.chatPage([posted.encodedEvent], {}, asOf, day);
  assert.deepEqual(page.messages[0].mentions, { everyone: true, members: [hex(friend)] });
  const plain = engine.executeChatCommand({ type: "post-chat-message", messageId: "02".repeat(16), blobRef: blob(0xa2), blobKey: blob(0xc2) }, context(2), [], asOf, day);
  assert.deepEqual(engine.chatPage([plain.encodedEvent], {}, asOf, day).messages[0].mentions ?? { everyone: false, members: [] }, { everyone: false, members: [] });
});

test("chat pins are commands, limited to ten, and listed by a page that asks for them (#131)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const member = new Uint8Array(16).fill(0xbb);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let sequence = 0;
  const context = () => { sequence += 1; return { eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId: member, deviceId: new Uint8Array(16).fill(0xab), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) }; };
  const asOf = 1_791_475_200_900, day = 20261009;
  const blob = (byte) => byte.toString(16).padStart(2, "0").repeat(32);
  const chat = [];
  const run = (command) => { const result = engine.executeChatCommand(command, context(), chat, asOf, day); chat.push(result.encodedEvent); return result; };
  const ids = Array.from({ length: 11 }, (_, index) => (index + 1).toString(16).padStart(2, "0").repeat(16));
  ids.forEach((messageId, index) => run({ type: "post-chat-message", messageId, blobRef: blob(0xa0 + index), blobKey: blob(0xc0 + index) }));
  assert.equal(new DataView(run({ type: "pin-chat-message", messageId: ids[0], on: true }).encodedEvent.buffer).getUint16(2, true), 48);
  for (const messageId of ids.slice(1, 10)) run({ type: "pin-chat-message", messageId, on: true });
  // The eleventh, a repeat, and an unpin of something not pinned are refused.
  assert.throws(() => run({ type: "pin-chat-message", messageId: ids[10], on: true }), (error) => error.code === 4);
  assert.throws(() => run({ type: "pin-chat-message", messageId: ids[0], on: true }), (error) => error.code === 4);
  assert.throws(() => run({ type: "pin-chat-message", messageId: ids[10], on: false }), (error) => error.code === 4);
  const page = engine.chatPage(chat, { includePins: true }, asOf, day);
  assert.deepEqual(page.pins.map((pin) => pin.messageId), ids.slice(0, 10));
  assert.equal(page.pins[0].pinnedBy, hex(member));
  assert.equal(page.pins[0].state, "live");
  assert.deepEqual(engine.chatPage(chat, {}, asOf, day).pins, [], "pins only when asked for");
  run({ type: "pin-chat-message", messageId: ids[0], on: false });
  assert.equal(engine.chatPage(chat, { includePins: true }, asOf, day).pins.length, 9);
});

test("chat topics are opened, resolved and cleared by command and listed newest change first (#312)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const member = new Uint8Array(16).fill(0xbb), friend = new Uint8Array(16).fill(0xbc);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let sequence = 0;
  const as = (actorId) => { sequence += 1; return { eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId, deviceId: new Uint8Array(16).fill(0xab), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) }; };
  const asOf = 1_791_475_200_900, day = 20261009;
  const blob = (byte) => byte.toString(16).padStart(2, "0").repeat(32);
  const chat = [];
  const run = (command, actor = member) => { const result = engine.executeChatCommand(command, as(actor), chat, asOf, day); chat.push(result.encodedEvent); return result; };
  const [first, second] = ["01".repeat(16), "02".repeat(16)];
  run({ type: "post-chat-message", messageId: first, blobRef: blob(0xa1), blobKey: blob(0xc1) });
  run({ type: "post-chat-message", messageId: second, blobRef: blob(0xa2), blobKey: blob(0xc2) });
  const opened = run({ type: "set-chat-topic", messageId: first, state: "open" }, friend);
  assert.equal(new DataView(opened.encodedEvent.buffer).getUint16(2, true), 65);
  assert.equal(opened.metadata.kind, "CHAT_TOPIC_SET");
  run({ type: "set-chat-topic", messageId: second, state: "open" });
  // A repeat, a message the log lacks and an unknown state are refused.
  assert.throws(() => run({ type: "set-chat-topic", messageId: first, state: "open" }), (error) => error.code === 4);
  assert.throws(() => run({ type: "set-chat-topic", messageId: "09".repeat(16), state: "open" }), (error) => error.code === 4);
  assert.throws(() => run({ type: "set-chat-topic", messageId: first, state: "talk" }), (error) => error.code === 2);
  run({ type: "set-chat-topic", messageId: first, state: "resolved" });
  assert.throws(() => run({ type: "set-chat-topic", messageId: first, state: "resolved" }), (error) => error.code === 4);
  const topics = () => engine.chatPage(chat, { includeTopics: true }, asOf, day).topics;
  assert.deepEqual(topics().map((topic) => [topic.messageId, topic.state, topic.flaggedBy]), [[first, "resolved", hex(friend)], [second, "open", hex(member)]]);
  assert.equal(topics()[0].quote.messageId, first);
  assert.equal(topics()[0].quote.state, "live");
  assert.deepEqual(engine.chatPage(chat, {}, asOf, day).topics, [], "topics only when asked for");
  run({ type: "set-chat-topic", messageId: second, state: "cleared" });
  run({ type: "delete-chat-message", messageId: first, byAdmin: false });
  assert.deepEqual(topics(), []);
});

test("chat polls are posted, voted in and closed through the engine, and a page lists the votes (#135)", async () => {
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);
  const author = new Uint8Array(16).fill(0xbb), friend = new Uint8Array(16).fill(0xbc);
  const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let sequence = 0;
  const as = (actorId) => { sequence += 1; return { eventId: new Uint8Array(16).fill(sequence), householdId: new Uint8Array(16).fill(0xaa), actorId, deviceId: new Uint8Array(16).fill(0xab), timestamp: 1_791_475_200_000 + sequence, logicalTime: BigInt(sequence) }; };
  const asOf = 1_791_475_200_900, day = 20261009;
  const blob = (byte) => byte.toString(16).padStart(2, "0").repeat(32);
  const chat = [];
  const run = (command, actor = author) => { const result = engine.executeChatCommand(command, as(actor), chat, asOf, day); chat.push(result.encodedEvent); return result; };
  const poll = "0a".repeat(16);
  // The shape: 2 to 10 options.
  for (const options of [1, 11]) assert.throws(() => run({ type: "post-chat-message", messageId: poll, blobRef: blob(0xa0), blobKey: blob(0xc0), contentKind: "poll", poll: { options } }), (error) => error.code === 2 || error.code === 4);
  const posted = run({ type: "post-chat-message", messageId: poll, blobRef: blob(0xa0), blobKey: blob(0xc0), contentKind: "poll", poll: { options: 3, multiple: false } });
  assert.equal(new DataView(posted.encodedEvent.buffer).getUint16(2, true), 44);
  const page = (options = {}) => engine.chatPage(chat, { includePolls: true, ...options }, asOf, day);
  assert.equal(page().messages[0].contentKind, "poll");
  assert.deepEqual(page().messages[0].poll, { options: 3, multiple: false, closed: false, votes: [] });
  assert.equal(engine.chatPage(chat, {}, asOf, day).messages[0].poll, undefined, "polls only when asked for");
  // Votes: one answer, from the poll's options, and a change each time.
  assert.equal(new DataView(run({ type: "vote-chat-poll", messageId: poll, choice: [1] }, friend).encodedEvent.buffer).getUint16(2, true), 49);
  for (const choice of [[1], [0, 1], [3]]) assert.throws(() => run({ type: "vote-chat-poll", messageId: poll, choice }, friend), (error) => error.code === 2 || error.code === 4, JSON.stringify(choice));
  run({ type: "vote-chat-poll", messageId: poll, choice: [2] }, author);
  run({ type: "vote-chat-poll", messageId: poll, choice: [0] }, friend);
  const votes = page().messages[0].poll.votes;
  assert.deepEqual(Object.fromEntries(votes.map((vote) => [vote.memberId, vote.choice])), { [hex(author)]: [2], [hex(friend)]: [0] });
  // Only the author closes it, and nothing counts after.
  assert.throws(() => run({ type: "close-chat-poll", messageId: poll }, friend), (error) => error.code === 4);
  assert.equal(new DataView(run({ type: "close-chat-poll", messageId: poll }).encodedEvent.buffer).getUint16(2, true), 50);
  assert.throws(() => run({ type: "vote-chat-poll", messageId: poll, choice: [1] }, friend), (error) => error.code === 4);
  assert.equal(page().messages[0].poll.closed, true);
  // Deleting it for everyone takes the votes with it.
  run({ type: "delete-chat-message", messageId: poll, byAdmin: false });
  assert.equal(page().messages[0].poll, undefined);
  assert.equal(page().messages[0].status, "deleted");
});

test("kin_audio_peaks reduces mono samples to 64 peaks", async () => {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadCurrentEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
  const samples = new Float32Array(6400);
  samples[0] = 0.5;
  samples[3200] = -1;
  samples[6399] = 2;
  const peaks = engine.audioPeaks(samples);
  assert.equal(peaks.length, 64);
  assert.equal(peaks[0], 128);
  assert.equal(peaks[32], 255);
  assert.equal(peaks[63], 255, "values over full scale are clamped");
  assert.equal(peaks[1], 0);
  assert.throws(() => engine.audioPeaks(new Float32Array(0)));
});

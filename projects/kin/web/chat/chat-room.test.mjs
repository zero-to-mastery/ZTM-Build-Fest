// The chat room's transport (#111): sending while offline, the chat relay
// stream against the real service, authentication of what arrives, sequence
// recovery, resealing, deletion of replaced blobs, and the coordinator's
// chat pass. A small JavaScript stand-in plays the engine so these run
// without the WASM build; kin-engine.test.mjs covers the real chat engine.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createKinServer } from "../../server/server.mjs";
import { decryptStoredEvent, deviceKeyFingerprint, encryptEvent, exportDevicePublicKeys, generateDeviceKeys, generateHouseholdKey } from "../sync/crypto.js";
import { decodeEnvelopeBatch, encodeEventPage } from "../sync/envelope-wire.js";
import { SyncCoordinator } from "../sync/sync-coordinator.js";
import { writeArchive, readArchive } from "../security/archive-stream.js";
import { appendChatBlob, appendChatEvents, blobSegment, blobSegmentLength, chatEventsView, chooseChatBlobs, importChatSection, openChatSection, validateChatSection } from "./chat-archive.js";
import { ChatBlobClient } from "./chat-blob-client.js";
import { ChatBlobStore } from "./chat-blob-store.js";
import { ChatBlobs } from "./chat-blobs.js";
import { ChatLogStore, chatLogDatabaseName } from "./chat-log-store.js";
import { ChatRecords } from "./chat-records.js";
import { chatAdmins, chatTextProblem, ChatRoom, MAX_CHAT_PULL } from "./chat-room.js";
import { fakeIndexedDB, fakeKeyRange } from "./fake-indexeddb.test-support.mjs";
import { memberLabels } from "../components/household/member-labels.js";
import { loadKinEngine } from "../wasm/kin-engine.js";

const WASM = new URL("../wasm/kin_engine.wasm", import.meta.url);

const encoder = new TextEncoder(), decoder = new TextDecoder();
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
const KINDS = { "post-chat-message": "CHAT_MESSAGE_POSTED", "edit-chat-message": "CHAT_MESSAGE_EDITED", "delete-chat-message": "CHAT_MESSAGE_DELETED", "react-chat-message": "CHAT_REACTION_SET", "pin-chat-message": "CHAT_PIN_SET", "vote-chat-poll": "CHAT_POLL_VOTE", "close-chat-poll": "CHAT_POLL_CLOSED", "set-chat-topic": "CHAT_TOPIC_SET" };

/** The engine calls the room makes, over JSON "canonical events". */
function fakeEngine() {
  const decode = (bytes) => JSON.parse(decoder.decode(bytes));
  const metadata = (bytes) => {
    const event = decode(bytes);
    return {
      kind: event.kind, eventId: bytesOf(event.eventId), householdId: bytesOf(event.householdId),
      actorId: bytesOf(event.actorId), deviceId: bytesOf(event.deviceId),
      timestamp: event.timestamp, logicalTime: BigInt(event.logicalTime),
    };
  };
  const events = (source) => Array.from({ length: source.length }, (_, index) => decode(source.record(index)))
    .sort((left, right) => Number(BigInt(left.logicalTime) - BigInt(right.logicalTime)) || (left.eventId < right.eventId ? -1 : 1));
  return {
    calls: { page: 0, execute: 0 },
    texts: new Map(),
    putChatTexts(entries) {
      return entries.map(({ blobRef, text }) => {
        const ok = text.length > 0 && !/[\u0000-\u0008]/.test(text);
        if (ok) this.texts.set(blobRef, text);
        return ok;
      });
    },
    eventMetadata: metadata,
    eventMetadataBatch: (records) => records.map(metadata),
    executeChatCommand(command, identity, source, asOf, civilDate, syncIdentity, admins, members = []) {
      this.calls.execute += 1;
      // The engine names only members who can read chat (#130).
      for (const id of command.mentions?.members ?? [])
        if (!members.includes(id)) throw Object.assign(new Error("Kin refused that mention."), { code: 4 });
      assert.equal(typeof source.copyRecordsTo, "function", "the chat log goes to the engine as a view");
      const event = { ...identity, logicalTime: String(identity.logicalTime), kind: KINDS[command.type], command };
      const encodedEvent = encoder.encode(JSON.stringify(event));
      return { encodedEvent, metadata: metadata(encodedEvent) };
    },
    // The engine's chat search, simplified: case-insensitive substring over
    // the texts it holds; the rest are listed for the host to open.
    chatSearch(source, options) {
      (this.calls.search ??= []).push(options);
      const { messages } = this.chatPage(source, { includeText: true, admins: [] });
      const excluded = new Set(options.excluded);
      const results = [], missing = [];
      let total = 0, unsearched = 0;
      for (const message of [...messages].reverse()) {
        if (!["live", "edited"].includes(message.status) || excluded.has(message.messageId)) continue;
        if (message.text === null) {
          unsearched += 1;
          missing.push({ messageId: message.messageId, blobRef: message.blobRef, blobKey: message.blobKey });
          continue;
        }
        const at = message.text.toLowerCase().indexOf(options.query.toLowerCase());
        if (at < 0) continue;
        total += 1;
        results.push({ messageId: message.messageId, index: message.index, authorId: message.authorId, postedAt: message.postedAt, contentKind: message.contentKind, ranges: [[at, at + options.query.length]], excerpt: message.text, excerptOffset: 0 });
      }
      return { total, results, unsearched, missing };
    },
    chatPage(source, options) {
      this.calls.page += 1;
      const messages = new Map(), retired = [], pinned = [], topics = [];
      let clock = 0;
      for (const { command, actorId, deviceId, timestamp } of events(source)) {
        const message = messages.get(command.messageId);
        if (command.type === "set-chat-topic") {
          // Latest wins; a deleted or unknown message changes nothing (#312).
          if (!message || message.status === "deleted") continue;
          const at = topics.findIndex((topic) => topic.messageId === command.messageId);
          if (command.state === "cleared") { if (at >= 0) topics.splice(at, 1); }
          else if (at >= 0) Object.assign(topics[at], { state: command.state, changed: ++clock });
          else topics.push({ messageId: command.messageId, state: command.state, flaggedBy: actorId, changed: ++clock });
        } else if (command.type === "pin-chat-message") {
          const at = pinned.findIndex((pin) => pin.messageId === command.messageId);
          if (command.on && message && at < 0) pinned.push({ messageId: command.messageId, pinnedBy: actorId });
          else if (!command.on && at >= 0) pinned.splice(at, 1);
        } else if (command.type === "vote-chat-poll") {
          // Votes count while the poll shows and is open; the last write wins.
          const poll = message?.poll;
          if (!poll || poll.closed || message.status !== "live") continue;
          if (command.choice.some((option) => option >= poll.options) || (!poll.multiple && command.choice.length > 1)) continue;
          if (command.choice.length) poll.votes.set(actorId, [...command.choice].sort((x, y) => x - y));
          else poll.votes.delete(actorId);
        } else if (command.type === "close-chat-poll") {
          if (message?.poll && !message.poll.closed && actorId === message.authorId) message.poll.closed = true;
        } else if (command.type === "post-chat-message" && !message)
          messages.set(command.messageId, { poll: command.contentKind === "poll" ? { options: command.poll.options, multiple: command.poll.multiple, closed: false, votes: new Map() } : null, reply: command.replyTo ?? null, mentions: { everyone: command.mentions?.everyone === true, members: command.mentions?.members ?? [] }, messageId: command.messageId, authorId: actorId, deviceId, postedAt: timestamp, status: "live", contentKind: command.contentKind ?? "text", blobRef: command.blobRef, blobKey: bytesOf(command.blobKey) });
        else if (command.type === "react-chat-message") {
          if (!message) continue;
          const groups = message.reactions ??= [];
          let group = groups.find((entry) => entry.emoji === command.emoji);
          if (command.on) {
            if (!group) groups.push(group = { emoji: command.emoji, actors: [] });
            if (!group.actors.includes(actorId)) group.actors.push(actorId);
          } else if (group) {
            group.actors = group.actors.filter((actor) => actor !== actorId);
            if (!group.actors.length) groups.splice(groups.indexOf(group), 1);
          }
        } else if (message && message.status !== "deleted" && (actorId === message.authorId || (command.byAdmin && options.admins.includes(actorId)))) {
          retired.push(message.blobRef);
          if (command.type === "edit-chat-message") Object.assign(message, { status: "edited", blobRef: command.blobRef, blobKey: bytesOf(command.blobKey), mentions: { everyone: command.mentions?.everyone === true, members: command.mentions?.members ?? [] } });
          else {
            Object.assign(message, { status: command.byAdmin ? "removed-by-admin" : "deleted", blobRef: null, blobKey: null });
            if (!command.byAdmin) {
              pinned.splice(0, pinned.length, ...pinned.filter((pin) => pin.messageId !== command.messageId));
              message.poll = null;
              topics.splice(0, topics.length, ...topics.filter((topic) => topic.messageId !== command.messageId));
            }
          }
        }
      }
      const order = [...messages.keys()];
      const quote = (message) => {
        if (!message.reply || !["live", "edited"].includes(message.status)) return null;
        const original = messages.get(message.reply);
        if (!original) return { messageId: message.reply, state: "unknown", contentKind: null, authorId: null, index: null, blobRef: null, blobKey: null, text: null };
        const shown = ["live", "edited"].includes(original.status);
        return {
          messageId: original.messageId, state: original.status, contentKind: original.contentKind, authorId: original.authorId, index: order.indexOf(original.messageId),
          blobRef: shown ? original.blobRef : null, blobKey: shown ? original.blobKey : null,
          text: shown && options.includeText !== false ? this.texts.get(original.blobRef) ?? null : null,
        };
      };
      const list = [...messages.values()].map((message, index) => ({
        ...message, index, replyTo: quote(message),
        poll: options.includePolls && message.poll && (message.status === "live" || message.status === "edited")
          ? { options: message.poll.options, multiple: message.poll.multiple, closed: message.poll.closed, votes: [...message.poll.votes].sort(([x], [y]) => (x < y ? -1 : 1)).map(([memberId, choice]) => ({ memberId, choice })) }
          : null,
        reactions: options.includeReactions && (message.status === "live" || message.status === "edited") ? message.reactions ?? [] : [],
        mentions: message.status === "live" || message.status === "edited" ? message.mentions ?? { everyone: false, members: [] } : { everyone: false, members: [] },
        text: options.includeText === false ? null : this.texts.get(message.blobRef) ?? null,
      }));
      const shown = new Set(list.map((message) => message.blobRef));
      const pins = options.includePins
        ? pinned.filter((pin) => ["live", "edited"].includes(messages.get(pin.messageId).status)).slice(0, 10).map((pin) => {
          const original = messages.get(pin.messageId);
          return {
            messageId: original.messageId, state: original.status, contentKind: original.contentKind, authorId: original.authorId, index: order.indexOf(original.messageId),
            blobRef: original.blobRef, blobKey: original.blobKey, text: options.includeText !== false ? this.texts.get(original.blobRef) ?? null : null, pinnedBy: pin.pinnedBy,
          };
        })
        : [];
      const topicList = options.includeTopics
        ? topics.filter((topic) => ["live", "edited"].includes(messages.get(topic.messageId).status)).sort((x, y) => y.changed - x.changed).map((topic) => {
          const original = messages.get(topic.messageId);
          return {
            messageId: topic.messageId, state: topic.state, flaggedBy: topic.flaggedBy,
            quote: { messageId: original.messageId, state: original.status, contentKind: original.contentKind, authorId: original.authorId, index: order.indexOf(original.messageId), blobRef: original.blobRef, blobKey: original.blobKey, text: options.includeText !== false ? this.texts.get(original.blobRef) ?? null : null },
          };
        })
        : [];
      return { total: list.length, start: 0, messages: list, retired: options.includeRetired ? retired.filter((ref) => !shown.has(ref)) : [], pins, topics: topicList };
    },
  };
}

async function service(t) {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const admin = app.service.bootstrap({ credential: { id: "admin", publicKey: "key-admin", algorithm: -7 } });
  const invitation = app.service.createPairing(admin.sessionToken);
  const claim = app.service.claimPairing({ code: invitation.code, credential: { id: "partner", publicKey: "key-partner", algorithm: -7 }, deviceLabel: "Phone" });
  app.service.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
  const partner = app.service.activateClaim(claim.claimToken);
  app.syncService.enable(admin.sessionToken);
  // Another device of a member (same-member pairing).
  let devices = 0;
  const pairDevice = (who) => {
    const invite = app.service.createDevicePairing(who.sessionToken);
    const deviceClaim = app.service.claimPairing({ code: invite.code, credential: { id: `extra-${(devices += 1)}`, publicKey: `key-extra-${devices}`, algorithm: -7 }, deviceLabel: "Tablet" });
    app.service.approvePairing(who.sessionToken, invite.pairingId, deviceClaim.version);
    return app.service.activateClaim(deviceClaim.claimToken);
  };
  return { app, base, admin, partner, pairDevice, householdId: admin.householdId };
}

/** The coordinator's request() for one device: JSON, or bytes for pages. */
function requester(base, who) {
  const cookie = `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}`;
  const call = async (path, { binary = false, ...options } = {}) => {
    if (call.offline) {
      const error = new Error("Household sync could not be reached.");
      error.code = "connection_unavailable";
      throw error;
    }
    call.paths.push(`${options.method ?? "GET"} ${path.split("?")[0]}`);
    const response = await fetch(base + path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}), cookie } });
    if (binary && response.ok) return new Uint8Array(await response.arrayBuffer());
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(value.message);
      error.code = value.error;
      throw error;
    }
    return value;
  };
  call.paths = [];
  call.offline = false;
  call.fetch = (path, init) => {
    call.paths.push(`${init.method} ${path}`);
    return fetch(base + path, { ...init, headers: { ...init.headers, cookie } });
  };
  return call;
}

/** One device: its keys, its directory entry, its chat storage. */
async function device(who, { householdId, epochs, memberKind = "adult", householdAdmin = false }) {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  const fingerprint = await deviceKeyFingerprint(publicKeys);
  // Keys saved under other families (the chat key, #123), by "family:epoch".
  const saved = new Map();
  return {
    who,
    deviceKeys: { keys, fingerprint },
    entry: { deviceId: who.deviceId, memberId: who.memberId, publicKeys, fingerprint, verifiedKeyHistory: [{ publicKeys }], historyFromEpoch: 1, memberKind, memberActive: true, householdAdmin },
    keyStore: {
      vault: { assertUnlocked() {} },
      getEpoch: async (household, keyEpoch) => household === householdId
        ? (epochs.has(keyEpoch) ? { keyEpoch, householdKey: epochs.get(keyEpoch) } : null)
        : saved.get(`${household}:${keyEpoch}`) ?? null,
      listEpochs: async (household) => household === householdId
        ? [...epochs].map(([keyEpoch, householdKey]) => ({ keyEpoch, householdKey }))
        : [...saved.values()].filter((record) => record.householdId === household),
      saveEpoch: async (record) => { saved.set(`${record.householdId}:${record.keyEpoch}`, record); return record; },
    },
    indexedDB: fakeIndexedDB(),
  };
}

async function openRoom(phone, { base, householdId, engine = fakeEngine(), request = requester(base, phone.who), indexedDB = phone.indexedDB, locks, preparePhoto } = {}) {
  const blobs = new ChatBlobs({ store: await ChatBlobStore.open(householdId, { indexedDB }), client: new ChatBlobClient({ fetch: request.fetch }) });
  const room = await ChatRoom.open({
    identity: { householdId, memberId: phone.who.memberId, deviceId: phone.who.deviceId },
    keyStore: phone.keyStore, deviceKeys: phone.deviceKeys, engine, request, blobs,
    indexedDB, keyRange: fakeKeyRange, locks, ...(preparePhoto ? { preparePhoto } : {}),
  });
  return { room, request, blobs, engine };
}

const STATUS = { currentEpoch: 1, rotationPending: false };
const texts = async ({ room, blobs }) => Promise.all(room.page().messages.map(async (message) =>
  message.blobRef ? (await blobs.openText({ ref: message.blobRef, key: message.blobKey })).text ?? null : message.status));

test("a message written offline waits, then reaches the other device through the chat relay", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  const changes = [];
  a.room.subscribe(() => changes.push(a.room.pending.size));

  a.request.offline = true;
  const first = await a.room.send("Dinner at 6 🍝");
  const second = await a.room.send("Bring bread");
  assert.ok(a.room.isPending(first.eventId) && a.room.isPending(second.eventId), "shown as waiting to send");
  assert.ok(a.room.pendingMessages.has(first.messageId) && a.room.pendingMessages.has(second.messageId), "by message, for the view");
  assert.deepEqual(await texts(a), ["Dinner at 6 🍝", "Bring bread"], "the sender sees them at once");
  assert.ok(changes.length >= 2);
  await assert.rejects(a.room.sync({ status: STATUS, devices }), (error) => error.code === "connection_unavailable");
  assert.ok(a.room.isPending(first.eventId), "still waiting while offline");

  a.request.offline = false;
  assert.deepEqual(await a.room.sync({ status: STATUS, devices }), { hasMore: false });
  assert.equal(a.room.pending.size, 0, "sent");
  assert.equal(a.room.pendingMessages.size, 0);
  assert.ok(a.request.paths.includes("GET /api/chat/status"), "a new log asks the relay where it stands");
  assert.deepEqual(a.request.paths.filter((path) => path.startsWith("PUT /api/chat/blobs/")).length, 2, "content uploads before its event");

  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual(await texts(b), ["Dinner at 6 🍝", "Bring bread"]);
  // The view opens texts through the room: fetched, checked, handed to the
  // engine, then paged with the text in place.
  const unopened = b.room.page().messages;
  assert.deepEqual(unopened.map((message) => message.text), [null, null]);
  const opened = await b.room.loadTexts(unopened);
  assert.deepEqual([...opened.values()].map((result) => result.text), ["Dinner at 6 🍝", "Bring bread"]);
  assert.deepEqual(b.room.page().messages.map((message) => message.text), ["Dinner at 6 🍝", "Bring bread"]);
  assert.equal(b.room.authorLabel(s.admin.memberId), "Adult 1", "named as People & devices names members");
  assert.equal(b.room.authorLabel(s.partner.memberId), "You");
  assert.equal(b.room.authorLabel("ee".repeat(16)), "Household member");
  assert.equal(a.room.authorLabel(s.partner.memberId), "Adult 2", "the founder sees the partner as Household access does");
  assert.equal(b.request.paths.filter((path) => path === "GET /api/chat/status").length, 1, "a new log settles its sequence once");
  assert.equal(b.room.records.length, 2);
  // Pulling again finds nothing new and stores nothing twice.
  await b.room.sync({ status: STATUS, devices });
  assert.equal(b.request.paths.filter((path) => path === "GET /api/chat/status").length, 1, "nothing to send, a settled log: no status call");
  await a.room.sync({ status: STATUS, devices });
  assert.equal(a.room.records.length, 2, "its own events coming back are not stored again");
  assert.equal(b.room.records.length, 2);

  // The household relay never carried any of it.
  assert.equal(s.app.syncService.pull(s.admin.sessionToken, "", "20").events.length, 0);

  // Reopened (after a lock), the log decrypts from storage alone.
  b.room.close();
  assert.equal(b.room.records.length, 0, "locking drops the decrypted log");
  const reopened = await openRoom(laptop, s);
  assert.deepEqual(await texts(reopened), ["Dinner at 6 🍝", "Bring bread"]);
  await assert.rejects(b.room.send("after lock"), (error) => error.code === "chat_locked");
});

test("only authenticated chat events are stored; one that can never pass is skipped, not a wall", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const a = await openRoom(phone, s);
  await a.room.send("hello");
  await a.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
  await a.room.send("again");
  await a.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });

  // A device this one doesn't know yet (paired after it read the directory)
  // pauses chat: nothing is stored or read past, and the next pass retries.
  const b = await openRoom(laptop, s);
  await assert.rejects(b.room.sync({ status: STATUS, devices: [laptop.entry] }), (error) => error.code === "chat_device_unknown");
  assert.equal(b.room.records.length, 0);
  assert.equal((await b.room.store.state()).cursor, "", "not read past");
  // So does a missing key epoch.
  const forgetful = await device(s.partner, { householdId: s.householdId, epochs: new Map() });
  const c = await openRoom(forgetful, s);
  await assert.rejects(c.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] }), (error) => error.code === "chat_key_missing");
  await b.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
  assert.equal(b.room.records.length, 2);

  // A signature that doesn't verify against the directory this pass read
  // (the device changed its key since) pauses chat; with a fresh directory
  // the event arrives.
  const stale = await openRoom({ ...laptop, indexedDB: fakeIndexedDB() }, s);
  const wrongKey = { ...phone.entry, verifiedKeyHistory: laptop.entry.verifiedKeyHistory };
  await assert.rejects(stale.room.sync({ status: STATUS, devices: [wrongKey, laptop.entry] }), (error) => error.code === "event_signature_invalid");
  assert.equal((await stale.room.store.state()).cursor, "", "not read past");
  await stale.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
  assert.equal(stale.room.records.length, 2);
  assert.deepEqual(stale.room.refused, []);

  // What no retry can fix is skipped and remembered: a device revoked before
  // this epoch, history from before the device's grant, an author who isn't
  // the signing device's member, and a signature that fails on two passes.
  let phoneEvents = 2;
  for (const [signer, code, passes] of [
    [{ ...phone.entry, revokedAt: 1 }, "chat_event_refused", 1],
    [{ ...phone.entry, historyFromEpoch: 2 }, "chat_event_refused", 1],
    [{ ...phone.entry, memberId: s.partner.memberId }, "chat_event_refused", 1],
    [wrongKey, "event_signature_invalid", 2],
  ]) {
    const fresh = await openRoom({ ...laptop, indexedDB: fakeIndexedDB() }, s);
    const seen = [];
    fresh.room.subscribe(() => seen.push(fresh.room.refused.length));
    if (passes === 2) {
      await assert.rejects(fresh.room.sync({ status: STATUS, devices: [signer, laptop.entry] }), (error) => error.code === code);
      assert.deepEqual(fresh.room.refused, [], "one failure isn't enough");
    }
    assert.deepEqual(await fresh.room.sync({ status: STATUS, devices: [signer, laptop.entry] }), { hasMore: false });
    assert.equal(fresh.room.records.length, 0, "nothing refused is kept");
    assert.deepEqual(fresh.room.refused.map((entry) => entry.code), new Array(phoneEvents).fill(code));
    assert.ok(seen.includes(phoneEvents), "the view hears about it");
    const state = await fresh.room.store.state();
    assert.notEqual(state.cursor, "", "read past, so chat goes on");
    assert.equal(state.refused.length, phoneEvents, "remembered across unlocks");
    // Later events from good devices still arrive.
    await a.room.send(`after ${code}`);
    phoneEvents += 1;
    await a.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
    await fresh.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
    assert.equal(fresh.room.records.length, 1);
  }
});

test("a device that lost its chat log continues its sequence; a lost acknowledgement isn't sent twice", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s);
  await a.room.send("one");
  await a.room.send("two");
  await a.room.sync({ status: STATUS, devices });

  // The same device with fresh storage writes before it ever syncs: its
  // provisional first sequence is renumbered after the relay's count.
  const fresh = await openRoom({ ...phone, indexedDB: fakeIndexedDB() }, s);
  fresh.request.offline = true;
  await fresh.room.send("three");
  assert.equal((await fresh.room.store.outbox())[0].deviceSequence, 1, "provisional");
  fresh.request.offline = false;
  await fresh.room.sync({ status: STATUS, devices });
  assert.equal(fresh.room.pending.size, 0);
  assert.deepEqual((await fresh.room.store.state()).deviceSequence, 3);
  // Written against an empty log, "three" has logical time 1, like "one",
  // so replay orders it among the earliest: Lamport order, as for household
  // events.
  assert.deepEqual((await texts(fresh)).sort(), ["one", "three", "two"]);

  // The relay accepts a push but the reply is lost: the next pass sees the
  // relay already has it and drops it from the outbox without resending.
  await fresh.room.send("four");
  const realRequest = fresh.room.request;
  fresh.room.request = async (path, options) => {
    const value = await realRequest(path, options);
    if (options?.method === "POST") {
      fresh.room.request = realRequest;
      throw Object.assign(new Error("lost"), { code: "connection_unavailable" });
    }
    return value;
  };
  await assert.rejects(fresh.room.sync({ status: STATUS, devices }));
  assert.equal(fresh.room.pending.size, 1);
  const posts = realRequest.paths.filter((path) => path === "POST /api/chat/events").length;
  await fresh.room.sync({ status: STATUS, devices });
  assert.equal(fresh.room.pending.size, 0);
  assert.equal(realRequest.paths.filter((path) => path === "POST /api/chat/events").length, posts, "not pushed again");

  const b = await openRoom(laptop, s);
  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual((await texts(b)).sort(), ["four", "one", "three", "two"]);
});

test("a long outbox goes out over several passes, two batches at a time", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const a = await openRoom(phone, s);
  a.request.offline = true;
  for (let index = 0; index < 41; index += 1) await a.room.send(`message ${index}`);
  a.request.offline = false;
  assert.deepEqual(await a.room.sync({ status: STATUS, devices: [phone.entry] }), { hasMore: true });
  assert.equal(a.room.pending.size, 1);
  assert.equal(a.request.paths.filter((path) => path === "POST /api/chat/events").length, 2);
  assert.ok(a.request.paths.length <= 50, "a pass stays well inside the request budget");
  assert.deepEqual(await a.room.sync({ status: STATUS, devices: [phone.entry] }), { hasMore: false });
  assert.equal(a.room.pending.size, 0);
});

test("a device drops cached content after 90 days, but never what is waiting to be sent (#125)", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const a = await openRoom(phone, s);
  await a.room.send("already sent");
  await a.room.sync({ status: STATUS, devices: [phone.entry] });
  const sent = a.room.page().messages[0].blobRef;
  a.request.offline = true;
  await a.room.send("still waiting");
  const waiting = (await a.room.store.outbox())[0].blobRef;
  assert.notEqual(sent, waiting);
  const real = a.room.now;
  assert.equal(await a.room.trimCache(), 0, "nothing is old yet");
  a.room.trimmedAt = 0;
  a.room.now = () => real() + 91 * 24 * 60 * 60 * 1000;
  assert.equal(await a.room.trimCache(), 1);
  assert.equal(await a.blobs.store.get(sent), null, "the sent message's cached bytes are gone");
  assert.ok(await a.blobs.store.get(waiting), "the unsent one stays");
  assert.equal(await a.blobs.store.isRetired(sent), false, "nothing was deleted for good");
  assert.equal(await a.room.trimCache(), 0, "and it doesn't look again for hours");
  assert.ok((await a.blobs.client.download(sent)).ciphertext, "the service still has it");
});

test("editing and deleting delete the replaced content on the service and on every device", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs, memberKind: "limited" });
  const devices = [phone.entry, laptop.entry];
  assert.deepEqual(chatAdmins(devices), [s.admin.memberId], "admins are the service's household admins");
  assert.deepEqual(chatAdmins([{ ...phone.entry, memberActive: false }]), []);
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  await b.room.send("typo");
  await b.room.send("rude");
  await b.room.sync({ status: STATUS, devices });
  await a.room.sync({ status: STATUS, devices });
  const [typo, rude] = a.room.page().messages;
  assert.deepEqual(await texts(a), ["typo", "rude"]);

  const [own] = b.room.page().messages;
  await b.room.edit(own, "fixed");
  await a.room.remove(rude, { byAdmin: true });
  await b.room.sync({ status: STATUS, devices });
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual(await texts(a), ["fixed", "removed-by-admin"]);
  assert.deepEqual(await texts(b), ["fixed", "removed-by-admin"]);
  // Gone from the service and from both devices' blob stores.
  for (const ref of [typo.blobRef, rude.blobRef]) {
    assert.deepEqual(await a.blobs.client.download(ref), { deleted: true });
    assert.equal(await a.blobs.store.get(ref), null);
    assert.equal(await b.blobs.store.get(ref), null);
    assert.equal(await b.blobs.store.isRetired(ref), true);
  }

  // The admins last known are kept, so a removal still shows offline and
  // after reopening, before any sync.
  b.room.close();
  const reopened = await openRoom(laptop, s);
  assert.deepEqual(reopened.room.admins, [s.admin.memberId]);
  assert.deepEqual(await texts(reopened), ["fixed", "removed-by-admin"]);
  assert.equal(reopened.room.retiredThrough, reopened.room.records.length, "replaced blobs aren't deleted again after reopening");
  // A change of admins looks at the retired list again, with no new event.
  const pages = reopened.engine.calls.page;
  await reopened.room.sync({ status: STATUS, devices: [{ ...phone.entry, householdAdmin: false }, laptop.entry] });
  assert.deepEqual(reopened.room.admins, []);
  assert.ok(reopened.engine.calls.page > pages);
});

test("a deletion the service refuses outright doesn't hold back later messages", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  // The partner's device wrongly believes the partner is an admin (demoted
  // meanwhile, say); the service, which keeps the record, refuses.
  const laptop = await device(s.partner, { householdId: s.householdId, epochs, householdAdmin: true });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  await a.room.send("mine");
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  const [mine] = b.room.page().messages;
  await b.room.remove(mine, { byAdmin: true });
  assert.deepEqual(await b.room.sync({ status: STATUS, devices }), { hasMore: false });
  assert.equal(b.room.retireRefusal?.code, "chat_blob_retire_forbidden", "reported");
  assert.equal(b.room.pending.size, 0, "sent anyway");
  await b.room.send("still sending");
  await b.room.sync({ status: STATUS, devices });
  assert.equal(b.room.pending.size, 0);
  // The admin's own content stays on the service.
  assert.ok((await a.blobs.client.download(mine.blobRef)).ciphertext);
});

test("sending while a pull is storing events loads every event exactly once", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  for (let index = 0; index < 3; index += 1) await a.room.send(`from phone ${index}`);
  await a.room.sync({ status: STATUS, devices });
  // Overlapping reads, sends and a pass, in one tab and a second tab.
  const other = await openRoom(laptop, s);
  await Promise.all([
    b.room.sync({ status: STATUS, devices }),
    b.room.send("from laptop 1"),
    b.room.refresh(),
    b.room.send("from laptop 2"),
    other.room.send("from the other tab"),
    b.room.refresh(),
  ]);
  await b.room.refresh();
  await b.room.sync({ status: STATUS, devices });
  await other.room.refresh();
  for (const { room } of [b, other]) {
    const ids = [...room.indexById.keys()];
    assert.equal(room.records.length, 6);
    assert.equal(new Set(ids).size, 6, "no event twice");
    assert.equal(room.loadedOrder, 6);
  }
  assert.equal(b.room.pending.size, 0, "the outbox isn't stuck");
  await a.room.sync({ status: STATUS, devices });
  assert.equal(a.room.records.length, 6);
});

test("pending events sealed under an older key epoch are sealed again before they leave", async () => {
  const householdId = "aa".repeat(16);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device({ memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, { householdId, epochs });
  const pushed = [];
  let relaySequence = 0;
  const request = async (path, options = {}) => {
    if (request.offline) throw Object.assign(new Error("offline"), { code: "connection_unavailable" });
    if (path === "/api/chat/status") return { deviceSequence: relaySequence };
    // A service error on the member list doesn't hold chat back (labels
    // wait for a later pass).
    if (path === "/api/household") throw Object.assign(new Error("Internal error"), { code: "internal_error" });
    if (path.startsWith("/api/chat/events") && options.method === "POST") {
      const batch = decodeEnvelopeBatch(options.body);
      pushed.push(...batch);
      relaySequence = batch.at(-1).deviceSequence;
      return { accepted: batch.length };
    }
    if (path.startsWith("/api/chat/events")) return encodeEventPage({ events: [], nextCursor: "AAAAAAAAAAA", hasMore: false });
    throw new Error(`unexpected ${path}`);
  };
  request.fetch = async () => new Response("{}", { status: 200 });
  const { room } = await openRoom(phone, { householdId, request });
  // A first message goes out under epoch 1, settling the sequence.
  await room.send("first");
  await room.sync({ status: STATUS, devices: [phone.entry] });
  assert.deepEqual(pushed.map((envelope) => [envelope.deviceSequence, envelope.keyEpoch]), [[1, 1]]);
  // Written offline under epoch 1; the household rotates to 2 meanwhile.
  request.offline = true;
  await room.send("before the rotation");
  request.offline = false;
  epochs.set(2, await generateHouseholdKey());
  // While the rotation is pending, nothing is pushed.
  assert.deepEqual(await room.sync({ status: { currentEpoch: 2, rotationPending: true }, devices: [phone.entry] }), { hasMore: false });
  assert.equal(pushed.length, 1);
  assert.equal(room.pending.size, 1);
  await room.sync({ status: { currentEpoch: 2, rotationPending: false }, devices: [phone.entry] });
  assert.deepEqual(pushed.map((envelope) => [envelope.deviceSequence, envelope.keyEpoch]), [[1, 1], [2, 2]]);
  assert.equal(room.pending.size, 0);
  // Reopened, the resealed event decrypts under its new epoch.
  room.close();
  const again = await openRoom(phone, { householdId, request });
  assert.equal(again.room.records.length, 2);
});

test("the chat log store keeps each event once and one sequence per send", async () => {
  const householdId = "aa".repeat(16);
  const indexedDB = fakeIndexedDB();
  const one = await ChatLogStore.open(householdId, { indexedDB, keyRange: fakeKeyRange });
  const two = await ChatLogStore.open(householdId, { indexedDB, keyRange: fakeKeyRange });
  const envelope = (eventId, deviceSequence) => ({ eventId, deviceSequence });
  assert.deepEqual(await one.state(), { key: "state", nextOrder: 1, cursor: "", deviceSequence: 0, provisional: true, admins: [], members: [], membersSignature: null, retiredThrough: 0, refused: [], hidden: [], hiddenRevision: 0, hiddenDirty: false, hiddenSealedFor: [] });
  await one.addLocal(envelope("01".repeat(16), 1), { blobRef: "ab".repeat(32) });
  // Another tab sending with the same sequence loses and retries.
  await assert.rejects(two.addLocal(envelope("02".repeat(16), 1)), (error) => error.code === "chat_sequence_taken");
  assert.equal(await two.addReceived([envelope("01".repeat(16), 1), envelope("03".repeat(16), 4), envelope("03".repeat(16), 4)], "AAAAAAAAAAE"), 1);
  assert.deepEqual((await one.eventsFrom(1)).map((row) => [row.order, row.eventId]), [[1, "01".repeat(16)], [2, "03".repeat(16)]]);
  assert.deepEqual((await one.eventsFrom(2)).map((row) => row.order), [2]);
  assert.deepEqual((await one.eventsFrom(1, 1)).map((row) => row.order), [1], "in chunks");
  assert.deepEqual((await one.outbox()).map((row) => [row.deviceSequence, row.blobRef]), [[1, "ab".repeat(32)]]);
  // Renumbering refuses when a send took a sequence meanwhile.
  await assert.rejects(one.replacePending([{ order: 1, previousSequence: 1, envelope: envelope("01".repeat(16), 5) }], { expectedDeviceSequence: 0, deviceSequence: 5 }),
    (error) => error.code === "chat_outbox_changed");
  await one.markSent([1]);
  assert.deepEqual(await one.outbox(), []);
  await assert.rejects(one.replacePending([{ order: 1, previousSequence: 1, envelope: envelope("01".repeat(16), 1) }], { expectedDeviceSequence: 1, deviceSequence: 1 }), (error) => error.code === "chat_outbox_changed");
  await one.addReceived([], "AAAAAAAAAAI", { refused: Array.from({ length: 120 }, (_, index) => ({ eventId: String(index) })) });
  const state = await one.state();
  assert.equal(state.cursor, "AAAAAAAAAAI");
  assert.equal(state.refused.length, 100, "bounded");
  assert.equal(state.refused.at(-1).eventId, "119");
  // Hiding only adds: a pass that settles what it wrote keeps what was
  // hidden meanwhile, due for the next write; compaction drops deleted ones.
  await one.addHidden(["01".repeat(16)]);
  await two.addHidden(["02".repeat(16)]);
  assert.deepEqual(await one.settleHidden({ ids: ["01".repeat(16)], revision: 1 }), { ids: ["01".repeat(16), "02".repeat(16)], revision: 1, dirty: true, read: null });
  assert.deepEqual(await one.settleHidden({ ids: ["01".repeat(16), "02".repeat(16)], revision: 2, dropped: ["01".repeat(16)] }), { ids: ["02".repeat(16)], revision: 2, dirty: false, read: null });
  assert.ok(indexedDB.databases.has(chatLogDatabaseName(householdId)));
  await assert.rejects(ChatLogStore.open("nope", { indexedDB, keyRange: fakeKeyRange }), (error) => error.code === "chat_log_unavailable");
});

test("members are labelled as Household access lists them", () => {
  const members = [
    { id: "a", kind: "adult", active: true },
    { id: "b", kind: "adult", active: false },
    { id: "c", kind: "limited", active: true },
    { id: "d", kind: "adult", active: true },
    { id: "e", kind: "temporary", active: false },
    { id: "f", kind: "temporary", active: true },
  ];
  assert.deepEqual([...memberLabels(members, "d")], [
    ["a", "Adult 1"], ["d", "You"], ["c", "Limited member 1"], ["e", "Temporary member 1"], ["f", "Temporary member 2"],
  ]);
});

test("a message must follow the engine's text rule before it is sent", async () => {
  assert.equal(chatTextProblem("Dinner at 6\nBring bread\t🍞"), null);
  assert.match(chatTextProblem("   \n"), /Write a message/);
  assert.match(chatTextProblem("bell \u0007"), /characters/);
  assert.match(chatTextProblem("lone \ud800"), /can't be sent/);
  assert.equal(chatTextProblem("😀".repeat(4_000)), null, "counted in characters, not bytes");
  assert.match(chatTextProblem("x".repeat(4_001)), /too long/);
  const householdId = "aa".repeat(16);
  const phone = await device({ memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, { householdId, epochs: new Map([[1, await generateHouseholdKey()]]) });
  const offline = async () => { throw Object.assign(new Error("offline"), { code: "connection_unavailable" }); };
  offline.fetch = offline;
  const { room } = await openRoom(phone, { householdId, request: offline });
  await assert.rejects(room.send(" "), (error) => error.code === "chat_text_invalid");
  assert.equal(room.records.length, 0, "nothing stored");
});

test("the private read position counts unread messages and follows me between my devices (#133)", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const tablet = await device(s.pairDevice(s.admin), { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, tablet.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(tablet, s), c = await openRoom(laptop, s);
  const syncAll = async () => { for (const { room } of [a, b, c]) await room.sync({ status: STATUS, devices }); };
  for (const text of ["one", "two", "three"]) { await c.room.send(text); await new Promise((resolve) => setTimeout(resolve, 3)); }
  await a.room.send("mine");
  await syncAll();
  await syncAll();
  const byText = new Map();
  for (const message of a.room.page().messages) byText.set((await a.blobs.openText({ ref: message.blobRef, key: message.blobKey })).text, message);
  const [one, two, three] = ["one", "two", "three"].map((text) => byText.get(text));
  assert.deepEqual(a.room.unread().count, 3, "mine doesn't count");
  assert.equal(a.room.unread().first, null, "no position yet: nothing to mark a divider at");
  assert.equal(c.room.unread().count, 1, "the partner has only my message to read");
  assert.equal(await a.room.markReadPosition(two), true);
  assert.equal(await a.room.markReadPosition(one), false, "it only moves forward");
  const after = a.room.unread();
  assert.equal(after.count, 1);
  assert.equal(after.first.messageId, three.messageId);
  await syncAll();
  await syncAll();
  assert.equal(b.room.unread().count, 1, "my other device agrees");
  assert.equal(b.room.unread().first.messageId, three.messageId);
  assert.equal(c.room.unread().count, 1, "nobody else's count changes");
  // The service holds it sealed, with the hidden-messages record.
  const stored = s.app.chatRelayService.hidden(s.app.syncService.authorize(s.admin.sessionToken));
  assert.equal(JSON.stringify(stored.record).includes(two.messageId), false);
  // Reading on the tablet clears it on the phone.
  await b.room.markReadPosition(three);
  await syncAll();
  await syncAll();
  assert.equal(a.room.unread().count, 0);
  // A deleted message is not unread, and survives a lock.
  a.room.close();
  const reopened = await openRoom(phone, s);
  assert.equal(reopened.room.unread().count, 0);
  assert.deepEqual(reopened.room.readPosition, { postedAt: three.postedAt, messageId: three.messageId });
});

test("delete for me hides a message on all of my devices and nowhere else (#119)", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const tablet = await device(s.pairDevice(s.admin), { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  let devices = [phone.entry, tablet.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(tablet, s), c = await openRoom(laptop, s);
  const syncAll = async () => { for (const { room } of [a, b, c]) await room.sync({ status: STATUS, devices }); };
  await c.room.send("about the surprise");
  await c.room.send("dinner?");
  await syncAll();
  await syncAll();
  const [surprise, dinner] = a.room.page().messages;

  await a.room.hide(surprise);
  assert.ok(a.room.isHidden(surprise.messageId), "hidden here at once");
  await syncAll();
  assert.ok(b.room.isHidden(surprise.messageId), "and on my other device");
  assert.ok(!c.room.isHidden(surprise.messageId), "nobody else sees any change");
  assert.equal(c.room.page().messages.length, 2);
  // The partner's own record is separate; mine is opaque on the service.
  assert.equal(s.app.chatRelayService.hidden(s.app.syncService.authorize(s.partner.sessionToken)).revision, 0);
  const stored = s.app.chatRelayService.hidden(s.app.syncService.authorize(s.admin.sessionToken));
  assert.equal(stored.revision, 1);
  assert.equal(JSON.stringify(stored.record).includes(surprise.messageId), false, "the service can't read which");
  assert.deepEqual(stored.record.recipients.map((entry) => entry.deviceId).sort(), [s.admin.deviceId, tablet.who.deviceId].sort(), "sealed to my devices only");
  // A pass with nothing new asks only for the revision.
  const before = a.request.paths.length;
  await a.room.sync({ status: STATUS, devices });
  assert.ok(!a.request.paths.slice(before).some((path) => path === "PUT /api/chat/hidden"));

  // Both of my devices hide something offline: the record ends with both.
  a.request.offline = true;
  b.request.offline = true;
  await a.room.hide(dinner);
  await b.room.hide({ messageId: "ab".repeat(16) });
  a.request.offline = false;
  b.request.offline = false;
  await syncAll();
  await syncAll();
  for (const { room } of [a, b]) assert.deepEqual([...room.hidden].sort(), [surprise.messageId, dinner.messageId, "ab".repeat(16)].sort());

  // Survives a lock: kept on the device.
  a.room.close();
  const reopened = await openRoom(phone, s);
  assert.ok(reopened.room.isHidden(dinner.messageId));

  // A device of mine added later reads the record once another of mine
  // writes it again (sealed to it too).
  const tv = await device(s.pairDevice(s.admin), { householdId: s.householdId, epochs, householdAdmin: true });
  const d = await openRoom(tv, s);
  devices = [phone.entry, tablet.entry, laptop.entry, tv.entry];
  await d.room.sync({ status: STATUS, devices });
  assert.equal(d.room.hiddenWaiting, true, "not sealed to it yet");
  assert.equal(d.room.isHidden(surprise.messageId), false);
  await b.room.sync({ status: STATUS, devices });
  await d.room.sync({ status: STATUS, devices });
  assert.equal(d.room.hiddenWaiting, false);
  assert.ok(d.room.isHidden(surprise.messageId) && d.room.isHidden(dinner.messageId));

  // The device that wrote last is revoked: my other devices write afresh
  // from what they hold, and keep syncing.
  const lastWriter = s.app.chatRelayService.hidden(s.app.syncService.authorize(s.admin.sessionToken)).record.senderDeviceId;
  const writerRoom = [reopened, b, d].find(({ room }) => room.identity.deviceId === lastWriter) ?? reopened;
  devices = devices.map((entry) => (entry.deviceId === lastWriter ? { ...entry, revokedAt: Date.now() } : entry));
  const others = [reopened, b, d].filter((room) => room !== writerRoom);
  await others[0].room.hide({ messageId: "cd".repeat(16) });
  for (const { room } of others) await room.sync({ status: STATUS, devices });
  for (const { room } of others) await room.sync({ status: STATUS, devices });
  for (const { room } of others) {
    assert.equal(room.hiddenError, null, String(room.hiddenError?.code));
    assert.ok(room.isHidden("cd".repeat(16)) && room.isHidden(surprise.messageId), "kept and still syncing");
  }
  const after = s.app.chatRelayService.hidden(s.app.syncService.authorize(s.admin.sessionToken)).record;
  assert.ok(!after.recipients.some((entry) => entry.deviceId === lastWriter), "the revoked device isn't sealed to");
});

test("delete for me keeps syncing when one of my devices changes its key, and refuses a rollback", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const tablet = await device(s.pairDevice(s.admin), { householdId: s.householdId, epochs, householdAdmin: true });
  phone.entry.fingerprint = "phone-1";
  tablet.entry.fingerprint = "tablet-1";
  let devices = [phone.entry, tablet.entry];
  const a = await openRoom(phone, s), b = await openRoom(tablet, s);
  await a.room.hide({ messageId: "01".repeat(16) });
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  assert.ok(b.room.isHidden("01".repeat(16)));
  // The tablet rekeys: its old key can't open what was sealed to it.
  const rekeyed = await device(tablet.who, { householdId: s.householdId, epochs, householdAdmin: true });
  rekeyed.entry.fingerprint = "tablet-2";
  rekeyed.indexedDB = tablet.indexedDB;
  devices = [phone.entry, rekeyed.entry];
  b.room.close();
  const b2 = await openRoom(rekeyed, s);
  await b2.room.hide({ messageId: "02".repeat(16) });
  await b2.room.sync({ status: STATUS, devices });
  assert.equal(b2.room.hiddenWaiting, true, "waits for the phone, which can read it");
  await a.room.sync({ status: STATUS, devices });
  await b2.room.sync({ status: STATUS, devices });
  await a.room.sync({ status: STATUS, devices });
  for (const { room } of [a, b2]) assert.deepEqual([...room.hidden].sort(), ["01".repeat(16), "02".repeat(16)]);
  // Every device of mine rekeyed or new: the record can't be read by any of
  // them, so one writes it afresh from what it holds.
  const fresh = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  fresh.entry.fingerprint = "phone-2";
  fresh.indexedDB = phone.indexedDB;
  devices = [fresh.entry];
  a.room.close();
  const a2 = await openRoom(fresh, s);
  await a2.room.sync({ status: STATUS, devices });
  assert.equal(a2.room.hiddenError, null);
  assert.equal(a2.room.hiddenWaiting, false);
  assert.ok(a2.room.isHidden("01".repeat(16)));
  // The service goes back to an older (here: empty) record, as after a
  // restored backup: the device writes back what it holds.
  const auth = s.app.syncService.authorize(s.admin.sessionToken);
  s.app.chatRelayService.storage.forgetHousehold(s.householdId);
  assert.equal(s.app.chatRelayService.hidden(auth).revision, 0);
  await a2.room.sync({ status: STATUS, devices });
  assert.equal(a2.room.hiddenError, null);
  assert.ok(a2.room.isHidden("01".repeat(16)) && a2.room.isHidden("02".repeat(16)));
  assert.equal(s.app.chatRelayService.hidden(auth).revision, 1, "written back");
});

test("the in-memory chat log grows in place and gives the engine views of it", () => {
  const records = new ChatRecords();
  const first = records.view();
  for (let index = 0; index < 2_000; index += 1) records.append(encoder.encode(`event ${index} `.repeat(10)));
  const view = records.view();
  assert.equal(view.arena, first.arena, "the same log, so the engine is sent only what's new");
  assert.equal(view.epoch, first.epoch);
  assert.equal(view.length, 2_000);
  assert.equal(decoder.decode(view.record(1_999)), "event 1999 ".repeat(10));
  const target = new Uint8Array(view.recordLength(3) + view.recordLength(4));
  view.copyRecordsTo(target, 0, 3, 5);
  assert.equal(decoder.decode(target), "event 3 ".repeat(10) + "event 4 ".repeat(10));
  records.clear();
  assert.notEqual(records.view().epoch, view.epoch);
  assert.throws(() => view.record(0), /changed/);
  assert.equal(MAX_CHAT_PULL, 200);
});

test("the coordinator runs a chat pass after each full pass and keeps chat trouble to chat", async () => {
  const reports = [];
  const room = { syncs: 0, closed: false, result: { hasMore: true }, failure: null,
    async sync(context) { this.syncs += 1; this.context = context; if (this.failure) throw this.failure; return this.result; },
    reportSync(error) { reports.push(error?.code ?? null); }, setLiveSender() {}, close() { this.closed = true; } };
  const opened = [], told = [];
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16), memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, liveChannel: () => null,
    chatRoom: async (options) => { opened.push(options); return room; }, onChatRoom: (value) => told.push(value) });
  coordinator.deviceKeys = { keys: {} };
  coordinator.keyStore = { close() {} };
  const context = { status: STATUS, devices: [] };
  assert.deepEqual(await coordinator.syncChat(context), { hasMore: true });
  assert.equal(opened.length, 1);
  assert.equal(typeof opened[0].request, "function");
  assert.equal(opened[0].deviceKeys, coordinator.deviceKeys);
  await coordinator.syncChat(context);
  assert.equal(opened.length, 1, "opened once");
  assert.equal(room.context.deviceKeys, coordinator.deviceKeys);
  room.failure = Object.assign(new Error("Chat isn't available to you."), { code: "chat_unavailable" });
  assert.deepEqual(await coordinator.syncChat(context), { hasMore: false }, "household sync carries on");
  room.failure = Object.assign(new Error("Signed out"), { code: "authentication_required" });
  await assert.rejects(coordinator.syncChat(context), (error) => error.code === "authentication_required");
  assert.deepEqual(reports, [null, null, "chat_unavailable"]);
  assert.deepEqual(told, [room], "the view hears when the room opens");
  coordinator.stop();
  assert.equal(room.closed, true, "stopping (on lock) closes the room");
  assert.deepEqual(told, [room, null], "and when it closes");
  assert.equal(coordinator.chat, null);

  // A pass that leaves chat to read continues soon, like a household catch-up.
  const continuing = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16) }, liveChannel: () => null, chatRoom: async () => null });
  const continued = [];
  continuing.runOnce = async () => ({ hasMore: false, advanced: true, chatMore: true });
  continuing.scheduleContinuation = () => continued.push(true);
  continuing.updatePollInterval = () => {};
  await continuing.syncNow();
  assert.deepEqual(continued, [true]);
  continuing.runOnce = async () => ({ hasMore: false, advanced: true, chatMore: false });
  await continuing.syncNow();
  assert.deepEqual(continued, [true]);
  // Blob requests stop with sync.
  continuing.stop();
  await assert.rejects(continuing.blobFetch("/api/chat/blobs/x"), /stopped/);

  // A room that fails to open is remembered for the view and retried.
  let attempts = 0;
  const failing = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16) }, liveChannel: () => null,
    chatRoom: async () => { attempts += 1; throw Object.assign(new Error("missing key"), { code: "chat_key_missing" }); } });
  assert.deepEqual(await failing.syncChat(context), { hasMore: false });
  assert.equal(failing.chatOpenError.code, "chat_key_missing");
  await failing.syncChat(context);
  assert.equal(attempts, 2);

  // Where chat storage is missing, the coordinator stops trying.
  const none = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16) }, liveChannel: () => null, chatRoom: async () => null });
  assert.deepEqual(await none.syncChat(context), { hasMore: false });
  assert.equal(none.openChatRoom, null);
});

test("the room drives the real chat engine: send, edit, delete and page (#109, #111)", { skip: !existsSync(WASM) && "kin_engine.wasm is not built here" }, async () => {
  const engine = await loadKinEngine(`data:application/wasm;base64,${readFileSync(WASM).toString("base64")}`);
  const householdId = "aa".repeat(16);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device({ memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, { householdId, epochs });
  const offline = async () => { throw Object.assign(new Error("offline"), { code: "connection_unavailable" }); };
  offline.fetch = offline;
  const opened = await openRoom(phone, { householdId, engine, request: offline });
  await opened.room.send("Dinner at 6");
  await opened.room.send("Bring bread");
  const [first, second] = opened.room.page().messages;
  assert.deepEqual([first.status, second.status], ["live", "live"]);
  assert.equal(first.authorId, "bb".repeat(16));
  await opened.room.edit(first, "Dinner at 7");
  await opened.room.remove(second);
  const page = opened.room.page({ includeRetired: true });
  assert.deepEqual(page.messages.map((message) => message.status), ["edited", "deleted"]);
  assert.deepEqual(page.retired.sort(), [first.blobRef, second.blobRef].sort());
  assert.deepEqual(await texts(opened), ["Dinner at 7", "deleted"]);
  // Reopened from storage with the same engine instance, the mirror resets
  // to the new log and pages the same.
  opened.room.close();
  const again = await openRoom(phone, { householdId, engine, request: offline });
  assert.deepEqual(again.room.page().messages.map((message) => message.status), ["edited", "deleted"]);
  assert.equal(again.room.pending.size, 4, "all four wait to send");
});

test("photos and files go to the other device in parts, and deleting the message deletes every part", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  // A stand-in for the browser's photo preparation: the photo is "drawn
  // again" as different bytes, with a thumbnail.
  const preparePhoto = async (photo) => ({
    blob: new Blob([new Uint8Array(3000).fill(7)], { type: photo.type }),
    thumbnail: new Blob([new Uint8Array(200).fill(9)], { type: "image/jpeg" }),
  });
  const a = await openRoom(phone, { ...s, preparePhoto }), b = await openRoom(laptop, s);
  const slip = new Uint8Array(2.5 * 1024 * 1024);
  for (let index = 0; index < slip.length; index += 1) slip[index] = (index * 31 + 7) & 0xff;
  const slipFile = new File([slip], "Permission slip.pdf", { type: "application/pdf" });
  const photoFile = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...new Array(36).fill(0)])], "IMG_2041.heic.jpg", { type: "image/jpeg" });

  await a.room.sendAttachments({ text: "Sign by Friday", files: [slipFile, photoFile] });
  await a.room.sync({ status: STATUS, devices });
  // Three parts of the slip, the photo and its thumbnail, then the manifest
  // (the last of them), all before the event that names them.
  const paths = a.request.paths;
  const uploads = paths.map((path, index) => (path.startsWith("PUT /api/chat/blobs/") ? index : -1)).filter((index) => index >= 0);
  assert.equal(uploads.length, 3 + 1 + 1 + 1, "parts, thumbnail, then manifest");
  assert.ok(uploads.at(-1) < paths.indexOf("POST /api/chat/events"), "the event goes after its content");
  await b.room.sync({ status: STATUS, devices });
  const message = b.room.page().messages.find((entry) => entry.contentKind === "attachment");
  assert.ok(message && message.text === null, "shown as an attachment, its content not in the engine");
  const opened = await b.room.openAttachment(message);
  assert.equal(opened.text, "Sign by Friday");
  assert.deepEqual(opened.files.map((file) => [file.name, file.size, file.photo]), [["Permission slip.pdf", slip.length, false], ["IMG_2041.heic.jpg", 3000, true]]);
  const back = new Uint8Array(await (await b.room.attachmentFile(message, 0)).arrayBuffer());
  assert.equal(back.length, slip.length);
  assert.ok(back.every((byte, index) => byte === slip[index]), "the file's bytes arrive whole");
  assert.equal(await b.room.attachmentThumbnail(message, 0), null, "a file has no thumbnail");
  assert.equal((await b.room.attachmentThumbnail(message, 1)).size, 200);
  assert.equal((await b.room.attachmentFile(message, 1)).size, 3000, "the photo is the drawn-again copy");

  // Deleting for everyone: the author's device names the parts; the service
  // deletes them, and the other device deletes its copies.
  const parts = (await b.room.manifestOf(message)).files.flatMap((file) => [...file.parts, file.thumbnail].filter(Boolean)).map((part) => part.ref);
  assert.equal(parts.length, 3 + 1 + 1 + 0, "the slip's parts, the photo part and the thumbnail");
  await a.room.remove(a.room.page().messages.find((entry) => entry.messageId === message.messageId));
  await a.room.sync({ status: STATUS, devices });
  for (const ref of parts) assert.deepEqual(await a.blobs.client.download(ref), { deleted: true }, "deleted on the service");
  await b.room.sync({ status: STATUS, devices });
  await assert.rejects(b.room.openAttachment(message), (error) => error.code === "chat_attachment_deleted");
  for (const ref of parts) assert.equal(await b.blobs.store.get(ref), null, "and on the other device");

  // A voice message (#134) is one audio file with a duration and waveform.
  const peaks = Array.from({ length: 64 }, (_, index) => index * 4);
  const speech = new Uint8Array(3000).map((_, index) => (index * 7) & 0xff);
  await assert.rejects(a.room.sendVoice({ recording: new Blob([speech], { type: "video/mp4" }), durationMs: 4000, peaks }), (error) => error.code === "chat_attachment_invalid");
  await assert.rejects(a.room.sendVoice({ recording: new Blob([speech], { type: "audio/webm" }), durationMs: 400_000, peaks }), (error) => error.code === "chat_attachment_invalid");
  await a.room.sendVoice({ recording: new Blob([speech], { type: "audio/webm;codecs=opus" }), durationMs: 4200, peaks });
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  const voiced = b.room.page().messages.find((entry) => entry.contentKind === "attachment" && entry.messageId !== message.messageId);
  const spoken = await b.room.openAttachment(voiced);
  assert.equal(spoken.files.length, 1);
  assert.equal(spoken.files[0].type, "audio/webm");
  assert.deepEqual(spoken.files[0].voice, { durationMs: 4200, peaks });
  const heard = new Uint8Array(await (await b.room.attachmentFile(voiced, 0)).arrayBuffer());
  assert.deepEqual(Array.from(heard), Array.from(speech), "the recording arrives whole");
});

test("sending files reports progress per file, and cancelling leaves no sealed part behind", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const a = await openRoom(phone, s);
  const held = async () => (await a.blobs.store.inventory()).length;
  const slip = new File([new Uint8Array(2.5 * 1024 * 1024).fill(3)], "Slip.pdf", { type: "application/pdf" });
  const note = new File([new Uint8Array(100).fill(4)], "note.txt", { type: "text/plain" });

  const seen = [];
  await a.room.sendAttachments({ text: "", files: [slip, note], onProgress: (progress) => seen.push(progress) });
  assert.deepEqual(seen.filter((entry) => entry.index === 0).map((entry) => entry.done), [1048576, 2097152, 2621440, 2621440], "a step per 1 MiB part, then complete");
  assert.deepEqual(seen.filter((entry) => entry.index === 1).map((entry) => [entry.done, entry.total]), [[100, 100], [100, 100]]);
  const afterSend = await held();

  // Cancelled between parts of the second file: that file's sealed parts and the first file's are retired.
  const controller = new AbortController();
  await assert.rejects(
    a.room.sendAttachments({ text: "", files: [note, slip], signal: controller.signal, onProgress: ({ index, done }) => { if (index === 1 && done >= 1048576) controller.abort(); } }),
    (error) => error.code === "chat_attachment_cancelled",
  );
  assert.equal(await held(), afterSend, "nothing from the cancelled send is kept");
  assert.equal(a.room.page().messages.filter((entry) => entry.contentKind === "attachment").length, 1, "and no message was posted");

  // Cancelled after the last part is sealed (the common case for a small file): still stopped.
  const late = new AbortController();
  await assert.rejects(
    a.room.sendAttachments({ text: "", files: [note], signal: late.signal, onProgress: ({ done, total }) => { if (done === total) late.abort(); } }),
    (error) => error.code === "chat_attachment_cancelled",
  );
  assert.equal(await held(), afterSend, "the sealed part and manifest are gone");

  // A progress callback that throws doesn't break sending or leak.
  await a.room.sendAttachments({ text: "", files: [note], onProgress: () => { throw new Error("broken"); } });
  assert.equal(a.room.page().messages.filter((entry) => entry.contentKind === "attachment").length, 2);
  const afterBroken = await held();

  // Cancelled before it starts.
  const early = new AbortController();
  early.abort();
  await assert.rejects(a.room.sendAttachments({ text: "", files: [note], signal: early.signal }), (error) => error.code === "chat_attachment_cancelled");
  assert.equal(await held(), afterBroken);
});

test("read receipts travel through the real receipt route, sealed, and survive the other device's sync", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  await a.room.send("Dinner at 6");
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  const [message] = b.room.page().messages;
  assert.deepEqual(a.room.presence.readers(message), [], "nobody has read it yet");

  // The partner reads it on screen; their cursor goes to the service.
  assert.equal(b.room.presence.markRead(message), true);
  await b.room.presence.flush();
  const stored = JSON.stringify(s.app.chatRelayService.receipts({ ...s.app.syncService.authorize(s.admin.sessionToken) }));
  assert.equal(stored.includes(message.messageId), false, "the service holds no message ID");
  assert.equal(stored.includes("cursor"), false, "nor a cursor");
  // The chat pass reads the slots at most every 15 seconds; the live hint
  // (or the first pass after opening) brings them sooner.
  a.room.receiptsChanged();
  await a.room.sync({ status: STATUS, devices });
  assert.deepEqual(a.room.presence.readers(message).map((reader) => reader.memberId), [s.partner.memberId], "the sender sees who read it");

  // Turning receipts off hides mine and theirs, and clears the cursor.
  await a.room.presence.setSettings({ receipts: false });
  assert.deepEqual(a.room.presence.readers(message), []);
  await b.room.sync({ status: STATUS, devices });
  await b.room.presence.refresh();
  assert.equal(b.room.presence.readers({ ...message, authorId: s.admin.memberId }).length, 0, "the admin's slot says nothing");
  // A write for a stale revision is refused by the real service and merged.
  await b.room.presence.setSettings({ typing: false });
  await a.room.presence.refresh();
  assert.equal(a.room.presence.sendsTyping, true, "settings are per member, not household-wide");
  b.room.close();
  a.room.close();
});

test("the chat policy: read-only can't post and sends nothing; no access stops the pass; lifting it resumes", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  const status = (access) => ({ ...STATUS, chat: { access } });
  await a.room.send("Dinner at 6");
  await a.room.sync({ status: status("write"), devices });
  assert.equal(a.room.access, "write");

  // Read only: a message written before the change waits instead of sending,
  // new ones are refused, and the presence stays quiet.
  await a.room.send("Running late");
  await a.room.sync({ status: status("read"), devices });
  assert.equal(a.room.access, "read");
  assert.equal(a.room.pending.size, 1, "the unsent message waits rather than fail");
  await assert.rejects(a.room.send("more"), (error) => error.code === "chat_read_only");
  await assert.rejects(a.room.edit(a.room.page().messages[0], "x"), (error) => error.code === "chat_read_only");
  await assert.rejects(a.room.remove(a.room.page().messages[0]), (error) => error.code === "chat_read_only");
  assert.equal(a.room.presence.sendsReceipts, false);
  assert.equal(a.room.presence.sendsTyping, false);
  assert.equal(a.room.page().messages.length, 2, "still readable");

  // No access: the pass does nothing, and nothing new arrives.
  await b.room.sync({ status: status("write"), devices });
  await b.room.send("Okay!");
  await b.room.sync({ status: status("write"), devices });
  const before = a.room.page().total;
  const result = await a.room.sync({ status: status("none"), devices });
  assert.deepEqual(result, { hasMore: false });
  assert.equal(a.room.access, "none");
  assert.equal(a.room.page().total, before, "nothing fetched");

  // Restored: the waiting message goes out and the new one arrives.
  await a.room.sync({ status: status("write"), devices });
  assert.equal(a.room.access, "write");
  assert.equal(a.room.pending.size, 0);
  assert.equal(a.room.page().total, before + 1);
  a.room.close();
  b.room.close();
});

// The dedicated chat key (#123): content is sealed under a key only devices of
// members allowed to read are given. Shutting a class out rotates it; a device
// that never receives it cannot open what is sent afterwards, even holding the
// household key and the sealed envelope; giving access back shares it again.
test("a member shut out of chat cannot open messages sent after the chat key rotates", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const invitation = s.app.service.createPairing(s.admin.sessionToken, { kind: "limited" });
  const claim = s.app.service.claimPairing({ code: invitation.code, credential: { id: "child", publicKey: "key-child", algorithm: -7 }, deviceLabel: "Tablet" });
  s.app.service.approvePairing(s.admin.sessionToken, invitation.pairingId, claim.version);
  const child = s.app.service.activateClaim(claim.claimToken);
  const householdKey = await generateHouseholdKey();
  const epochs = new Map([[1, householdKey]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const tablet = await device(child, { householdId: s.householdId, epochs, memberKind: "limited" });
  for (const one of [phone, laptop, tablet]) s.app.service.devices.get(one.who.deviceId).syncKeyFingerprint = one.entry.fingerprint;
  const devices = [phone.entry, laptop.entry, tablet.entry];
  const [a, b, c] = [await openRoom(phone, s), await openRoom(laptop, s), await openRoom(tablet, s)];
  const status = (who) => s.app.syncService.status(who.sessionToken);
  const sync = (one, room) => room.room.sync({ status: status(one.who), devices, deviceKeys: one.deviceKeys });

  await a.room.send("before");
  await sync(phone, a);
  await sync(laptop, b);
  await sync(tablet, c);
  assert.deepEqual(await texts(c), ["before"], "no chat key yet: everyone reads");

  s.app.service.setChatPolicy(s.admin.sessionToken, { limited: "none", temporary: "write" }, s.admin.memberId);
  assert.equal(status(phone.who).chat.key.action, "rotate");
  await sync(phone, a);
  assert.equal(status(phone.who).chat.key.epoch, 1, "an adult's device made the chat key");
  assert.equal(a.room.chatKeys.pending, false);
  await sync(laptop, b);
  assert.equal((await b.room.chatKeys.key(1)) instanceof CryptoKey, true, "the other adult was given it");

  await a.room.send("secret after");
  await sync(phone, a);
  await sync(laptop, b);
  assert.deepEqual(await texts(b), ["before", "secret after"], "devices with the chat key read it");
  const stored = s.app.chatRelayService.pull(s.app.syncService.authorize(s.admin.sessionToken), "", "50").events.at(-1).envelope;
  assert.equal(a.room.chatEpochById.get(stored.eventId), 1, "sealed under the chat key");

  // The tablet is told it has no access and fetches nothing. Even handed the
  // sealed envelope (it holds the household key), it can't open the content.
  await sync(tablet, c);
  assert.equal(c.room.access, "none");
  const outer = await decryptStoredEvent({ envelope: stored, householdKey });
  assert.deepEqual([...outer.slice(0, 4)], [0x4b, 0x43, 0x4b, 0x31], "inside the household envelope, the chat key's layer");
  await assert.rejects(c.room.chatKeys.open(outer, stored.eventId), (error) => error.code === "chat_key_missing");
  await assert.rejects(c.room.chatKeys.key(1), (error) => error.code === "chat_key_missing");
  assert.equal(c.room.chatKeys.keys.size, 0);

  const adminAuth = s.app.syncService.authorize(s.admin.sessionToken);
  // A damaged package stored for the tablet doesn't wedge it: it drops the
  // package, and a holder shares the key again.
  s.app.service.setChatPolicy(s.admin.sessionToken, { limited: "write", temporary: "write" }, s.admin.memberId);
  const junk = {
    version: 1, grantId: "ab".repeat(16), householdId: `chat:${s.householdId}`, senderDeviceId: s.admin.deviceId, recipientDeviceId: child.deviceId,
    recipientFingerprint: tablet.entry.fingerprint, keyEpoch: 1, expiresAt: Date.now() + 60_000, ephemeralPublicKey: { kty: "EC" },
    salt: "AAAA", nonce: "AAAA", wrappedKey: "AAAA", signature: "AAAA",
  };
  s.app.chatRelayService.putKeys(adminAuth, { expectedEpoch: 1, epoch: 1, packages: [{ deviceId: child.deviceId, keyEpoch: 1, package: junk }] });
  assert.equal(status(phone.who).chat.key.action, null, "the service believes the tablet has it");
  await assert.rejects(sync(tablet, c), (error) => error.code === "chat_key_missing", "waiting for the key");
  assert.equal(status(phone.who).chat.key.action, "grant", "the tablet dropped what it couldn't open");

  // Access back: a holder shares the key, and the tablet reads everything.
  await sync(phone, a);
  await sync(tablet, c);
  assert.deepEqual(await texts(c), ["before", "secret after"]);
  assert.equal(status(phone.who).chat.key.action, null);

  // A plain (unsealed) event pushed after the key began is refused by every
  // reader, so a client holding only the household key can't write chat.
  const forged = a.engine.executeChatCommand({ type: "post-chat-message", messageId: "ab".repeat(16), blobRef: "cd".repeat(32), blobKey: "ef".repeat(32) }, {
    eventId: "12".repeat(16), householdId: s.householdId, actorId: s.admin.memberId, deviceId: s.admin.deviceId, timestamp: Date.now(), logicalTime: 99n,
  }, a.room.records.view(), Date.now(), 0, a.room.syncIdentity(), a.room.admins);
  const plain = await encryptEvent({
    eventId: "12".repeat(16), householdId: s.householdId, deviceId: s.admin.deviceId,
    deviceSequence: s.app.chatRelayService.status(adminAuth).deviceSequence + 1, logicalTime: "99", keyEpoch: 1,
    plaintext: forged.encodedEvent, householdKey, signingKey: phone.deviceKeys.keys.signingPrivateKey,
  });
  s.app.chatRelayService.push(adminAuth, [plain], { chatEpoch: 1 });
  await sync(laptop, b);
  assert.equal(b.room.refused.length, 1, "refused, and chat goes on");
  assert.deepEqual(await texts(b), ["before", "secret after"]);
});

test("members react to a message, take it back, and a deletion drops the reactions (#127)", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs, memberKind: "limited" });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  await a.room.send("Dinner at 6");
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  const [dinner] = b.room.page().messages;
  assert.deepEqual(dinner.reactions, []);
  await b.room.react(dinner, "\u{1F44D}", true);
  await b.room.react(dinner, "\u2764\uFE0F", true);
  assert.equal(b.room.pendingMessages.has(dinner.messageId), false, "a reaction doesn't make its message \"sending\"");
  await b.room.sync({ status: STATUS, devices });
  await a.room.sync({ status: STATUS, devices });
  const [seen] = a.room.page().messages;
  assert.deepEqual(seen.reactions, [
    { emoji: "\u{1F44D}", actors: [s.partner.memberId] },
    { emoji: "\u2764\uFE0F", actors: [s.partner.memberId] },
  ]);
  await a.room.react(seen, "\u{1F44D}", true);
  await b.room.react(dinner, "\u2764\uFE0F", false);
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual(b.room.page().messages[0].reactions, [{ emoji: "\u{1F44D}", actors: [s.partner.memberId, s.admin.memberId] }]);
  // Pages carry them unless a caller opts out.
  assert.deepEqual(b.room.page({ includeReactions: false }).messages[0].reactions, []);
  // The author deletes the message: its reactions go with it.
  await a.room.remove(a.room.page().messages[0]);
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual(b.room.page().messages[0].reactions, []);
  // A member who can only read may not react.
  b.room.access = "read";
  await assert.rejects(() => b.room.react(b.room.page().messages[0], "\u{1F44D}", true), (error) => error.code === "chat_read_only" || /read/i.test(error.message));
});

test("a reply quotes its original, and the quote follows the original's edits, deletion and late text (#129)", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs, memberKind: "limited" });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  await a.room.send("Dinner at 6");
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  const [dinner] = b.room.page().messages;
  assert.equal(dinner.replyTo, null);
  await b.room.send("Sounds good", { replyTo: dinner.messageId });
  await b.room.sync({ status: STATUS, devices });
  await a.room.sync({ status: STATUS, devices });
  let [original, reply] = a.room.page().messages;
  assert.equal(reply.replyTo.messageId, original.messageId);
  assert.equal(reply.replyTo.state, "live");
  assert.equal(reply.replyTo.authorId, s.admin.memberId);
  assert.equal(reply.replyTo.index, 0);
  // The quote's text isn't copied into the reply: it is opened like a message's, on demand.
  const fresh = await openRoom(laptop, s);
  await fresh.room.sync({ status: STATUS, devices });
  [, reply] = fresh.room.page().messages;
  assert.equal(reply.replyTo.text, null);
  const opened = await fresh.room.loadQuoteTexts([reply]);
  assert.equal(opened.get(original.messageId).text, "Dinner at 6");
  assert.equal(fresh.room.page().messages[1].replyTo.text, "Dinner at 6");
  // Editing the original is reflected; deleting it turns the quote into a deleted one.
  await a.room.edit(original, "Dinner at 7");
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  await b.room.loadQuoteTexts(b.room.page().messages);
  assert.equal(b.room.page().messages[1].replyTo.state, "edited");
  assert.equal(b.room.page().messages[1].replyTo.text, "Dinner at 7");
  await a.room.remove(a.room.page().messages[0]);
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  const gone = b.room.page().messages[1].replyTo;
  assert.deepEqual([gone.state, gone.blobRef, gone.text], ["deleted", null, null]);
  // A reply to a message nobody holds still sends; its quote is "unknown".
  await b.room.send("Who said that?", { replyTo: "ab".repeat(16) });
  assert.equal(b.room.page().messages[2].replyTo.state, "unknown");
});

test("searching opens older texts in rounds, leaves out hidden messages and refuses without chat access (#124)", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs, memberKind: "limited" });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  await a.room.send("Dinner at 6");
  await a.room.send("Pasta night, dinner again");
  await a.room.send("Something else");
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  // The reader's engine holds no texts yet: they are opened, then searched.
  const updates = [];
  const done = await b.room.search({ query: "DINNER" }, (update) => updates.push(update));
  assert.equal(updates[0].searching, true);
  assert.equal(updates[0].total, 0);
  assert.equal(done.searching, false);
  assert.equal(done.incomplete, false);
  assert.equal(done.total, 2);
  assert.deepEqual(done.results.map((result) => result.ranges), [[[13, 19]], [[0, 6]]]);
  assert.equal(b.engine.calls.search.length, 2);
  assert.equal(b.engine.calls.search[0].admins.length, b.room.admins.length);
  // A message the reader hid is left out.
  b.room.hidden = new Set([done.results[0].messageId]);
  const hidden = await b.room.search({ query: "dinner" });
  assert.deepEqual(hidden.results.map((result) => result.messageId), [done.results[1].messageId]);
  assert.deepEqual(b.engine.calls.search.at(-1).excluded, [done.results[0].messageId]);
  // No access to chat: nothing is searched, even from what this device holds.
  b.room.access = "none";
  const before = b.engine.calls.search.length;
  await assert.rejects(b.room.search({ query: "dinner" }), (error) => error.code === "chat_no_access");
  assert.equal(b.engine.calls.search.length, before);
});

test("unread skips hidden, deleted and future-dated messages, and a future position is ignored (#133)", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), c = await openRoom(laptop, s);
  for (const text of ["one", "two", "three"]) { await c.room.send(text); await new Promise((resolve) => setTimeout(resolve, 3)); }
  for (const { room } of [a, c]) await room.sync({ status: STATUS, devices });
  for (const { room } of [a, c]) await room.sync({ status: STATUS, devices });
  const [one, two] = a.room.page().messages;
  assert.equal(a.room.unread().count, 3);
  await a.room.hide(one);
  assert.equal(a.room.unread().count, 2, "hidden is not unread");
  await c.room.remove(c.room.page().messages.find((message) => message.messageId === two.messageId));
  for (const { room } of [c, a, c, a]) await room.sync({ status: STATUS, devices });
  assert.equal(a.room.unread().count, 1, "deleted is not unread");
  const real = a.room.now;
  a.room.now = () => real() - 3_600_000;
  assert.equal(a.room.unread().count, 0, "dated ahead of this clock: not counted yet");
  a.room.now = real;
});

test("mentions name members who can read chat, follow edits, and count as unread (#130)", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), c = await openRoom(laptop, s);
  const syncAll = async () => { for (const { room } of [a, c, a, c]) await room.sync({ status: STATUS, devices }); };
  await syncAll();
  assert.deepEqual(a.room.mentionable().map((member) => member.id), [s.partner.memberId], "everyone but me");
  assert.deepEqual(c.room.mentionable().map((member) => member.id), [s.admin.memberId]);
  // Naming someone the service doesn't list as a reader is refused.
  await assert.rejects(a.room.send("hi @nobody", { mentions: { members: ["99".repeat(16)] } }));
  const first = await a.room.send("@Adult lunch?", { mentions: { members: [s.partner.memberId] } });
  await a.room.send("@everyone dinner at six", { mentions: { everyone: true } });
  await a.room.send("no mentions");
  await syncAll();
  const messages = c.room.page().messages;
  assert.equal(messages.length, 3);
  assert.deepEqual(c.room.mentionsOf(messages[0]), { everyone: false, members: [s.partner.memberId], me: true });
  assert.equal(c.room.mentionsOf(messages[1]).me, true, "@everyone reaches me too");
  assert.equal(c.room.mentionsOf(messages[2]).me, false);
  assert.equal(a.room.mentionsOf(a.room.page().messages[0]).me, false, "my own mention of someone else is not mine");
  assert.deepEqual({ count: c.room.unread().count, mentions: c.room.unread().mentions }, { count: 3, mentions: 2 });
  // An edit replaces the list.
  await a.room.edit(a.room.page().messages.find((message) => message.messageId === first.messageId), "lunch?", { mentions: null });
  await syncAll();
  assert.equal(c.room.mentionsOf(c.room.page().messages[0]).me, false);
  assert.equal(c.room.unread().mentions, 1);
  // A member who can no longer read chat is plain text.
  c.room.readers = c.room.readers.filter((id) => id !== s.partner.memberId);
  assert.deepEqual(a.room.mentionsOf({ authorId: "x", mentions: { everyone: false, members: [s.partner.memberId] } }).members, [s.partner.memberId]);
  a.room.readers = a.room.readers.filter((id) => id !== s.partner.memberId);
  assert.deepEqual(a.room.mentionsOf({ authorId: "x", mentions: { everyone: false, members: [s.partner.memberId] } }).members, []);
  assert.deepEqual(a.room.mentionable(), []);
});

test("members pin messages up to the limit, anyone unpins, and deleting for everyone unpins (#131)", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), c = await openRoom(laptop, s);
  const syncAll = async () => { for (const { room } of [a, c, a, c]) await room.sync({ status: STATUS, devices }); };
  await syncAll();
  const sent = [];
  for (let n = 1; n <= 12; n += 1) sent.push(await a.room.send(`message ${n}`));
  await syncAll();
  const byId = (room, id) => room.page().messages.find((message) => message.messageId === id);
  await c.room.pin(byId(c.room, sent[0].messageId), true);
  await syncAll();
  const pins = () => a.room.page({ includePins: true }).pins;
  assert.deepEqual(pins().map((pin) => [pin.messageId, pin.pinnedBy]), [[sent[0].messageId, s.partner.memberId]]);
  for (let n = 1; n < 10; n += 1) await a.room.pin(byId(a.room, sent[n].messageId), true);
  await syncAll();
  assert.equal(pins().length, 10);
  // The 11th is refused with a plain message, and nothing is sent.
  const before = a.room.page().total;
  await assert.rejects(a.room.pin(byId(a.room, sent[10].messageId), true), (error) => error.code === "chat_pin_limit" && /up to 10/.test(error.message));
  // Anyone unpins; the slot is free.
  await a.room.pin(byId(a.room, sent[0].messageId), false);
  await a.room.pin(byId(a.room, sent[10].messageId), true);
  await syncAll();
  assert.equal(pins().length, 10);
  // Deleting a pinned message for everyone unpins it.
  await a.room.remove(byId(a.room, sent[1].messageId));
  await syncAll();
  assert.equal(pins().some((pin) => pin.messageId === sent[1].messageId), false);
  assert.equal(c.room.page({ includePins: true }).pins.length, 9, "and it syncs");
  assert.equal(a.room.page().total, before + 0, "no new messages");
});

test("members put messages on the To talk about list, resolve and clear them, and read-only members can't (#312)", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), c = await openRoom(laptop, s);
  const syncAll = async () => { for (const { room } of [a, c, a, c]) await room.sync({ status: STATUS, devices }); };
  await syncAll();
  const holiday = await a.room.send("Holiday plans");
  const bins = await a.room.send("Who does the bins?");
  await syncAll();
  const byId = (room, id) => room.page().messages.find((message) => message.messageId === id);
  const topics = ({ room }) => room.page({ includeTopics: true }).topics.map((topic) => [topic.messageId, topic.state, topic.flaggedBy]);
  await c.room.setTopic(byId(c.room, holiday.messageId), "open");
  await syncAll();
  await a.room.setTopic(byId(a.room, bins.messageId), "open");
  await syncAll();
  assert.deepEqual(topics(a), [[bins.messageId, "open", s.admin.memberId], [holiday.messageId, "open", s.partner.memberId]]);
  const { quote } = a.room.page({ includeTopics: true }).topics[1];
  assert.deepEqual([quote.messageId, quote.state, quote.authorId], [holiday.messageId, "live", s.admin.memberId]);
  assert.deepEqual(a.room.page().topics, [], "only when asked for");
  // Resolved by someone else, it keeps who flagged it and moves to the top.
  await a.room.setTopic(byId(a.room, holiday.messageId), "resolved");
  await syncAll();
  assert.deepEqual(topics(c)[0], [holiday.messageId, "resolved", s.partner.memberId]);
  await c.room.setTopic(byId(c.room, bins.messageId), "cleared");
  // Deleting a message for everyone drops its topic.
  await a.room.remove(byId(a.room, holiday.messageId));
  await syncAll();
  assert.deepEqual(topics(c), []);
  // A member who can only read may not set one, and nothing is sent.
  const executed = c.engine.calls.execute;
  c.room.access = "read";
  await assert.rejects(() => c.room.setTopic(byId(c.room, bins.messageId), "open"), (error) => error.code === "chat_read_only");
  assert.equal(c.engine.calls.execute, executed);
});

test("members ask a poll, vote and change their vote, the author closes it, and deleting it deletes everything (#135)", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), c = await openRoom(laptop, s);
  const syncAll = async () => { for (const { room } of [a, c, a, c]) await room.sync({ status: STATUS, devices }); };
  await syncAll();
  // Bad polls never leave the device.
  for (const bad of [
    { question: "", options: ["a", "b"] },
    { question: "Pizza?", options: ["only one"] },
    { question: "Pizza?", options: ["a", "A"] },
    { question: "Pizza?", options: ["a", ""] },
    { question: "Pizza?", options: Array.from({ length: 11 }, (_, n) => `option ${n}`) },
  ]) await assert.rejects(a.room.sendPoll(bad), (error) => error.code === "chat_poll_invalid");
  const poll = await a.room.sendPoll({ question: "Pizza or tacos?", options: ["Pizza", "Tacos", "Soup"], multiple: true });
  await syncAll();
  const byId = (room) => room.page().messages.find((message) => message.messageId === poll.messageId);
  assert.equal(byId(c.room).contentKind, "poll");
  assert.deepEqual(await c.room.openPoll(byId(c.room)), { question: "Pizza or tacos?", options: ["Pizza", "Tacos", "Soup"] }, "another device opens the question and options");
  assert.deepEqual(byId(c.room).poll, { options: 3, multiple: true, closed: false, votes: [] });
  await c.room.vote(byId(c.room), [0, 2]);
  await syncAll();
  await a.room.vote(byId(a.room), [1]);
  await syncAll();
  const votes = () => Object.fromEntries(byId(a.room).poll.votes.map((vote) => [vote.memberId, vote.choice]));
  assert.deepEqual(votes(), { [s.admin.memberId]: [1], [s.partner.memberId]: [0, 2] }, "who voted for what");
  await c.room.vote(byId(c.room), [2]);
  await syncAll();
  assert.deepEqual(votes()[s.partner.memberId], [2], "a later vote replaces the earlier one");
  await c.room.vote(byId(c.room), []);
  await syncAll();
  assert.equal(votes()[s.partner.memberId], undefined, "and may be cleared");
  // Only the author closes; a vote after that doesn't count.
  await c.room.closePoll(byId(c.room));
  await syncAll();
  assert.equal(byId(a.room).poll.closed, false, "someone else can't close it");
  await a.room.closePoll(byId(a.room));
  await syncAll();
  await c.room.vote(byId(c.room), [0]);
  await syncAll();
  assert.equal(byId(c.room).poll.closed, true);
  assert.deepEqual(votes(), { [s.admin.memberId]: [1] }, "no vote counts after it closes");
  // Deleting the poll for everyone removes the question, options and votes.
  await a.room.remove(byId(a.room));
  await syncAll();
  assert.equal(byId(c.room).status, "deleted");
  assert.equal(byId(c.room).poll, null);
  await assert.rejects(c.room.openPoll(byId(c.room)), (error) => error.code === "chat_poll_invalid");
});

test("rooms report who is online while Kin is visible, and go away when hidden or closed (#128)", { timeout: 60_000 }, async (t) => {
  const listeners = new Map();
  const doc = {
    visibilityState: "visible",
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== fn)),
  };
  const fire = (type) => (listeners.get(type) ?? []).forEach((fn) => fn());
  const hadDocument = Object.hasOwn(globalThis, "document");
  const previous = globalThis.document;
  globalThis.document = doc;
  t.after(() => { if (hadDocument) globalThis.document = previous; else delete globalThis.document; });
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), c = await openRoom(laptop, s);
  t.after(() => { a.room.close(); c.room.close(); });
  await a.room.sync({ status: STATUS, devices });
  await c.room.sync({ status: STATUS, devices });
  // A loopback live channel between the two rooms.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const link = (from, to) => from.room.setLiveSender((bytes, kind) => {
    void (kind === "presence" ? to.room.receivePresence(bytes) : to.room.receiveTyping(bytes));
    return true;
  });
  link(a, c);
  await settle();
  assert.deepEqual(c.room.presence.online(), [s.admin.memberId], "c hears a's hello");
  assert.deepEqual(a.room.presence.online(), [], "a has not heard from c yet");
  link(c, a);
  c.room.liveUp();
  await settle();
  assert.deepEqual(a.room.presence.online(), [s.partner.memberId], "c said hello when its channel came up");
  // Hidden: away at once.
  doc.visibilityState = "hidden";
  fire("visibilitychange");
  await settle();
  assert.deepEqual(c.room.presence.online(), [], "hidden counts as away");
  doc.visibilityState = "visible";
  fire("visibilitychange");
  await settle();
  assert.deepEqual(c.room.presence.online(), [s.admin.memberId]);
  // Locking closes the room: no more heartbeats (the "away" frame is best
  // effort, since the keys go with the room; the others' view runs out in 70 s).
  c.room.close();
  assert.equal(c.room.presence.active, false);
  assert.equal(c.room.presence.beatTimer, null);
  a.room.close();
});

test("an export carries the chat to a device that has none, which then merges with the relay (#136)", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s);
  const dinner = await a.room.send("Dinner at 6 🍝");
  const bread = await a.room.send("Bring bread");
  const secret = await a.room.send("Oops, wrong chat");
  await a.room.sync({ status: STATUS, devices });
  await a.room.remove(a.room.page().messages.find((message) => message.messageId === secret.messageId));
  await a.room.hide(a.room.page().messages.find((message) => message.messageId === bread.messageId));
  await a.room.sync({ status: STATUS, devices });

  // The plan: every event, but only the content of messages that still exist.
  const plan = await a.room.chatExportPlan();
  assert.equal(plan.events, 4, "three posts and a deletion");
  assert.equal(plan.blobs.length, 2, "the deleted message's content is not part of it");
  const posted = a.room.page().messages;
  const kept = new Set(posted.filter((message) => message.status === "live").map((message) => message.blobRef));
  assert.deepEqual(new Set(plan.blobs.map((blob) => blob.ref)), kept);
  assert.deepEqual(plan.notes.hidden, [bread.messageId]);
  assert.equal(plan.notes.memberId, s.admin.memberId);

  // Write and read the archive (the engine's container framing is a stand-in).
  const stub = {
    archiveHeader: (metadataLength, region) => {
      const header = new Uint8Array(16), view = new DataView(header.buffer);
      view.setUint32(0, metadataLength, true); view.setUint32(4, region, true);
      return header;
    },
  };
  const archiveKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const prefix = new Uint8Array(8).fill(5);
  const choice = chooseChatBlobs(plan.blobs, 10 * 1024 * 1024);
  const bytes = await writeArchive({
    engine: stub, metadata: new TextEncoder().encode("meta"), key: archiveKey, noncePrefix: prefix, vaultId: "ab".repeat(16),
    context: { key: "installation" }, attachments: [], view: { length: 0 },
    chat: { notes: plan.notes, view: chatEventsView(plan.view), blobs: choice.chosen, loadBlob: plan.loadBlob, blobSegmentLength, blobSegment },
    check: async () => {},
  });
  const view = new DataView(bytes.buffer);
  const section = openChatSection();
  await readArchive({
    bytes, offset: 16 + view.getUint32(0, true), length: view.getUint32(4, true), key: archiveKey, noncePrefix: prefix, vaultId: "ab".repeat(16),
    attachmentCount: 0, eventCount: 0, chatPresent: true, chatEventCount: plan.events, chatBlobCount: choice.chosen.length,
    onContext() {}, onAttachment() {}, onEvents() {},
    onChatNotes: (value) => { section.notes = value; },
    onChatEvents: (sequences, records) => appendChatEvents(section, sequences, records),
    onChatBlob: (blob) => appendChatBlob(section, blob),
    check: async () => {},
  });
  await validateChatSection(section, { engine: fakeEngine(), counts: { eventCount: plan.events, blobCount: choice.chosen.length }, householdId: s.householdId, memberId: s.admin.memberId });

  // A device with no chat at all (a new browser): the vault seals what is imported.
  const vault = {
    assertUnlocked() {},
    seal: async (value) => ({ sealed: Array.from(value) }),
    open: async (envelope) => Uint8Array.from(envelope.sealed),
  };
  const fresh = { ...phone, indexedDB: fakeIndexedDB(), keyStore: { ...phone.keyStore, vault } };
  const imported = await importChatSection(section, { householdId: s.householdId, vault, hidden: section.notes.hidden, indexedDB: fresh.indexedDB, keyRange: fakeKeyRange });
  assert.deepEqual(imported, { events: 4, blobs: 2 });

  const b = await openRoom(fresh, s);
  await b.room.refresh();
  assert.equal(b.room.records.length, 4, "read from the archive alone, with no relay and no chat key");
  assert.equal(b.room.isHidden(bread.messageId), true, "the member's deleted-for-me list came back");
  const shown = b.room.page().messages;
  assert.deepEqual(shown.map((message) => message.status), ["live", "live", "deleted"], "the deleted message is a placeholder");
  const opened = await b.room.loadTexts(shown.filter((message) => message.status === "live"));
  assert.deepEqual([...opened.values()].map((result) => result.text), ["Dinner at 6 🍝", "Bring bread"], "the content opens from the imported blobs");
  assert.equal(shown[2].blobRef && await b.blobs.store.get(shown[2].blobRef), null, "nothing of the deleted message's content came back");

  // Sealed under a root this device no longer has (the recovery key was
  // replaced): the room opens without those events instead of stopping.
  const rotated = { ...vault, open: async () => { throw Object.assign(new Error("Kin could not verify the protected store."), { code: "protected_store_corrupt" }); } };
  const lost = await openRoom({ ...fresh, keyStore: { ...phone.keyStore, vault: rotated } }, s);
  await lost.room.refresh();
  assert.equal(lost.room.unreadableImports, 4);
  assert.equal(lost.room.records.length, 0);
  lost.room.close();

  // The household moved on after the export; syncing brings it here and stores nothing twice.
  await a.room.remove(a.room.page().messages.find((message) => message.messageId === dinner.messageId));
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  assert.equal(b.room.records.length, 6 - 1, "the relay's four earlier events were not stored again, only the new deletion");
  assert.deepEqual(b.room.page().messages.map((message) => message.status), ["deleted", "live", "deleted"], "a deletion made after the export removes that content too");
  assert.equal(await b.blobs.store.get(dinner.blobRef ?? shown[0].blobRef), null);

});

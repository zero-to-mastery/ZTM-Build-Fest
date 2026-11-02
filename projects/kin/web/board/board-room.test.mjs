// The fridge's transport (#317): drawing offline, the board relay stream
// against the real service, authentication of what arrives, sequence
// recovery and the decrypted log the engine replays. A small JavaScript
// stand-in plays the engine (JSON "canonical events") so these run without
// the WASM build; rust/src/board_tests.rs covers the real board rules.
import assert from "node:assert/strict";
import test from "node:test";
import { createKinServer } from "../../server/server.mjs";
import { deviceKeyFingerprint, encryptEvent, exportDevicePublicKeys, generateDeviceKeys, generateHouseholdKey } from "../sync/crypto.js";
import { encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../sync/envelope-wire.js";
import { fakeIndexedDB, fakeKeyRange } from "../chat/fake-indexeddb.test-support.mjs";
import { BOARD_COMMANDS, BOARD_EVENT_KINDS } from "../wasm/kin-board.js";
import { BoardLogStore, boardLogDatabaseName } from "./board-log-store.js";
import { BoardRoom, newBoardId } from "./board-room.js";
import { appendBoardEvents, importBoardSection, openBoardSection, validateBoardSection } from "./board-archive.js";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));

/** The engine calls the room makes. Board rules are Rust's; this stand-in
 * only keeps strokes and erasures so the transport can be checked. */
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
  return {
    eventMetadata: metadata,
    eventMetadataBatch: (records) => records.map(metadata),
    executeBoardCommand(command, identity, source) {
      assert.equal(typeof source.copyRecordsTo, "function", "the board log goes to the engine as a view");
      const kind = BOARD_EVENT_KINDS[BOARD_COMMANDS.indexOf(command.type)];
      if (!kind) throw Object.assign(new Error("Kin received an invalid fridge change."), { code: 2 });
      const event = { ...identity, logicalTime: String(identity.logicalTime), kind, command };
      const encodedEvent = encoder.encode(JSON.stringify(event));
      return { encodedEvent, metadata: metadata(encodedEvent) };
    },
    boardState(source) {
      const events = Array.from({ length: source.length }, (_, index) => decode(source.record(index)))
        .sort((left, right) => Number(BigInt(left.logicalTime) - BigInt(right.logicalTime)) || (left.eventId < right.eventId ? -1 : 1));
      const strokes = new Map();
      for (const { command, actorId } of events) {
        if (command.type === "add-stroke" && !strokes.has(command.strokeId)) strokes.set(command.strokeId, { id: command.strokeId, author: actorId, hidden: false });
        if (command.type === "hide-stroke" && strokes.has(command.strokeId)) strokes.get(command.strokeId).hidden = command.hidden;
      }
      return { strokes: [...strokes.values()].filter((stroke) => !stroke.hidden), magnets: [], openClear: null };
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
  const claim = app.service.claimPairing({ code: invitation.code, credential: { id: "partner", publicKey: "key-partner", algorithm: -7 }, deviceLabel: "Tablet" });
  app.service.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
  const partner = app.service.activateClaim(claim.claimToken);
  app.syncService.enable(admin.sessionToken);
  return { app, base, admin, partner, householdId: admin.householdId };
}

function requester(base, who) {
  const cookie = `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}`;
  const call = async (path, { binary = false, ...options } = {}) => {
    if (call.offline) throw Object.assign(new Error("Household sync could not be reached."), { code: "connection_unavailable" });
    call.paths.push(`${options.method ?? "GET"} ${path.split("?")[0]}`);
    const response = await fetch(base + path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}), cookie } });
    if (binary && response.ok) return new Uint8Array(await response.arrayBuffer());
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.message), { code: value.error });
    return value;
  };
  call.paths = [];
  call.offline = false;
  return call;
}

async function device(who, { householdId, epochs }) {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  const fingerprint = await deviceKeyFingerprint(publicKeys);
  return {
    who,
    deviceKeys: { keys, fingerprint },
    entry: { deviceId: who.deviceId, memberId: who.memberId, publicKeys, fingerprint, verifiedKeyHistory: [{ publicKeys }], historyFromEpoch: 1, memberActive: true },
    keyStore: {
      vault: { assertUnlocked() {} },
      getEpoch: async (household, keyEpoch) => household === householdId && epochs.has(keyEpoch) ? { keyEpoch, householdKey: epochs.get(keyEpoch) } : null,
      listEpochs: async (household) => household === householdId ? [...epochs].map(([keyEpoch, householdKey]) => ({ keyEpoch, householdKey })) : [],
    },
    indexedDB: fakeIndexedDB(),
  };
}

async function openRoom(phone, { base, householdId, request = requester(base, phone.who), engine = fakeEngine() } = {}) {
  const room = await BoardRoom.open({
    identity: { householdId, memberId: phone.who.memberId, deviceId: phone.who.deviceId },
    keyStore: phone.keyStore, deviceKeys: phone.deviceKeys, engine, request,
    indexedDB: phone.indexedDB, keyRange: fakeKeyRange,
  });
  return { room, request };
}

const STATUS = { currentEpoch: 1, rotationPending: false };
const stroke = () => ({ type: "add-stroke", strokeId: newBoardId(), colour: 0, width: 1, points: [[10, 10], [20, 20]] });

test("a stroke drawn offline shows at once, then reaches the other device through the board relay", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const tablet = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, tablet.entry];
  const a = await openRoom(phone, s), b = await openRoom(tablet, s);
  let changes = 0;
  a.room.subscribe(() => { changes += 1; });

  a.request.offline = true;
  const first = stroke(), second = stroke();
  await a.room.change(first);
  await a.room.change(second);
  assert.deepEqual(a.room.board().strokes.map((entry) => entry.id), [first.strokeId, second.strokeId], "the drawer sees it at once");
  assert.ok(a.room.waiting, "shown as waiting to send");
  assert.ok(changes >= 2);
  await assert.rejects(a.room.sync({ status: STATUS, devices }), (error) => error.code === "connection_unavailable");

  a.request.offline = false;
  assert.deepEqual(await a.room.sync({ status: STATUS, devices }), { hasMore: false });
  assert.equal(a.room.waiting, false, "sent");
  assert.ok(a.request.paths.includes("GET /api/board/status"), "a new log asks the relay where it stands");
  assert.ok(a.request.paths.includes("POST /api/board/events"));

  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual(b.room.board().strokes.map((entry) => [entry.id, entry.author]), [[first.strokeId, s.admin.memberId], [second.strokeId, s.admin.memberId]]);
  // Erasing from the other device converges both ways.
  await b.room.change({ type: "hide-stroke", strokeId: first.strokeId, hidden: true });
  await b.room.sync({ status: STATUS, devices });
  await a.room.sync({ status: STATUS, devices });
  assert.deepEqual(a.room.board().strokes.map((entry) => entry.id), [second.strokeId]);
  assert.equal(a.room.records.length, 3, "its own events coming back are not stored twice");

  // Neither the household relay nor chat carried any of it.
  assert.equal(s.app.syncService.pull(s.admin.sessionToken, "", "20").events.length, 0);
  assert.equal(s.app.chatRelayService.pull(s.app.syncService.authorize(s.admin.sessionToken), "", "20").events.length, 0);

  // Reopened (after a lock), the log decrypts from storage alone.
  b.room.close();
  assert.equal(b.room.records.length, 0, "locking drops the decrypted log");
  const reopened = await openRoom(tablet, s);
  assert.deepEqual(reopened.room.board().strokes.map((entry) => entry.id), [second.strokeId]);
  await assert.rejects(b.room.change(stroke()), (error) => error.code === "board_locked");
});

test("only authenticated board events are stored; one that can never pass is skipped", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const tablet = await device(s.partner, { householdId: s.householdId, epochs });
  const a = await openRoom(phone, s);
  await a.room.change(stroke());
  await a.room.sync({ status: STATUS, devices: [phone.entry, tablet.entry] });

  // A device this one doesn't know yet pauses the fridge: nothing is read past.
  const b = await openRoom(tablet, s);
  await assert.rejects(b.room.sync({ status: STATUS, devices: [tablet.entry] }), (error) => error.code === "board_device_unknown");
  assert.equal(b.room.records.length, 0);

  // A chat kind sent into the board stream by the admin's device is refused
  // for good and skipped; the stroke after it still arrives.
  const chatLike = { eventId: "cc".repeat(16), householdId: s.householdId, actorId: s.admin.memberId, deviceId: s.admin.deviceId, timestamp: Date.now(), logicalTime: "5", kind: "CHAT_MESSAGE_POSTED", command: {} };
  const envelope = await encryptEvent({
    eventId: chatLike.eventId, householdId: s.householdId, deviceId: s.admin.deviceId, deviceSequence: 2, logicalTime: "5", keyEpoch: 1,
    plaintext: encoder.encode(JSON.stringify(chatLike)), householdKey: epochs.get(1), signingKey: phone.deviceKeys.keys.signingPrivateKey,
  });
  const pushed = await requester(s.base, s.admin)("/api/board/events", { method: "POST", body: encodeEnvelopeBatch([envelope]), headers: { "Content-Type": ENVELOPE_CONTENT_TYPE } });
  assert.equal(pushed.accepted, 1, "the service can't tell; the device must");
  await b.room.sync({ status: STATUS, devices: [phone.entry, tablet.entry] });
  assert.equal(b.room.records.length, 1, "the real stroke is stored, the chat kind is not");
  assert.deepEqual(b.room.refused.map((entry) => entry.code), ["board_event_refused"]);
});

test("a device whose log was lost picks up its board sequence from the relay", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const devices = [phone.entry];
  const a = await openRoom(phone, s);
  await a.room.change(stroke());
  await a.room.sync({ status: STATUS, devices });
  a.room.close();
  // The browser lost the board database; a fresh one starts provisional.
  phone.indexedDB = fakeIndexedDB();
  const again = await openRoom(phone, s);
  again.request.offline = true;
  await again.room.change(stroke());
  again.request.offline = false;
  await again.room.sync({ status: STATUS, devices });
  assert.equal(again.room.waiting, false, "renumbered after the relay's count and sent");
  assert.equal(s.app.boardRelayService.status(s.app.syncService.authorize(s.admin.sessionToken)).deviceSequence, 2);
  assert.equal(again.room.board().strokes.length, 2, "and it reads back the stroke it drew before");
});

test("leaving the household deletes the fridge log", async () => {
  const indexedDB = fakeIndexedDB();
  const householdId = "ab".repeat(16);
  const store = await BoardLogStore.open(householdId, { indexedDB, keyRange: fakeKeyRange });
  store.close();
  await BoardLogStore.remove(householdId, { indexedDB });
  assert.equal(boardLogDatabaseName(householdId), `kin-board-log:${householdId}`);
});

test("look only keeps the fridge readable without drawing; no access stops it (#323)", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const tablet = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, tablet.entry];
  const a = await openRoom(phone, s), b = await openRoom(tablet, s);
  await a.room.change(stroke());
  await a.room.sync({ status: STATUS, devices });

  let notified = 0;
  b.room.subscribe(() => { notified += 1; });
  await b.room.sync({ status: { ...STATUS, board: { access: "read" } }, devices });
  assert.equal(b.room.access, "read");
  assert.ok(notified > 0, "the view hears about the change");
  assert.equal(b.room.board().strokes.length, 1, "still reads the fridge");
  await assert.rejects(b.room.change(stroke()), (error) => error.code === "board_read_only");

  b.request.paths.length = 0;
  await b.room.sync({ status: { ...STATUS, board: { access: "none" } }, devices });
  assert.equal(b.room.access, "none");
  assert.deepEqual(b.request.paths, [], "nothing is fetched or sent");
  await b.room.sync({ status: { ...STATUS, board: { access: "write" } }, devices });
  await b.room.change(stroke());
  assert.equal(b.room.board().strokes.length, 2, "drawing again once allowed");
});

test("a fridge restored from an export reads back sealed by the vault, then the relay's copy takes over (#363)", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const devices = [phone.entry];
  const a = await openRoom(phone, s);
  const first = stroke(), second = stroke();
  await a.room.change(first);
  await a.room.change(second);
  await a.room.sync({ status: STATUS, devices });
  const plan = await a.room.exportPlan();
  assert.equal(plan.view.length, 2);

  // The section as an archive read hands it over.
  const section = openBoardSection();
  appendBoardEvents(section, [1, 2], [plan.view.record(0), plan.view.record(1)]);
  assert.throws(() => validateBoardSection(section, { engine: fakeEngine(), eventCount: 2, householdId: "ab".repeat(16) }), /damaged/);
  assert.deepEqual(validateBoardSection(section, { engine: fakeEngine(), eventCount: 2, householdId: s.householdId }), { eventCount: 2 });
  assert.equal(section.eventIds.length, 2, "a refused check leaves nothing half-done");

  // A fresh device of the same member: no log yet, a vault that seals.
  const sealed = new Map();
  const vault = {
    assertUnlocked() {},
    async seal(bytes, { store, id }) { assert.equal(store, "board-import"); const copy = bytes.slice(); sealed.set(id, copy); return { id, length: copy.length }; },
    async open(value, { store, id }) { assert.equal(store, "board-import"); assert.equal(value.id, id); return sealed.get(id).slice(); },
  };
  const fresh = { ...phone, indexedDB: fakeIndexedDB(), keyStore: { ...phone.keyStore, vault } };
  assert.deepEqual(await importBoardSection(section, { householdId: s.householdId, vault, indexedDB: fresh.indexedDB, keyRange: fakeKeyRange }), { events: 2 });
  assert.deepEqual(await importBoardSection(section, { householdId: s.householdId, vault, indexedDB: fresh.indexedDB, keyRange: fakeKeyRange }), { events: 0 }, "restoring twice adds nothing");
  const b = await openRoom(fresh, s);
  assert.deepEqual(b.room.board().strokes.map((entry) => entry.id), [first.strokeId, second.strokeId], "readable before any sync");

  // The relay's signed copies replace the imported rows, without duplicates.
  await b.room.sync({ status: STATUS, devices });
  assert.equal(b.room.records.length, 2);
  const store = await BoardLogStore.open(s.householdId, { indexedDB: fresh.indexedDB, keyRange: fakeKeyRange });
  const rows = await store.eventsFrom(1);
  store.close();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.envelope && !row.imported), "each row now holds the relay's envelope");
});

test("the relay's copy of a restored event is authenticated and must match it (#363)", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const devices = [phone.entry];
  const a = await openRoom(phone, s);
  const original = stroke();
  await a.room.change(original);
  const plan = await a.room.exportPlan();
  const eventId = [...a.room.indexById.keys()][0];
  // The export holds a different event under the same ID than the one the
  // relay will serve (a relay or writer substituting content).
  const forged = JSON.parse(new TextDecoder().decode(plan.view.record(0)));
  forged.command = { ...forged.command, points: [[900, 900], [950, 950]] };
  const section = openBoardSection();
  appendBoardEvents(section, [1], [new TextEncoder().encode(JSON.stringify(forged))]);
  validateBoardSection(section, { engine: fakeEngine(), eventCount: 1, householdId: s.householdId });
  assert.deepEqual(section.eventIds, [eventId]);
  await a.room.sync({ status: STATUS, devices });

  const sealed = new Map();
  const vault = {
    assertUnlocked() {},
    async seal(bytes, { id }) { sealed.set(id, bytes.slice()); return { id }; },
    async open(value, { id }) { return sealed.get(id).slice(); },
  };
  const fresh = { ...phone, indexedDB: fakeIndexedDB(), keyStore: { ...phone.keyStore, vault } };
  await importBoardSection(section, { householdId: s.householdId, vault, indexedDB: fresh.indexedDB, keyRange: fakeKeyRange });
  const b = await openRoom(fresh, s);
  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual(b.room.refused.map((entry) => [entry.eventId, entry.code]), [[eventId, "board_event_refused"]], "the mismatch is refused");
  const store = await BoardLogStore.open(s.householdId, { indexedDB: fresh.indexedDB, keyRange: fakeKeyRange });
  const rows = await store.eventsFrom(1);
  store.close();
  assert.ok(rows[0].imported && !rows[0].envelope, "the restored copy is kept, not overwritten");
});

test("the member's fridge access is remembered for the next unlock (#323)", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const tablet = await device(s.partner, { householdId: s.householdId, epochs });
  const b = await openRoom(tablet, s);
  await b.room.sync({ status: { ...STATUS, board: { access: "read" } }, devices: [tablet.entry] });
  b.room.close();
  const again = await openRoom(tablet, s);
  assert.equal(again.room.access, "read", "starts look only, before any sync");
  await assert.rejects(again.room.change(stroke()), (error) => error.code === "board_read_only");
});

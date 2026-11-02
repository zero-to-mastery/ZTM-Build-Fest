// A member's private log on the device (#492, ADR 0019): offline writes,
// the private relay stream against the real service, authentication of what
// arrives, member-key rotation after a revocation, and the coordinator's
// private pass. A small JavaScript stand-in plays the engine (JSON
// "canonical events") so these run without the WASM build;
// rust/src/private_tests.rs covers the real records and replay. The vault
// key is a test double for the #557 integration point.
import assert from "node:assert/strict";
import test from "node:test";
import { createKinServer } from "../../server/server.mjs";
import { deviceKeyFingerprint, exportDevicePublicKeys, generateDeviceKeys } from "../sync/crypto.js";
import { SyncCoordinator } from "../sync/sync-coordinator.js";
import { fakeIndexedDB, fakeKeyRange } from "../chat/fake-indexeddb.test-support.mjs";
import { generateVaultKey, openVault, sealVault } from "../security/account-vault.js";
import { MemberKeyRing } from "./member-key.js";
import { encryptPrivateEvent } from "./private-envelope.js";
import { PrivateLog, newPrivateId } from "./private-log.js";
import { PrivateLogStore, privateLogDatabaseName } from "./private-log-store.js";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));

/** The engine calls the log makes, over JSON events. */
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
    // A private command (#511) as JSON: "refuse" is refused like code 4.
    commands: [],
    executePrivateCommand(command, identity, source) {
      assert.equal(typeof source.copyRecordsTo, "function", "commands see the log as a view");
      this.commands.push({ command, identity, records: source.length });
      if (command.type === "refuse") throw Object.assign(new Error("It changed meanwhile."), { code: 4 });
      const encodedEvent = encoder.encode(JSON.stringify({
        kind: "PRIVATE_ITEM_ADDED", eventId: identity.eventId, householdId: identity.householdId, actorId: identity.actorId,
        deviceId: identity.deviceId, timestamp: identity.timestamp, logicalTime: String(identity.logicalTime), noteId: command.itemId, text: command.text,
      }));
      return { encodedEvent, metadata: metadata(encodedEvent) };
    },
    privateState(source) {
      assert.equal(typeof source.copyRecordsTo, "function", "the private log goes to the engine as a view");
      const events = Array.from({ length: source.length }, (_, index) => decode(source.record(index)))
        .sort((left, right) => Number(BigInt(left.logicalTime) - BigInt(right.logicalTime)) || (left.eventId < right.eventId ? -1 : 1));
      const notes = new Map();
      for (const event of events) if (event.text) notes.set(event.noteId, event.text); else notes.delete(event.noteId);
      return { memberId: events[0]?.actorId ?? null, recordCount: events.length, notes: [...notes].map(([id, text]) => ({ id, text })) };
    },
  };
}

/** A private note as the engine would make it for this device. */
function note(log, text, { noteId = newPrivateId(), kind = "PRIVATE_NOTE_SET", actorId = log.identity.memberId } = {}) {
  return encoder.encode(JSON.stringify({
    kind, eventId: newPrivateId(), householdId: log.identity.householdId, actorId, deviceId: log.identity.deviceId,
    timestamp: 1_791_475_200_000, logicalTime: String(log.nextLogicalTime()), noteId, text,
  }));
}

/** Each member's account vault, as the vault routes keep it. */
function vaults() {
  const byMember = new Map();
  return {
    byMember,
    async seed(householdId, memberId) {
      const vaultKey = generateVaultKey();
      byMember.set(memberId, { vaultKey, vault: { version: 1, ciphertext: await sealVault(vaultKey, { epochs: [] }, { householdId, memberId, version: 1 }) } });
      return vaultKey;
    },
    api(memberId) {
      return {
        async download() { const entry = byMember.get(memberId); return { vault: entry?.vault && { ...entry.vault, ciphertext: entry.vault.ciphertext.slice() }, wrappers: [] }; },
        async upload({ expectedVersion, ciphertext }) {
          const entry = byMember.get(memberId);
          if (entry.vault.version !== expectedVersion) throw Object.assign(new Error("conflict"), { code: "vault_version_conflict" });
          entry.vault = { version: expectedVersion + 1, ciphertext: ciphertext.slice() };
          return { version: entry.vault.version };
        },
      };
    },
  };
}

async function service(t) {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
  const admin = app.service.bootstrap({ credential: credential("admin") });
  const admit = (sessionToken, options, label) => {
    const invitation = options ? app.service.createPairing(sessionToken, options) : app.service.createDevicePairing(sessionToken);
    const claim = app.service.claimPairing({ code: invitation.code, credential: credential(`${label}-${Math.random()}`), deviceLabel: label });
    app.service.approvePairing(sessionToken, invitation.pairingId, claim.version);
    return app.service.activateClaim(claim.claimToken);
  };
  const phone = admit(admin.sessionToken, { kind: "adult" }, "Phone");
  const laptop = admit(phone.sessionToken, null, "Laptop");
  const tablet = admit(phone.sessionToken, null, "Tablet");
  app.syncService.enable(admin.sessionToken);
  return { app, base, admin, phone, laptop, tablet, householdId: admin.householdId };
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

async function device(who) {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  const fingerprint = await deviceKeyFingerprint(publicKeys);
  return {
    who, deviceKeys: { keys: { signingPrivateKey: keys.signingPrivateKey }, fingerprint },
    entry: { deviceId: who.deviceId, memberId: who.memberId, publicKeys, fingerprint, verifiedKeyHistory: [{ publicKeys }], revokedAt: null },
    indexedDB: fakeIndexedDB(),
  };
}

async function openLog(phone, { base, householdId, store, request = requester(base, phone.who), held = () => true }) {
  const entry = () => store.byMember.get(phone.who.memberId);
  const keyRing = new MemberKeyRing({ api: store.api(phone.who.memberId), householdId, memberId: phone.who.memberId,
    vaultKey: async () => (held() && entry() ? entry().vaultKey.slice() : null) });
  const log = await PrivateLog.open({
    identity: { householdId, memberId: phone.who.memberId, deviceId: phone.who.deviceId },
    deviceKeys: phone.deviceKeys, engine: fakeEngine(), request, keyRing,
    indexedDB: phone.indexedDB, keyRange: fakeKeyRange,
  });
  return { log, request };
}

const ON = { private: { access: "write" } };
const texts = (log) => log.projection().notes.map((entry) => entry.text).sort();

test("a private note written offline counts at once, then reaches the member's other device and no one else's", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const store = vaults();
  await store.seed(s.householdId, s.phone.memberId);
  await store.seed(s.householdId, s.admin.memberId);
  const phone = await device(s.phone), laptop = await device(s.laptop), admin = await device(s.admin);
  const devices = [phone.entry, laptop.entry, admin.entry];
  const a = await openLog(phone, { ...s, store });
  assert.equal(a.log.reason, "no_member_key", "no member key until something private is used");
  assert.equal(await a.log.enable(), "ready");
  assert.equal(a.log.active, true);

  a.request.offline = true;
  await a.log.append(note(a.log, "Call Mum"));
  await a.log.append(note(a.log, "Book the dentist"));
  assert.deepEqual(texts(a.log), ["Book the dentist", "Call Mum"], "it counts at once");
  assert.ok(a.log.waiting);
  await assert.rejects(a.log.sync({ status: ON, devices }), (error) => error.code === "connection_unavailable");

  a.request.offline = false;
  assert.deepEqual(await a.log.sync({ status: ON, devices }), { hasMore: false });
  assert.equal(a.log.waiting, false);
  assert.ok(a.request.paths.includes("GET /api/private/status"), "a new log asks the relay where it stands");
  assert.ok(a.request.paths.includes("POST /api/private/events"));

  // The laptop opens the same member key from the vault and reads them.
  const b = await openLog(laptop, { ...s, store });
  assert.equal(b.log.active, true);
  await b.log.sync({ status: ON, devices });
  assert.deepEqual(texts(b.log), ["Book the dentist", "Call Mum"]);
  // What is stored is ciphertext under the member key.
  const stored = await (await PrivateLogStore.open(s.householdId, s.laptop.memberId, { indexedDB: laptop.indexedDB, keyRange: fakeKeyRange })).eventsFrom(1);
  assert.equal(stored.length, 2);
  assert.ok(stored.every((row) => row.envelope.keyEpoch === 1 && !decoder.decode(Uint8Array.from(atob(row.envelope.ciphertext.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))).includes("Call Mum")));
  assert.equal(privateLogDatabaseName(s.householdId, s.laptop.memberId), `kin-private-log:${s.householdId}:${s.laptop.memberId}`);

  // The admin's device reaches only the admin's own stream: nothing of Sam's.
  const c = await openLog(admin, { ...s, store });
  await c.log.enable();
  await c.log.sync({ status: ON, devices });
  assert.deepEqual(texts(c.log), []);

  // Locking drops the decrypted log and the member key.
  b.log.close();
  assert.equal(b.log.ring.available, false);
  assert.throws(() => b.log.projection(), (error) => error.code === "private_locked");
});

test("execute makes a private change through the engine with the next logical time, offline, and stores nothing it refuses", { timeout: 30_000 }, async () => {
  const householdId = newPrivateId(), memberId = newPrivateId(), deviceId = newPrivateId();
  const store = vaults();
  await store.seed(householdId, memberId);
  const phone = await device({ memberId, deviceId });
  const request = Object.assign(async () => { throw Object.assign(new Error("offline"), { code: "connection_unavailable" }); }, { paths: [] });
  const { log } = await openLog(phone, { householdId, store, request });
  await log.enable();
  const changed = [];
  log.onLocalChange = () => changed.push(true);
  const itemId = newPrivateId();
  const eventId = await log.execute({ type: "add-private-item", itemId, text: "Dentist" });
  assert.match(eventId, /^[a-f0-9]{32}$/);
  const [first] = log.engine.commands;
  assert.equal(first.identity.logicalTime, 1n);
  assert.equal(first.identity.actorId, memberId);
  assert.equal(first.identity.deviceId, deviceId);
  assert.equal(first.records, 0);
  assert.deepEqual(texts(log), ["Dentist"], "it counts at once");
  assert.ok(log.waiting, "and waits to send");
  await log.execute({ type: "add-private-item", itemId: newPrivateId(), text: "Gift" });
  assert.equal(log.engine.commands[1].identity.logicalTime, 2n);
  assert.equal(log.engine.commands[1].records, 1, "the engine sees what is already stored");
  await assert.rejects(log.execute({ type: "refuse" }), (error) => error.code === 4);
  assert.deepEqual(texts(log), ["Dentist", "Gift"], "a refusal stores nothing");
  assert.equal(changed.length, 2);
  log.close();
  await assert.rejects(log.execute({ type: "add-private-item", itemId, text: "x" }), (error) => error.code === "private_locked");
});

test("without the member key, or with private storage off, the pass does nothing", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const store = vaults();
  await store.seed(s.householdId, s.phone.memberId);
  const phone = await device(s.phone);
  const devices = [phone.entry];
  // No vault key on this device (the #557 integration point says null).
  const none = await openLog(phone, { ...s, store, held: () => false });
  assert.equal(none.log.reason, "no_vault_key");
  assert.deepEqual(await none.log.sync({ status: ON, devices }), { hasMore: false });
  assert.deepEqual(none.request.paths, [], "no request at all");
  await assert.rejects(none.log.append(note(none.log, "x")), (error) => error.code === "private_key_unavailable");
  none.log.close();

  const on = await openLog(phone, { ...s, store });
  await on.log.enable();
  on.request.paths.length = 0;
  // A Limited member whose household turned it off, or a Temporary member.
  assert.deepEqual(await on.log.sync({ status: { private: { access: "none" } }, devices }), { hasMore: false });
  assert.deepEqual(on.request.paths, []);
  assert.equal(on.log.reason, "off");
  await assert.rejects(on.log.append(note(on.log, "x")), (error) => error.code === "private_off");
  // Only private kinds, written as this member on this device, are stored.
  await on.log.sync({ status: ON, devices });
  await assert.rejects(on.log.append(note(on.log, "x", { kind: "ITEM_ADDED" })), (error) => error.code === "private_event_invalid");
  await assert.rejects(on.log.append(note(on.log, "x", { actorId: "f".repeat(32) })), (error) => error.code === "private_event_invalid");
});

test("revoking one of the member's devices starts a new key epoch; pending changes are resealed under it", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const store = vaults();
  await store.seed(s.householdId, s.phone.memberId);
  const phone = await device(s.phone), laptop = await device(s.laptop), tablet = await device(s.tablet);
  const a = await openLog(phone, { ...s, store });
  await a.log.enable();
  const c = await openLog(tablet, { ...s, store });
  const before = [phone.entry, laptop.entry, tablet.entry];
  await a.log.append(note(a.log, "before"));
  await a.log.sync({ status: ON, devices: before });
  await c.log.sync({ status: ON, devices: before });
  assert.deepEqual(texts(c.log), ["before"]);

  // Written while the laptop is still trusted, sent after it was revoked.
  a.request.offline = true;
  await a.log.append(note(a.log, "after"));
  a.request.offline = false;
  const { revokedAt } = s.app.service.revokeDevice(s.phone.sessionToken, s.laptop.deviceId, s.phone.memberId);
  const after = [phone.entry, { ...laptop.entry, revokedAt }, tablet.entry];
  await a.log.sync({ status: ON, devices: after });
  assert.equal(a.log.ring.current().epoch, 2, "the phone started epoch 2");
  const vault = await openVault(store.byMember.get(s.phone.memberId).vaultKey, store.byMember.get(s.phone.memberId).vault.ciphertext,
    { householdId: s.householdId, memberId: s.phone.memberId, version: store.byMember.get(s.phone.memberId).vault.version });
  assert.deepEqual(vault.memberKeys.map(({ epoch, revokedThrough }) => [epoch, revokedThrough]), [[1, 0], [2, revokedAt]]);
  const relayed = s.app.privateRelayService.pull({ member: { id: s.phone.memberId }, household: { id: s.householdId }, device: { id: s.tablet.deviceId } }, "", "20");
  assert.deepEqual(relayed.events.map((row) => row.envelope.keyEpoch), [1, 2], "the pending change went out under the new epoch");

  // The tablet sees the same revocation, adopts epoch 2 and reads everything.
  await c.log.sync({ status: ON, devices: after });
  assert.equal(c.log.ring.current().epoch, 2);
  assert.deepEqual(texts(c.log), ["after", "before"]);
  await c.log.append(note(c.log, "from the tablet"));
  await c.log.sync({ status: ON, devices: after });
  await a.log.sync({ status: ON, devices: after });
  assert.deepEqual(texts(a.log), ["after", "before", "from the tablet"]);
  // The revoked laptop can't reach the stream at all.
  await assert.rejects(requester(s.base, s.laptop)("/api/private/status"), (error) => error.code === "authentication_required");
});

test("a private change from someone else's device, or from a revoked device under a later epoch, is refused", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const store = vaults();
  await store.seed(s.householdId, s.phone.memberId);
  const phone = await device(s.phone), laptop = await device(s.laptop), admin = await device(s.admin);
  const a = await openLog(phone, { ...s, store });
  await a.log.enable();
  await a.log.ring.rotate({ revokedThrough: 500 });
  const forge = async (from, keyEpoch, actorId = s.phone.memberId) => {
    const event = { kind: "PRIVATE_NOTE_SET", eventId: newPrivateId(), householdId: s.householdId, actorId, deviceId: from.who.deviceId,
      timestamp: 1, logicalTime: "5", noteId: newPrivateId(), text: "not yours" };
    return encryptPrivateEvent({ eventId: event.eventId, householdId: s.householdId, memberId: s.phone.memberId, deviceId: from.who.deviceId,
      deviceSequence: 1, logicalTime: "5", keyEpoch, plaintext: encoder.encode(JSON.stringify(event)),
      memberKey: await a.log.ring.key(keyEpoch), signingKey: from.deviceKeys.keys.signingPrivateKey });
  };
  // Even holding the member key, the admin's device isn't one of Sam's.
  const devices = [phone.entry, { ...laptop.entry, revokedAt: 400 }, admin.entry];
  await assert.rejects(a.log.authenticate(await forge(admin, 2, s.admin.memberId), devices), (error) => error.code === "private_event_refused");
  await assert.rejects(a.log.authenticate(await forge(admin, 2), devices), (error) => error.code === "private_event_refused");
  // The laptop, revoked at 400, never held epoch 2 (made after 500).
  await assert.rejects(a.log.authenticate(await forge(laptop, 2), devices), (error) => error.code === "private_event_refused");
  // Under epoch 1, from before its revocation, it is the member's own.
  await a.log.authenticate(await forge(laptop, 1), devices);
});

test("the coordinator runs a private pass after the fridge's and keeps private trouble private", async () => {
  const reports = [];
  const log = { syncs: 0, closed: false, failure: null,
    async sync(context) { this.syncs += 1; this.context = context; if (this.failure) throw this.failure; return { hasMore: true }; },
    reportSync(error) { reports.push(error?.code ?? null); }, close() { this.closed = true; } };
  const opened = [], told = [];
  let vaultKey = null;
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16), memberId: "bb".repeat(16), deviceId: "cc".repeat(16) },
    liveChannel: () => null, chatRoom: async () => null, boardRoom: async () => null,
    privateLog: async (options) => { opened.push(options); return log; }, onPrivateLog: (value) => told.push(value),
    vaultKey: async () => vaultKey?.slice() ?? null });
  coordinator.deviceKeys = { keys: {} };
  coordinator.keyStore = { close() {} };
  const context = { status: ON, devices: [] };
  // No vault key on this device yet (#557 not wired): nothing opens.
  assert.deepEqual(await coordinator.syncPrivate(context), { hasMore: false });
  assert.equal(opened.length, 0);
  vaultKey = new Uint8Array(32).fill(7);
  assert.deepEqual(await coordinator.syncPrivate(context), { hasMore: true });
  assert.equal(opened.length, 1);
  assert.equal(typeof opened[0].request, "function");
  assert.ok(await opened[0].vaultKey(), "the log gets the coordinator's vault key provider");
  assert.equal(log.context.deviceKeys, coordinator.deviceKeys);
  await coordinator.syncPrivate(context);
  assert.equal(opened.length, 1, "opened once");
  log.failure = Object.assign(new Error("Missing key"), { code: "private_key_missing" });
  assert.deepEqual(await coordinator.syncPrivate(context), { hasMore: false }, "household sync carries on");
  log.failure = Object.assign(new Error("Signed out"), { code: "authentication_required" });
  await assert.rejects(coordinator.syncPrivate(context), (error) => error.code === "authentication_required");
  assert.deepEqual(reports, [null, null, "private_key_missing"]);
  assert.deepEqual(told, [log]);
  coordinator.stop();
  assert.equal(log.closed, true, "stopping (on lock) closes the log and drops the member key");
  assert.deepEqual(told, [log, null]);
});

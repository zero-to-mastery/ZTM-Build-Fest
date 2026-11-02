// The client live channel (#108): records, reconnecting with backoff,
// losing access, going offline, one tab per device, the coordinator's use of
// it, and the real service end to end.
import assert from "node:assert/strict";
import test from "node:test";
import { DurableStore } from "../../server/durable-store.mjs";
import { PairingService } from "../../server/pairing-service.mjs";
import { createKinServer } from "../../server/server.mjs";
import { exportDevicePublicKeys, generateDeviceKeys } from "./crypto.js";
import { CLOSE_NOT_KIN, LIVE_CLOSE, LIVE_TYPE, LiveChannel, liveUrl, MAX_RECONNECT_MS, parseLiveRecord } from "./live-channel.js";
import { LIVE_POLL_MS, MIN_HINT_GAP_MS, POLL_MS, SyncCoordinator } from "./sync-coordinator.js";

const record = (type, payload = new Uint8Array()) => {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes[0] = type;
  bytes.set(payload, 8);
  return bytes.buffer;
};

/** A scripted stand-in for the browser's WebSocket; like a browser, it
 * refuses close codes other than 1000 and 3000-4999. */
function fakeSockets() {
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.closed = null; sockets.push(this); }
    close(code, reason) {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("invalid code", "InvalidAccessError");
      this.closed = { code, reason };
    }
    receive(data) { this.onmessage?.({ data }); }
    end(code) { this.onclose?.({ code }); }
  }
  return { sockets, FakeSocket };
}

/** Timers run by hand: `fire()` runs the next one and says how long it was. */
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer: (callback, ms) => { const timer = { callback, ms }; pending.push(timer); return timer; },
    clearTimer: (timer) => { const index = pending.indexOf(timer); if (index >= 0) pending.splice(index, 1); },
    fire() { const timer = pending.shift(); timer.callback(); return timer.ms; },
  };
}

function channel(overrides = {}) {
  const { sockets, FakeSocket } = fakeSockets();
  const timers = fakeTimers();
  const calls = [];
  const events = new EventTarget();
  const live = new LiveChannel({
    url: "wss://kin.example/api/live",
    WebSocket: FakeSocket,
    locks: null,
    events,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 1,
    onHint: () => calls.push("hint"),
    onUp: () => calls.push("up"),
    onDown: () => calls.push("down"),
    onEnd: ({ code }) => calls.push(`end ${code}`),
    ...overrides,
  });
  return { live, sockets, timers, calls, events };
}

test("records are read strictly, and the URL follows the page's origin", () => {
  assert.deepEqual(parseLiveRecord(record(LIVE_TYPE.HELLO)), { type: 1, flags: 0, payload: new Uint8Array() });
  assert.equal(parseLiveRecord(record(9, Uint8Array.of(1, 2))).payload.length, 2);
  const reserved = new Uint8Array(record(2)); reserved[2] = 1;
  const long = new Uint8Array(record(2)); long[4] = 1;
  for (const bad of ["text", new Uint8Array(record(2)), new ArrayBuffer(7), reserved.buffer, long.buffer, new ArrayBuffer(256 * 1024 + 1)])
    assert.equal(parseLiveRecord(bad), null);
  assert.equal(liveUrl({ href: "https://kin.example/app?x=1" }), "wss://kin.example/api/live");
  assert.equal(liveUrl({ href: "http://127.0.0.1:8080/" }), "ws://127.0.0.1:8080/api/live");
});

test("typing frames and receipt hints reach the chat once up, and typing goes out only on a draining socket", () => {
  const typed = [], hints = [];
  const { live, sockets } = channel({ onTyping: (bytes) => typed.push([...bytes]), onReceipts: () => hints.push(1) });
  live.start();
  const socket = sockets[0];
  Object.assign(socket, { readyState: 1, bufferedAmount: 0, sent: [], send(bytes) { this.sent.push(bytes); } });
  socket.receive(record(LIVE_TYPE.TYPING, Uint8Array.of(1, 2)));
  socket.receive(record(LIVE_TYPE.RECEIPTS));
  assert.deepEqual([typed, hints], [[], []], "nothing before HELLO");
  assert.equal(live.send(LIVE_TYPE.TYPING, Uint8Array.of(9)), false, "and nothing is sent before HELLO");
  socket.receive(record(LIVE_TYPE.HELLO));
  socket.receive(record(LIVE_TYPE.TYPING, Uint8Array.of(1, 2)));
  socket.receive(record(LIVE_TYPE.RECEIPTS));
  assert.deepEqual([typed, hints.length], [[[1, 2]], 1]);
  // A frame goes out as a Kin record: type, flags, reserved, little-endian length, payload.
  assert.equal(live.send(LIVE_TYPE.TYPING, Uint8Array.of(7, 8, 9)), true);
  assert.deepEqual([...socket.sent[0]], [3, 0, 0, 0, 3, 0, 0, 0, 7, 8, 9]);
  // Typing is worth sending now or not at all.
  assert.equal(live.send(LIVE_TYPE.TYPING, new Uint8Array(2049)), false, "too big");
  assert.equal(live.send(LIVE_TYPE.TYPING, "text"), false, "not bytes");
  socket.bufferedAmount = 64 * 1024;
  assert.equal(live.send(LIVE_TYPE.TYPING, Uint8Array.of(1)), false, "a socket that isn't draining");
  socket.bufferedAmount = 0;
  socket.readyState = 2;
  assert.equal(live.send(LIVE_TYPE.TYPING, Uint8Array.of(1)), false, "a closing socket");
  socket.readyState = 1;
  socket.send = () => { throw new Error("closed"); };
  assert.equal(live.send(LIVE_TYPE.TYPING, Uint8Array.of(1)), false, "a send that throws");
  assert.equal(socket.sent.length, 1);
});

test("HELLO brings the channel up and hints sync; a drop reconnects with doubling, jittered waits", () => {
  const { live, sockets, timers, calls } = channel();
  live.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].binaryType, "arraybuffer");
  sockets[0].receive(record(LIVE_TYPE.SYNC_HINT));
  assert.deepEqual(calls, [], "no hint before HELLO");
  sockets[0].receive(record(LIVE_TYPE.HELLO));
  sockets[0].receive(record(LIVE_TYPE.SYNC_HINT));
  sockets[0].receive(record(77)); // a newer record type: ignored
  assert.deepEqual(calls, ["up", "hint"]);
  sockets[0].end(1006);
  assert.deepEqual(calls.slice(2), ["down"]);
  // With the most jitter, each wait is twice its doubling base, capped at 30 s.
  const waits = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    waits.push(timers.fire());
    sockets.at(-1).end(1006);
  }
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  // A HELLO resets the backoff.
  timers.fire();
  sockets.at(-1).receive(record(LIVE_TYPE.HELLO));
  sockets.at(-1).end(1011);
  assert.equal(timers.fire(), 2_000);
  // With no jitter the waits are the base: even the first retry spreads
  // over 1-2 s, so a restarted service isn't hit all at once.
  const low = channel({ random: () => 0 });
  low.live.start();
  low.sockets[0].end(1006);
  assert.equal(low.timers.fire(), 1_000);
  low.sockets[1].end(1006);
  assert.equal(low.timers.pending[0].ms, 2_000);
});

test("losing access ends the channel; being replaced waits the longest", () => {
  for (const code of [LIVE_CLOSE.SESSION_ENDED, LIVE_CLOSE.ACCESS_LOST]) {
    const { live, sockets, timers, calls } = channel();
    live.start();
    sockets[0].receive(record(LIVE_TYPE.HELLO));
    sockets[0].end(code);
    assert.deepEqual(calls, ["up", `end ${code}`]);
    assert.equal(timers.pending.length, 0, "no reconnecting");
    live.online();
    assert.equal(sockets.length, 1);
  }
  const { live, sockets, timers } = channel();
  live.start();
  sockets[0].receive(record(LIVE_TYPE.HELLO));
  sockets[0].end(LIVE_CLOSE.REPLACED);
  assert.equal(timers.pending[0].ms, MAX_RECONNECT_MS);
  // A slow consumer reconnects as usual and catches up over HTTP.
  timers.fire();
  sockets[1].end(LIVE_CLOSE.SLOW_CONSUMER);
  assert.equal(timers.pending.length, 1);
});

test("a malformed message gives up that socket with a code browsers allow; online reconnects at once", () => {
  const { live, sockets, timers, events, calls } = channel();
  live.start();
  sockets[0].receive(record(LIVE_TYPE.HELLO));
  sockets[0].receive(new ArrayBuffer(3));
  assert.deepEqual(sockets[0].closed, { code: CLOSE_NOT_KIN, reason: "" });
  assert.deepEqual(calls, ["up", "down"], "polling resumes at once");
  assert.equal(timers.pending.length, 1);
  sockets[0].end(CLOSE_NOT_KIN); // handlers are detached: nothing more happens
  assert.equal(timers.pending.length, 1);
  events.dispatchEvent(new Event("online"));
  assert.equal(timers.pending.length, 0, "the wait is cancelled");
  assert.equal(sockets.length, 2);
  events.dispatchEvent(new Event("online"));
  assert.equal(sockets.length, 2, "not while a socket is open");
});

test("going offline drops a socket that may be half-open; coming back reconnects", () => {
  const { live, sockets, timers, events, calls } = channel();
  live.start();
  sockets[0].receive(record(LIVE_TYPE.HELLO));
  events.dispatchEvent(new Event("offline"));
  assert.deepEqual(calls, ["up", "down"]);
  assert.ok(sockets[0].closed);
  events.dispatchEvent(new Event("online"));
  assert.equal(sockets.length, 2);
  assert.equal(timers.pending.length, 0);
});

test("stopping closes the socket, releases the lock and never reconnects", () => {
  const { live, sockets, timers, calls, events } = channel();
  live.start();
  sockets[0].receive(record(LIVE_TYPE.HELLO));
  live.stop();
  assert.deepEqual(sockets[0].closed, { code: 1000, reason: "" });
  sockets[0].end(1000);
  events.dispatchEvent(new Event("online"));
  assert.deepEqual(calls, ["up"]);
  assert.equal(timers.pending.length, 0);
  assert.equal(sockets.length, 1);
  // Without a WebSocket (or a URL) there is no channel at all.
  const none = channel({ WebSocket: undefined });
  none.live.start();
  assert.equal(none.sockets.length, 0);
});

/** A minimal Web Locks manager: one holder per name, others queue; an
 * aborted request leaves the queue. */
function fakeLocks() {
  const held = new Set(), queue = new Map();
  return {
    queue,
    request(name, options, callback) {
      const run = () => {
        held.add(name);
        return Promise.resolve(callback()).finally(() => {
          held.delete(name);
          queue.get(name)?.shift()?.();
        });
      };
      if (!held.has(name)) return run();
      return new Promise((resolve, reject) => {
        if (!queue.has(name)) queue.set(name, []);
        const waiter = () => resolve(run());
        queue.get(name).push(waiter);
        options.signal?.addEventListener("abort", () => {
          queue.set(name, queue.get(name).filter((entry) => entry !== waiter));
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
  };
}

test("one tab per device holds the socket; the next takes over; a stopped waiter leaves the queue", async () => {
  const locks = fakeLocks();
  const { sockets, FakeSocket } = fakeSockets();
  const make = () => new LiveChannel({ url: "wss://kin.example/api/live", lockName: "kin-live:device", WebSocket: FakeSocket, locks, events: new EventTarget() });
  const first = make(), second = make(), third = make();
  first.start();
  second.start();
  third.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 1, "only the lock holder connects");
  third.stop();
  assert.equal(locks.queue.get("kin-live:device").length, 1, "a stopped tab withdraws its wait");
  first.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2, "the waiting tab takes over");
  second.stop();
});

/** A coordinator whose sync passes are scripted: `finish(ok)` ends the
 * running one. Its live channel is a recorder. */
function coordinatorRig() {
  let made = null, created = 0;
  let now = 0;
  const coordinator = new SyncCoordinator({
    store: {}, engine: {}, identity: { deviceId: "d1" }, now: () => now,
    liveChannel: (options) => {
      created += 1;
      made = { options, started: false, stopped: false, start() { this.started = true; }, stop() { this.stopped = true; } };
      return made;
    },
  });
  const runs = [];
  coordinator.runOnce = () => new Promise((resolve, reject) => runs.push({ resolve, reject }));
  coordinator.timer = setInterval(() => {}, POLL_MS);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const finish = async (error = null) => {
    const run = runs.at(-1);
    if (error) run.reject(error); else run.resolve({ hasMore: false });
    await settle(); await settle();
  };
  return {
    coordinator, runs, finish, settle,
    get made() { return made; }, get created() { return created; },
    advance: (ms) => { now += ms; },
    done: () => { clearInterval(coordinator.timer); coordinator.stop(); },
  };
}

test("the coordinator polls less only while the channel is up and sync is healthy", async () => {
  const rig = coordinatorRig();
  try {
    rig.coordinator.startLive();
    assert.equal(rig.made.started, true);
    assert.equal(rig.made.options.lockName, "kin-live:d1");
    rig.advance(10_000);
    rig.made.options.onUp();
    assert.equal(rig.runs.length, 1, "HELLO syncs: catch up and drain the outbox");
    assert.equal(rig.coordinator.pollMs, POLL_MS, "not yet: no sync has succeeded");
    await rig.finish();
    assert.equal(rig.coordinator.pollMs, LIVE_POLL_MS);
    // A paused sync (waiting on keys, a rotation, an error) polls every 5 s.
    rig.advance(10_000);
    rig.made.options.onHint();
    await rig.finish(Object.assign(new Error("paused"), { code: "sync_epoch_missing" }));
    assert.equal(rig.coordinator.pollMs, POLL_MS);
    rig.advance(10_000);
    rig.made.options.onHint();
    await rig.finish();
    assert.equal(rig.coordinator.pollMs, LIVE_POLL_MS);
    rig.made.options.onDown();
    assert.equal(rig.coordinator.pollMs, POLL_MS);
    // A pass that made no progress is a pause, not health.
    rig.advance(10_000);
    rig.made.options.onUp();
    rig.runs.at(-1).resolve({ hasMore: true, advanced: false });
    await rig.settle(); await rig.settle();
    assert.equal(rig.coordinator.lastSyncOk, false);
    assert.equal(rig.coordinator.pollMs, POLL_MS);
  } finally {
    rig.done();
  }
});

test("a hint during a sync runs one more sync after it, at most once a second", async () => {
  const rig = coordinatorRig();
  try {
    rig.coordinator.startLive();
    rig.advance(10_000);
    rig.made.options.onHint();
    for (let index = 0; index < 5; index += 1) rig.made.options.onHint();
    assert.equal(rig.runs.length, 1);
    rig.advance(MIN_HINT_GAP_MS);
    await rig.finish();
    assert.equal(rig.runs.length, 2, "the hints during it lead to exactly one more");
    await rig.finish();
    assert.equal(rig.runs.length, 2, "and no further one without a new hint");
    // Soon after a sync started, a hint waits out the gap.
    rig.made.options.onHint();
    assert.equal(rig.runs.length, 2);
    await new Promise((resolve) => setTimeout(resolve, MIN_HINT_GAP_MS + 50));
    assert.equal(rig.runs.length, 3);
    await rig.finish();
  } finally {
    rig.done();
  }
});

test("lost access stops the channel; the next successful sync starts a new one", async () => {
  const rig = coordinatorRig();
  try {
    rig.coordinator.startLive();
    const first = rig.made;
    // An upgrade refused with 401 shows the browser only 1006, so the HTTP
    // sync's refusal is what stops reconnecting.
    rig.advance(10_000);
    void rig.coordinator.syncNow();
    await rig.finish(Object.assign(new Error("signed out"), { code: "authentication_required" }));
    assert.equal(first.stopped, true);
    assert.equal(rig.coordinator.live, null);
    // Signed in again (a new session): sync works, and the channel returns.
    rig.advance(10_000);
    void rig.coordinator.syncNow();
    await rig.finish();
    assert.equal(rig.created, 2);
    assert.equal(rig.made.started, true);
    // A channel ended by 4401 also comes back after a good sync.
    rig.made.options.onEnd({ code: LIVE_CLOSE.SESSION_ENDED });
    assert.equal(rig.runs.length, 3, "the end itself triggers a sync");
    await rig.finish();
    assert.equal(rig.created, 3);
  } finally {
    rig.done();
  }
});

test("a channel that ended on lost access lets go of its lock, so a new one connects", async () => {
  const locks = fakeLocks();
  const { sockets, FakeSocket } = fakeSockets();
  const coordinator = new SyncCoordinator({
    store: {}, engine: {}, identity: { deviceId: "d1" },
    liveChannel: (options) => new LiveChannel({ url: "wss://kin.example/api/live", WebSocket: FakeSocket, locks, events: new EventTarget(), ...options }),
  });
  const runs = [];
  coordinator.runOnce = () => new Promise((resolve) => runs.push(resolve));
  const settle = async () => { for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
  try {
    coordinator.startLive();
    await settle();
    assert.equal(sockets.length, 1);
    sockets[0].receive(record(LIVE_TYPE.HELLO));
    sockets[0].end(LIVE_CLOSE.SESSION_ENDED);
    // The end syncs; that sync succeeds (a new session) and starts a new
    // channel, which must get the lock and connect.
    await settle();
    for (const resolve of runs.splice(0)) resolve({ hasMore: false });
    await settle();
    assert.equal(sockets.length, 2, "the new channel connected");
    assert.equal(locks.queue.get("kin-live:d1")?.length ?? 0, 0, "nobody waits on an orphaned lock");
    coordinator.stop();
    await settle();
    // After stop, another tab's channel can take the lock at once.
    const other = new LiveChannel({ url: "wss://kin.example/api/live", lockName: "kin-live:d1", WebSocket: FakeSocket, locks, events: new EventTarget() });
    other.start();
    await settle();
    assert.equal(sockets.length, 3);
    other.stop();
  } finally {
    coordinator.stop();
  }
});

test("end to end: the real service's HELLO, event and key hints, and sign-out reach the channel", { timeout: 30_000 }, async (t) => {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: { id: "phone", publicKey: "key-phone", algorithm: -7 }, deviceLabel: "Phone" });
  const pairing = service.createDevicePairing(adult.sessionToken);
  const claim = service.claimPairing({ code: pairing.code, credential: { id: "laptop", publicKey: "key-laptop", algorithm: -7 }, deviceLabel: "Laptop" });
  service.approvePairing(adult.sessionToken, pairing.pairingId, claim.version);
  const laptop = service.activateClaim(claim.claimToken);
  const app = createKinServer({ store: new DurableStore(":memory:"), service, origin: "http://localhost" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)).finally(() => app.store.close()));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (who, path, body) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost", Cookie: `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}` },
    body: JSON.stringify(body),
  });
  // Node's WebSocket, carrying what a browser would: the page's origin and
  // the session cookie.
  const socketFor = (who) => class extends WebSocket {
    constructor(url) { super(url, { headers: { origin: "http://localhost", cookie: `kin_session=${who.sessionToken}` } }); }
  };
  const seen = [];
  const live = new LiveChannel({
    url: `${base.replace("http", "ws")}/api/live`, WebSocket: socketFor(adult), locks: null, events: new EventTarget(),
    onUp: () => seen.push("up"), onHint: () => seen.push("hint"), onEnd: ({ code }) => seen.push(`end ${code}`),
  });
  const until = async (condition) => { for (let index = 0; index < 300 && !condition(); index += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };
  live.start();
  await until(() => seen.includes("up"));
  // The laptop's events were accepted: the phone hears about it.
  app.liveService.eventsAccepted(adult.householdId, laptop.deviceId);
  await until(() => seen.filter((entry) => entry === "hint").length === 1);
  // A change that isn't an event hints too: the phone registers its keys,
  // then the laptop does, which makes the household provision it.
  assert.equal((await post(adult, "/api/sync/device-keys", { publicKeys: await exportDevicePublicKeys(await generateDeviceKeys()) })).status, 200);
  assert.equal((await post(laptop, "/api/sync/device-keys", { publicKeys: await exportDevicePublicKeys(await generateDeviceKeys()) })).status, 200);
  await until(() => seen.filter((entry) => entry === "hint").length === 2);
  // Signing out ends the session: the channel stops for good.
  await post(adult, "/api/logout", {});
  await until(() => seen.some((entry) => entry.startsWith("end")));
  assert.deepEqual(seen, ["up", "hint", "hint", `end ${LIVE_CLOSE.SESSION_ENDED}`]);
  live.stop();
});

test("the coordinator hands typing frames and receipt hints to the chat room, and gives it the channel to send on", async () => {
  const frames = [], hints = [], sent = [];
  const channelStub = { started: false, start() { this.started = true; }, stop() {}, send(type, bytes) { sent.push([type, [...bytes]]); return true; } };
  let options = null;
  const room = {
    receiveTyping: (bytes) => frames.push([...bytes]), receiptsChanged: () => hints.push(1),
    setLiveSender(send) { this.send = send; }, close() {},
  };
  const coordinator = new SyncCoordinator({
    store: {}, engine: {}, identity: { householdId: "aa".repeat(16), memberId: "bb".repeat(16), deviceId: "d1" },
    liveChannel: (given) => { options = given; return channelStub; },
    chatRoom: async () => room,
  });
  coordinator.deviceKeys = { keys: {} };
  coordinator.keyStore = { close() {} };
  coordinator.startLive();
  assert.equal(channelStub.started, true);
  await coordinator.openChat();
  options.onTyping(Uint8Array.of(4, 5));
  options.onReceipts();
  assert.deepEqual([frames, hints.length], [[[4, 5]], 1]);
  assert.equal(room.send(Uint8Array.of(1, 2)), true);
  assert.deepEqual(sent, [[LIVE_TYPE.TYPING, [1, 2]]]);
  coordinator.stopLive();
  assert.equal(room.send(Uint8Array.of(1)), false, "no channel, no typing");
  coordinator.stop();
});

test("presence frames reach the chat once up and go out as record type 5 (#128)", () => {
  const seen = [];
  const { live, sockets } = channel({ onPresence: (bytes) => seen.push([...bytes]) });
  live.start();
  const socket = sockets[0];
  Object.assign(socket, { readyState: 1, bufferedAmount: 0, sent: [], send(bytes) { this.sent.push(bytes); } });
  socket.receive(record(LIVE_TYPE.PRESENCE, Uint8Array.of(1)));
  assert.deepEqual(seen, [], "nothing before HELLO");
  socket.receive(record(LIVE_TYPE.HELLO));
  socket.receive(record(LIVE_TYPE.PRESENCE, Uint8Array.of(1, 2)));
  assert.deepEqual(seen, [[1, 2]]);
  assert.equal(live.send(LIVE_TYPE.PRESENCE, Uint8Array.of(7)), true);
  assert.deepEqual([...socket.sent[0]], [5, 0, 0, 0, 1, 0, 0, 0, 7]);
});

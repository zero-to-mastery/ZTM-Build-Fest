import assert from "node:assert/strict";
import test from "node:test";

import {
  QUEUE_LIMITS,
  RECORD_VERSION,
  captureBytes,
  createCaptureQueue,
  createMemoryStore,
  isRetryable,
  makeRecord,
  openIndexedStore,
  queueLimits,
  readRecord,
  roomProblem,
} from "../../web/admin/capture-queue.js";

const idOf = (n) => String(n).padStart(32, "0");
const photo = (name, size = 100) => ({ name, type: "image/jpeg", size, blob: new Blob([new Uint8Array(size)]) });
const capture = (n, extra = {}) => ({
  id: idOf(n),
  fields: { trade: "flooring", service: "hardwood-install", town: "Springfield", notes: "Words" },
  photos: [photo("a.jpg")],
  audio: null,
  ...extra,
});
const apiError = (status, message = "no") => Object.assign(new Error(message), { status });

test("a record is the versioned format, copies only its own fields, and round-trips through the reader", () => {
  const input = { ...capture(1), secret: "not stored", fields: { trade: "x", service: "", town: "T", notes: "n", extra: "no" } };
  const record = makeRecord(input, new Date("2026-10-29T10:00:00Z"));
  assert.equal(record.v, RECORD_VERSION);
  assert.deepEqual(Object.keys(record).sort(), ["attempts", "audio", "createdAt", "failed", "fields", "id", "lastError", "photos", "v"]);
  assert.deepEqual(Object.keys(record.fields).sort(), ["notes", "service", "town", "trade"]);
  const read = readRecord(record);
  assert.equal(read.state, "ok");
  assert.equal(read.record.id, idOf(1));
  assert.equal(read.record.photos[0].blob, record.photos[0].blob);
});

test("a stored value is read defensively: newer versions are kept, damage is reported, nothing throws", () => {
  const good = makeRecord(capture(1));
  assert.deepEqual(readRecord({ ...good, v: 2 }), { state: "newer", id: idOf(1) });
  assert.equal(readRecord({ ...good, v: 0 }).state, "unreadable");
  assert.equal(readRecord(null).state, "unreadable");
  assert.equal(readRecord("text").state, "unreadable");
  assert.equal(readRecord({ ...good, id: "../x" }).state, "unreadable");
  assert.equal(readRecord({ ...good, photos: [{ name: "a", size: 1 }] }).state, "unreadable");
  assert.equal(readRecord({ ...good, photos: Array.from({ length: 13 }, () => photo("a.jpg")) }).state, "unreadable");
  assert.equal(readRecord({ ...good, fields: { ...good.fields, notes: "x".repeat(8001) } }).state, "unreadable");
  assert.equal(readRecord({ ...good, audio: { type: "audio/webm" } }).state, "unreadable");
  const clipped = readRecord({ ...good, lastError: "e".repeat(500), attempts: -3 }).record;
  assert.equal(clipped.lastError.length, 200);
  assert.equal(clipped.attempts, 0);
});

test("the bounds are finite: count, bytes per capture and bytes in total", () => {
  assert.deepEqual(queueLimits({}), QUEUE_LIMITS);
  assert.equal(queueLimits({ capture: { maxQueued: 2 } }).maxQueued, 2);
  const small = { ...QUEUE_LIMITS, maxQueued: 2, maxCaptureBytes: 1000, maxQueueBytes: 1500 };
  const entry = (n, size) => ({ state: "ok", record: makeRecord(capture(n, { photos: [photo("a.jpg", size)] })) });
  assert.equal(roomProblem([], entry(1, 900).record, small), "");
  assert.match(roomProblem([], entry(1, 1001).record, small), /at most 0 MB|can be at most/);
  assert.match(roomProblem([entry(1, 900)], entry(2, 700).record, small), /are full/);
  assert.match(roomProblem([entry(1, 1), entry(2, 1)], entry(3, 1).record, small), /2 captures are already waiting/);
  assert.equal(captureBytes({ photos: [photo("a", 5), photo("b", 7)], audio: { size: 11 } }), 23);
});

test("only a missing answer, a busy server or a time-out is worth trying again", () => {
  for (const error of [new TypeError("Failed to fetch"), apiError(500), apiError(503), apiError(408), apiError(429)]) assert.equal(isRetryable(error), true);
  for (const error of [apiError(400), apiError(409), apiError(413), apiError(422)]) assert.equal(isRetryable(error), false);
});

test("offline, a capture is kept and sent once the connection returns, and replaying it makes one draft", async () => {
  const store = createMemoryStore();
  let online = false;
  const drafts = new Map();
  const send = async (record) => {
    if (!online) throw new TypeError("Failed to fetch");
    drafts.set(record.id, `posts/${record.id.slice(0, 6)}.md`);
    return { path: drafts.get(record.id), skipped: [] };
  };
  const changes = [];
  const queue = createCaptureQueue({ store, send, onChange: () => changes.push(queue.entries().length) });

  assert.deepEqual(await queue.add(capture(1)), { ok: true });
  assert.deepEqual(await queue.add(capture(2)), { ok: true });
  let result = await queue.flush();
  assert.equal(result.blocked, "offline");
  assert.deepEqual(result.sent, []);
  assert.equal(queue.entries().length, 2);
  assert.equal(queue.entries()[0].record.attempts, 1);
  assert.equal(queue.entries()[1].record.attempts, 0, "stops at the first failure");

  online = true;
  result = await queue.flush();
  assert.equal(result.blocked, "");
  assert.deepEqual(result.sent.map((item) => item.id), [idOf(1), idOf(2)]);
  assert.equal(queue.entries().length, 0);
  assert.equal(drafts.size, 2);

  // The same capture arriving again (a second tab, a retry after a lost answer) is one draft on the server.
  await queue.add(capture(1));
  await queue.flush();
  assert.equal(drafts.size, 2);
});

test("a flush in flight is shared, and an expired session stops it without losing anything", async () => {
  const store = createMemoryStore();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createCaptureQueue({ store, send: async () => { calls += 1; await gate; return { path: "posts/a.md", skipped: [] }; } });
  await queue.add(capture(1));
  const first = queue.flush();
  const second = queue.flush();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 1);

  const expired = createCaptureQueue({ store, send: async () => { throw apiError(401, "Sign in"); } });
  await expired.add(capture(2));
  assert.equal((await expired.flush()).blocked, "signin");
  assert.equal(expired.entries().length, 1);
  assert.equal(expired.entries()[0].record.failed, false);
});

test("a capture the server refuses for good is kept, marked, skipped over, and tried again only when asked", async () => {
  const store = createMemoryStore();
  const sent = [];
  let refuse = true;
  const queue = createCaptureQueue({
    store,
    send: async (record) => {
      if (record.id === idOf(1) && refuse) throw apiError(422, "A title is needed");
      sent.push(record.id);
      return { path: "posts/x.md", skipped: [] };
    },
  });
  await queue.add(capture(1), new Date("2026-10-29T10:00:00Z"));
  await queue.add(capture(2), new Date("2026-10-29T10:01:00Z"));
  await queue.flush();
  assert.deepEqual(sent, [idOf(2)], "the next capture still goes");
  assert.equal(queue.entries().length, 1);
  assert.equal(queue.entries()[0].record.failed, true);
  assert.equal(queue.entries()[0].record.lastError, "A title is needed");

  await queue.flush();
  assert.deepEqual(sent, [idOf(2)], "a refused capture is not hammered");
  refuse = false;
  await queue.retry(idOf(1));
  assert.deepEqual(sent, [idOf(2), idOf(1)]);
  assert.equal(queue.entries().length, 0);
});

test("a full queue says so and keeps what it has; a newer record is never sent or changed", async () => {
  const store = createMemoryStore();
  const send = async () => { throw new Error("must not send"); };
  const queue = createCaptureQueue({ store, send, limits: { ...QUEUE_LIMITS, maxQueued: 2 } });
  await queue.add(capture(1));
  await store.put({ v: 2, id: idOf(9), shape: "from the future" });
  const full = await queue.add(capture(3));
  assert.equal(full.ok, false);
  assert.match(full.reason, /2 captures are already waiting/);
  assert.equal(queue.entries().length, 2);

  const quiet = createCaptureQueue({ store, send: async () => ({ path: "p", skipped: [] }), limits: QUEUE_LIMITS });
  await quiet.flush();
  assert.deepEqual((await store.all()).map((value) => value.id), [idOf(9)]);
  assert.deepEqual((await store.all())[0], { v: 2, id: idOf(9), shape: "from the future" });
  await quiet.discard(idOf(9));
  assert.equal((await store.all()).length, 0);
});

test("a store that cannot write is reported, not thrown", async () => {
  const store = { ...createMemoryStore(), put: async () => { throw new DOMException("full", "QuotaExceededError"); } };
  const queue = createCaptureQueue({ store, send: async () => ({}) });
  const result = await queue.add(capture(1));
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not keep/);
});

test("without IndexedDB the store is null, so the view sends straight away", async () => {
  assert.equal(await openIndexedStore(null), null);
  assert.equal(await openIndexedStore({ open() { throw new Error("blocked"); } }), null);
  const failing = { open() { const request = {}; queueMicrotask(() => request.onerror?.()); return request; } };
  assert.equal(await openIndexedStore(failing), null);
});

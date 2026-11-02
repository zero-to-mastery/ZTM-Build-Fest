// The Capture queue (ADR 0297): captures a phone could not send yet, kept in IndexedDB until they can be.
// The first half of this file is plain functions and a queue over any store with put/all/remove (tested in
// tests/web/admin-capture-queue.test.mjs with an in-memory store); `openIndexedStore` is the browser's.
//
// Stored format, version 1. One record per capture, keyed by its capture id:
//   { v: 1, id, createdAt, fields: { trade, service, town, notes, draft? },
//     photos: [{ name, type, size, blob }], audio: null | { type, size, seconds, blob },
//     attempts, failed, lastError }
// draft is optional and additive (ADR 0304): an applied, unsaved job draft { title, description, sections }. A build
// that does not know it ignores it and sends the notes; one that does bounds and sends it. Nothing is stored outside the bounds the server advertises (`capture` in Admin's meta); a record with a
// newer version is never read, changed or sent, only shown, and the author decides whether to discard it.

import { normalizeDraft } from "./capture-assistant.js";

export const RECORD_VERSION = 1;
export const DB_NAME = "openblog-capture";
export const STORE_NAME = "captures";
const DB_VERSION = 1;
const MAX_ERROR = 200;
const MAX_NAME = 120;
const ID = /^[0-9a-f]{32}$/;

export const QUEUE_LIMITS = Object.freeze({
  maxPhotos: 12,
  maxNotesChars: 8000,
  maxQueued: 5,
  maxCaptureBytes: 60 * 1024 * 1024,
  maxQueueBytes: 120 * 1024 * 1024,
});

/** The queue's bounds as the server advertised them, with the defaults for any it did not. */
export function queueLimits(meta = {}) {
  const limits = { ...QUEUE_LIMITS };
  for (const key of Object.keys(limits)) {
    const value = meta?.capture?.[key];
    if (Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return limits;
}

const clip = (value, length) => String(value ?? "").slice(0, length);

/** The bytes a capture holds: its photos and its voice note. */
export function captureBytes(capture) {
  return capture.photos.reduce((sum, photo) => sum + (photo.size || 0), 0) + (capture.audio?.size || 0);
}

/** The draft entry of a record's fields: a bounded draft, or nothing. */
const draftField = (draft) => {
  const clean = normalizeDraft(draft);
  return clean ? { draft: clean } : {};
};

/** The record to store for a capture. Only the fields of the format are copied. */
export function makeRecord(capture, now = new Date()) {
  const { trade, service, town, notes } = capture.fields;
  return {
    v: RECORD_VERSION,
    id: capture.id,
    createdAt: now.toISOString(),
    fields: { trade: clip(trade, 80), service: clip(service, 80), town: clip(town, 80), notes: String(notes ?? ""), ...draftField(capture.fields.draft) },
    photos: capture.photos.map(({ name, type, size, blob }) => ({ name: clip(name, MAX_NAME), type: clip(type, 100), size, blob })),
    audio: capture.audio ? { type: clip(capture.audio.type, 100), size: capture.audio.size, seconds: capture.audio.seconds, blob: capture.audio.blob } : null,
    attempts: 0,
    failed: false,
    lastError: "",
  };
}

/**
 * What a stored value is: `{ state: "ok", record }`, `{ state: "newer", id }` for a version this build does not
 * know (left exactly as it is), or `{ state: "unreadable", id }`.
 */
export function readRecord(raw, limits = QUEUE_LIMITS) {
  const id = typeof raw?.id === "string" ? raw.id : "";
  if (!raw || typeof raw !== "object") return { state: "unreadable", id };
  if (raw.v !== RECORD_VERSION) return Number.isInteger(raw.v) && raw.v > RECORD_VERSION ? { state: "newer", id } : { state: "unreadable", id };
  const blobs = (items) => Array.isArray(items) && items.every((item) => item && item.blob instanceof Blob && Number.isFinite(item.size) && item.size >= 0);
  const limit = limits.maxPhotos ?? QUEUE_LIMITS.maxPhotos;
  const notes = typeof raw.fields?.notes === "string" ? raw.fields.notes : "";
  if (!ID.test(id) || !raw.fields || !blobs(raw.photos) || raw.photos.length > limit || notes.length > (limits.maxNotesChars ?? QUEUE_LIMITS.maxNotesChars)) {
    return { state: "unreadable", id };
  }
  if (raw.audio !== null && raw.audio !== undefined && !blobs([raw.audio])) return { state: "unreadable", id };
  const field = (value) => clip(typeof value === "string" ? value : "", 80);
  return {
    state: "ok",
    record: {
      v: RECORD_VERSION,
      id,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
      fields: { trade: field(raw.fields.trade), service: field(raw.fields.service), town: field(raw.fields.town), notes, ...draftField(raw.fields.draft) },
      photos: raw.photos.map(({ name, type, size, blob }) => ({ name: clip(name, MAX_NAME), type: clip(type, 100), size, blob })),
      audio: raw.audio ? { type: clip(raw.audio.type, 100), size: raw.audio.size, seconds: Number(raw.audio.seconds) || 0, blob: raw.audio.blob } : null,
      attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
      failed: raw.failed === true,
      lastError: clip(raw.lastError, MAX_ERROR),
    },
  };
}

/** Whether the queue can take one more capture, as a sentence when it cannot, or an empty string. */
export function roomProblem(entries, record, limits = QUEUE_LIMITS) {
  if (entries.length >= limits.maxQueued) {
    return `${limits.maxQueued} captures are already waiting to be sent from this device. Reconnect and let them send first.`;
  }
  const bytes = captureBytes(record);
  if (bytes > limits.maxCaptureBytes) return `This capture is ${Math.ceil(bytes / (1024 * 1024))} MB; a capture kept on this device can be at most ${Math.floor(limits.maxCaptureBytes / (1024 * 1024))} MB. Remove a photo.`;
  const held = entries.reduce((sum, entry) => sum + (entry.record ? captureBytes(entry.record) : 0), 0);
  if (held + bytes > limits.maxQueueBytes) return "The captures waiting on this device are full. Reconnect and let them send first.";
  return "";
}

/** A send that should be tried again later: no answer at all, a busy or failing server, or a time-out. */
export const isRetryable = (error) => error?.status === undefined || error.status >= 500 || error.status === 408 || error.status === 429;

/** An in-memory store with the same three calls as the IndexedDB one: for tests and nothing else. */
export function createMemoryStore() {
  const records = new Map();
  return {
    async put(record) { records.set(record.id, record); },
    async all() { return [...records.values()]; },
    async remove(id) { records.delete(id); },
  };
}

const done = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

/** The browser's store, or null when IndexedDB is missing, blocked or refuses to open (private modes, policies). */
export function openIndexedStore(factory = globalThis.indexedDB) {
  return new Promise((resolve) => {
    if (!factory) return resolve(null);
    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onsuccess = () => {
      const database = request.result;
      resolve({
        async put(record) {
          const transaction = database.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).put(record);
          await done(transaction);
        },
        async all() {
          return new Promise((resolveAll, reject) => {
            const read = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
            read.onsuccess = () => resolveAll(read.result);
            read.onerror = () => reject(read.error);
          });
        },
        async remove(id) {
          const transaction = database.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).delete(id);
          await done(transaction);
        },
      });
    };
  });
}

/**
 * The queue over a store. `send(record)` resolves to the saved draft or throws the API error. `onChange` is
 * told whenever `entries()` changes. Returns `{ entries, refresh, add, flush, retry, discard }`.
 */
export function createCaptureQueue({ store, limits = QUEUE_LIMITS, send, onChange = () => {} }) {
  let entries = [];
  let flushing = null;

  const refresh = async () => {
    const sending = new Set(entries.filter((entry) => entry.sending).map((entry) => entry.id));
    const read = (await store.all()).map((raw) => {
      const entry = readRecord(raw, limits);
      return { ...entry, id: entry.record?.id ?? entry.id, sending: sending.has(entry.record?.id ?? entry.id) };
    });
    entries = read.sort((a, b) => String(a.record?.createdAt ?? "").localeCompare(String(b.record?.createdAt ?? "")));
    onChange();
    return entries;
  };

  const update = async (entry, changes) => {
    entry.record = { ...entry.record, ...changes };
    await store.put(entry.record);
  };

  return {
    entries: () => entries,
    refresh,
    /** Keep a capture on the device. Resolves `{ ok: true }` or `{ ok: false, reason }` and never throws. */
    async add(capture, now = new Date()) {
      try {
        await refresh();
        const record = makeRecord(capture, now);
        const problem = roomProblem(entries, record, limits);
        if (problem) return { ok: false, reason: problem };
        await store.put(record);
        await refresh();
        return { ok: true };
      } catch {
        return { ok: false, reason: "This device could not keep the capture (it may be out of space)." };
      }
    },
    /** Send what is waiting, oldest first. Stops at the first sign the connection or session is gone. */
    flush() {
      if (flushing) return flushing;
      flushing = (async () => {
        const sent = [];
        let blocked = "";
        await refresh();
        for (const entry of entries.filter((item) => item.state === "ok" && !item.record.failed)) {
          entry.sending = true;
          onChange();
          try {
            const result = await send(entry.record);
            await store.remove(entry.record.id);
            sent.push({ id: entry.record.id, ...result });
          } catch (error) {
            entry.sending = false;
            if (error?.status === 401) {
              blocked = "signin";
              break;
            }
            if (isRetryable(error)) {
              await update(entry, { attempts: entry.record.attempts + 1, lastError: "Waiting for a connection." }).catch(() => {});
              blocked = "offline";
              break;
            }
            await update(entry, { attempts: entry.record.attempts + 1, failed: true, lastError: clip(error?.message || "The server refused this capture.", MAX_ERROR) }).catch(() => {});
          }
        }
        await refresh();
        return { sent, blocked };
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    },
    /** Let a capture the server refused be tried again. */
    async retry(id) {
      const entry = entries.find((item) => item.id === id && item.state === "ok");
      if (entry) await update(entry, { failed: false, lastError: "" });
      return this.flush();
    },
    async discard(id) {
      await store.remove(id);
      await refresh();
    },
  };
}

// The household chat in an encrypted export, and back out of one (#136).
//
// An archive with chat (security/archive-stream.js) carries, after the
// household's own history: a notes value, the canonical chat events and the
// chat blobs this device still holds. Events are the engine's own bytes with
// the transport envelope removed, so they can be read without any household
// or chat key. The blobs are the sealed message contents as the service stores
// them; their keys are inside the events. All of it sits inside the archive's
// authenticated encryption, so an export needs the same recovery key as the
// rest.
//
//   notes   { version: 1, memberId, hidden: [message IDs] }
//   events  chunks of 256 as the household history's (chat order, sequences
//           1, 2, 3 ...)
//   blobs   one segment each: ref (32 bytes), part count (u16 LE), the part
//           refs (32 bytes each), then the sealed blob
//
// Restoring checks all of it before anything is written (the engine decodes
// and replays every event; every blob must hash to its reference), then
// stores each event sealed by the local vault in the chat log (not as a relay
// envelope: there is nothing to verify it against until the device is
// approved) and the blobs in the chat blob store. Deleted messages stay
// deleted: their events are in the archive but their blobs are not, and
// when the household syncs, a deletion made after the export reaches this
// device as an ordinary chat event and removes the content as usual.
import { isRef, MAX_CHAT_BLOB_BYTES, MIN_CHAT_BLOB_BYTES, blobRef } from "./chat-blob-crypto.js";
import { ChatLogStore } from "./chat-log-store.js";
import { ChatBlobStore } from "./chat-blob-store.js";
import { ChatRecords } from "./chat-records.js";
import { VaultError } from "../security/local-vault.js";
import { projectionContext } from "../browser-time.js";

export const CHAT_EVENT_KINDS = new Set(["CHAT_MESSAGE_POSTED", "CHAT_MESSAGE_EDITED", "CHAT_MESSAGE_DELETED", "CHAT_REACTION_SET", "CHAT_PIN_SET", "CHAT_POLL_VOTE", "CHAT_POLL_CLOSED", "CHAT_TOPIC_SET"]);
export const MAX_ARCHIVE_CHAT_EVENTS = 250_000;
export const MAX_ARCHIVE_CHAT_BLOBS = 20_000;
export const MAX_ARCHIVE_CHAT_HIDDEN = 10_000;
const MAX_PARTS = 256;
const REF_BYTES = 32;
const METADATA_BATCH = 500;
const hexOf = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytesOfHex = (hex) => Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
const damaged = () => new VaultError("This file is damaged or incomplete.");

/** The most chat content (blob bytes) an archive can hold next to a
 * household of `householdBytes`, within `limit` bytes in all. */
export function chatBlobBudget(limit, householdBytes) {
  return Math.max(0, limit - householdBytes - 4 * 1024 * 1024);
}

/**
 * Which of the blobs a device holds go into an export of at most `budget`
 * bytes: the newest first, each only if it fits. Returns the choice (sorted
 * by reference, so the same chat always exports in the same order) and how
 * many blobs and bytes were left out.
 */
export function chooseChatBlobs(inventory, budget) {
  const newestFirst = [...inventory].sort((a, b) => b.storedAt - a.storedAt || (a.ref < b.ref ? -1 : 1));
  const chosen = [];
  let bytes = 0, skipped = 0, skippedBytes = 0;
  for (const blob of newestFirst) {
    // The segment, its length prefix and its authentication tag.
    const cost = blobSegmentLength(blob) + 20;
    if (chosen.length < MAX_ARCHIVE_CHAT_BLOBS && bytes + cost <= budget) {
      chosen.push(blob);
      bytes += cost;
    } else {
      skipped += 1;
      skippedBytes += blob.size;
    }
  }
  chosen.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { chosen, bytes, skipped, skippedBytes };
}

/** The plaintext length of a blob's archive segment. */
export function blobSegmentLength(blob) {
  return REF_BYTES + 2 + REF_BYTES * (blob.parts?.length ?? 0) + blob.size;
}

/** A blob's archive segment: `blob` is { ref, parts }, `ciphertext` its bytes. */
export function blobSegment(blob, ciphertext) {
  const parts = blob.parts ?? [];
  if (parts.length > MAX_PARTS || !isRef(blob.ref) || parts.some((part) => !isRef(part)))
    throw new VaultError("Kin could not prepare this export.");
  const segment = new Uint8Array(REF_BYTES + 2 + REF_BYTES * parts.length + ciphertext.length);
  segment.set(bytesOfHex(blob.ref), 0);
  new DataView(segment.buffer).setUint16(REF_BYTES, parts.length, true);
  parts.forEach((part, index) => segment.set(bytesOfHex(part), REF_BYTES + 2 + index * REF_BYTES));
  segment.set(ciphertext, REF_BYTES + 2 + parts.length * REF_BYTES);
  return segment;
}

/** { ref, parts, ciphertext } from a blob segment (a copy; the input is wiped by the caller). */
export function parseBlobSegment(bytes) {
  if (bytes.length < REF_BYTES + 2) throw damaged();
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(REF_BYTES, true);
  const start = REF_BYTES + 2 + count * REF_BYTES;
  const size = bytes.length - start;
  if (count > MAX_PARTS || size < MIN_CHAT_BLOB_BYTES || size > MAX_CHAT_BLOB_BYTES) throw damaged();
  const parts = [];
  for (let index = 0; index < count; index += 1)
    parts.push(hexOf(bytes.subarray(REF_BYTES + 2 + index * REF_BYTES, REF_BYTES + 2 + (index + 1) * REF_BYTES)));
  return { ref: hexOf(bytes.subarray(0, REF_BYTES)), parts: count ? parts : null, ciphertext: bytes.slice(start) };
}

/** A snapshot view of a chat log as the archive writer reads it (sequences 1, 2, 3 ...). */
export function chatEventsView(view) {
  return {
    length: view.length,
    recordLength: (index) => view.recordLength(index),
    record: (index) => view.record(index),
    localSequence: (index) => index + 1,
  };
}

/** The notes value: the exporting member and the messages they deleted for themselves. */
export function chatNotes({ memberId, hidden }) {
  return { version: 1, memberId, hidden: [...hidden].sort() };
}

function validateNotes(notes) {
  const ok = notes && typeof notes === "object" && !Array.isArray(notes) &&
    Object.keys(notes).sort().join(",") === "hidden,memberId,version" && notes.version === 1 &&
    typeof notes.memberId === "string" && /^[a-f0-9]{32}$/.test(notes.memberId) &&
    Array.isArray(notes.hidden) && notes.hidden.length <= MAX_ARCHIVE_CHAT_HIDDEN &&
    notes.hidden.every((id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id)) &&
    new Set(notes.hidden).size === notes.hidden.length;
  if (!ok) throw damaged();
  return notes;
}

/** An empty chat section being read from an archive. */
export function openChatSection() {
  return { notes: null, records: new ChatRecords(), eventIds: [], blobs: [], blobBytes: 0, nextSequence: 1 };
}

/** Appends one chunk of chat events from an archive. */
export function appendChatEvents(section, sequences, records) {
  records.forEach((record, index) => {
    if (sequences[index] !== section.nextSequence) throw damaged();
    section.nextSequence += 1;
    section.records.append(record);
  });
}

/** Adds one blob segment (the caller wipes `bytes` afterwards). */
export function appendChatBlob(section, bytes) {
  const blob = parseBlobSegment(bytes);
  if (section.blobs.length >= MAX_ARCHIVE_CHAT_BLOBS) throw damaged();
  section.blobs.push(blob);
  section.blobBytes += blob.ciphertext.length;
}

/** Wipes a chat section. */
export function discardChatSection(section) {
  section?.records.clear();
  if (section) { section.notes = null; section.eventIds = []; }
  for (const blob of section?.blobs ?? []) blob.ciphertext.fill(0);
  if (section) section.blobs = [];
}

/**
 * Checks a chat section read from an archive against the manifest and the
 * engine: every record decodes as a chat event of this household with a
 * unique ID, the whole log replays, and every blob hashes to its reference.
 * Returns what restore needs.
 */
export async function validateChatSection(section, { engine, counts, householdId, memberId = null, syncIdentity = null }) {
  if (!section.notes || section.records.length !== counts.eventCount || section.blobs.length !== counts.blobCount) throw damaged();
  const notes = validateNotes(section.notes);
  const view = section.records.view();
  const ids = new Set();
  section.eventIds = [];
  for (let from = 0; from < view.length; from += METADATA_BATCH) {
    const to = Math.min(from + METADATA_BATCH, view.length);
    const batch = [];
    for (let index = from; index < to; index += 1) batch.push(view.record(index));
    let metadata;
    try { metadata = engine.eventMetadataBatch(batch); } catch { throw damaged(); }
    for (const entry of metadata) {
      const eventId = hexOf(entry.eventId);
      if (!CHAT_EVENT_KINDS.has(entry.kind) || ids.has(eventId) || hexOf(entry.householdId) !== householdId) throw damaged();
      ids.add(eventId);
      section.eventIds.push(eventId);
    }
  }
  // The same decoding and replay the chat room runs, over the whole log.
  try {
    const { asOf, civilDate } = projectionContext();
    engine.chatPage(section.records.view(), { limit: 1, includeText: false, includeRetired: true, includePolls: true, includePins: true }, asOf, civilDate, syncIdentity);
  } catch { throw damaged(); }
  const refs = new Set();
  for (const blob of section.blobs) {
    if (refs.has(blob.ref) || await blobRef(blob.ciphertext) !== blob.ref) throw damaged();
    refs.add(blob.ref);
  }
  // The deleted-for-me list is the exporting member's own: it is only kept
  // when the household being restored is that member's.
  const hidden = memberId && notes.memberId === memberId ? notes.hidden : [];
  return Object.freeze({ eventCount: section.records.length, blobCount: section.blobs.length, blobBytes: section.blobBytes, hidden });
}

/**
 * Writes a validated chat section into this household's chat log and blob
 * store. Events already there are kept (or, if an earlier import put them
 * there, written again under the vault's current root). Resolves with how
 * many events and blobs were new.
 */
export async function importChatSection(section, { householdId, vault, hidden, indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange }) {
  const log = await ChatLogStore.open(householdId, { indexedDB, keyRange });
  let blobs;
  try {
    blobs = await ChatBlobStore.open(householdId, { indexedDB });
    const view = section.records.view();
    const entries = [];
    for (let index = 0; index < view.length; index += 1) {
      const eventId = section.eventIds[index];
      const copy = view.record(index).slice();
      try { entries.push({ eventId, sealed: await vault.seal(copy, { store: "chat-import", id: eventId }) }); } finally { copy.fill(0); }
    }
    // Blobs first: an event is never there without the content it names.
    let storedBlobs = 0;
    for (const blob of section.blobs) if (await blobs.put(blob.ref, blob.ciphertext, { parts: blob.parts })) storedBlobs += 1;
    const events = await log.importEvents(entries, { hidden });
    return { events, blobs: storedBlobs };
  } finally {
    log.close();
    blobs?.close();
  }
}

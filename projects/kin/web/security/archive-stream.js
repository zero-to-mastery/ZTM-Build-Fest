// Package format 3: an archive's ciphertext as a stream of sealed segments,
// so export and restore handle 256 events at a time instead of holding the
// whole household as one serialized value, one plaintext and one ciphertext.
//
// The KARC v1 container (rust/src/archive.rs) is unchanged: a 16-byte header,
// the metadata, then the ciphertext region. Inside that region each segment
// is `length:u32 LE` followed by its AES-256-GCM ciphertext (tag included),
// in this order:
//
//   0           the local context row (protected-value serialization)
//   1 .. A      one attachment record each (A = the manifest's attachmentCount)
//   A+1 ..      the history, CHUNK_EVENTS records per segment, the last one
//               possibly shorter
//
// An archive made with the household chat (#136) continues with, in order: one
// chat segment holding the exporting member's chat notes (the messages they
// deleted for themselves), the chat events in chunks laid out as the history's
// (sequences count up from 1), then one segment per chat blob (chat-archive.js
// has the layout). The manifest names the counts, so an archive without chat
// is byte-for-byte what package format 3 always was.
//
// An archive made with the family fridge (#363) ends with the board events in
// chunks laid out the same way (after the chat, when there is one).
//
// Every segment is sealed under one key for this archive
// (LocalVault.archiveStreamKey), with the nonce `noncePrefix:8 || index:u32 BE`
// and additional data naming its index and whether it is the last. A reader
// decides "last" from the segment's position, so a dropped, repeated,
// reordered or truncated segment fails to open, as does anything after the
// final one.
//
// An event chunk's plaintext is `count:u32`, then per record its local
// sequence (f64) and length (u32), then the records back to back. Restore
// derives every other event row field from the canonical bytes.
import { deserializeProtectedValue, serializeProtectedValue, VaultError } from "./local-vault.js";

export const CHUNK_EVENTS = 256;
// A bound on one segment, well above the largest legitimate one (an
// attachment record of 4 MiB of file data, serialized).
export const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const TAG_BYTES = 16;
const PURPOSE = "kin/archive-stream/v1";
const encoder = new TextEncoder();

function damaged() {
  return new VaultError("This file is damaged or incomplete.");
}

function segmentParams(noncePrefix, vaultId, index, final) {
  const iv = new Uint8Array(12);
  iv.set(noncePrefix);
  new DataView(iv.buffer).setUint32(8, index, false);
  return {
    name: "AES-GCM", iv, tagLength: 128,
    additionalData: encoder.encode(JSON.stringify([PURPOSE, vaultId, index, final ? "final" : "more"])),
  };
}

/** The number of segments an archive with these counts holds. */
export function segmentCount(attachmentCount, eventCount, chat = null, boardEventCount = 0) {
  const household = 1 + attachmentCount + Math.ceil(eventCount / CHUNK_EVENTS);
  const withChat = chat ? household + 1 + Math.ceil(chat.eventCount / CHUNK_EVENTS) + chat.blobCount : household;
  return withChat + Math.ceil(boardEventCount / CHUNK_EVENTS);
}

function chunkLength(view, from, to) {
  let length = 4 + (to - from) * 12;
  for (let index = from; index < to; index += 1) length += view.recordLength(index);
  return length;
}

// Writes records [from, to) of `view` as one event chunk into `target`.
function writeChunk(view, from, to, target) {
  const data = new DataView(target.buffer, target.byteOffset, target.byteLength);
  data.setUint32(0, to - from, true);
  let entry = 4;
  let offset = 4 + (to - from) * 12;
  for (let index = from; index < to; index += 1) {
    const record = view.record(index);
    data.setFloat64(entry, view.localSequence(index), true);
    data.setUint32(entry + 8, record.length, true);
    target.set(record, offset);
    entry += 12;
    offset += record.length;
  }
  return offset;
}

/** The local sequences and records (subarrays of `bytes`) of one event chunk. */
export function readEventChunk(bytes) {
  if (bytes.length < 4) throw damaged();
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = data.getUint32(0, true);
  if (count < 1 || count > CHUNK_EVENTS || bytes.length < 4 + count * 12) throw damaged();
  const sequences = new Array(count);
  const records = new Array(count);
  let offset = 4 + count * 12;
  for (let index = 0; index < count; index += 1) {
    const sequence = data.getFloat64(4 + index * 12, true);
    const length = data.getUint32(4 + index * 12 + 8, true);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || offset + length > bytes.length) throw damaged();
    sequences[index] = sequence;
    records[index] = bytes.subarray(offset, offset + length);
    offset += length;
  }
  if (offset !== bytes.length) throw damaged();
  return { sequences, records };
}

/**
 * The whole archive: KARC header, `metadata`, then the sealed segments of
 * `context`, `attachments` and the history `view`. The output is allocated
 * once at its final size; event chunks pass through one reusable buffer.
 * `chat` ({ notes, view, blobs, loadBlob(ref), blobSegmentLength(blob),
 * blobSegment(blob, bytes) }) adds the household chat (#136): `view` is its
 * event view (length, recordLength, record, localSequence), `blobs` the
 * blobs to include, each read by `loadBlob` as its segment is sealed.
 * `board` ({ view }) adds the family fridge's events (#363) last.
 * `check` runs after every segment (the caller's lock and epoch checks);
 * `onProgress({ done, total })` reports events written.
 */
export async function writeArchive({ engine, metadata, key, noncePrefix, vaultId, context, attachments, view, chat = null, board = null, check, onProgress }) {
  const serializedLength = (value) => {
    const bytes = serializeProtectedValue(value);
    bytes.fill(0);
    return bytes.length;
  };
  const chunks = [];
  for (let from = 0; from < view.length; from += CHUNK_EVENTS) {
    const to = Math.min(from + CHUNK_EVENTS, view.length);
    chunks.push({ from, to, length: chunkLength(view, from, to) });
  }
  const chatChunks = [];
  for (let from = 0; chat && from < chat.view.length; from += CHUNK_EVENTS) {
    const to = Math.min(from + CHUNK_EVENTS, chat.view.length);
    chatChunks.push({ from, to, length: chunkLength(chat.view, from, to) });
  }
  const boardChunks = [];
  for (let from = 0; board && from < board.view.length; from += CHUNK_EVENTS) {
    const to = Math.min(from + CHUNK_EVENTS, board.view.length);
    boardChunks.push({ from, to, length: chunkLength(board.view, from, to) });
  }
  const plainLengths = [serializedLength(context), ...attachments.map(serializedLength), ...chunks.map((chunk) => chunk.length),
    ...(chat ? [serializedLength(chat.notes), ...chatChunks.map((chunk) => chunk.length), ...chat.blobs.map((blob) => chat.blobSegmentLength(blob))] : []),
    ...boardChunks.map((chunk) => chunk.length)];
  if (plainLengths.some((length) => length + TAG_BYTES > MAX_SEGMENT_BYTES))
    throw new VaultError("This household is too large to export.");
  const region = plainLengths.reduce((total, length) => total + 4 + length + TAG_BYTES, 0);
  const output = new Uint8Array(16 + metadata.length + region);
  output.set(engine.archiveHeader(metadata.length, region));
  output.set(metadata, 16);
  const frames = new DataView(output.buffer);
  const last = plainLengths.length - 1;
  let offset = 16 + metadata.length;
  let index = 0;
  const seal = async (plaintext) => {
    // Web Crypto copies its input when called, so `plaintext` may be reused
    // as soon as this returns.
    const sealed = new Uint8Array(await crypto.subtle.encrypt(segmentParams(noncePrefix, vaultId, index, index === last), key, plaintext));
    if (sealed.length !== plaintext.length + TAG_BYTES) throw new VaultError("Kin could not prepare this export.");
    frames.setUint32(offset, sealed.length, true);
    output.set(sealed, offset + 4);
    offset += 4 + sealed.length;
    index += 1;
    await check();
  };
  const sealValue = async (value) => {
    const bytes = serializeProtectedValue(value);
    try { await seal(bytes); } finally { bytes.fill(0); }
  };
  const scratch = new Uint8Array([...chunks, ...chatChunks, ...boardChunks].reduce((largest, chunk) => Math.max(largest, chunk.length), 0));
  const chatEvents = chat?.view.length ?? 0;
  const totalEvents = view.length + chatEvents + (board?.view.length ?? 0);
  try {
    await sealValue(context);
    for (const attachment of attachments) await sealValue(attachment);
    for (const chunk of chunks) {
      const length = writeChunk(view, chunk.from, chunk.to, scratch);
      await seal(scratch.subarray(0, length));
      onProgress?.({ done: chunk.to, total: totalEvents });
    }
    if (chat) {
      await sealValue(chat.notes);
      for (const chunk of chatChunks) {
        const length = writeChunk(chat.view, chunk.from, chunk.to, scratch);
        await seal(scratch.subarray(0, length));
        onProgress?.({ done: view.length + chunk.to, total: totalEvents });
      }
      // One blob at a time: the ciphertext is read, sealed and dropped.
      for (const blob of chat.blobs) {
        const bytes = await chat.loadBlob(blob);
        if (!bytes) throw new VaultError("A chat file changed while the export was being prepared. Try again.");
        const segment = chat.blobSegment(blob, bytes);
        try { await seal(segment); } finally { segment.fill(0); }
      }
    }
    for (const chunk of boardChunks) {
      const length = writeChunk(board.view, chunk.from, chunk.to, scratch);
      await seal(scratch.subarray(0, length));
      onProgress?.({ done: view.length + chatEvents + chunk.to, total: totalEvents });
    }
  } catch (error) {
    output.fill(0);
    throw error;
  } finally {
    scratch.fill(0);
  }
  if (offset !== output.length) throw new VaultError("Kin could not prepare this export.");
  return output;
}

/**
 * Opens the segments in `bytes[offset, offset + length)` in order. Calls
 * `onContext(value)`, `onAttachment(value)` for each attachment record and
 * `onEvents(sequences, records, remaining)` for each event chunk; the
 * records are views of a plaintext buffer that is zero-filled once the
 * callback returns, and `remaining` is the number of archive bytes from this
 * segment to the end (a bound on the history's size still to come).
 * An archive with the household chat (`chatEventCount` and `chatBlobCount`
 * from the manifest, #136) then calls `onChatNotes(value)`,
 * `onChatEvents(sequences, records)` for each chunk and
 * `onChatBlob(bytes)` for each blob segment (zero-filled afterwards too).
 * An archive with the family fridge (`boardEventCount`, #363) ends with
 * `onBoardEvents(sequences, records)` for each chunk.
 * Rejects a stream whose segment count or chunking differs from the counts
 * in the authenticated manifest.
 */
export async function readArchive({ bytes, offset, length, key, noncePrefix, vaultId, attachmentCount, eventCount,
  chatEventCount = 0, chatBlobCount = 0, chatPresent = false, boardEventCount = 0,
  onContext, onAttachment, onEvents, onChatNotes, onChatEvents, onChatBlob, onBoardEvents, check, onProgress }) {
  const chat = chatPresent ? { eventCount: chatEventCount, blobCount: chatBlobCount } : null;
  const total = segmentCount(attachmentCount, eventCount, chat, boardEventCount);
  const boardStart = segmentCount(attachmentCount, eventCount, chat);
  const historyEnd = attachmentCount + Math.ceil(eventCount / CHUNK_EVENTS);
  const notesAt = historyEnd + 1;
  const chatEventsEnd = notesAt + Math.ceil(chatEventCount / CHUNK_EVENTS);
  const end = offset + length;
  const frames = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let index = 0;
  let events = 0;
  let chatEvents = 0;
  let boardEvents = 0;
  const allEvents = eventCount + chatEventCount + boardEventCount;
  while (offset < end) {
    if (index >= total || offset + 4 > end) throw damaged();
    const sealedLength = frames.getUint32(offset, true);
    const start = offset + 4;
    if (sealedLength < TAG_BYTES || sealedLength > MAX_SEGMENT_BYTES || start + sealedLength > end) throw damaged();
    const final = start + sealedLength === end;
    let plaintext;
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt(
        segmentParams(noncePrefix, vaultId, index, final), key, bytes.subarray(start, start + sealedLength)));
    } catch { throw damaged(); }
    try {
      await check();
      if (index >= boardStart) {
        const chunk = readEventChunk(plaintext);
        const expected = Math.min(CHUNK_EVENTS, boardEventCount - boardEvents);
        if (chunk.records.length !== expected) throw damaged();
        onBoardEvents(chunk.sequences, chunk.records);
        boardEvents += expected;
        onProgress?.({ done: events + chatEvents + boardEvents, total: allEvents });
      } else if (index === 0) onContext(deserializeProtectedValue(plaintext));
      else if (index <= attachmentCount) onAttachment(deserializeProtectedValue(plaintext));
      else if (index <= historyEnd) {
        const chunk = readEventChunk(plaintext);
        const expected = Math.min(CHUNK_EVENTS, eventCount - events);
        if (chunk.records.length !== expected) throw damaged();
        onEvents(chunk.sequences, chunk.records, end - offset);
        events += expected;
        onProgress?.({ done: events + chatEvents, total: allEvents });
      } else if (index === notesAt) onChatNotes(deserializeProtectedValue(plaintext));
      else if (index <= chatEventsEnd) {
        const chunk = readEventChunk(plaintext);
        const expected = Math.min(CHUNK_EVENTS, chatEventCount - chatEvents);
        if (chunk.records.length !== expected) throw damaged();
        onChatEvents(chunk.sequences, chunk.records);
        chatEvents += expected;
        onProgress?.({ done: events + chatEvents, total: allEvents });
      } else onChatBlob(plaintext);
    } finally {
      plaintext.fill(0);
    }
    offset = start + sealedLength;
    index += 1;
  }
  if (index !== total || events !== eventCount || chatEvents !== chatEventCount || boardEvents !== boardEventCount) throw damaged();
}

// The family fridge in an encrypted export, and back out of one (#363).
//
// An archive with a fridge (security/archive-stream.js) carries, after the
// household's history and any chat, the canonical board events in chunks of
// 256 laid out like the history's (sequences 1, 2, 3 ...). Events are the
// engine's own bytes with the transport envelope removed, so they read back
// without any household key; all of it sits inside the archive's
// authenticated encryption.
//
// Restoring checks the whole section before anything is written (each event
// decodes as a board kind of this household with a unique ID, and the engine
// replays the board), then stores each event sealed by the local vault in the
// board log. The relay's signed copy replaces it once the household syncs.
import { BoardLogStore } from "./board-log-store.js";
import { BOARD_EVENT_KINDS, MAX_BOARD_EVENT_COUNT } from "../wasm/kin-board.js";
import { ChatRecords } from "../chat/chat-records.js";
import { VaultError } from "../security/local-vault.js";
import { projectionContext } from "../browser-time.js";

export const MAX_ARCHIVE_BOARD_EVENTS = MAX_BOARD_EVENT_COUNT;
const BOARD_KINDS = new Set(BOARD_EVENT_KINDS);
const METADATA_BATCH = 500;
const hexOf = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const damaged = () => new VaultError("This file is damaged or incomplete.");

/** A snapshot view of a board log as the archive writer reads it. */
export function boardEventsView(view) {
  return {
    length: view.length,
    recordLength: (index) => view.recordLength(index),
    record: (index) => view.record(index),
    localSequence: (index) => index + 1,
  };
}

/** An empty board section being read from an archive. */
export function openBoardSection() {
  return { records: new ChatRecords(), eventIds: [], nextSequence: 1 };
}

/** Appends one chunk of board events from an archive. */
export function appendBoardEvents(section, sequences, records) {
  records.forEach((record, index) => {
    if (sequences[index] !== section.nextSequence) throw damaged();
    section.nextSequence += 1;
    section.records.append(record);
  });
}

/** Wipes a board section. */
export function discardBoardSection(section) {
  section?.records.clear();
  if (section) section.eventIds = [];
}

/**
 * Checks a board section against the manifest and the engine: every record
 * decodes as a board event of this household with a unique ID, and the whole
 * fridge replays. Returns what restore needs.
 */
export function validateBoardSection(section, { engine, eventCount, householdId, syncIdentity = null }) {
  if (section.records.length !== eventCount || eventCount < 1 || eventCount > MAX_ARCHIVE_BOARD_EVENTS) throw damaged();
  const view = section.records.view();
  const ids = new Set(), eventIds = [];
  section.eventIds = [];
  for (let from = 0; from < view.length; from += METADATA_BATCH) {
    const to = Math.min(from + METADATA_BATCH, view.length);
    const batch = [];
    for (let index = from; index < to; index += 1) batch.push(view.record(index));
    let metadata;
    try { metadata = engine.eventMetadataBatch(batch); } catch { throw damaged(); }
    for (const entry of metadata) {
      const eventId = hexOf(entry.eventId);
      if (!BOARD_KINDS.has(entry.kind) || ids.has(eventId) || hexOf(entry.householdId) !== householdId) throw damaged();
      ids.add(eventId);
      eventIds.push(eventId);
    }
  }
  // The same decoding and replay the board room runs, over the whole log.
  try {
    const { asOf, civilDate } = projectionContext();
    engine.boardState(section.records.view(), asOf, civilDate, syncIdentity);
  } catch { throw damaged(); }
  section.eventIds = eventIds;
  return Object.freeze({ eventCount: section.records.length });
}

/** Writes a validated board section into this household's board log.
 * Resolves with how many events were new. */
export async function importBoardSection(section, { householdId, vault, indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange }) {
  const log = await BoardLogStore.open(householdId, { indexedDB, keyRange });
  try {
    const view = section.records.view();
    if (section.eventIds.length !== view.length) throw damaged();
    const entries = [];
    for (let index = 0; index < view.length; index += 1) {
      const eventId = section.eventIds[index];
      const copy = view.record(index).slice();
      try { entries.push({ eventId, sealed: await vault.seal(copy, { store: "board-import", id: eventId }) }); } finally { copy.fill(0); }
    }
    return { events: await log.importEvents(entries) };
  } finally {
    log.close();
  }
}

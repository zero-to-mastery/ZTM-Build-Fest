import {
  asBytes,
  assertCivilDate,
  assertTimestamp,
  idToHex,
  KinEngineError,
  MAX_EVENT_COUNT,
  MAX_ITEM_TEXT_BYTES,
  MAX_PROTOCOL_BYTES,
  MAX_STEP_TEXT_BYTES,
  MAX_STEP_TEXT_CHARS,
  PROTOCOL_VERSION,
  PULSE_VALUES,
  readAscii,
  ROUTINE_CADENCES,
  strictTextDecoder,
} from "./wire.js";
import { recordDiagnostic } from "../diagnostics/ring-buffer.js";
import { errorName } from "../diagnostics/global.js";
import { decodeAttachmentBindings, decodeProjection } from "./projection-decode.js";
import { HistoryMirror } from "./history-mirror.js";
import { BOARD_COMMANDS, BOARD_EVENT_KINDS, MAX_BOARD_EVENT_COUNT, BoardFormatError, decodeBoard, encodeBoardIntent } from "./kin-board.js";
import { FIRST_MEAL_PLAN_KIND, MEAL_COMMANDS, MEAL_EVENT_KINDS, MEAL_PLAN_COMMANDS, MEAL_PLAN_EVENT_KINDS, MealFormatError, decodeMeals, decodePlan, encodeMealIntent, encodePlanQuery } from "./kin-meals.js";
import { SIMPLE_COMMANDS, SIMPLE_EVENT_KINDS, SimpleFormatError, decodeItemEmojis, decodeMyThings, encodeItemEmojiIntent, encodeMyThingsQuery } from "./kin-simple.js";
import { decodeWeek, encodeWeekQuery } from "./kin-week.js";
import { SECTION_COMMANDS, SECTION_EVENT_KINDS, SectionFormatError, decodeShoppingSections, encodeSectionIntent } from "./kin-sections.js";
import { ROTATION_COMMANDS, ROTATION_EVENT_KINDS, RotationFormatError, decodeRoutineRotations, encodeRotationIntent } from "./kin-rotations.js";
import { SITTER_COMMANDS, SITTER_EVENT_KINDS, SitterFormatError, decodeSitterPage, encodeSitterIntent } from "./kin-sitter.js";
import { ALBUM_COMMANDS, ALBUM_EVENT_KINDS, AlbumFormatError, FIRST_ALBUM_KIND, decodeAlbum, encodeAlbumIntent } from "./kin-album.js";
import { CALENDAR_COMMANDS, CALENDAR_EVENT_KINDS, CalendarFormatError, MAX_ICAL_BYTES, decodeCalendarRange, decodeICalendar, encodeCalendarIntent, encodeCalendarRangeQuery } from "./kin-calendar.js";
import { CHORE_COMMANDS, CHORE_EVENT_KINDS, ChoreFormatError, FIRST_CHORE_KIND, decodeChoreChart, encodeChartQuery, encodeChoreIntent } from "./kin-chores.js";
import { FIRST_PRIVATE_KIND, MAX_PRIVATE_EVENT_COUNT, PRIVATE_EVENT_KINDS, decodePrivate } from "./kin-private.js";
import { FIRST_JOURNAL_KIND, FIRST_PRIVATE_ITEM_KIND, JOURNAL_EVENT_KINDS, PRIVATE_ITEM_EVENT_KINDS, PrivateFormatError, encodePrivateIntent } from "./kin-private.js";
import { encodePrefsIntent, PREFS_COMMANDS, PREFS_KIND_CODES, PrefsFormatError } from "./kin-prefs.js";

export { idToHex, KinEngineError };

const REQUEST_HEADER_BYTES = 64;
export const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
export const MAX_LOGICAL_TIME = 9_007_199_254_740_991n;
const textEncoder = new TextEncoder();
/** Longest device name in UTF-8 bytes (48 characters, rust/src/state.rs). */
const MAX_DEVICE_NAME_BYTES = 192;

const USER_MESSAGES = new Map([
  [1, "Kin could not safely access its household engine. Try again."],
  [
    2,
    "Kin could not read that household event. Your saved information was not deleted.",
  ],
  [
    3,
    "This household has changes from a newer version of Kin. Update Kin on this device to continue. Your saved information was not deleted.",
  ],
  [
    4,
    "That household change is not valid. Review its current state and try again.",
  ],
  [
    5,
    "Kin has reached a supported storage limit. Your saved information was not deleted.",
  ],
  [
    6,
    "Kin could not complete that action. Your saved information was not deleted.",
  ],
]);

// The exports of the most recently created engine. The module-level
// eventMetadata()/eventMetadataBatch() below use it, for callers that have no
// engine object at hand (snapshot helpers in storage). An EventStore passes
// its own engine instead (event-store.js appendRows). Disposing the engine
// that is current clears it, and those helpers then throw until another
// engine is created; avoid making short-lived engines while a store is open.
let sharedCodec = null;

export async function loadKinEngine(
  wasmUrl = new URL("./kin_engine.wasm", import.meta.url),
) {
  let response;
  try { response = await fetch(wasmUrl); } catch (error) {
    recordDiagnostic("engine_load_failed", { stage: "load", name: errorName(error) });
    throw error;
  }
  if (!response.ok) {
    recordDiagnostic("engine_load_failed", { stage: "load", status: response.status });
    throw new KinEngineError(
      6,
      "Kin could not load its household engine. Check the local WASM build and try again.",
    );
  }
  const bytes = await response.arrayBuffer();
  let instance;
  try { ({ instance } = await WebAssembly.instantiate(bytes, {})); } catch (error) {
    recordDiagnostic("engine_load_failed", { stage: "instantiate", name: errorName(error) });
    throw error;
  }
  return createEngine(instance.exports);
}

/** Wraps instantiated engine exports in the host API. Exposed separately so
 * Node tests can exercise ABI ownership against a substitute export table. */
export function createEngine(instanceExports) {
  let exports = instanceExports;
  const requiredExports = [
    "memory",
    "kin_alloc",
    "kin_free",
    "kin_history_reset",
    "kin_history_append",
    "kin_history_truncate",
    "kin_project",
    "kin_device_names",
    "kin_member_names",
    "kin_meals",
    "kin_meal_plans",
    "kin_meal_shopping_plan",
    "kin_item_emojis",
    "kin_my_things",
    "kin_week",
    "kin_shopping_sections",
    "kin_routine_rotations",
    "kin_sitter_page",
    "kin_album",
    "kin_calendar_range",
    "kin_ical_parse",
    "kin_chore_chart",
    "kin_event_metadata",
    "kin_event_metadata_batch",
    "kin_audio_peaks",
    "kin_encode_command",
    "kin_execute",
    "kin_encode_archive",
    "kin_decode_archive",
    "kin_archive_header",
    "kin_archive_layout",
    "kin_plan_import",
    "kin_chat_history_reset",
    "kin_chat_history_append",
    "kin_chat_history_truncate",
    "kin_chat_execute",
    "kin_chat_page",
    "kin_chat_search",
    "kin_chat_text",
    "kin_chat_texts_clear",
    "kin_board_history_reset",
    "kin_board_history_append",
    "kin_board_history_truncate",
    "kin_board_execute",
    "kin_board_state",
    "kin_private_history_reset",
    "kin_private_history_append",
    "kin_private_history_truncate",
    "kin_private_state",
    "kin_private_execute",
    "kin_qr_encode",
    "kin_qr_decode",
    "kin_clear",
    "kin_result_ptr",
    "kin_result_len",
    "kin_error_ptr",
    "kin_error_len",
  ];
  if (
    requiredExports.some((name) => !(name in exports)) ||
    !(exports.memory instanceof WebAssembly.Memory)
  ) {
    throw new KinEngineError(6, "Kin loaded an incompatible household engine.");
  }

  sharedCodec = exports;
  // The last state this engine decoded from a stamped projection. Each new
  // replay or command reuses its unchanged sections (projection-decode.js),
  // so states share those arrays; decoded states are never mutated.
  // applyEvents and executeCommand advance it. planImport (unstamped, always
  // decoded in full) and projectionBytes (no decode) do not; skipping an
  // update is always safe, it only means less reuse next time. A decode that
  // throws leaves the previous state in place for the same reason.
  let lastState = null;
  const decoded = (state) => (lastState = state);
  // What the instance's own history holds; replays and commands bring it up
  // to date with only the records that changed (history-mirror.js).
  const mirror = new HistoryMirror(
    exports,
    (batch) => callCore(exports, "kin_history_append", batch, { statusOnly: true }),
    asBytes,
  );
  // The chat log, a second history apart from the household's (#109).
  const chatMirror = new HistoryMirror(
    exports,
    (batch) => callCore(exports, "kin_chat_history_append", batch, { statusOnly: true }),
    asBytes,
    { reset: "kin_chat_history_reset", truncate: "kin_chat_history_truncate" },
  );
  // The fridge log, a third history (#317, ADR 0011).
  const boardMirror = new HistoryMirror(
    exports,
    (batch) => callCore(exports, "kin_board_history_append", batch, { statusOnly: true }),
    asBytes,
    { reset: "kin_board_history_reset", truncate: "kin_board_history_truncate" },
  );
  // The unlocked member's private log, a fourth history (#489, ADR 0019).
  const privateMirror = new HistoryMirror(
    exports,
    (batch) => callCore(exports, "kin_private_history_append", batch, { statusOnly: true }),
    asBytes,
    { reset: "kin_private_history_reset", truncate: "kin_private_history_truncate" },
  );
  return {
    dispose() {
      if (exports) {
        exports.kin_clear();
        mirror.forget();
        chatMirror.forget();
        boardMirror.forget();
        privateMirror.forget();
        if (sharedCodec === exports) sharedCodec = null;
        exports = null;
        lastState = null;
      }
    },
    eventMetadata: (bytes) =>
      decodeMetadata(callCore(exports, "kin_event_metadata", asBytes(bytes))),
    eventMetadataBatch: (records) => metadataBatch(exports, records),
    executeCommand: (
      command,
      identity,
      records,
      asOf,
      cursorEventId = null,
      civilDate,
      syncIdentity = null,
    ) => {
      const result = executeCommand(
        exports,
        mirror,
        command,
        identity,
        records,
        asOf,
        cursorEventId,
        civilDate,
        syncIdentity,
        lastState,
      );
      decoded(result.state);
      return result;
    },
    encodeArchive: (metadata, ciphertext) =>
      encodeArchive(exports, metadata, ciphertext),
    decodeArchive: (bytes) => decodeArchive(exports, bytes),
    archiveHeader: (metadataLength, ciphertextLength) =>
      archiveHeader(exports, metadataLength, ciphertextLength),
    archiveLayout: (bytes) => archiveLayout(exports, bytes),
    // The import plan of `records` (a history view or an array), replayed
    // from the instance's history like applyEvents. An archive's history is
    // a different arena, so the instance is reset to it; the next replay of
    // the session's own history resets it back.
    planImport: (
      records,
      asOf,
      cursorEventId = null,
      civilDate,
      syncIdentity = null,
    ) =>
      planImport(
        exports,
        mirror,
        records,
        asOf,
        cursorEventId,
        civilDate,
        syncIdentity,
      ),
    // The same plan with only its attachment bindings decoded
    // ({ eventCount, nextLogicalTime, attachments }), for archive checks.
    importBindings: (
      records,
      asOf,
      cursorEventId = null,
      civilDate,
      syncIdentity = null,
    ) =>
      planImport(
        exports,
        mirror,
        records,
        asOf,
        cursorEventId,
        civilDate,
        syncIdentity,
        true,
      ),
    applyEvents: (
      records,
      asOf,
      cursorEventId = null,
      civilDate,
      syncIdentity = null,
    ) =>
      decoded(applyEvents(
        exports,
        mirror,
        records,
        asOf,
        cursorEventId,
        civilDate,
        syncIdentity,
        lastState,
      )),
    // The exact protocol-24 projection bytes, for equivalence checks that must
    // compare encodings rather than decoded objects. The section revisions in
    // these bytes depend on this engine's earlier calls, so two calls compare
    // equal only with nothing changed in between. This call moves Rust's
    // comparison basis but not `lastState`; the next decode stays correct
    // because a changed section always gets a new revision.
    projectionBytes: (
      records,
      asOf,
      cursorEventId = null,
      civilDate,
      syncIdentity = null,
    ) =>
      replayBytes(exports, mirror, records, asOf, cursorEventId, civilDate, syncIdentity),
    // The household's named devices (#71), replayed from the same history:
    // [{ deviceId, memberId, autoName, nickname }] in device-ID order, IDs
    // as hex. nickname is null when none is set; autoName is null when this
    // history has a nickname for the device but not its description.
    deviceNames: (records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeDeviceNames(
        replayBytes(exports, mirror, records, asOf, null, civilDate, syncIdentity, "kin_device_names"),
      )),
    // Members' preferred display names (#224), replayed from the same
    // history: [{ memberId, name }] in member-ID order, IDs as hex. Members
    // who never set a name are absent; hosts fall back to their own labels.
    // Meals (#333, #679): { recipes, dinners, meals } from the household
    // history, every meal of the day (KMLS v2, `kin_meal_plans`) from 35 days
    // before `civilDate` to 370 after, and favourites (kin-meals.js
    // decodeMeals). `kin_meals` (KMLS v1, dinners only) stays exported.
    meals: (records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeMeals(
        replayBytes(exports, mirror, records, asOf, null, civilDate, syncIdentity, "kin_meal_plans"),
      )),
    // Item emoji (#344): a Map itemId -> emoji for items that exist and
    // aren't archived.
    itemEmojis: (records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeItemEmojis(
        replayBytes(exports, mirror, records, asOf, null, civilDate, syncIdentity, "kin_item_emojis"),
      )),
    // Store sections (#411, ADR 0015): { sections: [{ sectionId, name }] in
    // the household's order, itemSections: Map itemId -> sectionId } for
    // items that exist, aren't archived and whose section is listed.
    shoppingSections: (records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeShoppingSections(
        replayBytes(exports, mirror, records, asOf, null, civilDate, syncIdentity, "kin_shopping_sections"),
      )),
    // Taking turns (#429, ADR 0016): [{ routineId, memberIds, current, next }]
    // for routines that exist, aren't archived and rotate. Every listed
    // member counts; turnAmong() (kin-rotations.js) passes over inactive ones.
    routineRotations: (records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeRoutineRotations(
        replayBytes(exports, mirror, records, asOf, null, civilDate, syncIdentity, "kin_routine_rotations"),
      )),
    // The sitter page (#442, ADR 0017): { intro, entries: [{ kind: "note" |
    // "reference-record" | "routine", id }] }, only entries whose record
    // exists and isn't archived, in the page's order.
    sitterPage: (records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeSitterPage(
        replayBytes(exports, mirror, records, asOf, null, civilDate, syncIdentity, "kin_sitter_page"),
      )),
    // The family album (#673, ADR 0022 §5): { photos: [{ photoId,
    // attachmentId, addedBy, addedAt, caption }], removed: [{ photoId,
    // attachmentId, removedAt }] }, both newest first.
    album: (records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeAlbum(
        replayBytes(exports, mirror, records, asOf, null, civilDate, syncIdentity, "kin_album"),
      )),
    // The calendar from `from` to `to` (civil dates, at most 400 days; #656,
    // ADR 0022): occurrences of calendar events with cancellations applied,
    // merged with dated items, routines and meals, the next countdown and
    // member colours (kin-calendar.js decodeCalendarRange). Options:
    // allEvents (every event's definition, for editing a series and
    // de-duplicating imports by sourceUid), includeCancelled (cancelled
    // occurrences too, marked).
    calendarRange: (from, to, records, asOf, civilDate, syncIdentity = null, options = {}) => {
      let query;
      try { query = encodeCalendarRangeQuery(from, to, options); }
      catch (error) {
        if (error instanceof CalendarFormatError) throw new KinEngineError(2, error.message);
        throw error;
      }
      return safeDecode(() => decodeCalendarRange(queryBytes(exports, mirror, "kin_calendar_range", query, records, asOf, civilDate, syncIdentity)));
    },
    // An .ics file (bytes, at most 2 MB) as Kin events (#666,
    // kin-calendar.js decodeICalendar). Parsed in Rust on this device; no
    // household state is read or changed.
    parseICalendar: (bytes) => {
      const input = asBytes(bytes);
      if (input.length > MAX_ICAL_BYTES) throw new KinEngineError(5, "That calendar file is too large to import (2 MB at most).");
      if (input.length === 0) return { name: "", skipped: 0, truncated: false, events: [] };
      return safeDecode(() => decodeICalendar(callCore(exports, "kin_ical_parse", input)));
    },
    // The chore chart (#676, ADR 0022 §6) for the week of `civilDate`:
    // `query` is { start, bounds, adultsAllowed, members } (kin-chores.js
    // encodeChartQuery); the result is decodeChoreChart's.
    choreChart: (query, records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeChoreChart(queryBytes(exports, mirror, "kin_chore_chart", encodeChartQuery(query), records, asOf, civilDate, syncIdentity))),
    // A member's things on `civilDate` (#344, ADR 0013): [{ kind: "item",
    // itemId } | { kind: "routine", routineId, occurrenceKey, done }].
    myThings: (memberId, records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeMyThings(queryBytes(exports, mirror, "kin_my_things", encodeMyThingsQuery(memberId), records, asOf, civilDate, syncIdentity))),
    // The household's seven days from `startCivilDate` (#417, kin-week.js):
    // [{ date, items, routines, meals, maintenance, omitted }]. "current" and
    // "done" on a routine occurrence are judged at `civilDate`.
    week: (startCivilDate, records, asOf, civilDate, syncIdentity = null) => {
      const query = encodeWeekQuery(startCivilDate);
      return safeDecode(() => decodeWeek(queryBytes(exports, mirror, "kin_week", query, records, asOf, civilDate, syncIdentity)));
    },
    // What adding a recipe's ({ recipeId }), a date's dinner's ({ date }), a
    // date's meal's ({ date, slot }) or a week's ({ week }) ingredients to
    // Shopping would do now: [{ outcome, text, stapleId }].
    mealShoppingPlan: (source, records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodePlan(mealPlanBytes(exports, mirror, source, records, asOf, civilDate, syncIdentity))),
    memberNames: (records, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeMemberNames(
        replayBytes(exports, mirror, records, asOf, null, civilDate, syncIdentity, "kin_member_names"),
      )),
    // Household chat (#109). `chatRecords` is the chat log (a history view
    // or an array of canonical chat records), never the household history.
    // A chat command validated against the chat log: { encodedEvent,
    // metadata }. The host stores the event, then reads a page. `admins`
    // are the household admins' member IDs (hex) as the service reports
    // them; removing another member's message needs the actor among them.
    // `members` are the members who can read chat (hex, at most 64): the
    // only ones a post or edit may mention by name (#130).
    executeChatCommand: (command, identity, chatRecords, asOf, civilDate, syncIdentity = null, admins = [], members = []) =>
      executeChatCommand(exports, chatMirror, command, identity, chatRecords, asOf, civilDate, syncIdentity, admins, members),
    // A page of messages, oldest first (KCHP, ABI.md). Options: before (an
    // index; omit for the newest), limit (1 to 500), includeText, includeRetired,
    // includeReactions, includePins, includePolls, includeTopics (#312: the
    // "To talk about" list as `topics`), admins (the household admins'
    // member IDs as hex; at most 16).
    chatPage: (chatRecords, options, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeChatPage(
        chatPageBytes(exports, chatMirror, chatRecords, options, asOf, civilDate, syncIdentity),
        options?.includePins === true,
        options?.includePolls === true,
        options?.includeTopics === true,
      )),
    // Searches the chat (KCHF/KCHR, ABI.md): { query, limit (1 to 200),
    // attachmentsOnly, from, to (ms; 0 for none), authors (hex, at most 16),
    // excluded (hex IDs of messages hidden for me, at most 10,000), admins }.
    // Resolves with { total, results: [{ messageId, index, ranges: [[start,
    // end]] }], unsearched, missing: [{ messageId, blobRef, blobKey }] }:
    // ranges are UTF-8 byte offsets; `missing` are texts the engine doesn't
    // hold yet, which the host opens and searches again.
    chatSearch: (chatRecords, options, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeChatSearch(
        chatSearchBytes(exports, chatMirror, chatRecords, options, asOf, civilDate, syncIdentity),
      )),
    // Hands decrypted texts to the engine's arena: [{ blobRef, text }] with
    // blobRef as 64 hex digits. Returns one boolean per text: whether it
    // passed Rust's checks and is held.
    putChatTexts: (entries) => putChatTexts(exports, entries),
    // Reduces decoded voice-message samples (a Float32Array of mono samples,
    // at most 16,000,000) to 64 waveform peaks (KAPQ/KAPR, ABI.md): a
    // Uint8Array of 64 values, 0 (silent) to 255 (full scale).
    audioPeaks: (samples) => audioPeaks(exports, samples),
    // Drops every decrypted chat text the engine holds, for a member who
    // lost access to chat while unlocked (locking drops them too).
    clearChatTexts: () => {
      if (exports) exports.kin_chat_texts_clear();
    },
    // The fridge (#317). `boardRecords` is the board log (a history view or
    // an array of canonical board records). A board command (kin-board.js
    // BOARD_COMMANDS) validated against it: { encodedEvent, metadata }.
    executeBoardCommand: (command, identity, boardRecords, asOf, civilDate, syncIdentity = null) =>
      executeBoardCommand(exports, boardMirror, command, identity, boardRecords, asOf, civilDate, syncIdentity),
    // The fridge as drawn (KBRD): { strokes, magnets, openClear }.
    boardState: (boardRecords, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodeBoard(boardStateBytes(exports, boardMirror, boardRecords, asOf, civilDate, syncIdentity))),
    // A member's private projection (#489, KPRV): `privateRecords` is that
    // member's private log (a history view or an array of canonical private
    // records). Returns { memberId, recordCount, notes } (kin-private.js).
    privateState: (privateRecords, asOf, civilDate, syncIdentity = null) =>
      safeDecode(() => decodePrivate(privateStateBytes(exports, privateMirror, privateRecords, asOf, civilDate, syncIdentity))),
    // A private command (kin-private.js PRIVATE_ITEM_COMMANDS, #511;
    // JOURNAL_COMMANDS, #498)
    // validated against the member's private log: { encodedEvent, metadata }.
    // `identity` names the event (hex IDs, timestamp, logical time).
    // Reminders and settings (#520, kin-prefs.js PREFS_COMMANDS) take the
    // same path.
    executePrivateCommand: (command, identity, privateRecords, asOf, civilDate, syncIdentity = null) =>
      executePrivateCommand(exports, privateMirror, command, identity, privateRecords, asOf, civilDate, syncIdentity),
  };
}

function executePrivateCommand(exports, privateMirror, command, identity, privateRecords, asOf, civilDate, syncIdentity) {
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (privateRecords.length > MAX_PRIVATE_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  let intent;
  try { intent = PREFS_COMMANDS.includes(command?.type) ? encodePrefsIntent(command, identity) : encodePrivateIntent(command, identity); }
  catch (error) {
    if (error instanceof PrivateFormatError || error instanceof PrefsFormatError) throw new KinEngineError(2, error.message);
    throw error;
  }
  // u32 intent length, KCMD, then the record-less KINE context.
  const prefix = 4 + intent.length;
  const request = encodeRequest([], asOf, null, civilDate, syncIdentity, prefix);
  new DataView(request.buffer).setUint32(0, intent.length, true);
  request.set(intent, 4);
  const release = privateMirror.hold(privateRecords);
  let bytes;
  try {
    bytes = callCore(exports, "kin_private_execute", request);
  } finally {
    release();
    intent.fill(0);
    request.fill(0);
  }
  const invalid = () => new KinEngineError(6, "Kin received an invalid command result.");
  if (bytes.length < 20 || readAscii(bytes, 0, 4) !== "KCMT") throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eventLength = view.getUint32(8, true), metadataLength = view.getUint32(12, true);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0 || view.getUint32(16, true) !== 0 ||
    20 + eventLength + metadataLength !== bytes.length)
    throw invalid();
  return {
    encodedEvent: bytes.slice(20, 20 + eventLength),
    metadata: decodeMetadata(bytes.subarray(20 + eventLength)),
  };
}

function privateStateBytes(exports, privateMirror, privateRecords, asOf, civilDate, syncIdentity) {
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (privateRecords.length > MAX_PRIVATE_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  const request = encodeRequest([], asOf, null, civilDate, syncIdentity);
  const release = privateMirror.hold(privateRecords);
  try {
    return callCore(exports, "kin_private_state", request);
  } finally {
    release();
  }
}

function executeBoardCommand(exports, boardMirror, command, identity, boardRecords, asOf, civilDate, syncIdentity) {
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (boardRecords.length > MAX_BOARD_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  let intent;
  try { intent = encodeBoardIntent(command, identity); }
  catch (error) {
    if (error instanceof BoardFormatError) throw new KinEngineError(2, error.message);
    throw error;
  }
  // u32 intent length, KCMD, then the record-less KINE context.
  const prefix = 4 + intent.length;
  const request = encodeRequest([], asOf, null, civilDate, syncIdentity, prefix);
  new DataView(request.buffer).setUint32(0, intent.length, true);
  request.set(intent, 4);
  const release = boardMirror.hold(boardRecords);
  let bytes;
  try {
    bytes = callCore(exports, "kin_board_execute", request);
  } finally {
    release();
  }
  const invalid = () => new KinEngineError(6, "Kin received an invalid command result.");
  if (bytes.length < 20 || readAscii(bytes, 0, 4) !== "KCMT") throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eventLength = view.getUint32(8, true), metadataLength = view.getUint32(12, true);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0 || view.getUint32(16, true) !== 0 ||
    20 + eventLength + metadataLength !== bytes.length)
    throw invalid();
  return {
    encodedEvent: bytes.slice(20, 20 + eventLength),
    metadata: decodeMetadata(bytes.subarray(20 + eventLength)),
  };
}

function boardStateBytes(exports, boardMirror, boardRecords, asOf, civilDate, syncIdentity) {
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (boardRecords.length > MAX_BOARD_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  const request = encodeRequest([], asOf, null, civilDate, syncIdentity);
  const release = boardMirror.hold(boardRecords);
  try {
    return callCore(exports, "kin_board_state", request);
  } finally {
    release();
  }
}

const CHAT_QUOTE_STATES = ["unknown", "live", "edited", "deleted", "removed-by-admin"];
const CHAT_STATUSES = ["live", "edited", "deleted", "removed-by-admin"];
/** A "Talk later" topic's state byte (#312): KCMD action 65 and the page. */
const CHAT_TOPIC_STATES = ["cleared", "open", "resolved"];
/** Most open or resolved topics a chat keeps (#312); the engine enforces it. */
export const MAX_CHAT_TOPICS = 200;
const CHAT_CONTENT_KINDS = [null, "text", "attachment", "poll"];
export const MAX_CHAT_EVENT_COUNT = 250_000;
const MAX_CHAT_PAGE = 500;

// What follows a chat post's or edit's blob reference and key: nothing; a
// reply's 16-byte ID alone; or, with mentions, flags (1 everyone, 2 a reply
// follows), a count, the member IDs in ascending order, then the reply ID.
function mentionsTail(mentions, reply, isPost) {
  const members = [...new Set(mentions?.members ?? [])];
  const everyone = mentions?.everyone === true;
  if (mentions != null && (typeof mentions !== "object" || (mentions.everyone != null && typeof mentions.everyone !== "boolean") ||
    !Array.isArray(mentions.members ?? []) || members.length > 20 ||
    members.some((id) => typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id) || /^0{32}$/.test(id))))
    throw new KinEngineError(2, "Kin received invalid chat mentions.");
  if (!isPost && reply) throw new KinEngineError(2, "Kin received invalid chat mentions.");
  if (!everyone && !members.length) return reply ?? [];
  members.sort();
  return [(everyone ? 1 : 0) | (reply ? 2 : 0), members.length, ...members.flatMap((id) => [...idFromHex(id)]), ...(reply ?? [])];
}

function replyFromHex(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value) || /^0{32}$/.test(value))
    throw new KinEngineError(2, "Kin received an invalid chat reply.");
  return idFromHex(value);
}

function blobFromHex(value, what) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value) || /^0{64}$/.test(value))
    throw new KinEngineError(2, `Kin received an invalid chat ${what}.`);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function executeChatCommand(exports, chatMirror, command, identity, chatRecords, asOf, civilDate, syncIdentity, admins, members) {
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (!["post-chat-message", "edit-chat-message", "delete-chat-message", "react-chat-message", "pin-chat-message", "vote-chat-poll", "close-chat-poll", "set-chat-topic"].includes(command?.type))
    throw new KinEngineError(2, "Kin received an invalid household action.");
  if (chatRecords.length > MAX_CHAT_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  if (!Array.isArray(admins) || admins.length > 16 || !Array.isArray(members) || members.length > 64)
    throw new KinEngineError(2, "Kin received an invalid household action.");
  const intent = encodeIntentPacket(command, identity);
  // u32 intent length, KCMD, u32 admin count, admins, u32 member count,
  // members, KINE context.
  const prefix = 4 + intent.length + 4 + admins.length * 16 + 4 + members.length * 16;
  const request = encodeRequest([], asOf, null, civilDate, syncIdentity, prefix);
  const requestView = new DataView(request.buffer);
  requestView.setUint32(0, intent.length, true);
  request.set(intent, 4);
  requestView.setUint32(4 + intent.length, admins.length, true);
  admins.forEach((admin, index) => request.set(idFromHex(admin), 8 + intent.length + index * 16));
  const membersAt = 8 + intent.length + admins.length * 16;
  requestView.setUint32(membersAt, members.length, true);
  members.forEach((member, index) => request.set(idFromHex(member), membersAt + 4 + index * 16));
  const release = chatMirror.hold(chatRecords);
  let bytes;
  try {
    bytes = callCore(exports, "kin_chat_execute", request);
  } finally {
    release();
  }
  const invalid = () => new KinEngineError(6, "Kin received an invalid command result.");
  if (bytes.length < 20 || readAscii(bytes, 0, 4) !== "KCMT") throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eventLength = view.getUint32(8, true), metadataLength = view.getUint32(12, true);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0 || view.getUint32(16, true) !== 0 ||
    20 + eventLength + metadataLength !== bytes.length)
    throw invalid();
  return {
    encodedEvent: bytes.slice(20, 20 + eventLength),
    metadata: decodeMetadata(bytes.subarray(20 + eventLength)),
  };
}

// KCHQ v1 (ABI.md): "KCHQ", version, reserved, before u32, limit u16,
// flags u8 (1 texts, 2 retired, 4 reactions, 8 pins, 16 polls, 32 topics),
// reserved u8, admin count u32, admins,
// then the record-less KINE context.
function chatPageBytes(exports, chatMirror, chatRecords, options = {}, asOf, civilDate, syncIdentity) {
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (chatRecords.length > MAX_CHAT_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  const { before = null, limit = 50, includeText = true, includeRetired = false, includeReactions = false, includePins = false, includePolls = false, includeTopics = false, admins = [] } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHAT_PAGE ||
    (before !== null && (!Number.isInteger(before) || before < 0 || before > 0xffff_ffff)) ||
    !Array.isArray(admins) || admins.length > 16)
    throw new KinEngineError(2, "Kin received an invalid chat page request.");
  const prefix = 20 + admins.length * 16;
  const request = encodeRequest([], asOf, null, civilDate, syncIdentity, prefix);
  const view = new DataView(request.buffer);
  request.set([75, 67, 72, 81, 1, 0, 0, 0]);
  view.setUint32(8, before ?? 0xffff_ffff, true);
  view.setUint16(12, limit, true);
  request[14] = (includeText ? 1 : 0) | (includeRetired ? 2 : 0) | (includeReactions ? 4 : 0) | (includePins ? 8 : 0) | (includePolls ? 16 : 0) | (includeTopics ? 32 : 0);
  view.setUint32(16, admins.length, true);
  admins.forEach((admin, index) => request.set(idFromHex(admin), 20 + index * 16));
  const release = chatMirror.hold(chatRecords);
  try {
    return callCore(exports, "kin_chat_page", request);
  } finally {
    release();
  }
}

// KCHF v1 (ABI.md): "KCHF", version, reserved, limit u32, flags u32 (1 =
// attachments only), from i64, to i64, query bytes u32, admin count u32,
// author count u32, excluded count u32, the query, the admins, the authors,
// the excluded IDs, then the record-less KINE context.
const MAX_CHAT_SEARCH_RESULTS = 200;
const MAX_CHAT_SEARCH_QUERY_BYTES = 256;
const MAX_CHAT_SEARCH_EXCLUDED = 10_000;

function chatSearchBytes(exports, chatMirror, chatRecords, options = {}, asOf, civilDate, syncIdentity) {
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (chatRecords.length > MAX_CHAT_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  const {
    query = "", limit = 50, attachmentsOnly = false, from = 0, to = 0, authors = [], excluded = [], admins = [],
    mentioning = null,
  } = options;
  const queryBytes = new TextEncoder().encode(typeof query === "string" ? query : "\u0000");
  if (typeof query !== "string" || queryBytes.length > MAX_CHAT_SEARCH_QUERY_BYTES ||
    !Number.isInteger(limit) || limit < 1 || limit > MAX_CHAT_SEARCH_RESULTS ||
    !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0 || (to !== 0 && to <= from) ||
    !Array.isArray(admins) || admins.length > 16 || !Array.isArray(authors) || authors.length > 16 ||
    !Array.isArray(excluded) || excluded.length > MAX_CHAT_SEARCH_EXCLUDED ||
    (mentioning !== null && (typeof mentioning !== "string" || !/^[0-9a-f]{32}$/.test(mentioning) || /^0{32}$/.test(mentioning))))
    throw new KinEngineError(2, "Kin received an invalid chat search.");
  const prefix = 48 + queryBytes.length + (admins.length + authors.length + excluded.length + (mentioning ? 1 : 0)) * 16;
  const request = encodeRequest([], asOf, null, civilDate, syncIdentity, prefix);
  const view = new DataView(request.buffer);
  request.set([75, 67, 72, 70, 1, 0, 0, 0]);
  view.setUint32(8, limit, true);
  view.setUint32(12, (attachmentsOnly ? 1 : 0) | (mentioning ? 2 : 0), true);
  view.setBigInt64(16, BigInt(from), true);
  view.setBigInt64(24, BigInt(to), true);
  view.setUint32(32, queryBytes.length, true);
  view.setUint32(36, admins.length, true);
  view.setUint32(40, authors.length, true);
  view.setUint32(44, excluded.length, true);
  request.set(queryBytes, 48);
  let at = 48 + queryBytes.length;
  // The member whose mentions to list goes after the excluded IDs (#130).
  for (const id of [...admins, ...authors, ...excluded, ...(mentioning ? [mentioning] : [])]) {
    request.set(idFromHex(id), at);
    at += 16;
  }
  const release = chatMirror.hold(chatRecords);
  try {
    return callCore(exports, "kin_chat_search", request);
  } finally {
    release();
  }
}

// KCHR v1 (ABI.md): a 24-byte header, the results newest first (60 bytes,
// ranges, excerpt each), then the texts the engine couldn't look at.
function decodeChatSearch(bytes) {
  const invalid = () => new KinEngineError(6, "Kin received an invalid chat search result.");
  if (bytes.length < 24 || readAscii(bytes, 0, 4) !== "KCHR") throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw invalid();
  const total = view.getUint32(8, true), count = view.getUint32(12, true);
  const unsearched = view.getUint32(16, true), listed = view.getUint32(20, true);
  if (count > MAX_CHAT_SEARCH_RESULTS || count > total || listed > 256 || listed > unsearched) throw invalid();
  const results = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let at = 24;
  for (let index = 0; index < count; index += 1) {
    if (at + 60 > bytes.length) throw invalid();
    const ranges = view.getUint32(at + 20, true), kind = view.getUint32(at + 48, true);
    const offset = view.getUint32(at + 52, true), length = view.getUint32(at + 56, true);
    const postedAt = Number(view.getBigInt64(at + 40, true));
    const end = at + 60 + ranges * 8 + length;
    if (ranges > 4 || (kind !== 1 && kind !== 2) || !Number.isSafeInteger(postedAt) || end > bytes.length) throw invalid();
    const found = [];
    for (let range = 0; range < ranges; range += 1) {
      const start = view.getUint32(at + 60 + range * 8, true), stop = view.getUint32(at + 64 + range * 8, true);
      if (stop <= start) throw invalid();
      found.push([start, stop]);
    }
    let excerpt = "";
    try {
      excerpt = decoder.decode(bytes.subarray(at + 60 + ranges * 8, end));
    } catch {
      throw invalid();
    }
    results.push({
      messageId: idToHex(bytes.subarray(at, at + 16)),
      index: view.getUint32(at + 16, true),
      authorId: idToHex(bytes.subarray(at + 24, at + 40)),
      postedAt,
      contentKind: kind === 1 ? "text" : "attachment",
      ranges: found,
      excerpt,
      excerptOffset: offset,
    });
    at = end;
  }
  if (at + listed * 80 !== bytes.length) throw invalid();
  const missing = [];
  for (let index = 0; index < listed; index += 1, at += 80) {
    missing.push({
      messageId: idToHex(bytes.subarray(at, at + 16)),
      blobRef: idToHex(bytes.subarray(at + 16, at + 48)),
      blobKey: bytes.slice(at + 48, at + 80),
    });
  }
  return { total, results, unsearched, missing };
}

// KCHP v1 (ABI.md): a 28-byte header, 128 bytes per message, 32 bytes of
// key per message, the texts, 32 bytes per retired blob, then the reactions
// a request for them asked for.
function decodeChatPage(bytes, includePins = false, includePolls = false, includeTopics = false) {
  const invalid = () => new KinEngineError(6, "Kin received an invalid chat page.");
  if (bytes.length < 28 || readAscii(bytes, 0, 4) !== "KCHP") throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw invalid();
  const total = view.getUint32(8, true), start = view.getUint32(12, true), count = view.getUint32(16, true);
  const textBytes = view.getUint32(20, true), retiredCount = view.getUint32(24, true);
  const keysAt = 28 + count * 128, textsAt = keysAt + count * 32, retiredAt = textsAt + textBytes;
  const reactionsAt = retiredAt + retiredCount * 32;
  if (count > MAX_CHAT_PAGE || start + count > total || reactionsAt > bytes.length) throw invalid();
  const zero = (slice) => slice.every((byte) => byte === 0);
  const messages = [];
  // Texts follow each other in record order, with no gaps or overlaps.
  let nextText = 0;
  const groupCounts = [], quoted = [], mentionFlags = [], pollRecords = [];
  for (let index = 0; index < count; index += 1) {
    const at = 28 + index * 128;
    const status = CHAT_STATUSES[bytes[at + 68]], contentKind = CHAT_CONTENT_KINDS[bytes[at + 69]];
    const textOffset = view.getUint32(at + 104, true), textLength = view.getUint32(at + 108, true);
    const postedAt = Number(view.getBigInt64(at + 48, true)), editedAt = Number(view.getBigInt64(at + 56, true));
    if (!status || !contentKind || view.getUint32(at + 64, true) !== start + index ||
      textOffset + textLength > textBytes || !Number.isSafeInteger(postedAt) || !Number.isSafeInteger(editedAt))
      throw invalid();
    const visible = status === "live" || status === "edited";
    const blobRef = bytes.subarray(at + 72, at + 104), blobKey = bytes.subarray(keysAt + index * 32, keysAt + index * 32 + 32);
    if (visible === zero(blobRef) || visible === zero(blobKey) || (!visible && textLength) ||
      (textLength && (contentKind !== "text" || textOffset !== nextText)) || (!textLength && textOffset) ||
      bytes[at + 70] > 1 || bytes[at + 71] > 3 || (bytes[at + 70] === 1 && !visible) || !zero(bytes.subarray(at + 122, at + 128)) ||
      // Poll fields (#135): present only when asked for, on a poll that shows.
      (bytes[at + 118] || bytes[at + 119] || view.getUint16(at + 120, true)) && !(includePolls && visible && contentKind === "poll" && bytes[at + 118] >= 2 && bytes[at + 118] <= 10 && bytes[at + 119] <= 3 && view.getUint16(at + 120, true) <= 64) ||
      (includePolls && visible && contentKind === "poll" && !bytes[at + 118]) ||
      (bytes[at + 71] && !visible) || ((bytes[at + 71] & 2) !== 0) !== (view.getUint16(at + 116, true) > 0) || view.getUint16(at + 116, true) > 20 ||
      (status === "edited" && !editedAt) || (status === "live" && editedAt))
      throw invalid();
    nextText += textLength;
    const groups = view.getUint32(at + 112, true);
    if (groups && !visible) throw invalid();
    groupCounts.push(groups);
    pollRecords.push(includePolls && contentKind === "poll" && visible
      ? { options: bytes[at + 118], multiple: (bytes[at + 119] & 1) !== 0, closed: (bytes[at + 119] & 2) !== 0, voters: view.getUint16(at + 120, true) }
      : null);
    quoted.push(bytes[at + 70] === 1);
    mentionFlags.push({ everyone: (bytes[at + 71] & 1) !== 0, count: view.getUint16(at + 116, true) });
    messages.push({
      messageId: idToHex(bytes.subarray(at, at + 16)),
      authorId: idToHex(bytes.subarray(at + 16, at + 32)),
      deviceId: idToHex(bytes.subarray(at + 32, at + 48)),
      postedAt,
      editedAt: editedAt || null,
      index: start + index,
      status,
      contentKind,
      blobRef: visible ? idToHex(blobRef) : null,
      blobKey: visible ? blobKey.slice() : null,
      // null: the arena doesn't hold it yet; fetch, decrypt and putChatTexts.
      text: textLength ? strictTextDecoder.decode(bytes.subarray(textsAt + textOffset, textsAt + textOffset + textLength)) : null,
      reactions: [],
      replyTo: null,
      mentions: { everyone: false, members: [] },
    });
  }
  if (nextText !== textBytes) throw invalid();
  // Per group: emoji length u8, the emoji, member count u32, 16 bytes a member.
  let cursor = reactionsAt;
  groupCounts.forEach((groups, index) => {
    for (let group = 0; group < groups; group += 1) {
      const length = bytes[cursor];
      if (cursor >= bytes.length || length < 1 || length > 32 || cursor + 1 + length + 4 > bytes.length) throw invalid();
      const emoji = strictTextDecoder.decode(bytes.subarray(cursor + 1, cursor + 1 + length));
      const members = view.getUint32(cursor + 1 + length, true);
      cursor += 1 + length + 4;
      if (members < 1 || cursor + members * 16 > bytes.length) throw invalid();
      const actors = [];
      for (let member = 0; member < members; member += 1) actors.push(idToHex(bytes.subarray(cursor + member * 16, cursor + member * 16 + 16)));
      cursor += members * 16;
      messages[index].reactions.push({ emoji, actors });
    }
  });
  // A quote entry (also a pin's message): the original's ID, state, content
  // kind, author, blob ref and key, index and the text held.
  const readQuote = () => {
    if (cursor + 108 > bytes.length) throw invalid();
    const state = CHAT_QUOTE_STATES[bytes[cursor + 16]], contentKind = bytes[cursor + 17] === 0 ? null : CHAT_CONTENT_KINDS[bytes[cursor + 17]];
    const ref = bytes.subarray(cursor + 36, cursor + 68), key = bytes.subarray(cursor + 68, cursor + 100);
    const originalIndex = view.getUint32(cursor + 100, true), length = view.getUint32(cursor + 104, true);
    const shown = state === "live" || state === "edited";
    if (!state || (state === "unknown") !== (contentKind === null) || bytes[cursor + 18] || bytes[cursor + 19] ||
      shown === zero(ref) || shown === zero(key) || (!shown && length) || (length && contentKind !== "text") ||
      (state === "unknown") !== (originalIndex === 0xffff_ffff) || cursor + 108 + length > bytes.length) throw invalid();
    const quote = {
      messageId: idToHex(bytes.subarray(cursor, cursor + 16)),
      state,
      contentKind,
      authorId: state === "unknown" ? null : idToHex(bytes.subarray(cursor + 20, cursor + 36)),
      index: state === "unknown" ? null : originalIndex,
      blobRef: shown ? idToHex(ref) : null,
      blobKey: shown ? key.slice() : null,
      text: length ? strictTextDecoder.decode(bytes.subarray(cursor + 108, cursor + 108 + length)) : null,
    };
    cursor += 108 + length;
    return quote;
  };
  // Quotes (#129), one per message flagged as a reply.
  quoted.forEach((flagged, index) => {
    if (flagged) messages[index].replyTo = readQuote();
  });
  // Mentions (#130): the named members of each message that has any, in
  // record order, ascending; "everyone" comes from the record's flag.
  mentionFlags.forEach((flags, index) => {
    messages[index].mentions.everyone = flags.everyone;
    if (!flags.count) return;
    if (cursor + flags.count * 16 > bytes.length) throw invalid();
    let previous = "";
    for (let member = 0; member < flags.count; member += 1) {
      const id = idToHex(bytes.subarray(cursor, cursor + 16));
      if (id <= previous || /^0{32}$/.test(id)) throw invalid();
      messages[index].mentions.members.push(id);
      previous = id;
      cursor += 16;
    }
  });
  // Pins (#131), when asked for: a count (at most 10), then per pin who pinned
  // it and the message as a quote entry; only messages that show.
  const pins = [];
  if (includePins) {
    if (cursor + 4 > bytes.length) throw invalid();
    const pinCount = view.getUint32(cursor, true);
    cursor += 4;
    if (pinCount > 10) throw invalid();
    for (let pin = 0; pin < pinCount; pin += 1) {
      if (cursor + 16 > bytes.length) throw invalid();
      const pinnedBy = idToHex(bytes.subarray(cursor, cursor + 16));
      cursor += 16;
      const message = readQuote();
      if ((message.state !== "live" && message.state !== "edited") || /^0{32}$/.test(pinnedBy)) throw invalid();
      pins.push({ ...message, pinnedBy });
    }
  }
  // Polls (#135), when asked for: each shown poll's votes in record order,
  // voters ascending, each with their choice as a bit set.
  pollRecords.forEach((poll, index) => {
    if (!poll) return;
    const votes = [];
    let previous = "";
    for (let voter = 0; voter < poll.voters; voter += 1) {
      if (cursor + 20 > bytes.length) throw invalid();
      const memberId = idToHex(bytes.subarray(cursor, cursor + 16));
      const mask = view.getUint16(cursor + 16, true);
      if (memberId <= previous || /^0{32}$/.test(memberId) || mask === 0 || mask >> poll.options !== 0 ||
        (!poll.multiple && (mask & (mask - 1)) !== 0) || bytes[cursor + 18] || bytes[cursor + 19]) throw invalid();
      votes.push({ memberId, choice: [...Array(poll.options).keys()].filter((option) => (mask >> option) & 1) });
      previous = memberId;
      cursor += 20;
    }
    messages[index].poll = { options: poll.options, multiple: poll.multiple, closed: poll.closed, votes };
  });
  // Topics (#312), when asked for, last: a count (at most 200), then per
  // topic, newest change first, its message ID, state (1 open, 2 resolved),
  // 3 zero bytes, who flagged it and the message as a quote entry; only
  // messages that show.
  const topics = [];
  if (includeTopics) {
    if (cursor + 4 > bytes.length) throw invalid();
    const topicCount = view.getUint32(cursor, true);
    cursor += 4;
    if (topicCount > MAX_CHAT_TOPICS) throw invalid();
    const seen = new Set();
    for (let topic = 0; topic < topicCount; topic += 1) {
      if (cursor + 36 > bytes.length) throw invalid();
      const messageId = idToHex(bytes.subarray(cursor, cursor + 16));
      const state = CHAT_TOPIC_STATES[bytes[cursor + 16]];
      const flaggedBy = idToHex(bytes.subarray(cursor + 20, cursor + 36));
      if ((state !== "open" && state !== "resolved") || !zero(bytes.subarray(cursor + 17, cursor + 20)) ||
        /^0{32}$/.test(messageId) || /^0{32}$/.test(flaggedBy) || seen.has(messageId)) throw invalid();
      cursor += 36;
      const quote = readQuote();
      if (quote.messageId !== messageId || (quote.state !== "live" && quote.state !== "edited")) throw invalid();
      seen.add(messageId);
      topics.push({ messageId, state, flaggedBy, quote });
    }
  }
  if (cursor !== bytes.length) throw invalid();
  const retired = [];
  for (let index = 0; index < retiredCount; index += 1)
    retired.push(idToHex(bytes.subarray(retiredAt + index * 32, retiredAt + index * 32 + 32)));
  return { total, start, messages, retired, pins, topics };
}

// KCHT v1 / KCHS v1 (ABI.md).
function putChatTexts(exports, entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_CHAT_PAGE)
    throw new KinEngineError(2, "Kin received invalid chat texts.");
  const encoded = entries.map(({ blobRef, text }) => {
    // A lone surrogate would be encoded as U+FFFD, so Rust would check
    // different text from the host's.
    if (typeof text !== "string" || !text.isWellFormed()) throw new KinEngineError(2, "Kin received invalid chat texts.");
    return [blobFromHex(blobRef, "reference"), textEncoder.encode(text)];
  });
  const request = new Uint8Array(12 + encoded.reduce((sum, [, text]) => sum + 36 + text.length, 0));
  const view = new DataView(request.buffer);
  request.set([75, 67, 72, 84, 1, 0, 0, 0]);
  view.setUint32(8, entries.length, true);
  let offset = 12;
  for (const [blobRef, text] of encoded) {
    request.set(blobRef, offset);
    view.setUint32(offset + 32, text.length, true);
    request.set(text, offset + 36);
    offset += 36 + text.length;
  }
  const bytes = callCore(exports, "kin_chat_text", request);
  if (bytes.length !== 12 + entries.length || readAscii(bytes, 0, 4) !== "KCHS" || bytes[4] !== 1 ||
    bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0 ||
    new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true) !== entries.length ||
    bytes.subarray(12).some((status) => status > 1))
    throw new KinEngineError(6, "Kin received an invalid chat text result.");
  return [...bytes.subarray(12)].map((status) => status === 0);
}

// KDEV v1 (ABI.md): "KDEV", version u16, reserved u16, count u32, then per
// device its ID and member ID (16 bytes each), automatic-name and nickname
// lengths (u16 each; a zero automatic-name length means it is not in this
// history) and the two UTF-8 names. Every entry has at least one name.
function decodeDeviceNames(bytes) {
  const invalid = () => new KinEngineError(6, "Kin received invalid device names.");
  if (bytes.length < 12 || readAscii(bytes, 0, 4) !== "KDEV") throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw invalid();
  const count = view.getUint32(8, true);
  const devices = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    if (offset + 36 > bytes.length) throw invalid();
    const autoLength = view.getUint16(offset + 32, true);
    const nicknameLength = view.getUint16(offset + 34, true);
    const end = offset + 36 + autoLength + nicknameLength;
    if (autoLength + nicknameLength < 1 || end > bytes.length) throw invalid();
    devices.push({
      deviceId: idToHex(bytes.subarray(offset, offset + 16)),
      memberId: idToHex(bytes.subarray(offset + 16, offset + 32)),
      autoName: autoLength
        ? strictTextDecoder.decode(bytes.subarray(offset + 36, offset + 36 + autoLength))
        : null,
      nickname: nicknameLength
        ? strictTextDecoder.decode(bytes.subarray(offset + 36 + autoLength, end))
        : null,
    });
    offset = end;
  }
  if (offset !== bytes.length) throw invalid();
  return devices;
}

// KMNM v1 (ABI.md, #224): "KMNM", version u16, reserved u16, count u32,
// then per member its ID (16 bytes), name length u16 (nonzero) and UTF-8 name.
export function decodeMemberNames(bytes) {
  const invalid = () => new KinEngineError(6, "Kin received invalid member names.");
  if (bytes.length < 12 || readAscii(bytes, 0, 4) !== "KMNM") throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw invalid();
  const count = view.getUint32(8, true);
  const members = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    if (offset + 18 > bytes.length) throw invalid();
    const length = view.getUint16(offset + 16, true);
    const end = offset + 18 + length;
    if (length < 1 || end > bytes.length) throw invalid();
    members.push({
      memberId: idToHex(bytes.subarray(offset, offset + 16)),
      name: strictTextDecoder.decode(bytes.subarray(offset + 18, end)),
    });
    offset = end;
  }
  if (offset !== bytes.length) throw invalid();
  return members;
}

export function randomId() {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  return id;
}

export function idFromHex(value) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new KinEngineError(4, "Kin received an invalid household reference.");
  }
  const id = new Uint8Array(16);
  for (let index = 0; index < id.length; index += 1) {
    id[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return id;
}

// Compatibility helpers encode intent packets; Rust alone writes event bytes.
export const encodeAddedRecord = (value) => encodeIntent("add", value);
export const encodeCompletedRecord = (value) => encodeIntent("complete", value);
export const encodeReopenedRecord = (value) => encodeIntent("reopen", value);
export const encodeArchivedRecord = (value) => encodeIntent("archive", value);
export const encodeHandoffAddedRecord = (value) =>
  encodeIntent("add-handoff", value);
export const encodeHandoffAcknowledgedRecord = (value) =>
  encodeIntent("acknowledge-handoff", value);
export const encodeHandoffArchivedRecord = (value) =>
  encodeIntent("archive-handoff", value);
export const encodeTalkAddedRecord = (value) => encodeIntent("add-talk", value);
export const encodeTalkResolvedRecord = (value) =>
  encodeIntent("resolve-talk", value);
export const encodeTalkReopenedRecord = (value) =>
  encodeIntent("reopen-talk", value);
export const encodeTalkArchivedRecord = (value) =>
  encodeIntent("archive-talk", value);
export const encodePulseSetRecord = (value) => encodeIntent("set-pulse", value);
export const encodePulseClearedRecord = (value) =>
  encodeIntent("clear-pulse", value);
export const encodeRoutineCreatedRecord = (value) =>
  encodeIntent("create-routine", value);
export const encodeRoutineActionRecord = (value) =>
  encodeIntent(
    {
      complete: "complete-routine-occurrence",
      reopen: "reopen-routine-occurrence",
      archive: "archive-routine",
    }[value.action],
    value,
  );
export const encodeNoteCreatedRecord = (value) => encodeIntent("create-note", value);
export const encodeNoteUpdatedRecord = (value) => encodeIntent("update-note", value);
export const encodeNoteArchivedRecord = (value) => encodeIntent("archive-note", value);
export const encodeHouseholdModeRecord = (value) =>
  encodeIntent("set-household-mode", value);
export const encodeItemPlanningDateRecord = (value) =>
  encodeIntent("set-item-planning-date", value);
export const eventMetadata = (bytes) =>
  decodeMetadata(callCore(sharedCodec, "kin_event_metadata", asBytes(bytes)));
export const eventMetadataBatch = (records) =>
  metadataBatch(sharedCodec, records);

const COMMAND_TYPES = [
  null,
  "add",
  "complete",
  "reopen",
  "archive",
  "add-handoff",
  "acknowledge-handoff",
  "archive-handoff",
  "add-talk",
  "resolve-talk",
  "reopen-talk",
  "archive-talk",
  "set-pulse",
  "clear-pulse",
  "create-routine",
  "complete-routine-occurrence",
  "reopen-routine-occurrence",
  "archive-routine",
  "create-area",
  "rename-area",
  "archive-area",
  "change-item-area",
  "create-note",
  "update-note",
  "archive-note",
  "add-item-step",
  "complete-item-step",
  "reopen-item-step",
  "archive-item-step",
  "set-household-mode",
  "set-item-planning-date",
  "pin",
  "unpin",
  "save-playbook",
  "archive-playbook",
  "save-reference-record",
  "archive-reference-record",
  "save-maintenance-event",
  "archive-maintenance-event",
  "bind-attachment",
  "remove-attachment",
  "change-responsibility",
  "describe-device",
  "nickname-device",
  "post-chat-message",
  "edit-chat-message",
  "delete-chat-message",
  "react-chat-message",
  "pin-chat-message",
  "vote-chat-poll",
  "close-chat-poll",
  // A member's own preferred display name (#224): KCMD action 51.
  "name-member",
  // The fridge (#317): KCMD actions 52–58, encoded by kin-board.js.
  ...BOARD_COMMANDS,
  // Meals (#333): KCMD actions 59–63, encoded by kin-meals.js.
  ...MEAL_COMMANDS,
  // Simple view (#344): KCMD action 64, encoded by kin-simple.js.
  ...SIMPLE_COMMANDS,
  // "Talk later" (#312): KCMD action 65, a chat command; its state rides in
  // the u8 field.
  "set-chat-topic",
  // Store sections (#411): KCMD actions 66–67, encoded by kin-sections.js.
  ...SECTION_COMMANDS,
  // Taking turns (#429): KCMD actions 68–69, encoded by kin-rotations.js.
  ...ROTATION_COMMANDS,
  // The sitter page (#442): KCMD action 70, encoded by kin-sitter.js.
  ...SITTER_COMMANDS,
  // The family calendar (#656): KCMD actions 71–74, encoded by
  // kin-calendar.js.
  ...CALENDAR_COMMANDS,
];
// Fuller meal plans (#679): KCMD actions 80–82, encoded by kin-meals.js.
// Placed by code, after a gap of codes used by other family-hub kinds.
MEAL_PLAN_COMMANDS.forEach((type, index) => { COMMAND_TYPES[FIRST_MEAL_PLAN_KIND + index] = type; });
// The chore chart (#676): KCMD actions 77–79, encoded by kin-chores.js. Set
// by position: 71–76 belong to other family-hub kinds (ADR 0022).
CHORE_COMMANDS.forEach((type, index) => { COMMAND_TYPES[FIRST_CHORE_KIND + index] = type; });
const EVENT_KINDS = [
  null,
  "ITEM_ADDED",
  "ITEM_COMPLETED",
  "ITEM_REOPENED",
  "ITEM_ARCHIVED",
  "HANDOFF_ADDED",
  "HANDOFF_ACKNOWLEDGED",
  "HANDOFF_ARCHIVED",
  "TALK_ADDED",
  "TALK_RESOLVED",
  "TALK_REOPENED",
  "TALK_ARCHIVED",
  "PULSE_SET",
  "PULSE_CLEARED",
  "ROUTINE_CREATED",
  "ROUTINE_OCCURRENCE_COMPLETED",
  "ROUTINE_OCCURRENCE_REOPENED",
  "ROUTINE_ARCHIVED",
  "AREA_CREATED",
  "AREA_RENAMED",
  "AREA_ARCHIVED",
  "ITEM_AREA_CHANGED",
  "NOTE_CREATED",
  "NOTE_UPDATED",
  "NOTE_ARCHIVED",
  "ITEM_STEP_ADDED",
  "ITEM_STEP_COMPLETED",
  "ITEM_STEP_REOPENED",
  "ITEM_STEP_ARCHIVED",
  "HOUSEHOLD_MODE_CHANGED",
  "ITEM_PLANNING_DATE_CHANGED",
  "PIN_ADDED",
  "PIN_REMOVED",
  "PLAYBOOK_SAVED",
  "PLAYBOOK_ARCHIVED",
  "REFERENCE_RECORD_SAVED",
  "REFERENCE_RECORD_ARCHIVED",
  "MAINTENANCE_EVENT_SAVED",
  "MAINTENANCE_EVENT_ARCHIVED",
  "ATTACHMENT_BOUND",
  "ATTACHMENT_REMOVED",
  "RESPONSIBILITY_CHANGED",
  "DEVICE_DESCRIBED",
  "DEVICE_NICKNAMED",
  "CHAT_MESSAGE_POSTED",
  "CHAT_MESSAGE_EDITED",
  "CHAT_MESSAGE_DELETED",
  "CHAT_REACTION_SET",
  "CHAT_PIN_SET",
  "CHAT_POLL_VOTE",
  "CHAT_POLL_CLOSED",
  "MEMBER_NAMED",
  ...BOARD_EVENT_KINDS,
  ...MEAL_EVENT_KINDS,
  ...SIMPLE_EVENT_KINDS,
  "CHAT_TOPIC_SET",
  ...SECTION_EVENT_KINDS,
  ...ROTATION_EVENT_KINDS,
  ...SITTER_EVENT_KINDS,
  ...CALENDAR_EVENT_KINDS,
];
// The chore chart (#676): kinds 77–79.
CHORE_EVENT_KINDS.forEach((kind, index) => { EVENT_KINDS[FIRST_CHORE_KIND + index] = kind; });
// A member's private log (#489): kinds from 100, after a gap of unused codes.
PRIVATE_EVENT_KINDS.forEach((kind, index) => { EVENT_KINDS[FIRST_PRIVATE_KIND + index] = kind; });
// "Just for me" (#510): kinds 110–118.
PRIVATE_ITEM_EVENT_KINDS.forEach((kind, index) => { EVENT_KINDS[FIRST_PRIVATE_ITEM_KIND + index] = kind; });
// The journal (#496): kinds 101–104.
JOURNAL_EVENT_KINDS.forEach((kind, index) => { EVENT_KINDS[FIRST_JOURNAL_KIND + index] = kind; });
// Reminders and settings (#520): kinds 120, 121 and 130.
for (const [kind, code] of Object.entries(PREFS_KIND_CODES)) EVENT_KINDS[code] = kind;
// The family album (#673): kinds and KCMD actions 75–76, encoded by
// kin-album.js. Placed by number, so the kinds other stories add (71–74,
// 77–82) can sit around them.
ALBUM_COMMANDS.forEach((type, index) => { COMMAND_TYPES[FIRST_ALBUM_KIND + index] = type; });
ALBUM_EVENT_KINDS.forEach((kind, index) => { EVENT_KINDS[FIRST_ALBUM_KIND + index] = kind; });
// Fuller meal plans (#679): kinds 80–82.
MEAL_PLAN_EVENT_KINDS.forEach((kind, index) => { EVENT_KINDS[FIRST_MEAL_PLAN_KIND + index] = kind; });

// The command field that names each event's own entity (packet offset 92).
// Other ID fields on a command are references to a different entity: a
// note's or reference record's areaId, a maintenance entry's routineId and
// recordId, a step's itemId, an attachment's parentId. A reference must never
// become the entity ID, so the field is chosen by command type, not by which
// ID happens to be present. Pulse and household-mode commands carry none.
const ENTITY_FIELDS = Object.freeze({
  add: "itemId",
  complete: "itemId",
  reopen: "itemId",
  archive: "itemId",
  "add-handoff": "handoffId",
  "acknowledge-handoff": "handoffId",
  "archive-handoff": "handoffId",
  "add-talk": "talkId",
  "resolve-talk": "talkId",
  "reopen-talk": "talkId",
  "archive-talk": "talkId",
  "create-routine": "routineId",
  "complete-routine-occurrence": "routineId",
  "reopen-routine-occurrence": "routineId",
  "archive-routine": "routineId",
  "create-area": "areaId",
  "rename-area": "areaId",
  "archive-area": "areaId",
  "change-item-area": "itemId",
  "create-note": "noteId",
  "update-note": "noteId",
  "archive-note": "noteId",
  "add-item-step": "stepId",
  "complete-item-step": "stepId",
  "reopen-item-step": "stepId",
  "archive-item-step": "stepId",
  "set-item-planning-date": "itemId",
  pin: "targetId",
  unpin: "targetId",
  "save-playbook": "playbookId",
  "archive-playbook": "playbookId",
  "save-reference-record": "recordId",
  "archive-reference-record": "recordId",
  "save-maintenance-event": "maintenanceId",
  "archive-maintenance-event": "maintenanceId",
  "bind-attachment": "attachmentId",
  "remove-attachment": "attachmentId",
  "change-responsibility": "targetId",
  "nickname-device": "targetDeviceId",
  "post-chat-message": "messageId",
  "edit-chat-message": "messageId",
  "delete-chat-message": "messageId",
  "react-chat-message": "messageId",
  "pin-chat-message": "messageId",
  "vote-chat-poll": "messageId",
  "close-chat-poll": "messageId",
  "set-chat-topic": "messageId",
});

/** The entity ID an intent packet carries: the type's own field, else `id`, else the caller's fallback. */
export function commandEntityId(command, identity = {}) {
  const field = Object.hasOwn(ENTITY_FIELDS, command.type) ? ENTITY_FIELDS[command.type] : null;
  if (!field) throw new KinEngineError(2, "Kin received an invalid household action.");
  return command[field] ?? command.id ?? identity.entityId;
}

function encodeIntent(type, value) {
  return callCore(
    sharedCodec,
    "kin_encode_command",
    encodeIntentPacket({ ...value, type }, value),
  );
}

function encodeIntentPacket(command, identity) {
  const kind = COMMAND_TYPES.indexOf(command.type);
  // Meals (59–63, and 80–82 for fuller meal plans) carry their canonical
  // payload (kin-meals.js).
  if ((kind >= 59 && kind <= 63) || (kind >= FIRST_MEAL_PLAN_KIND && kind < FIRST_MEAL_PLAN_KIND + MEAL_PLAN_COMMANDS.length)) {
    try { return encodeMealIntent(command, identity); }
    catch (error) {
      if (error instanceof MealFormatError) throw new KinEngineError(2, error.message);
      throw error;
    }
  }
  // An item's emoji (64) carries its canonical payload (kin-simple.js).
  if (kind === 64) {
    try { return encodeItemEmojiIntent(command, identity); }
    catch (error) {
      if (error instanceof SimpleFormatError) throw new KinEngineError(2, error.message);
      throw error;
    }
  }
  // Store sections (66–67) carry their canonical payload (kin-sections.js).
  if (kind === 66 || kind === 67) {
    try { return encodeSectionIntent(command, identity); }
    catch (error) {
      if (error instanceof SectionFormatError) throw new KinEngineError(2, error.message);
      throw error;
    }
  }
  // Rotations (68–69) carry their canonical payload (kin-rotations.js).
  if (kind === 68 || kind === 69) {
    try { return encodeRotationIntent(command, identity); }
    catch (error) {
      if (error instanceof RotationFormatError) throw new KinEngineError(2, error.message);
      throw error;
    }
  }
  // The sitter page (70) carries its canonical payload (kin-sitter.js).
  if (kind === 70) {
    try { return encodeSitterIntent(command, identity); }
    catch (error) {
      if (error instanceof SitterFormatError) throw new KinEngineError(2, error.message);
      throw error;
    }
  }
  // The family album (75–76) carries its canonical payloads (kin-album.js).
  if (kind === FIRST_ALBUM_KIND || kind === FIRST_ALBUM_KIND + 1) {
    try { return encodeAlbumIntent(command, identity); }
    catch (error) {
      if (error instanceof AlbumFormatError) throw new KinEngineError(2, error.message);
      throw error;
    }
  }
  // The family calendar (71–74) carries its canonical payloads
  // (kin-calendar.js).
  if (kind >= 71 && kind <= 74) {
    try { return encodeCalendarIntent(command, identity); }
    catch (error) {
      if (error instanceof CalendarFormatError) throw new KinEngineError(2, error.message);
      throw error;
    }
  }
  // The chore chart (77–79) carries its canonical payload (kin-chores.js).
  if (kind >= FIRST_CHORE_KIND && kind < FIRST_CHORE_KIND + CHORE_COMMANDS.length) {
    try { return encodeChoreIntent(command, identity); }
    catch (error) {
      if (error instanceof ChoreFormatError) throw new KinEngineError(2, error.message);
      throw error;
    }
  }
  // Fridge actions (52+) have their own encoder and log (kin-board.js); a
  // chat topic (65) is a classic packet.
  if (kind < 1 || (kind >= 52 && kind !== 65))
    throw new KinEngineError(2, "Kin received an invalid household action.");
  const hasText = [1, 5, 8, 14, 18, 19, 47].includes(kind);
  // A reaction's text is its emoji; Rust checks it is one emoji.
  const text = kind === 47 ? command.emoji : hasText ? (command.name ?? command.text) : "";
  const stepText = kind === 25 ? textEncoder.encode(command.text ?? "") : null;
  if (
    kind === 25 &&
    (typeof command.text !== "string" ||
      strictTextDecoder.decode(stepText) !== command.text ||
      command.text.trim() !== command.text ||
      [...command.text].length < 1 ||
      [...command.text].length > MAX_STEP_TEXT_CHARS ||
      stepText.length > MAX_STEP_TEXT_BYTES ||
      [...command.text].some((character) => /\p{Cc}/u.test(character)))
  ) {
    throw new KinEngineError(2, "Step text must be short plain text.");
  }
  const noteTitle = kind === 22 || kind === 23 ? textEncoder.encode(command.title ?? "") : null;
  const noteBody = kind === 22 || kind === 23 ? textEncoder.encode(command.body ?? "") : null;
  if ((kind === 22 || kind === 23) && (typeof command.title !== "string" || typeof command.body !== "string" || strictTextDecoder.decode(noteTitle) !== command.title || strictTextDecoder.decode(noteBody) !== command.body || noteTitle.length > 256 || noteBody.length > 4096))
    throw new KinEngineError(2, "Note text must be valid Unicode and within its supported size.");
  // A member's own name (51) travels like a nickname: empty clears it.
  const deviceName = kind === 42 ? command.autoName : kind === 43 || kind === 51 ? (command.nickname ?? command.name ?? "") : null;
  const deviceNameBytes = deviceName === null ? null : textEncoder.encode(deviceName);
  // Rust trims and checks device names; this only keeps the packet well formed.
  if (
    deviceName !== null &&
    (typeof deviceName !== "string" ||
      strictTextDecoder.decode(deviceNameBytes) !== deviceName ||
      deviceNameBytes.length > MAX_DEVICE_NAME_BYTES ||
      (kind === 42 && deviceNameBytes.length < 1) ||
      (kind === 43 && !/^[a-f0-9]{32}$/.test(command.targetDeviceId ?? "")))
  ) {
    throw new KinEngineError(2, kind === 51 ? "A name must be short plain text." : "A device name must be short plain text.");
  }
  const textBytes = textEncoder.encode(text);
  const playbookBytes = kind === 33 ? encodePlaybookPayload(command) : null;
  const referenceBytes = kind === 35 ? encodeReferencePayload(command) : null;
  const maintenanceBytes = kind === 37 ? encodeMaintenancePayload(command) : null;
  // Chat (#109): the content blob's reference and key; Rust checks the rest.
  const chatBlob = kind === 44 || kind === 45
    ? Uint8Array.of(
      ...blobFromHex(command.blobRef, "reference"), ...blobFromHex(command.blobKey, "key"),
      // After the blob: mentions (#130), then the message a reply answers
      // (#129), as ABI.md lays them out.
      ...mentionsTail(command.mentions, kind === 44 && command.replyTo != null ? replyFromHex(command.replyTo) : null, kind === 44))
    : null;
  if (
    hasText &&
    (typeof text !== "string" ||
      strictTextDecoder.decode(textBytes) !== text ||
      textBytes.length < 1 ||
      textBytes.length > ([18, 19].includes(kind) ? 96 : MAX_ITEM_TEXT_BYTES))
  ) {
    throw new KinEngineError(
      2,
      "Text must be valid Unicode and no more than 4096 UTF-8 bytes.",
    );
  }
  const stepAction = kind >= 25 && kind <= 28;
  const packet = new Uint8Array(
    128 +
      (kind === 21 || (stepAction && kind !== 25)
        ? 16
        : kind === 25
          ? 16 + stepText.length
          : kind === 22 || kind === 23
            ? 24 + noteTitle.length + noteBody.length
            : kind === 33 ? playbookBytes.length : kind === 35 ? referenceBytes.length : kind === 37 ? maintenanceBytes.length : kind === 39 || kind === 41 ? 16 : chatBlob ? chatBlob.length : deviceNameBytes ? deviceNameBytes.length : textBytes.length),
  );
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  const view = new DataView(packet.buffer);
  view.setUint16(8, kind, true);
  for (const [name, offset] of [
    ["eventId", 12],
    ["householdId", 28],
    ["actorId", 44],
    ["deviceId", 60],
  ]) {
    packet.set(
      typeof identity[name] === "string"
        ? idFromHex(identity[name])
        : assertId(identity[name]),
      offset,
    );
  }
  assertTimestamp(identity.timestamp);
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n || logicalTime > MAX_LOGICAL_TIME)
    throw new KinEngineError(2, "Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  if (![12, 13, 29, 42, 51].includes(kind)) {
    const entity = commandEntityId(command, identity);
    packet.set(
      typeof entity === "string" ? idFromHex(entity) : assertId(entity),
      92,
    );
  }
  if ([14, 15, 16, 30].includes(kind)) {
    const date = kind === 14
      ? command.createdOn
      : kind === 30
        ? command.planningDate
        : command.occurrenceKey;
    if (kind === 30 && date === null) {
      view.setUint32(108, 0, true);
    } else {
      assertCivilDate(date);
      view.setUint32(108, date, true);
    }
  }
  if (kind === 1) {
    const code = ["today", "need", "shopping", "staple"].indexOf(command.classification ?? "need");
    if (code < 0) throw new KinEngineError(2, "Choose a valid list.");
    packet[112] = code;
  } else if (kind === 12) {
    const code = PULSE_VALUES.indexOf(command.value);
    if (code < 0) throw new KinEngineError(2, "Choose a valid capacity.");
    packet[112] = code;
    assertTimestamp(command.expiresAt);
    view.setBigInt64(116, BigInt(command.expiresAt), true);
  } else if (kind === 14) {
    const code = ROUTINE_CADENCES.indexOf(command.cadence);
    if (code < 0) throw new KinEngineError(2, "Choose a valid cadence.");
    packet[112] = code;
  } else if (kind === 29) {
    const code = ["normal", "vacation", "guests", "rest"].indexOf(command.mode);
    if (code < 0) throw new KinEngineError(2, "Choose a valid household mode.");
    packet[112] = code;
  } else if (kind === 31 || kind === 32) {
    const code = ["", "item", "note", "routine", "area"].indexOf(command.targetKind);
    if (code < 1) throw new KinEngineError(2, "Choose a valid Pin target.");
    packet[112] = code;
  } else if (kind === 39) {
    const code = ["", "note", "reference-record", "maintenance", "item"].indexOf(command.parentKind);
    if (code < 1 || !/^[a-f0-9]{32}$/.test(command.parentId ?? "")) throw new KinEngineError(2, "Choose a valid attachment parent.");
    packet[112] = code;
    packet.set(idFromHex(command.parentId), 128);
    view.setUint32(124, 16, true);
  } else if (kind === 41) {
    const targetKind = ["", "item", "routine"].indexOf(command.targetKind);
    if (targetKind < 1 || (command.memberId !== null && !/^[a-f0-9]{32}$/.test(command.memberId ?? ""))) throw new KinEngineError(2, "Choose a household member.");
    packet[112] = targetKind;
    packet.set(command.memberId ? idFromHex(command.memberId) : new Uint8Array(16), 128);
    view.setUint32(124, 16, true);
  } else if (kind === 44) {
    const code = CHAT_CONTENT_KINDS.indexOf(command.contentKind ?? "text");
    if (code < 1) throw new KinEngineError(2, "Kin received an invalid chat message.");
    packet[112] = code;
    if (code === 3) {
      // A poll (#135): the option count and the multiple-choice flag ride in
      // the date field (ABI.md).
      const { options, multiple = false } = command.poll ?? {};
      if (!Number.isInteger(options) || options < 2 || options > 10 || typeof multiple !== "boolean")
        throw new KinEngineError(2, "A poll needs 2 to 10 options.");
      view.setUint32(108, options | (multiple ? 0x100 : 0), true);
    }
  } else if (kind === 49) {
    // A poll vote (#135): the chosen option numbers as a bit set in the date
    // field; none clears the member's vote.
    const choice = command.choice;
    if (!Array.isArray(choice) || choice.length > 10 || choice.some((option, at) => !Number.isInteger(option) || option < 0 || option > 9 || choice.indexOf(option) !== at))
      throw new KinEngineError(2, "Kin received an invalid vote.");
    view.setUint32(108, choice.reduce((mask, option) => mask | (1 << option), 0), true);
  } else if (kind === 46) {
    if (typeof (command.byAdmin ?? false) !== "boolean") throw new KinEngineError(2, "Kin received an invalid chat message.");
    packet[112] = command.byAdmin ? 1 : 0;
  } else if (kind === 47) {
    if (typeof command.on !== "boolean") throw new KinEngineError(2, "Kin received an invalid reaction.");
    packet[112] = command.on ? 1 : 0;
  } else if (kind === 48) {
    if (typeof command.on !== "boolean") throw new KinEngineError(2, "Kin received an invalid pin.");
    packet[112] = command.on ? 1 : 0;
  } else if (kind === 65) {
    // "Talk later" (#312): 0 cleared, 1 open, 2 resolved.
    const code = CHAT_TOPIC_STATES.indexOf(command.state);
    if (code < 0) throw new KinEngineError(2, "Kin received an invalid topic.");
    packet[112] = code;
  } else if (kind === 33) {
    packet.set(playbookBytes, 128);
    view.setUint32(124, playbookBytes.length, true);
  } else if (kind === 35) {
    packet.set(referenceBytes, 128);
    view.setUint32(124, referenceBytes.length, true);
  } else if (kind === 37) {
    packet.set(maintenanceBytes, 128);
    view.setUint32(124, maintenanceBytes.length, true);
  }
  if (kind === 22 || kind === 23) {
    packet.set(command.areaId ? idFromHex(command.areaId) : new Uint8Array(16), 128);
    view.setUint32(144, noteTitle.length, true); view.setUint32(148, noteBody.length, true);
    packet.set(noteTitle, 152); packet.set(noteBody, 152 + noteTitle.length);
    view.setUint32(124, 24 + noteTitle.length + noteBody.length, true);
  } else if (kind === 21) {
    packet.set(command.areaId ? idFromHex(command.areaId) : new Uint8Array(16), 128);
    view.setUint32(124, 16, true);
  } else if (kind === 25) {
    packet.set(idFromHex(command.itemId), 128);
    packet.set(stepText, 144);
    view.setUint32(124, 16 + stepText.length, true);
  } else if (stepAction) {
    packet.set(idFromHex(command.itemId), 128);
    view.setUint32(124, 16, true);
  } else if (chatBlob) {
    packet.set(chatBlob, 128);
    view.setUint32(124, chatBlob.length, true);
  } else if (kind === 33 || kind === 35 || kind === 37 || kind === 39 || kind === 41 || kind === 46 || kind === 48) {
    // The Playbook packet payload was encoded above; a chat deletion or pin has none.
  } else if (deviceNameBytes) {
    view.setUint32(124, deviceNameBytes.length, true);
    packet.set(deviceNameBytes, 128);
  } else {
    view.setUint32(124, textBytes.length, true);
    packet.set(textBytes, 128);
  }
  return packet;
}

function encodeMaintenancePayload(command) {
  const summary = textEncoder.encode(command.summary ?? "");
  if (typeof command.summary !== "string" || summary.length < 1 || summary.length > 240 || strictTextDecoder.decode(summary) !== command.summary || command.summary.trim() !== command.summary || [...command.summary].some((character) => /\p{Cc}/u.test(character)))
    throw new KinEngineError(2, "Add a short maintenance note.");
  assertCivilDate(command.performedOn);
  if (command.nextOn != null) {
    assertCivilDate(command.nextOn);
    if (command.nextOn < command.performedOn) throw new KinEngineError(2, "The next date must be on or after the performed date.");
  }
  const bytes = new Uint8Array(42 + summary.length), view = new DataView(bytes.buffer);
  bytes.set(idFromHex(command.recordId), 0);
  view.setUint32(16, command.performedOn, true);
  view.setUint32(20, command.nextOn ?? 0, true);
  bytes.set(command.routineId ? idFromHex(command.routineId) : new Uint8Array(16), 24);
  view.setUint16(40, summary.length, true); bytes.set(summary, 42);
  return bytes;
}

function encodeReferencePayload(command) {
  if (typeof command.title !== "string" || !Array.isArray(command.fields) || command.fields.length < 1 || command.fields.length > 16)
    throw new KinEngineError(2, "A reference record needs a title and one to sixteen fields.");
  const title = textEncoder.encode(command.title.trim());
  const fields = command.fields.map((field) => {
    if (typeof field.label !== "string" || typeof field.value !== "string") throw new KinEngineError(2, "Reference field labels and values must be text.");
    const labelText = field.label.trim();
    return { id: idFromHex(field.fieldId), labelText, label: textEncoder.encode(labelText), valueText: field.value, value: textEncoder.encode(field.value) };
  });
  if (strictTextDecoder.decode(title) !== command.title.trim() || !title.length || title.length > 128 || fields.some((field) => strictTextDecoder.decode(field.label) !== field.labelText || strictTextDecoder.decode(field.value) !== field.valueText || !field.label.length || field.label.length > 64 || field.value.length > 1024))
    throw new KinEngineError(2, "Reference record text is outside its supported size.");
  const size = 36 + title.length + fields.reduce((sum, field) => sum + 20 + field.label.length + field.value.length, 0);
  const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer);
  bytes.set(command.areaId ? idFromHex(command.areaId) : new Uint8Array(16), 16);
  view.setUint16(32, title.length, true); bytes[34] = fields.length;
  let offset = 36; bytes.set(title, offset); offset += title.length;
  for (const field of fields) { bytes.set(field.id, offset); view.setUint16(offset + 16, field.label.length, true); view.setUint16(offset + 18, field.value.length, true); offset += 20; bytes.set(field.label, offset); offset += field.label.length; bytes.set(field.value, offset); offset += field.value.length; }
  return bytes;
}

function encodePlaybookPayload(command) {
  if (typeof command.title !== "string" || !Array.isArray(command.entries) || command.entries.length < 1 || command.entries.length > 16)
    throw new KinEngineError(2, "A Playbook needs a title and one to sixteen entries.");
  const title = textEncoder.encode(command.title.trim());
  const entries = command.entries.map((entry) => textEncoder.encode(String(entry).trim()));
  if (title.length < 1 || title.length > 128 || entries.some((entry) => entry.length < 1 || entry.length > 256))
    throw new KinEngineError(2, "Playbook text is outside its supported size.");
  const size = 4 + title.length + entries.reduce((sum, entry) => sum + 2 + entry.length, 0);
  const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer);
  view.setUint16(0, title.length, true); bytes[2] = entries.length; bytes[3] = 0;
  let offset = 4; bytes.set(title, offset); offset += title.length;
  for (const entry of entries) { view.setUint16(offset, entry.length, true); offset += 2; bytes.set(entry, offset); offset += entry.length; }
  return bytes;
}

// KMET v1, 92 bytes (ABI.md): "KMET", version u16, reserved u16, then
// event ID @8, household @24, actor @40, device @56 (16 bytes each),
// timestamp i64 @72, logical time u64 @80, event version u16 @88, kind u16 @90.
function decodeMetadata(bytes) {
  if (bytes.length !== 92 || readAscii(bytes, 0, 4) !== "KMET")
    throw new KinEngineError(6, "Kin received invalid event metadata.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0)
    throw new KinEngineError(6, "Kin received unsupported event metadata.");
  const kind = EVENT_KINDS[view.getUint16(90, true)];
  if (!kind)
    throw new KinEngineError(6, "Kin received unsupported event metadata.");
  const timestamp = Number(view.getBigInt64(72, true));
  if (!Number.isSafeInteger(timestamp))
    throw new KinEngineError(6, "Kin received an invalid event timestamp.");
  const logicalTime = view.getBigUint64(80, true);
  if (logicalTime > MAX_LOGICAL_TIME)
    throw new KinEngineError(4, USER_MESSAGES.get(4));
  return {
    eventId: bytes.slice(8, 24),
    householdId: bytes.slice(24, 40),
    actorId: bytes.slice(40, 56),
    deviceId: bytes.slice(56, 72),
    timestamp,
    logicalTime,
    eventVersion: view.getUint16(88, true),
    kind,
  };
}

export const AUDIO_PEAK_COUNT = 64;
export const MAX_AUDIO_SAMPLES = 16_000_000;

function audioPeaks(exports, samples) {
  if (!(samples instanceof Float32Array) || samples.length < 1 || samples.length > MAX_AUDIO_SAMPLES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const request = new Uint8Array(12 + samples.length * 4);
  request.set([...textEncoder.encode("KAPQ"), 1, 0, 0, 0]);
  const view = new DataView(request.buffer);
  view.setUint32(8, samples.length, true);
  // Little-endian floats, whatever the host's byte order.
  for (let index = 0; index < samples.length; index += 1) view.setFloat32(12 + index * 4, samples[index], true);
  const output = callCore(exports, "kin_audio_peaks", request);
  if (output.length !== 8 + AUDIO_PEAK_COUNT || readAscii(output, 0, 4) !== "KAPR" || output[4] !== 1 || output[5] || output[6] || output[7])
    throw new KinEngineError(6, "Kin received invalid waveform data.");
  return output.slice(8);
}

function metadataBatch(exports, records) {
  if (!Array.isArray(records) || records.length > MAX_EVENT_COUNT)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const sources = records.map(asBytes);
  const length = sources.reduce((total, bytes) => total + 4 + bytes.length, 12);
  if (length > MAX_PROTOCOL_BYTES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const request = new Uint8Array(length);
  request.set([...textEncoder.encode("KMDQ"), 1, 0, 0, 0]); // magic, version 1, reserved
  const view = new DataView(request.buffer);
  view.setUint32(8, sources.length, true);
  let offset = 12;
  for (const source of sources) {
    view.setUint32(offset, source.length, true);
    request.set(source, offset + 4);
    offset += 4 + source.length;
  }
  const output = callCore(exports, "kin_event_metadata_batch", request);
  if (
    output.length !== 12 + 92 * sources.length ||
    readAscii(output, 0, 4) !== "KMDL"
  )
    throw new KinEngineError(6, "Kin received invalid batch metadata.");
  const resultView = new DataView(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  );
  if (
    resultView.getUint16(4, true) !== 1 ||
    resultView.getUint16(6, true) !== 0 ||
    resultView.getUint32(8, true) !== sources.length
  )
    throw new KinEngineError(6, "Kin received invalid batch metadata.");
  return sources.map((_, index) =>
    decodeMetadata(output.subarray(12 + 92 * index, 12 + 92 * (index + 1))),
  );
}

function executeCommand(
  exports,
  mirror,
  command,
  identity,
  records,
  asOf,
  cursor,
  civilDate,
  syncIdentity,
  previous,
) {
  const intent = encodeIntentPacket(
    {
      ...command,
      // Rust requires a new Routine's creation date to equal the request's
      // civil date, so the bridge fills it from the same value.
      ...(command.type === "create-routine" ? { createdOn: civilDate } : {}),
    },
    identity,
  );
  // Request layout: u32 intent length, the KCMD intent, then a record-less
  // KINE request giving the replay context; Rust validates the command
  // against the history the instance holds, brought up to date first. The
  // KCMT result is a 20-byte header ("KCMT", version, reserved, then event,
  // metadata and projection lengths as u32 @8, @12, @16) followed by those
  // three buffers.
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (records.length > MAX_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  const request = encodeRequest([], asOf, cursor, civilDate, syncIdentity, 4 + intent.length);
  new DataView(request.buffer).setUint32(0, intent.length, true);
  request.set(intent, 4);
  const release = mirror.hold(records);
  let bytes;
  try {
    bytes = callCore(exports, "kin_execute", request);
  } finally {
    release();
  }
  if (bytes.length < 20 || readAscii(bytes, 0, 4) !== "KCMT")
    throw new KinEngineError(6, "Kin received an invalid command result.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eventLength = view.getUint32(8, true),
    metadataLength = view.getUint32(12, true),
    stateLength = view.getUint32(16, true);
  if (
    view.getUint16(4, true) !== 1 ||
    view.getUint16(6, true) !== 0 ||
    20 + eventLength + metadataLength + stateLength !== bytes.length
  )
    throw new KinEngineError(6, "Kin received an invalid command result.");
  return {
    encodedEvent: bytes.slice(20, 20 + eventLength),
    metadata: decodeMetadata(
      bytes.subarray(20 + eventLength, 20 + eventLength + metadataLength),
    ),
    state: safeDecode(() => decodeProjection(bytes.subarray(20 + eventLength + metadataLength), { previous, stampedBy: exports })),
  };
}

// The 16-byte KARC header for a metadata and ciphertext of these lengths.
// Rust checks the bounds; the payload itself never enters WASM.
function archiveHeader(exports, metadataLength, ciphertextLength) {
  if (metadataLength + ciphertextLength + 16 > MAX_ARCHIVE_BYTES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const lengths = new Uint8Array(8);
  const view = new DataView(lengths.buffer);
  view.setUint32(0, metadataLength, true);
  view.setUint32(4, ciphertextLength, true);
  const header = callCore(exports, "kin_archive_header", lengths);
  if (header.length !== 16)
    throw new KinEngineError(6, "Kin received an invalid archive header.");
  return header;
}

function encodeArchive(exports, metadata, ciphertext) {
  metadata = asBytes(metadata);
  ciphertext = asBytes(ciphertext);
  const header = archiveHeader(exports, metadata.length, ciphertext.length);
  const bytes = new Uint8Array(16 + metadata.length + ciphertext.length);
  bytes.set(header);
  bytes.set(metadata, 16);
  bytes.set(ciphertext, 16 + metadata.length);
  return bytes;
}
function planImport(exports, mirror, records, asOf, cursor, civilDate, syncIdentity, bindingsOnly = false) {
  const bytes = replayBytes(exports, mirror, records, asOf, cursor, civilDate, syncIdentity, "kin_plan_import");
  if (bytes.length < 24 || readAscii(bytes, 0, 4) !== "KIMP")
    throw new KinEngineError(6, "Kin received an invalid import plan.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint16(4, true) !== 1 ||
    view.getUint16(6, true) !== 0 ||
    view.getUint32(20, true) + 24 !== bytes.length
  )
    throw new KinEngineError(6, "Kin received an invalid import plan.");
  const plan = { eventCount: view.getUint32(8, true), nextLogicalTime: view.getBigUint64(12, true) };
  if (bindingsOnly) return { ...plan, attachments: decodeAttachmentBindings(bytes.subarray(24)) };
  return { ...plan, state: decodeProjection(bytes.subarray(24)) };
}
// The metadata and ciphertext lengths of a whole KARC archive, after Rust
// checks its header against the buffer's length. Nothing is copied: a
// streaming reader decrypts the ciphertext a segment at a time.
function archiveLayout(exports, bytes) {
  bytes = asBytes(bytes);
  if (bytes.length > MAX_ARCHIVE_BYTES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  if (bytes.length < 16)
    throw new KinEngineError(2, USER_MESSAGES.get(2));
  const request = new Uint8Array(20);
  request.set(bytes.subarray(0, 16));
  new DataView(request.buffer).setUint32(16, bytes.length, true);
  const output = callCore(exports, "kin_archive_layout", request);
  if (output.length !== 8)
    throw new KinEngineError(6, "Kin received an invalid archive result.");
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const metadataLength = view.getUint32(0, true);
  const ciphertextLength = view.getUint32(4, true);
  if (16 + metadataLength + ciphertextLength !== bytes.length)
    throw new KinEngineError(6, "Kin received an invalid archive result.");
  return { metadataLength, ciphertextLength };
}

function decodeArchive(exports, bytes) {
  bytes = asBytes(bytes);
  const { metadataLength } = archiveLayout(exports, bytes);
  return {
    version: 1,
    // These copies deliberately detach caller-owned archive input before any
    // asynchronous authentication; no view escapes into mutable source bytes.
    metadata: bytes.slice(16, 16 + metadataLength),
    ciphertext: bytes.slice(16 + metadataLength),
  };
}

// `statusOnly`: the operation publishes no result on success
// (kin_history_append); only a failure's KERR buffer is read.
function callCore(exports, operation, request, { statusOnly = false } = {}) {
  if (!exports)
    throw new KinEngineError(
      6,
      "Unlock Kin before using its household engine.",
    );
  if (request.length > MAX_PROTOCOL_BYTES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const pointer = exports.kin_alloc(request.length);
  if (!pointer) throw new KinEngineError(5, USER_MESSAGES.get(5));
  // Every exit, including a throwing copy, operation or decode, releases the
  // input allocation exactly once. A free failure only surfaces on success so
  // it never masks the original error.
  let completed = false;
  try {
    new Uint8Array(exports.memory.buffer, pointer, request.length).set(request);
    const status = exports[operation](pointer, request.length);
    if (status === 0 && statusOnly) {
      completed = true;
      return null;
    }
    const bytes =
      status === 0
        ? copyWasmBytes(
            exports.memory,
            exports.kin_result_ptr(),
            exports.kin_result_len(),
          )
        : copyWasmBytes(
            exports.memory,
            exports.kin_error_ptr(),
            exports.kin_error_len(),
          );
    if (status !== 0) throw decodeError(bytes, status);
    completed = true;
    return bytes;
  } finally {
    const freed = exports.kin_free(pointer, request.length);
    if (freed !== 0 && completed)
      throw new KinEngineError(1, USER_MESSAGES.get(1));
  }
}

// The KINS projection of `records` (a history view, a historyWith() result
// or an array): the instance's history is brought up to date, then replayed
// in the context of a record-less KINE request. `operation` is kin_project,
// or kin_plan_import for an archive's import plan.
function mealPlanBytes(exports, mirror, source, records, asOf, civilDate, syncIdentity) {
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (records.length > MAX_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  let query;
  try { query = encodePlanQuery(source); }
  catch (error) {
    if (error instanceof MealFormatError) throw new KinEngineError(2, error.message);
    throw error;
  }
  // The 32-byte KMPQ query, then the record-less KINE context.
  const request = encodeRequest([], asOf, null, civilDate, syncIdentity, query.length);
  request.set(query, 0);
  const release = mirror.hold(records);
  try {
    return callCore(exports, "kin_meal_shopping_plan", request);
  } finally {
    release();
  }
}

// A query export (`operation`) given `query` then the record-less KINE
// context, against the instance's history brought up to date with `records`.
function queryBytes(exports, mirror, operation, query, records, asOf, civilDate, syncIdentity) {
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (records.length > MAX_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  const request = encodeRequest([], asOf, null, civilDate, syncIdentity, query.length);
  request.set(query, 0);
  const release = mirror.hold(records);
  try {
    return callCore(exports, operation, request);
  } finally {
    release();
  }
}

function replayBytes(exports, mirror, records, asOf, cursorEventId, civilDate, syncIdentity, operation = "kin_project") {
  if (!exports)
    throw new KinEngineError(
      6,
      "Unlock Kin before using its household engine.",
    );
  if (records.length > MAX_EVENT_COUNT) {
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  }
  const context = encodeRequest([], asOf, cursorEventId, civilDate, syncIdentity);
  const release = mirror.hold(records);
  try {
    return callCore(exports, operation, context);
  } finally {
    release();
  }
}

function applyEvents(
  exports,
  mirror,
  records,
  asOf,
  cursorEventId,
  civilDate,
  syncIdentity,
  previous,
) {
  return safeDecode(() => decodeProjection(
    replayBytes(exports, mirror, records, asOf, cursorEventId, civilDate, syncIdentity),
    { previous, stampedBy: exports },
  ));
}

// Any unexpected error while producing a state becomes a code-6 engine error,
// so callers always get a `code` and a safe message.
function safeDecode(decode) {
  try {
    return decode();
  } catch (error) {
    if (error instanceof KinEngineError) throw error;
    throw new KinEngineError(
      6,
      "Kin could not complete a household-engine operation.",
    );
  }
}

/**
 * Builds a protocol-24 KINE request. `records` is an array of canonical event
 * byte arrays, or a contiguous source exposing `length`, `byteLength` and
 * `copyTo(target, offset)` (the session event arena), which is copied in one
 * operation. `reserve` leaves that many leading bytes free for a caller prefix
 * so the history is never copied a second time.
 */
function encodeRequest(
  records,
  asOf,
  cursorEventId,
  civilDate,
  syncIdentity,
  reserve = 0,
) {
  assertTimestamp(asOf);
  assertCivilDate(civilDate);
  // Identity bindings map pre-sync placeholder IDs to the authenticated ones
  // (96 bytes each, at most 256). rust/src/request.rs documents the KINE
  // layout these offsets follow; docs/IDENTITY.md explains the bindings.
  const identityBindings = syncIdentity?.bindings ?? [];
  if (
    syncIdentity &&
    (!Array.isArray(identityBindings) || identityBindings.length > 256)
  ) {
    throw new KinEngineError(2, "Kin received invalid sync identity context.");
  }
  const contiguous = typeof records?.copyTo === "function";
  const headerBytes = REQUEST_HEADER_BYTES + identityBindings.length * 96;
  let length = headerBytes;
  if (contiguous) {
    length += records.byteLength;
  } else {
    for (const record of records) {
      length += asBytes(record).length;
      if (!Number.isSafeInteger(length) || length > MAX_PROTOCOL_BYTES) break;
    }
  }
  if (!Number.isSafeInteger(length) || length > MAX_PROTOCOL_BYTES) {
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  }

  const bytes = new Uint8Array(reserve + length);
  const view = new DataView(bytes.buffer, reserve);
  bytes.set([0x4b, 0x49, 0x4e, 0x45], reserve);
  view.setUint16(4, PROTOCOL_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, records.length, true);
  view.setBigInt64(12, BigInt(asOf), true);
  if (cursorEventId !== null) {
    const cursor =
      typeof cursorEventId === "string"
        ? idFromHex(cursorEventId)
        : assertId(cursorEventId);
    bytes[reserve + 20] = 1;
    bytes.set(cursor, reserve + 24);
  }
  view.setUint32(40, civilDate, true);
  if (syncIdentity) {
    bytes.set(idFromHex(syncIdentity.householdId), reserve + 44);
    view.setUint16(60, identityBindings.length, true);
    let bindingOffset = reserve + 64;
    for (const binding of identityBindings) {
      for (const id of [
        binding.legacyHouseholdId,
        binding.legacyActorId,
        binding.legacyDeviceId,
        binding.householdId,
        binding.actorId,
        binding.deviceId,
      ]) {
        bytes.set(idFromHex(id), bindingOffset);
        bindingOffset += 16;
      }
    }
  }
  let offset = reserve + headerBytes;
  if (contiguous) {
    records.copyTo(bytes, offset);
  } else {
    for (const record of records) {
      const eventBytes = asBytes(record);
      bytes.set(eventBytes, offset);
      offset += eventBytes.length;
    }
  }
  return bytes;
}

// Stage-level access for the performance harness; production callers use the
// engine API above.
export { encodeRequest as encodeReplayRequest, decodeProjection };

// Copies a published result or error out of WASM memory. Every result and
// error format starts with a magic header, so an empty buffer is invalid.
function copyWasmBytes(memory, pointer, length) {
  const start = Number(pointer);
  const size = Number(length);
  const end = start + size;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(size) ||
    start <= 0 ||
    size <= 0 ||
    end > memory.buffer.byteLength
  ) {
    throw new KinEngineError(
      6,
      "Kin received an invalid buffer from its household engine.",
    );
  }
  return new Uint8Array(memory.buffer, start, size).slice();
}

function decodeError(bytes, status) {
  if (bytes.length < 12 || readAscii(bytes, 0, 4) !== "KERR") {
    return new KinEngineError(6, USER_MESSAGES.get(6));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const code = view.getUint16(6, true);
  const messageLength = view.getUint32(8, true);
  if (version !== 1 || code !== status || bytes.length !== 12 + messageLength) {
    return new KinEngineError(6, USER_MESSAGES.get(6));
  }
  return new KinEngineError(
    status,
    USER_MESSAGES.get(code) ?? USER_MESSAGES.get(6),
  );
}

function assertId(value) {
  const bytes = asBytes(value);
  if (bytes.length !== 16) {
    throw new KinEngineError(
      4,
      "Kin received an invalid household identifier.",
    );
  }
  return bytes;
}


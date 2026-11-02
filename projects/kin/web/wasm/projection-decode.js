// Decoding the protocol-24 KINS projection: the 96-byte header, the section
// table, then one contiguous section per domain (ABI.md).
//
// Incremental decoding: a projection stamped by the same engine instance as
// `previous` reuses each decoded section whose revision did not change; the
// decoded arrays are then the same objects, so renderers can skip them by
// identity. Revision 0 is unversioned and always decodes. Cross-section
// references are checked on every decode, reused or not.
import {
  idToHex,
  KinEngineError,
  MAX_EVENT_COUNT,
  MAX_PROTOCOL_BYTES,
  MAX_STEPS_PER_ITEM,
  MAX_SUMMARY_ENTRIES,
  PROTOCOL_VERSION,
  readAscii,
} from "./wire.js";
import { decodeHandoffs, decodePulses, decodeSummary, decodeTalks } from "./projection/conversations.js";
import { decodeItems } from "./projection/items.js";
import { invalid, SectionReader } from "./projection/reader.js";
import {
  decodeAreas,
  decodeAttachments,
  decodeMaintenance,
  decodeNotes,
  decodePins,
  decodePlaybooks,
  decodeReferenceRecords,
  decodeResponsibilities,
} from "./projection/records.js";
import { decodeRoutines } from "./projection/routines.js";

const HEADER_BYTES = 96;
// Section table and body order; `rust/src/sections.rs` is the source.
const SECTIONS = [
  ["items", decodeItems],
  ["handoffs", decodeHandoffs],
  ["talks", decodeTalks],
  ["pulses", decodePulses],
  ["routines", decodeRoutines],
  ["areas", decodeAreas],
  ["notes", decodeNotes],
  ["pins", decodePins],
  ["playbooks", decodePlaybooks],
  ["referenceRecords", decodeReferenceRecords],
  ["maintenanceEvents", decodeMaintenance],
  ["attachments", decodeAttachments],
  ["responsibilities", decodeResponsibilities],
  ["summary", decodeSummary],
];
const TABLE_BYTES = SECTIONS.length * 8;
const BODY_OFFSET = HEADER_BYTES + TABLE_BYTES;
const MODES = ["normal", "vacation", "guests", "rest"];

// Per decoded state: the engine instance that stamped it, its section
// revisions and lengths, and the decoded sections, for the next decode.
// A WeakMap, so a state nobody holds any more is collected with its entry.
const sectionCache = new WeakMap();

/**
 * @param bytes     a KINS projection
 * @param previous  the state decoded from this engine's previous projection
 * @param stampedBy identity of the engine instance that stamped `bytes` (its
 *                  WASM exports object). Revisions only compare within one
 *                  instance, so reuse needs the same value both times.
 */
export function decodeProjection(bytes, { previous = null, stampedBy = null } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = decodeHeader(bytes, view);
  const table = decodeTable(bytes, view);
  const cached = previous && stampedBy ? sectionCache.get(previous) : undefined;
  const prior = cached?.stampedBy === stampedBy ? cached : null;
  const values = {};
  let start = BODY_OFFSET;
  SECTIONS.forEach(([name, decode], index) => {
    const end = start + table.lengths[index];
    const revision = table.revisions[index];
    // Equal revision already implies equal bytes; the length check is a cheap
    // second guard. Revision 0 means unversioned and always decodes.
    if (prior && revision !== 0 && prior.revisions[index] === revision && prior.lengths[index] === table.lengths[index]) {
      values[name] = prior.values[name];
    } else {
      const reader = new SectionReader(bytes, view, start, end);
      values[name] = decode(reader, header);
      reader.finish();
    }
    start = end;
  });
  checkCounts(values, header);
  checkReferences(values);
  const state = {
    items: values.items,
    handoffs: values.handoffs,
    talks: values.talks,
    pulses: values.pulses,
    routines: values.routines,
    areas: values.areas,
    notes: values.notes,
    pins: values.pins,
    playbooks: values.playbooks,
    referenceRecords: values.referenceRecords,
    maintenanceEvents: values.maintenanceEvents,
    // These three are left out when empty or normal, the shape every caller
    // and test has always seen. Read them with a shared fallback (for example
    // detail.js `NONE`), not a fresh `[]`, where identity matters.
    ...(values.attachments.length ? { attachments: values.attachments } : {}),
    ...(values.responsibilities.length ? { responsibilities: values.responsibilities } : {}),
    ...(header.modeCode === 0 ? {} : { mode: MODES[header.modeCode] }),
    summary: values.summary,
  };
  if (stampedBy) sectionCache.set(state, { stampedBy, ...table, values });
  return state;
}

/**
 * Only the attachment bindings of a KINS projection, after the same header
 * and section-table checks as a full decode. An archive's import plan needs
 * nothing else, and skipping the other sections avoids decoding every
 * Item's text (tens of MB at the history limit) to read a few bindings.
 */
export function decodeAttachmentBindings(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = decodeHeader(bytes, view);
  const table = decodeTable(bytes, view);
  let start = BODY_OFFSET;
  for (let index = 0; index < SECTIONS.length; index += 1) {
    const end = start + table.lengths[index];
    if (SECTIONS[index][0] === "attachments") {
      const reader = new SectionReader(bytes, view, start, end);
      const attachments = decodeAttachments(reader, header);
      reader.finish();
      return attachments;
    }
    start = end;
  }
  throw invalid("Kin received an invalid state from its household engine.");
}

function decodeHeader(bytes, view) {
  if (bytes.length < BODY_OFFSET || bytes.length > MAX_PROTOCOL_BYTES || readAscii(bytes, 0, 4) !== "KINS")
    throw invalid("Kin received an invalid state from its household engine.");
  if (view.getUint16(4, true) !== PROTOCOL_VERSION || view.getUint16(6, true) !== 0)
    throw invalid("Kin received an unsupported state format.");
  const header = {
    itemCount: view.getUint32(8, true),
    handoffCount: view.getUint32(12, true),
    talkCount: view.getUint32(16, true),
    pulseCount: view.getUint32(20, true),
    summaryCount: view.getUint32(24, true),
    summaryTotalCount: view.getUint32(28, true),
    routineCount: view.getUint32(52, true),
    areaCount: view.getUint32(56, true),
    noteCount: view.getUint32(60, true),
    stepCount: view.getUint32(64, true),
    modeCode: view.getUint8(68),
    pinCount: view.getUint32(72, true),
    playbookCount: view.getUint32(76, true),
    referenceRecordCount: view.getUint32(80, true),
    maintenanceEventCount: view.getUint32(84, true),
    attachmentCount: view.getUint32(88, true),
    responsibilityCount: view.getUint32(92, true),
  };
  if (header.modeCode > 3 || bytes.subarray(69, 72).some((byte) => byte !== 0))
    throw invalid("Kin received an invalid household mode.");
  const throughPresent = view.getUint8(32);
  const throughBytes = bytes.subarray(36, 52);
  const { summaryCount, summaryTotalCount } = header;
  if (
    summaryCount > MAX_SUMMARY_ENTRIES ||
    summaryCount > summaryTotalCount ||
    summaryTotalCount > MAX_EVENT_COUNT ||
    throughPresent > 1 ||
    (summaryTotalCount > 0 && throughPresent !== 1) ||
    (summaryCount > 0 && throughPresent !== 1) ||
    bytes.subarray(33, 36).some((byte) => byte !== 0) ||
    (throughPresent === 0 && throughBytes.some((byte) => byte !== 0))
  )
    throw invalid("Kin received invalid summary metadata.");
  header.summaryThroughEventId = throughPresent === 1 ? idToHex(throughBytes) : null;
  // Collection limits, matching Rust's (state.rs MAX_* and wire.rs): 32 Areas,
  // 128 Notes, 10 Pins, 32 Playbooks, 128 Reference Records, 8,192
  // Maintenance events, 256 attachments. A responsibility targets an Item or
  // a Routine, so there can be at most one per Item and Routine.
  const h = header;
  if (
    h.areaCount > 32 ||
    h.noteCount > 128 ||
    h.pinCount > 10 ||
    h.playbookCount > 32 ||
    h.referenceRecordCount > 128 ||
    h.maintenanceEventCount > 8192 ||
    h.attachmentCount > 256 ||
    h.responsibilityCount > h.itemCount + h.routineCount ||
    h.stepCount > MAX_EVENT_COUNT ||
    h.stepCount > h.itemCount * MAX_STEPS_PER_ITEM ||
    h.itemCount + h.handoffCount + h.talkCount + h.pulseCount + h.routineCount + h.noteCount + h.playbookCount +
      h.referenceRecordCount + h.maintenanceEventCount + h.attachmentCount + h.responsibilityCount > MAX_EVENT_COUNT
  )
    throw new KinEngineError(6, "Kin received too many items from its household engine.");
  return header;
}

function decodeTable(bytes, view) {
  const revisions = [];
  const lengths = [];
  let total = BODY_OFFSET;
  for (let index = 0; index < SECTIONS.length; index += 1) {
    revisions.push(view.getUint32(HEADER_BYTES + index * 8, true));
    const length = view.getUint32(HEADER_BYTES + index * 8 + 4, true);
    lengths.push(length);
    total += length;
  }
  if (total < bytes.length) throw invalid("Kin received trailing bytes from its household engine.");
  if (total > bytes.length) throw invalid("Kin received a truncated state from its household engine.");
  return { revisions, lengths };
}

// A reused section was checked when first decoded; its record counts must
// still match the header that now describes it.
function checkCounts(values, header) {
  const steps = values.items.reduce((total, item) => total + item.steps.length, 0);
  if (
    values.items.length !== header.itemCount ||
    steps !== header.stepCount ||
    values.handoffs.length !== header.handoffCount ||
    values.talks.length !== header.talkCount ||
    values.pulses.length !== header.pulseCount ||
    values.routines.length !== header.routineCount ||
    values.areas.length !== header.areaCount ||
    values.notes.length !== header.noteCount ||
    values.pins.length !== header.pinCount ||
    values.playbooks.length !== header.playbookCount ||
    values.referenceRecords.length !== header.referenceRecordCount ||
    values.maintenanceEvents.length !== header.maintenanceEventCount ||
    values.attachments.length !== header.attachmentCount ||
    values.responsibilities.length !== header.responsibilityCount ||
    values.summary.entries.length !== header.summaryCount
  )
    throw invalid("Kin received an inconsistent state from its household engine.");
}

function checkReferences(values) {
  const ids = (records, key) => new Set(records.map((record) => record[key]));
  const items = ids(values.items, "itemId");
  const areas = ids(values.areas, "areaId");
  const notes = ids(values.notes, "noteId");
  const routines = ids(values.routines, "routineId");
  const references = ids(values.referenceRecords, "recordId");
  const maintenance = ids(values.maintenanceEvents, "maintenanceId");
  if (values.items.some((item) => item.areaId && !areas.has(item.areaId)))
    throw invalid("Kin received an unknown Area assignment.");
  if (values.notes.some((note) => note.areaId && !areas.has(note.areaId)))
    throw invalid("Kin received a Note with an unknown Area.");
  const pinTargets = { item: items, note: notes, routine: routines, area: areas };
  if (values.pins.some((pin) => !pinTargets[pin.targetKind]?.has(pin.targetId)))
    throw invalid("Kin received a Pin for an unknown household record.");
  if (values.referenceRecords.some((record) => record.areaId && !areas.has(record.areaId)))
    throw invalid("Kin received a reference record for an unknown Area.");
  if (values.maintenanceEvents.some((entry) => !references.has(entry.recordId)))
    throw invalid("Kin received an invalid maintenance record.");
  const parents = { note: notes, "reference-record": references, maintenance, item: items };
  if (values.attachments.some((entry) => !parents[entry.parentKind].has(entry.parentId)))
    throw invalid("Kin received an attachment for an unknown household record.");
  const targets = { item: items, routine: routines };
  if (values.responsibilities.some((entry) => !targets[entry.targetKind].has(entry.targetId)))
    throw invalid("Kin received invalid responsibility data.");
}

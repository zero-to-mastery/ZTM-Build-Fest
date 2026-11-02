// The household record sections: Areas, Notes, Pins, Playbooks, Reference
// Records, Maintenance events, Attachments and Responsibilities. References
// to other sections are checked after every section is decoded.
import { idToHex, isCivilDate, MAX_TIMESTAMP, strictTextDecoder, ZERO_ID } from "../wire.js";
import { invalid } from "./reader.js";

// Strict UTF-8 text, failing closed with `message` like every other decoder.
function text(bytes, start, end, message) {
  try {
    return strictTextDecoder.decode(bytes.subarray(start, end));
  } catch {
    throw invalid(message);
  }
}

const optionalId = (bytes) => (bytes.every((byte) => byte === 0) ? null : idToHex(bytes));

// Text limits below mirror Rust's normalization (state.rs). Byte limits bound
// the UTF-8 length; character limits count Unicode scalars ([...text].length).
// Area name: 1-96 bytes, at most 48 characters, no control characters.
export function decodeAreas(reader, { areaCount }) {
  const { bytes, view } = reader;
  const areas = [];
  const areaIds = new Set();
  for (let index = 0; index < areaCount; index += 1) {
    const offset = reader.offset;
    reader.need(24, "Kin received a truncated Area.");
    const headerEnd = offset + 24;
    const areaId = idToHex(bytes.subarray(offset, offset + 16));
    const archived = bytes[offset + 16];
    const length = view.getUint32(offset + 20, true);
    const end = headerEnd + length;
    if (archived > 1 || bytes.subarray(offset + 17, offset + 20).some((byte) => byte !== 0) || length < 1 || length > 96 || end > reader.end || areaIds.has(areaId))
      throw invalid("Kin received an invalid Area.");
    let name;
    try { name = strictTextDecoder.decode(bytes.subarray(headerEnd, end)); }
    catch { throw invalid("Kin received invalid Area text."); }
    if (name.trim() !== name || [...name].length > 48 || /[\u0000-\u001f\u007f]/u.test(name))
      throw invalid("Kin received invalid Area text.");
    areaIds.add(areaId);
    areas.push({ areaId, name, archived: archived === 1 });
    reader.offset = end;
  }
  return areas;
}

// Note: title 1-256 bytes and at most 80 characters, body up to 4096 bytes.
export function decodeNotes(reader, { noteCount }) {
  const { bytes, view } = reader;
  const notes = [];
  const noteIds = new Set();
  for (let index = 0; index < noteCount; index += 1) {
    const offset = reader.offset;
    reader.need(92, "Kin received a truncated Note.");
    const headerEnd = offset + 92;
    const titleLength = view.getUint32(offset + 84, true), bodyLength = view.getUint32(offset + 88, true), end = headerEnd + titleLength + bodyLength;
    const noteId = idToHex(bytes.subarray(offset, offset + 16)), area = bytes.subarray(offset + 64, offset + 80), archived = bytes[offset + 80];
    if (titleLength < 1 || titleLength > 256 || bodyLength > 4096 || end > reader.end || archived > 1 || bytes.subarray(offset + 81, offset + 84).some(Boolean) || noteIds.has(noteId))
      throw invalid("Kin received an invalid Note.");
    let title, body;
    try { title = strictTextDecoder.decode(bytes.subarray(headerEnd, headerEnd + titleLength)); body = strictTextDecoder.decode(bytes.subarray(headerEnd + titleLength, end)); }
    catch { throw invalid("Kin received invalid Note text."); }
    const createdAt = Number(view.getBigInt64(offset + 48, true)), updatedAt = Number(view.getBigInt64(offset + 56, true));
    if (![createdAt, updatedAt].every((time) => Number.isSafeInteger(time) && Math.abs(time) <= MAX_TIMESTAMP))
      throw invalid("Kin received an invalid Note.");
    if (noteId === ZERO_ID || !title.trim() || title.trim() !== title || [...title].length > 80 || [...title].some((character) => /\p{Cc}/u.test(character)) || [...body].some((character) => /\p{Cc}/u.test(character) && !["\n", "\r", "\t"].includes(character)))
      throw invalid("Kin received invalid Note text.");
    notes.push({ noteId, title, body, areaId: optionalId(area), archived: archived === 1,
      createdBy: idToHex(bytes.subarray(offset + 16, offset + 32)), updatedBy: idToHex(bytes.subarray(offset + 32, offset + 48)),
      createdAt, updatedAt });
    noteIds.add(noteId);
    reader.offset = end;
  }
  return notes;
}

const PIN_TARGETS = [null, "item", "note", "routine", "area"];

export function decodePins(reader, { pinCount }) {
  const { bytes } = reader;
  const pins = [];
  const pinKeys = new Set();
  for (let index = 0; index < pinCount; index += 1) {
    const offset = reader.offset;
    reader.need(20, "Kin received a truncated Pin.");
    const kind = bytes[offset];
    const targetId = idToHex(bytes.subarray(offset + 4, offset + 20));
    const key = `${kind}:${targetId}`;
    if (!PIN_TARGETS[kind] || bytes.subarray(offset + 1, offset + 4).some(Boolean) || targetId === ZERO_ID || pinKeys.has(key))
      throw invalid("Kin received an invalid Pin.");
    pinKeys.add(key);
    pins.push({ targetKind: PIN_TARGETS[kind], targetId });
    reader.offset += 20;
  }
  return pins;
}

export function decodePlaybooks(reader, { playbookCount }) {
  const { bytes, view } = reader;
  const playbooks = [];
  const playbookIds = new Set();
  for (let index = 0; index < playbookCount; index += 1) {
    reader.need(22, "Kin received a truncated Playbook.");
    let offset = reader.offset;
    const playbookId = idToHex(bytes.subarray(offset, offset + 16));
    const archived = bytes[offset + 16];
    const entryCount = bytes[offset + 17];
    const titleLength = view.getUint16(offset + 18, true);
    if (playbookId === ZERO_ID || playbookIds.has(playbookId) || archived > 1 || entryCount < 1 || entryCount > 16 || titleLength < 1 || titleLength > 128 || bytes.subarray(offset + 20, offset + 22).some(Boolean))
      throw invalid("Kin received an invalid Playbook.");
    playbookIds.add(playbookId);
    offset += 22;
    const titleEnd = offset + titleLength;
    if (titleEnd > reader.end) throw invalid("Kin received a truncated Playbook title.");
    const title = text(bytes, offset, titleEnd, "Kin received invalid Playbook text.");
    offset = titleEnd;
    const entries = [];
    for (let entry = 0; entry < entryCount; entry += 1) {
      if (offset + 2 > reader.end) throw invalid("Kin received a truncated Playbook entry.");
      const length = view.getUint16(offset, true);
      offset += 2;
      if (length < 1 || length > 256 || offset + length > reader.end) throw invalid("Kin received an invalid Playbook entry.");
      entries.push(text(bytes, offset, offset + length, "Kin received invalid Playbook text."));
      offset += length;
    }
    playbooks.push({ playbookId, title, entries, archived: archived === 1 });
    reader.offset = offset;
  }
  return playbooks;
}

export function decodeReferenceRecords(reader, { referenceRecordCount }) {
  const { bytes, view } = reader;
  const referenceRecords = [];
  const referenceIds = new Set();
  const referenceFieldIds = new Set();
  for (let index = 0; index < referenceRecordCount; index += 1) {
    reader.need(36, "Kin received a truncated reference record.");
    let offset = reader.offset;
    const recordId = idToHex(bytes.subarray(offset, offset + 16));
    const areaId = idToHex(bytes.subarray(offset + 16, offset + 32));
    const titleLength = view.getUint16(offset + 32, true);
    const fieldCount = bytes[offset + 34];
    const archived = bytes[offset + 35];
    if (recordId === ZERO_ID || referenceIds.has(recordId) || fieldCount < 1 || fieldCount > 16 || archived > 1 || titleLength < 1 || titleLength > 128)
      throw invalid("Kin received an invalid reference record.");
    referenceIds.add(recordId);
    offset += 36;
    if (offset + titleLength > reader.end) throw invalid("Kin received a truncated reference record title.");
    const title = text(bytes, offset, offset + titleLength, "Kin received invalid reference record text.");
    offset += titleLength;
    const fields = [];
    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
      if (offset + 20 > reader.end) throw invalid("Kin received a truncated reference field.");
      const fieldId = idToHex(bytes.subarray(offset, offset + 16));
      const labelLength = view.getUint16(offset + 16, true);
      const valueLength = view.getUint16(offset + 18, true);
      offset += 20;
      if (fieldId === ZERO_ID || referenceFieldIds.has(fieldId) || labelLength < 1 || labelLength > 64 || valueLength > 1024 || offset + labelLength + valueLength > reader.end)
        throw invalid("Kin received an invalid reference field.");
      referenceFieldIds.add(fieldId);
      const label = text(bytes, offset, offset + labelLength, "Kin received invalid reference record text.");
      offset += labelLength;
      const value = text(bytes, offset, offset + valueLength, "Kin received invalid reference record text.");
      offset += valueLength;
      fields.push({ fieldId, label, value });
    }
    referenceRecords.push({ recordId, title, areaId: areaId === ZERO_ID ? null : areaId, fields, archived: archived === 1 });
    reader.offset = offset;
  }
  return referenceRecords;
}

export function decodeMaintenance(reader, { maintenanceEventCount }) {
  const { bytes, view } = reader;
  const maintenanceEvents = [];
  const maintenanceIds = new Set();
  for (let index = 0; index < maintenanceEventCount; index += 1) {
    const offset = reader.offset;
    reader.need(60, "Kin received a truncated maintenance record.");
    const maintenanceId = idToHex(bytes.subarray(offset, offset + 16));
    const recordId = idToHex(bytes.subarray(offset + 16, offset + 32));
    const performedOn = view.getUint32(offset + 32, true), nextOnCode = view.getUint32(offset + 36, true);
    const routineBytes = bytes.subarray(offset + 40, offset + 56);
    const archived = bytes[offset + 56], summaryLength = view.getUint16(offset + 58, true);
    const end = offset + 60 + summaryLength;
    if (maintenanceId === ZERO_ID || maintenanceIds.has(maintenanceId) || archived > 1 || bytes[offset + 57] !== 0 || summaryLength < 1 || summaryLength > 240 || end > reader.end)
      throw invalid("Kin received an invalid maintenance record.");
    const nextOn = nextOnCode === 0 ? null : nextOnCode;
    if (!isCivilDate(performedOn) || (nextOn != null && (!isCivilDate(nextOn) || nextOn < performedOn)))
      throw invalid("Kin received invalid maintenance dates.");
    const summary = text(bytes, offset + 60, end, "Kin received invalid maintenance text.");
    if (!summary.trim() || summary.trim() !== summary || [...summary].some((character) => /\p{Cc}/u.test(character)))
      throw invalid("Kin received invalid maintenance text.");
    maintenanceIds.add(maintenanceId);
    maintenanceEvents.push({ maintenanceId, recordId, performedOn, summary, nextOn, routineId: optionalId(routineBytes), archived: archived === 1 });
    reader.offset = end;
  }
  return maintenanceEvents;
}

const ATTACHMENT_PARENTS = ["", "note", "reference-record", "maintenance", "item"];

// An attachment binding is "removed" rather than archived: the file is
// detached from its record, while the binding stays as a tombstone.
export function decodeAttachments(reader, { attachmentCount }) {
  const { bytes } = reader;
  const attachments = [];
  const attachmentIds = new Set();
  for (let index = 0; index < attachmentCount; index += 1) {
    const offset = reader.offset;
    reader.need(36, "Kin received a truncated attachment binding.");
    const attachmentId = idToHex(bytes.subarray(offset, offset + 16));
    const parentKind = ATTACHMENT_PARENTS[bytes[offset + 16]];
    const removed = bytes[offset + 17];
    const parentId = idToHex(bytes.subarray(offset + 20, offset + 36));
    if (attachmentId === ZERO_ID || attachmentIds.has(attachmentId) || !parentKind || removed > 1 || bytes[offset + 18] || bytes[offset + 19])
      throw invalid("Kin received an invalid attachment binding.");
    attachmentIds.add(attachmentId);
    attachments.push({ attachmentId, parentKind, parentId, removed: removed === 1 });
    reader.offset += 36;
  }
  return attachments;
}

const RESPONSIBILITY_TARGETS = ["", "item", "routine"];

export function decodeResponsibilities(reader, { responsibilityCount }) {
  const { bytes } = reader;
  const responsibilities = [];
  const responsibilityIds = new Set();
  for (let index = 0; index < responsibilityCount; index += 1) {
    const offset = reader.offset;
    reader.need(33, "Kin received truncated responsibility data.");
    const targetKind = RESPONSIBILITY_TARGETS[bytes[offset]];
    const targetId = idToHex(bytes.subarray(offset + 1, offset + 17));
    const memberId = idToHex(bytes.subarray(offset + 17, offset + 33));
    const key = `${targetKind}:${targetId}`;
    if (!targetKind || targetId === ZERO_ID || responsibilityIds.has(key))
      throw invalid("Kin received invalid responsibility data.");
    responsibilityIds.add(key);
    responsibilities.push({ targetKind, targetId, memberId: memberId === ZERO_ID ? null : memberId });
    reader.offset += 33;
  }
  return responsibilities;
}

// The Handoffs, Talks and Pulses sections and the catch-up summary entries.
import {
  idToHex,
  MAX_ITEM_TEXT_BYTES,
  MAX_TIMESTAMP,
  PULSE_VALUES,
  strictTextDecoder,
  SUMMARY_KINDS,
} from "../wire.js";
import { invalid } from "./reader.js";

// Handoffs and Talks share one record shape: ID @0, created_by @16 (16 bytes
// each), created_at i64 @32, status u8 @40 (0-2), 3 reserved @41, text
// length u32 @44, then the text.
function textRecords(reader, count, { noun, idKey, statuses }) {
  const { bytes, view } = reader;
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const offset = reader.offset;
    reader.need(48, `Kin received a truncated ${noun} record.`);
    const headerEnd = offset + 48;
    const textLength = view.getUint32(offset + 44, true);
    const end = headerEnd + textLength;
    const status = bytes[offset + 40];
    const createdAt = Number(view.getBigInt64(offset + 32, true));
    if (
      end > reader.end ||
      textLength < 1 ||
      textLength > MAX_ITEM_TEXT_BYTES ||
      status > 2 ||
      bytes.subarray(offset + 41, offset + 44).some((value) => value !== 0) ||
      !Number.isSafeInteger(createdAt)
    )
      throw invalid(`Kin received an invalid ${noun} record.`);
    let text;
    try {
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, end));
    } catch {
      throw invalid(`Kin received invalid ${noun} text.`);
    }
    records.push({
      [idKey]: idToHex(bytes.subarray(offset, offset + 16)),
      createdBy: idToHex(bytes.subarray(offset + 16, offset + 32)),
      createdAt,
      text,
      status: statuses[status],
    });
    reader.offset = end;
  }
  return records;
}

export const decodeHandoffs = (reader, { handoffCount }) =>
  textRecords(reader, handoffCount, { noun: "handoff", idKey: "handoffId", statuses: ["unacknowledged", "acknowledged", "archived"] });

export const decodeTalks = (reader, { talkCount }) =>
  textRecords(reader, talkCount, { noun: "talk", idKey: "talkId", statuses: ["open", "resolved", "archived"] });

export function decodePulses(reader, { pulseCount }) {
  const { bytes, view } = reader;
  const pulses = [];
  let previousActor = null;
  for (let index = 0; index < pulseCount; index += 1) {
    const offset = reader.offset;
    reader.need(40, "Kin received a truncated pulse record.");
    const actorId = idToHex(bytes.subarray(offset, offset + 16));
    const setAt = Number(view.getBigInt64(offset + 16, true));
    const expiresAt = Number(view.getBigInt64(offset + 24, true));
    const value = bytes[offset + 32];
    const status = bytes[offset + 33];
    if (
      !Number.isSafeInteger(setAt) ||
      !Number.isSafeInteger(expiresAt) ||
      Math.abs(setAt) > MAX_TIMESTAMP ||
      Math.abs(expiresAt) > MAX_TIMESTAMP ||
      expiresAt <= setAt ||
      value > 4 ||
      status > 1 ||
      bytes.subarray(offset + 34, offset + 40).some((byte) => byte !== 0) ||
      // Rust emits one Pulse per member, sorted by actor ID bytes. Lowercase
      // hex strings sort the same way as the bytes they encode.
      (previousActor !== null && actorId <= previousActor)
    )
      throw invalid("Kin received an invalid pulse record.");
    pulses.push({
      actorId,
      setAt,
      expiresAt,
      value: PULSE_VALUES[value],
      status: ["active", "expired"][status],
    });
    previousActor = actorId;
    reader.offset += 40;
  }
  return pulses;
}

const ENTITY_NAMES = ["", "item", "handoff", "talk", "routine"];
const CLASSIFICATIONS = ["today", "need", "shopping", "staple"];

// Summary kind codes 1-4 are Item kinds, 5-7 Handoff, 8-11 Talk, 12-15 Routine
// (SUMMARY_KINDS in wire.js; Rust checks the same pairs in state_encode.rs).
function expectedEntity(kindCode) {
  if (kindCode >= 1 && kindCode <= 4) return 1;
  if (kindCode >= 5 && kindCode <= 7) return 2;
  if (kindCode >= 8 && kindCode <= 11) return 3;
  if (kindCode >= 12 && kindCode <= 15) return 4;
  return 0;
}

/** The whole summary: entries from this section, totals from the header. */
export function decodeSummary(reader, { summaryCount, summaryTotalCount, summaryThroughEventId }) {
  const { bytes, view } = reader;
  const entries = [];
  for (let index = 0; index < summaryCount; index += 1) {
    const offset = reader.offset;
    reader.need(24, "Kin received a truncated summary entry.");
    const headerEnd = offset + 24;
    const kindCode = bytes[offset + 16];
    const entityCode = bytes[offset + 17];
    const classificationCode = bytes[offset + 18];
    const textLength = view.getUint32(offset + 20, true);
    const end = headerEnd + textLength;
    const entity = expectedEntity(kindCode);
    const validClassification = kindCode === 1
      ? classificationCode <= 3
      : entity === 1
        ? classificationCode <= 3 || classificationCode === 255
        : classificationCode === 255;
    if (
      end > reader.end ||
      kindCode === 0 ||
      entity === 0 ||
      entityCode !== entity ||
      !validClassification ||
      bytes[offset + 19] !== 0 ||
      textLength < 1 ||
      textLength > MAX_ITEM_TEXT_BYTES
    )
      throw invalid("Kin received an invalid summary entry.");
    let text;
    try {
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, end));
    } catch {
      throw invalid("Kin received invalid summary text.");
    }
    entries.push({
      eventId: idToHex(bytes.subarray(offset, offset + 16)),
      kind: SUMMARY_KINDS[kindCode],
      entityKind: ENTITY_NAMES[entityCode],
      text,
      classification: classificationCode === 255 ? null : CLASSIFICATIONS[classificationCode],
    });
    reader.offset = end;
  }
  return { entries, totalCount: summaryTotalCount, throughEventId: summaryThroughEventId };
}

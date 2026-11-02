// The Items section: Item records, then per Item its Area ID, its Steps,
// its planning date and its last-changed timestamp.
import {
  idToHex,
  isCivilDate,
  MAX_ITEM_TEXT_BYTES,
  MAX_STEP_TEXT_BYTES,
  MAX_STEP_TEXT_CHARS,
  MAX_STEPS_PER_ITEM,
  MAX_TIMESTAMP,
  strictTextDecoder,
  ZERO_ID,
} from "../wire.js";
import { invalid } from "./reader.js";

// Item record: item ID @0, created_by @16 (16 bytes each), created_at i64 @32,
// classification u8 @40, status u8 @41, 2 reserved @42, text length u32 @44,
// then the text.
const ITEM_HEADER_BYTES = 48;
const CLASSIFICATIONS = ["today", "need", "shopping", "staple"];
const STATUSES = ["active", "completed", "archived"];

// Four passes, in the section's byte order, fill in the Item objects the first
// pass creates. The counts come from the header (sections.rs ties them to
// this section's revision).
export function decodeItems(reader, { itemCount, stepCount }) {
  const items = records(reader, itemCount);
  areas(reader, items);
  steps(reader, items, stepCount);
  planningDates(reader, items);
  lastChanged(reader, items);
  return items;
}

function records(reader, count) {
  const { bytes, view } = reader;
  const items = [];
  const itemIds = new Set();
  for (let index = 0; index < count; index += 1) {
    const offset = reader.offset;
    reader.need(ITEM_HEADER_BYTES, "Kin received a truncated state from its household engine.");
    const headerEnd = offset + ITEM_HEADER_BYTES;
    const textLength = view.getUint32(offset + 44, true);
    const recordEnd = headerEnd + textLength;
    const classificationCode = view.getUint8(offset + 40);
    const statusCode = view.getUint8(offset + 41);
    const validStatus =
      classificationCode <= 3 &&
      statusCode <= 2 &&
      view.getUint8(offset + 42) === 0 &&
      view.getUint8(offset + 43) === 0;
    if (recordEnd > reader.end || textLength < 1 || textLength > MAX_ITEM_TEXT_BYTES || !validStatus)
      throw invalid("Kin received an invalid item record from its household engine.");
    const createdAt = Number(view.getBigInt64(offset + 32, true));
    if (!Number.isSafeInteger(createdAt))
      throw invalid("Kin received an invalid item timestamp from its household engine.");
    let text;
    try {
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, recordEnd));
    } catch {
      throw invalid("Kin received invalid item text from its household engine.");
    }
    const itemId = idToHex(bytes.subarray(offset, offset + 16));
    // A duplicate would make Steps attach to the wrong record below.
    if (itemIds.has(itemId)) throw invalid("Kin received an invalid item record from its household engine.");
    itemIds.add(itemId);
    items.push({
      itemId,
      createdBy: idToHex(bytes.subarray(offset + 16, offset + 32)),
      createdAt,
      classification: CLASSIFICATIONS[classificationCode],
      status: STATUSES[statusCode],
      areaId: null,
      steps: [],
      planningDate: null,
      lastChangedAt: null,
      text,
    });
    reader.offset = recordEnd;
  }
  return items;
}

function areas(reader, items) {
  reader.need(items.length * 16, "Kin received truncated Area assignments.");
  for (const item of items) {
    const id = reader.bytes.subarray(reader.offset, reader.offset + 16);
    item.areaId = id.every((byte) => byte === 0) ? null : idToHex(id);
    reader.offset += 16;
  }
}

function steps(reader, items, count) {
  const { bytes, view } = reader;
  const itemById = new Map(items.map((item) => [item.itemId, item]));
  const stepIds = new Set();
  for (let index = 0; index < count; index += 1) {
    const offset = reader.offset;
    reader.need(40, "Kin received a truncated Step.");
    const headerEnd = offset + 40;
    const itemId = idToHex(bytes.subarray(offset, offset + 16));
    const stepId = idToHex(bytes.subarray(offset + 16, offset + 32));
    const completed = bytes[offset + 32];
    const archived = bytes[offset + 33];
    const textLength = view.getUint32(offset + 36, true);
    const end = headerEnd + textLength;
    const item = itemById.get(itemId);
    if (
      !item ||
      stepId === ZERO_ID ||
      stepIds.has(stepId) ||
      item.steps.length >= MAX_STEPS_PER_ITEM ||
      completed > 1 ||
      archived > 1 ||
      bytes.subarray(offset + 34, offset + 36).some(Boolean) ||
      textLength < 1 ||
      textLength > MAX_STEP_TEXT_BYTES ||
      end > reader.end
    )
      throw invalid("Kin received an invalid Step.");
    let text;
    try {
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, end));
    } catch {
      throw invalid("Kin received invalid Step text.");
    }
    if (
      text.trim() !== text ||
      [...text].length > MAX_STEP_TEXT_CHARS ||
      [...text].some((character) => /\p{Cc}/u.test(character))
    )
      throw invalid("Kin received invalid Step text.");
    stepIds.add(stepId);
    item.steps.push({ stepId, text, completed: completed === 1, archived: archived === 1 });
    reader.offset = end;
  }
}

function planningDates(reader, items) {
  reader.need(items.length * 4, "Kin received a truncated planning date.");
  for (const item of items) {
    const planningDate = reader.view.getUint32(reader.offset, true);
    if (planningDate !== 0 && !isCivilDate(planningDate))
      throw invalid("Kin received an invalid planning date.");
    item.planningDate = planningDate === 0 ? null : planningDate;
    reader.offset += 4;
  }
}

function lastChanged(reader, items) {
  reader.need(items.length * 8, "Kin received a truncated Item history date.");
  for (const item of items) {
    const lastChangedAt = Number(reader.view.getBigInt64(reader.offset, true));
    if (!Number.isSafeInteger(lastChangedAt) || Math.abs(lastChangedAt) > MAX_TIMESTAMP)
      throw invalid("Kin received an invalid Item history date.");
    item.lastChangedAt = lastChangedAt;
    reader.offset += 8;
  }
}

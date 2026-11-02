// "This week" (#417) codecs, matching rust/src/week.rs:
// - KWKQ v1: the query, a start civil date (YYYYMMDD); the KINE context
//   follows it.
// - KWKD v1: seven days of items, routine occurrences, dinners and
//   maintenance, each day in Rust's order. Rust supplies every date: the
//   host never derives an occurrence itself.
import { assertCivilDate, isCivilDate, ROUTINE_CADENCES } from "./wire.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const CLASSIFICATIONS = ["today", "need", "shopping", "staple"];
const ZERO_ID = "00".repeat(16);
export const WEEK_DAYS = 7;
/** Per-day caps (rust/src/week.rs); entries past them are counted in `omitted`. */
export const MAX_WEEK_ITEMS_PER_DAY = 64;
export const MAX_WEEK_ROUTINES_PER_DAY = 64;
export const MAX_WEEK_MAINTENANCE_PER_DAY = 32;

export class WeekFormatError extends Error {
  constructor() {
    super("Kin received invalid week data.");
    this.name = "WeekFormatError";
  }
}

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** KWKQ v1 for `startCivilDate`: 16 bytes; the KINE context follows it. */
export function encodeWeekQuery(startCivilDate) {
  assertCivilDate(startCivilDate);
  const out = new Uint8Array(16);
  out.set([75, 87, 75, 81, 1, 0, 0, 0]);
  new DataView(out.buffer).setUint32(8, startCivilDate, true);
  return out;
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  need(count) { if (this.at + count > this.bytes.length) throw new WeekFormatError(); }
  u8() { this.need(1); return this.bytes[this.at++]; }
  u16() { this.need(2); const value = this.view.getUint16(this.at, true); this.at += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.at, true); this.at += 4; return value; }
  date() { const value = this.u32(); if (!isCivilDate(value)) throw new WeekFormatError(); return value; }
  id() { this.need(16); const value = toHex(this.bytes.subarray(this.at, this.at + 16)); this.at += 16; return value; }
  zero(count) { for (let index = 0; index < count; index += 1) if (this.u8() !== 0) throw new WeekFormatError(); }
  /** An ID that is present exactly when `present`, else zero; null when absent. */
  optionalId(present) {
    const value = this.id();
    if (present ? value === ZERO_ID : value !== ZERO_ID) throw new WeekFormatError();
    return present ? value : null;
  }
  text() { const length = this.u16(); this.need(length); const value = decoder.decode(this.bytes.subarray(this.at, this.at + length)); this.at += length; return value; }
}

/** KWKD v1 as [{ date, items, routines, meals, maintenance, omitted }], one
 * entry per day from the start date, IDs as hex:
 * - items: { itemId, classification, ownerId|null }
 * - routines: { routineId, occurrenceKey (YYYYMMDD, as routine commands take
 *   it), cadence, current, done, ownerId|null }; `done` is only ever true for
 *   the occurrence open on the context's civil date (`current`)
 * - meals: { recipeId|null, cookId|null, name } (at most one)
 * - maintenance: { maintenanceId, recordId, performedOn } */
export function decodeWeek(bytes) {
  const read = new Reader(bytes);
  read.need(16);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "KWKD") throw new WeekFormatError();
  read.at = 4;
  if (read.u16() !== 1) throw new WeekFormatError();
  read.zero(2);
  const start = read.date();
  const dayCount = read.u8(), flags = read.u8();
  if (dayCount !== WEEK_DAYS || flags > 1) throw new WeekFormatError();
  read.zero(2);
  const days = [];
  let previous = null;
  for (let index = 0; index < dayCount; index += 1) {
    const date = read.date();
    if (index === 0 ? date !== start : date <= previous) throw new WeekFormatError();
    previous = date;
    const itemCount = read.u16(), routineCount = read.u16(), mealCount = read.u8(), maintenanceCount = read.u8();
    const omitted = read.u16();
    if (itemCount > MAX_WEEK_ITEMS_PER_DAY || routineCount > MAX_WEEK_ROUTINES_PER_DAY || mealCount > 1 || maintenanceCount > MAX_WEEK_MAINTENANCE_PER_DAY)
      throw new WeekFormatError();
    if (flags === 1 && routineCount !== 0) throw new WeekFormatError();
    const items = [];
    for (let entry = 0; entry < itemCount; entry += 1) {
      const itemId = read.id();
      const classification = CLASSIFICATIONS[read.u8()], owner = read.u8();
      if (!classification || owner > 1) throw new WeekFormatError();
      read.zero(2);
      items.push({ itemId, classification, ownerId: read.optionalId(owner === 1) });
    }
    const routines = [];
    for (let entry = 0; entry < routineCount; entry += 1) {
      const routineId = read.id();
      const occurrenceKey = read.date();
      const cadence = ROUTINE_CADENCES[read.u8()], bits = read.u8();
      // Bits: 0 owner, 1 current, 2 done (only with current).
      if (!cadence || bits > 7 || (bits & 4 && !(bits & 2))) throw new WeekFormatError();
      read.zero(2);
      routines.push({ routineId, occurrenceKey, cadence, current: (bits & 2) !== 0, done: (bits & 4) !== 0, ownerId: read.optionalId((bits & 1) !== 0) });
    }
    const meals = [];
    for (let entry = 0; entry < mealCount; entry += 1) {
      const bits = read.u8();
      if (bits > 3) throw new WeekFormatError();
      read.zero(3);
      const recipeId = read.optionalId((bits & 1) !== 0);
      const cookId = read.optionalId((bits & 2) !== 0);
      const name = read.text();
      if (!name) throw new WeekFormatError();
      meals.push({ recipeId, cookId, name });
    }
    const maintenance = [];
    for (let entry = 0; entry < maintenanceCount; entry += 1) {
      const maintenanceId = read.optionalId(true);
      const recordId = read.optionalId(true);
      maintenance.push({ maintenanceId, recordId, performedOn: read.date() });
    }
    days.push({ date, items, routines, meals, maintenance, omitted });
  }
  if (read.at !== bytes.length) throw new WeekFormatError();
  return days;
}

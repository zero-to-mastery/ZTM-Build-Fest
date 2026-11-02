// The Routines section: Routine records, then Rust's next-occurrence date per
// Routine. Wire combinations are checked here; no period is ever derived.
import {
  assertCivilDate,
  assertTimestamp,
  civilOrdinal,
  idToHex,
  ROUTINE_CADENCES,
  strictTextDecoder,
} from "../wire.js";
import { invalid } from "./reader.js";

export function decodeRoutines(reader, { routineCount }) {
  const routines = records(reader, routineCount);
  nextOccurrences(reader, routines);
  return routines;
}

// Cadence wire codes, in ROUTINE_CADENCES order (wire.js).
const DAILY = 0, WEEKLY = 1, BIWEEKLY = 2, MONTHLY = 3, WEEKDAYS = 4;

// The current occurrence key (a civil date, YYYYMMDD) must be the first day
// of a period of the cadence, on or after the Routine was created. Rust
// computes the key; this only rejects combinations that cannot be valid.
// Throws a bare Error, which records() turns into a decode error.
function assertOccurrenceKey(key, cadence, createdOn) {
  // Daily: any day from creation on.
  if (cadence === DAILY && key < createdOn) throw new Error();
  // Weekly: a Monday, and creation falls on or before that week's Sunday.
  if (cadence === WEEKLY) {
    const d = new Date(0);
    d.setUTCFullYear(Math.floor(key / 10000), (Math.floor(key / 100) % 100) - 1, key % 100);
    if (d.getUTCDay() !== 1) throw new Error();
    d.setUTCDate(d.getUTCDate() + 6);
    const endKey = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    if (endKey < createdOn) throw new Error();
  }
  // Every two weeks: a whole number of 14-day steps after creation.
  if (cadence === BIWEEKLY && (key < createdOn || (civilOrdinal(key) - civilOrdinal(createdOn)) % 14 !== 0))
    throw new Error();
  // Monthly: day 1 of a month, from the month of creation on.
  if (cadence === MONTHLY && (key % 100 !== 1 || key < Math.floor(createdOn / 100) * 100 + 1)) throw new Error();
  // Weekdays: a Monday-Friday key on or after creation. Ordinal 0 is
  // 0001-01-01, a Monday in the proleptic Gregorian calendar, so ordinal % 7
  // is 0 for Monday through 6 for Sunday.
  if (cadence === WEEKDAYS && (key < createdOn || civilOrdinal(key) % 7 >= 5)) throw new Error();
}

function records(reader, count) {
  const { bytes, view } = reader;
  const routines = [];
  const routineIds = new Set();
  for (let index = 0; index < count; index += 1) {
    const offset = reader.offset;
    reader.need(56, "Kin received a truncated routine.");
    const headerEnd = offset + 56;
    const length = view.getUint32(offset + 52, true);
    const end = headerEnd + length;
    const routineId = idToHex(bytes.subarray(offset, offset + 16));
    const createdAt = Number(view.getBigInt64(offset + 32, true));
    const createdOn = view.getUint32(offset + 40, true);
    const key = view.getUint32(offset + 44, true);
    const cadence = bytes[offset + 48];
    const status = bytes[offset + 49];
    const occurrence = bytes[offset + 50];
    if (
      length < 1 ||
      length > 4096 ||
      end > reader.end ||
      cadence > 4 ||
      status > 1 ||
      occurrence > 2 ||
      bytes[offset + 51] !== 0 ||
      (key === 0) !== (occurrence === 0) ||
      (status === 1 && occurrence !== 0) ||
      routineIds.has(routineId)
    )
      throw invalid("Kin received an invalid routine.");
    let text;
    try {
      assertTimestamp(createdAt);
      assertCivilDate(createdOn);
      if (key) {
        assertCivilDate(key);
        assertOccurrenceKey(key, cadence, createdOn);
      }
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, end));
    } catch {
      throw invalid("Kin received invalid routine fields.");
    }
    routineIds.add(routineId);
    routines.push({
      routineId,
      createdBy: idToHex(bytes.subarray(offset + 16, offset + 32)),
      createdAt,
      createdOn,
      cadence: ROUTINE_CADENCES[cadence],
      status: ["active", "archived"][status],
      occurrenceKey: key || null,
      occurrenceStatus: ["unavailable", "open", "completed"][occurrence],
      nextOn: null,
      text,
    });
    reader.offset = end;
  }
  return routines;
}

function nextOccurrences(reader, routines) {
  reader.need(routines.length * 4, "Kin received truncated routine schedule data.");
  for (const routine of routines) {
    const nextOn = reader.view.getUint32(reader.offset, true);
    reader.offset += 4;
    try {
      if (nextOn) assertCivilDate(nextOn);
      // An archived Routine has no next occurrence; an active one's next
      // occurrence (0 when none fits before 9999-12-31) comes after the current.
      const archivedWithNext = routine.status === "archived" && nextOn !== 0;
      const nextNotAfterCurrent = routine.status !== "archived" && nextOn !== 0 && routine.occurrenceKey && nextOn <= routine.occurrenceKey;
      if (archivedWithNext || nextNotAfterCurrent) throw new Error();
    } catch {
      throw invalid("Kin received invalid routine schedule data.");
    }
    routine.nextOn = nextOn || null;
  }
}

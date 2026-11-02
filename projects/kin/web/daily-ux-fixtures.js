// Stable records shaped exactly like the Rust/WASM item projection. These
// fixtures exercise presentation only; they are never written to IndexedDB.
export const DAILY_UX_CIVIL_DATE = 20261014;

const base = Object.freeze({
  classification: "need",
  areaId: null,
  responsibility: null,
  steps: [],
});

const item = (itemId, text, planningDate, status = "active") => Object.freeze({
  ...base,
  itemId,
  text,
  planningDate,
  status,
});

export const DAILY_UX_FIXTURES = Object.freeze({
  empty: Object.freeze([]),
  overdue: Object.freeze([
    item("00000000000000000000000000000001", "Return library books", 20261013),
  ]),
  dueToday: Object.freeze([
    item("00000000000000000000000000000002", "Call the dentist", DAILY_UX_CIVIL_DATE),
  ]),
  completed: Object.freeze([
    item("00000000000000000000000000000003", "Pack lunches", DAILY_UX_CIVIL_DATE, "completed"),
  ]),
  upcoming: Object.freeze([
    item("00000000000000000000000000000004", "Renew car registration", 20261016),
  ]),
});

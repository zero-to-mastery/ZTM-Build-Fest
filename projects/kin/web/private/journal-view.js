// The journal page's pure helpers (#497, #504): dates, grouping, search,
// months and "On this day". No DOM and no storage; entries are KPRV journal
// entries (web/wasm/kin-private.js), already newest first as Rust ordered
// them. Search runs here, on this device, over what this device decrypted:
// it never reaches household search (web/search.js) or the service.

/** Today's civil date ("YYYY-MM-DD") on this device's clock. */
export function todayCivilDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** A civil date as a UTC midnight Date, for formatting only. */
function asDate(civil) {
  const [year, month, day] = civil.split("-").map(Number);
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  return date;
}

/** "Saturday, 3 October 2026" in the reader's language. */
export function formatJournalDate(civil, locale = undefined) {
  return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(asDate(civil));
}

/** "October 2026" for a "YYYY-MM" month. */
export function formatJournalMonth(month, locale = undefined) {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(asDate(`${month}-01`));
}

/** Consecutive entries on the same date, in the order given:
 * [{ date, entries }]. */
export function groupByDate(entries) {
  const groups = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last?.date === entry.date) last.entries.push(entry);
    else groups.push({ date: entry.date, entries: [entry] });
  }
  return groups;
}

/** Text folded for matching: case and accents ignored. */
export function foldJournalText(text) {
  return String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/**
 * Entries whose title or body holds every word of `query` (case and accents
 * ignored), in the order given. An empty query matches everything.
 */
export function searchJournal(entries, query) {
  const terms = foldJournalText(query).split(/\s+/u).filter(Boolean);
  if (!terms.length) return entries;
  return entries.filter((entry) => {
    const text = foldJournalText(`${entry.title}\n${entry.body}`);
    return terms.every((term) => text.includes(term));
  });
}

/** The months that have entries, newest first: [{ month: "YYYY-MM",
 * count }]. */
export function journalMonths(entries) {
  const months = new Map();
  for (const entry of entries) {
    const month = entry.date.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + 1);
  }
  return [...months].sort(([left], [right]) => (left < right ? 1 : left > right ? -1 : 0)).map(([month, count]) => ({ month, count }));
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * "On this day": entries from the same day and month in earlier years, the
 * most recent year first. On 28 February of a year without a 29th, entries
 * from 29 February come along.
 */
export function onThisDay(entries, today) {
  const year = Number(today.slice(0, 4));
  const day = today.slice(5);
  const days = new Set([day]);
  if (day === "02-28" && !isLeapYear(year)) days.add("02-29");
  return entries.filter((entry) => Number(entry.date.slice(0, 4)) < year && days.has(entry.date.slice(5)));
}

/** How long ago a year was, in words: "1 year ago", "3 years ago". */
export function yearsAgo(civil, today) {
  const years = Number(today.slice(0, 4)) - Number(civil.slice(0, 4));
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/** Every blob reference an entry's photos name. */
export function photoRefs(photos) {
  return (photos ?? []).flatMap((photo) => [photo.ref, photo.thumbnail]);
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  foldJournalText, formatJournalDate, formatJournalMonth, groupByDate, journalMonths, onThisDay, photoRefs, searchJournal,
  todayCivilDate, yearsAgo,
} from "./journal-view.js";

const entry = (id, date, title = "", body = "") => ({ id, date, title, body, photos: [] });

test("today is this device's civil date", () => {
  assert.equal(todayCivilDate(new Date(2026, 9, 3, 23, 59)), "2026-10-03");
  assert.equal(todayCivilDate(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
});

test("dates and months read in the reader's language", () => {
  // ICU versions differ on the comma after the weekday.
  assert.match(formatJournalDate("2026-10-03", "en-GB"), /^Saturday,? 3 October 2026$/);
  assert.match(formatJournalDate("2024-02-29", "en-US"), /^Thursday,? February 29, 2024$/);
  assert.equal(formatJournalMonth("2026-10", "en-GB"), "October 2026");
});

test("entries group under their date in the order given", () => {
  const groups = groupByDate([entry("c", "2026-10-03"), entry("b", "2026-10-03"), entry("a", "2026-10-01")]);
  assert.deepEqual(groups.map((group) => [group.date, group.entries.map((item) => item.id)]), [
    ["2026-10-03", ["c", "b"]],
    ["2026-10-01", ["a"]],
  ]);
  assert.deepEqual(groupByDate([]), []);
});

test("search matches every word in the title or body, ignoring case and accents", () => {
  const entries = [
    entry("1", "2026-10-03", "Park", "Swings, then cocoa at the café."),
    entry("2", "2026-09-01", "", "First day of school.\nShe was brave."),
    entry("3", "2025-10-03", "Rainy", "Stayed in with cocoa."),
  ];
  assert.deepEqual(searchJournal(entries, "cocoa").map((item) => item.id), ["1", "3"]);
  assert.deepEqual(searchJournal(entries, "  COCOA   cafe ").map((item) => item.id), ["1"]);
  assert.deepEqual(searchJournal(entries, "school brave").map((item) => item.id), ["2"]);
  assert.deepEqual(searchJournal(entries, "rainy").map((item) => item.id), ["3"], "titles count");
  assert.deepEqual(searchJournal(entries, "zebra"), []);
  assert.equal(searchJournal(entries, " "), entries, "an empty query shows everything");
  assert.equal(foldJournalText("Ångström ÉTÉ"), "angstrom ete");
});

test("months with entries, newest first", () => {
  assert.deepEqual(journalMonths([entry("1", "2026-10-03"), entry("2", "2026-10-01"), entry("3", "2025-12-31"), entry("4", "2026-01-05")]), [
    { month: "2026-10", count: 2 },
    { month: "2026-01", count: 1 },
    { month: "2025-12", count: 1 },
  ]);
});

test("On this day shows the same day in earlier years only", () => {
  const entries = [entry("today", "2026-10-03"), entry("last", "2025-10-03"), entry("old", "2019-10-03"), entry("near", "2025-10-04")];
  assert.deepEqual(onThisDay(entries, "2026-10-03").map((item) => item.id), ["last", "old"]);
  assert.deepEqual(onThisDay(entries, "2026-11-03"), []);
  // 29 February comes along on 28 February of a year without one.
  const leap = [entry("leap", "2024-02-29"), entry("feb28", "2024-02-28")];
  assert.deepEqual(onThisDay(leap, "2025-02-28").map((item) => item.id), ["leap", "feb28"]);
  assert.deepEqual(onThisDay(leap, "2028-02-28").map((item) => item.id), ["feb28"]);
  assert.deepEqual(onThisDay(leap, "2028-02-29").map((item) => item.id), ["leap"]);
  assert.equal(yearsAgo("2025-10-03", "2026-10-03"), "1 year ago");
  assert.equal(yearsAgo("2019-10-03", "2026-10-03"), "7 years ago");
});

test("a photo names its blob and its thumbnail", () => {
  assert.deepEqual(photoRefs([{ ref: "a", thumbnail: "b" }, { ref: "c", thumbnail: "d" }]), ["a", "b", "c", "d"]);
  assert.deepEqual(photoRefs(undefined), []);
});

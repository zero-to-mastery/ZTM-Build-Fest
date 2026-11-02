import assert from "node:assert/strict";
import test from "node:test";
import { createCalendarExport } from "./calendar-export.js";

const exportedAt = new Date("2026-10-03T12:34:56.789Z");

test("exports active planned Items as sorted all-day calendar events", () => {
  const contents = createCalendarExport([
    {
      itemId: "later",
      text: "Pick up milk",
      planningDate: 20261005,
      status: "active",
    },
    {
      itemId: "earlier",
      text: "Call the school",
      planningDate: 20261003,
      status: "active",
    },
    {
      itemId: "completed",
      text: "Already handled",
      planningDate: 20261003,
      status: "completed",
    },
    {
      itemId: "archived",
      text: "No longer active",
      planningDate: 20261003,
      status: "archived",
    },
    {
      itemId: "undated",
      text: "No date yet",
      planningDate: null,
      status: "active",
    },
  ], exportedAt);

  assert.ok(contents.startsWith(
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kin//Planned Items//EN\r\n",
  ));
  assert.ok(contents.endsWith("END:VCALENDAR\r\n"));
  assert.equal((contents.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.ok(contents.indexOf("Call the school") < contents.indexOf("Pick up milk"));
  assert.match(contents, /DTSTAMP:20261003T123456Z/);
  assert.match(contents, /DTSTART;VALUE=DATE:20261003\r\nDURATION:P1D/);
  assert.ok(contents.includes(`UID:kin-${[...new TextEncoder().encode("earlier")]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")}@kin.local`));
});

test("escapes calendar text and folds lines on UTF-8 boundaries", () => {
  const text = `Buy, bake; and pack \\\\ bread\n${"🧺".repeat(32)}`;
  const contents = createCalendarExport([{
    itemId: "unicode",
    text,
    planningDate: 20261003,
    status: "active",
  }], exportedAt);
  const summary = contents.split("\r\n").filter((line) => line.startsWith("SUMMARY:") || line.startsWith(" "));

  assert.ok(contents.includes("SUMMARY:Buy\\, bake\\; and pack \\\\\\\\ bread\\n"));
  assert.ok(summary.length > 1, "long Unicode summary is folded");
  for (const line of contents.split("\r\n").filter(Boolean)) {
    assert.ok(new TextEncoder().encode(line).length <= 75, "folded line fits RFC octet limit");
  }
});

test("formats low years and leap days, rejecting invalid civil dates", () => {
  const contents = createCalendarExport([
    { itemId: "low", text: "First day", planningDate: 10101, status: "active" },
    { itemId: "leap", text: "Leap day", planningDate: 20240229, status: "active" },
  ], exportedAt);
  assert.ok(contents.includes("DTSTART;VALUE=DATE:00010101"));
  assert.ok(contents.includes("DTSTART;VALUE=DATE:20240229"));
  assert.throws(() => createCalendarExport([
    { itemId: "invalid", text: "Invalid day", planningDate: 20230229, status: "active" },
  ], exportedAt), /invalid planning date/);
});

test("rejects invalid export timestamps and over-limit exports", () => {
  assert.throws(() => createCalendarExport([], new Date(Number.NaN)), /valid timestamp/);
  assert.throws(() => createCalendarExport([], new Date(Date.UTC(10_000, 0, 1))), /four-digit year/);
  assert.throws(() => createCalendarExport(Array.from({ length: 10_001 }, (_, index) => ({
    itemId: `item-${index}`,
    text: "Planned",
    planningDate: 20261003,
    status: "active",
  }))), /10,000-Item limit/);
});

test("rejects calendar files above the 16 MiB output limit", () => {
  assert.throws(() => createCalendarExport([{
    itemId: "large",
    text: "x".repeat(16 * 1024 * 1024),
    planningDate: 20261003,
    status: "active",
  }], exportedAt), /16 MiB file limit/);
});

test("drops control characters and turns Unicode line breaks into escaped newlines (#162)", () => {
  const controls = ["\u0000", "\u0001", "\u0005", "\u0008", "\u000B", "\u000C", "\u000E", "\u001B", "\u001F", "\u007F", "\u0080", "\u009F"];
  const contents = createCalendarExport([
    {
      itemId: "controls",
      text: `Bell${controls.join("")}tab\there\u0085next\u2028line\u2029para`,
      planningDate: 20261005,
      status: "active",
    },
  ], exportedAt);
  const summary = contents.split("\r\n").find((line) => line.startsWith("SUMMARY:"));
  assert.equal(summary, "SUMMARY:Belltab\there\\nnext\\nline\\npara");
  // Outside the CRLF line endings, no C0/C1 control other than tab remains.
  const body = contents.replaceAll("\r\n", "");
  assert.equal(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/.test(body), false);
});

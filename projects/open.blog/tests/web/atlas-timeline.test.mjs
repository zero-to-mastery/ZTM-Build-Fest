// Contract tests for <ob-atlas-timeline> (ADR 0100): filters show or hide a
// whole dated aspect and never one of its competing datings, the status line
// says what is shown, the component reads only the page and writes only text,
// shadows no HTMLElement property, and the page's styles keep print complete
// and add no motion. The real DOM is covered by tests/browser/atlas-timeline.spec.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

globalThis.HTMLElement = class {};
let defined = null;
globalThis.customElements = { get: () => undefined, define: (name, constructor) => (defined = { name, constructor }) };

const { filterRows, statusText, aspectChoices, ObAtlasTimeline } = await import("../../web/components/ob-atlas-timeline.js");
const source = fs.readFileSync(new URL("../../web/components/ob-atlas-timeline.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../../web/base.css", import.meta.url), "utf8");

const ROWS = [
  { aspect: "birth", datings: 2 },
  { aspect: "active", datings: 1 },
  { aspect: "death", datings: 1 },
  { aspect: "composition", datings: 3 },
];

test("a filter shows or hides whole dated aspects, never one competing dating", () => {
  assert.deepEqual(filterRows(ROWS), [true, true, true, true]);
  assert.deepEqual(filterRows(ROWS, { aspect: "birth" }), [true, false, false, false]);
  assert.deepEqual(filterRows(ROWS, { competing: true }), [true, false, false, true]);
  assert.deepEqual(filterRows(ROWS, { aspect: "death", competing: true }), [false, false, false, false]);
  // The result is per row, so a row's datings can only stay together.
  assert.equal(filterRows(ROWS, { aspect: "composition" }).length, ROWS.length);
});

test("the status line says what is shown and every filter in force", () => {
  assert.equal(
    statusText(ROWS, filterRows(ROWS)),
    "Showing 4 of 4 dated aspects (7 of 7 datings). Every aspect shown keeps all its datings, their evidence and their notes.",
  );
  const filters = { aspect: "birth", competing: true };
  assert.equal(
    statusText(ROWS, filterRows(ROWS, filters), filters),
    "Showing 1 of 4 dated aspects (2 of 7 datings); birth only; only aspects with competing datings. Every aspect shown keeps all its datings, their evidence and their notes.",
  );
  const none = { aspect: "death", competing: true };
  assert.match(statusText(ROWS, filterRows(ROWS, none), none), /Showing 0 of 4 .*Nothing matches; choose every aspect to see the whole timeline\.$/);
  const one = [{ aspect: "active", datings: 1 }];
  assert.equal(statusText(one, [true], { aspect: "active" }), "Showing 1 of 1 dated aspect (1 of 1 dating); activity only. Every aspect shown keeps all its datings, their evidence and their notes.");
});

test("the aspect choices are only the aspects the timeline lists, in a fixed order", () => {
  assert.deepEqual(aspectChoices(ROWS).map(([value]) => value), ["birth", "death", "active", "composition"]);
  assert.deepEqual(aspectChoices([]), []);
});

test("the component is defined once, shadows no HTMLElement property, and reads only the page", () => {
  assert.equal(defined?.name, "ob-atlas-timeline");
  assert.equal(defined.constructor, ObAtlasTimeline);
  assert.deepEqual(Object.getOwnPropertyNames(ObAtlasTimeline.prototype).sort(), ["connectedCallback", "constructor", "disconnectedCallback"]);
  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "fetch(", "localStorage", "sessionStorage", "indexedDB", ".style", "eval(", "scrollIntoView", "animate("]) {
    assert.ok(!source.includes(banned), `the component uses ${banned}`);
  }
  assert.ok(source.includes("textContent"), "it writes text only");
  assert.ok(source.includes("new AbortController()"), "it detaches every listener on disconnection");
});

test("print shows the whole timeline without its filters, and nothing in it moves", () => {
  const print = [...styles.matchAll(/@media print\s*{([\s\S]*?)\n}/g)].map((match) => match[1]).join("\n");
  assert.match(print, /\.ob-atlas-timeline-tools\s*{\s*display:\s*none !important;\s*}/);
  assert.match(print, /\.ob-atlas-timeline li\[hidden\]\s*{\s*display:\s*list-item !important;\s*}/);
  assert.match(print, /\.ob-atlas-timeline section\[hidden\]\s*{\s*display:\s*block !important;\s*}/);
  const atlas = styles.slice(styles.indexOf("/* Knowledge Atlas datings and timeline"));
  assert.ok(!/transition|animation/.test(atlas), "the timeline adds no motion");
});

test("a period a filter emptied never stays selected: the choice moves to the first enabled option", async () => {
  const { settlePeriod } = await import("../../web/components/ob-atlas-timeline.js");
  const select = (flags, selected) => {
    const options = flags.map((disabled, index) => ({ value: `p${index}`, disabled }));
    const box = { options, selectedIndex: selected, set value(v) { this.selectedIndex = options.findIndex((o) => o.value === v); } };
    return box;
  };
  const stuck = select([true, false, false], 0);
  assert.equal(settlePeriod(stuck), true);
  assert.equal(stuck.selectedIndex, 1);
  const fine = select([false, false], 1);
  assert.equal(settlePeriod(fine), true);
  assert.equal(fine.selectedIndex, 1, "an enabled selection is left alone");
  const none = select([true, true], 0);
  assert.equal(settlePeriod(none), false, "nothing enabled is reported so the status line can say so");
  assert.equal(none.selectedIndex, 0);
  assert.match(source, /No period has anything to go to\./);
});

// The logic of <ob-atlas-trail> (ADR 0175): which steps a filter shows and what the status line
// says. The steps and filters are tests/fixtures/atlas-trail.json, whose steps crates/openblog-core
// /tests/atlas_trail.rs checks against the real renderer and the real bounded walk, so the
// component and the Rust side cannot drift. The keyboard, layout and print behaviour is covered in
// a browser by tests/browser/atlas-trail.spec.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The module defines its element when it loads; node has no DOM, so only the registry is faked.
globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define() {} };
const { depthChoices, filterSteps, kindChoices, readStep, statusText } = await import(
  "../../web/components/ob-atlas-trail.js"
);

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/atlas-trail.json", import.meta.url), "utf8"));
const attributesOf = (step) => ({
  "data-depth": String(step.depth),
  "data-kind": step.kind,
  "data-direction": step.direction,
  "data-standing": step.contested ? "contested" : "asserted",
  "data-uncertain": String(step.uncertain),
  "data-again": String(step.again),
});
const steps = fixtures.steps.map((step) => ({ id: step.id, ...readStep(attributesOf(step), step.kindLabel) }));

test("a step is read from the attributes the page writes", () => {
  assert.equal(steps.length, 5);
  assert.deepEqual(
    steps.map((step) => ({ ...step, id: undefined })),
    fixtures.steps.map((step) => ({
      id: undefined,
      depth: step.depth,
      kind: step.kind,
      kindLabel: step.kindLabel,
      direction: step.direction,
      contested: step.contested,
      uncertain: step.uncertain,
      again: step.again,
    })),
  );
  // A step written wrongly is still described, and matches no specific filter.
  const odd = readStep({ "data-depth": "x" });
  assert.deepEqual(odd, { depth: 0, kind: "", kindLabel: "", direction: "", contested: false, uncertain: false, again: false });
  assert.deepEqual(filterSteps([odd], { depth: 1 }), [false]);
  assert.deepEqual(filterSteps([odd], {}), [true]);
});

for (const { name, filters, shown } of fixtures.filters) {
  test(`filter: ${name}`, () => {
    const result = filterSteps(steps, filters);
    assert.deepEqual(steps.filter((_, index) => result[index]).map((step) => step.id), shown);
  });
}

test("a filter shows or hides whole steps and keeps their order", () => {
  const shown = filterSteps(steps, { direction: "forward" });
  assert.equal(shown.length, steps.length);
  assert.ok(shown.every((value) => typeof value === "boolean"));
});

test("the choices are only what the trail has, in the order it has them", () => {
  assert.deepEqual(kindChoices(steps), [
    ["authored", "authored"],
    ["developed", "developed"],
    ["influenced", "influenced"],
    ["related-to", "related to"],
    ["discusses", "discusses"],
  ]);
  assert.deepEqual(depthChoices(steps), [1, 2]);
  assert.deepEqual(depthChoices([]), []);
});

test("the status says how many are shown and every filter in force, and never claims more", () => {
  const all = filterSteps(steps, {});
  assert.equal(
    statusText(steps, all, {}),
    "Showing 5 of 5 relationships. Every relationship shown keeps its direction, evidence and uncertainty.",
  );
  const filters = { kind: "related-to", direction: "backward", depth: 1, doubtful: true };
  const shown = filterSteps(steps, filters);
  const text = statusText(steps, shown, filters);
  assert.match(text, /^Showing 1 of 5 relationships; type: related to; against the direction stated; relationships that read the same both ways are shown under either choice; within one step; only contested or uncertain relationships\./);
  assert.match(text, /keeps its direction, evidence and uncertainty/);
  const none = filterSteps(steps, { kind: "authored", direction: "backward" });
  assert.match(statusText(steps, none, { kind: "authored", direction: "backward" }), /Showing 0 of 5 relationships.*Nothing matches; reset the filters/);
  assert.match(statusText([steps[0]], [true], {}), /^Showing 1 of 1 relationship\./);
});

test("a relationship that reads the same both ways is shown under either direction and never called against one", () => {
  const symmetric = steps.find((step) => step.direction === "symmetric");
  assert.equal(symmetric.id, "r-related");
  for (const direction of ["forward", "backward"]) {
    const shown = filterSteps(steps, { direction });
    assert.equal(shown[steps.indexOf(symmetric)], true, direction);
    assert.match(statusText(steps, shown, { direction }), /read the same both ways are shown under either choice/);
  }
  // A trail with none says nothing about them.
  const directed = steps.filter((step) => step.direction !== "symmetric");
  assert.doesNotMatch(statusText(directed, filterSteps(directed, { direction: "backward" }), { direction: "backward" }), /same both ways/);
  // The kind's words come from the step's own attribute when it has one (a compact step has no Type entry).
  assert.equal(readStep({ "data-kind": "influenced", "data-kind-label": "influenced" }).kindLabel, "influenced");
});

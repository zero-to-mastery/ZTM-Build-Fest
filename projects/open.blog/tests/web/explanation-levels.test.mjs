// The logic of <ob-explanation-levels> (ADR 0232): which levels a page offers, which level a URL
// fragment asks for, and what the status line says. Hiding, keyboard and layout behaviour is covered
// in a browser by tests/browser/interpretation-pages.spec.mjs.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define() {} };
const { levelFromHash, levelsOf, modeAllows, statusFor } = await import("../../web/components/ob-explanation-levels.js");

test("levels are offered in the fixed order whatever order the page has them", () => {
  assert.deepEqual(levelsOf(["scholarly", "beginner"]), ["beginner", "scholarly"]);
  assert.deepEqual(levelsOf(["student", "unknown", "<b>", "beginner", "student"]), ["beginner", "student"]);
  assert.deepEqual(levelsOf([]), []);
});

test("a fragment names a level only when the page has it", () => {
  const levels = ["beginner", "student"];
  assert.equal(levelFromHash("#level-student", levels), "student");
  assert.equal(levelFromHash("#level-student-heading", levels), "student");
  assert.equal(levelFromHash("#level-scholarly", levels), null);
  for (const hash of ["", "#", "#x-beginner", "#level-", "#level-student-x", "#level-Student", null, undefined, 7]) {
    assert.equal(levelFromHash(hash, levels), null, String(hash));
  }
});

test("the status says what is shown and that the evidence is unchanged", () => {
  assert.equal(statusFor("all"), "Showing every explanation level.");
  const text = statusFor("student");
  assert.match(text, /student explanations/);
  assert.match(text, /evidence above are unchanged/);
});

test("standard shows every explanation and a named list narrows the other modes", () => {
  for (const modes of [null, undefined, "", "guided", "deep-dive", "guided deep-dive"]) {
    assert.equal(modeAllows("standard", modes), true, String(modes));
  }
  assert.equal(modeAllows("guided", "guided"), true);
  assert.equal(modeAllows("guided", "deep-dive"), false);
  assert.equal(modeAllows("deep-dive", "guided deep-dive"), true);
  assert.equal(modeAllows("deep-dive", " guided "), true);
  assert.equal(modeAllows("guided", "deep-dive guided"), true);
  assert.equal(modeAllows("guided", null), true);
});

test("a list the page cannot read never hides an explanation", () => {
  assert.equal(modeAllows("guided", "expert"), true);
  assert.equal(modeAllows("guided", 7), true);
});

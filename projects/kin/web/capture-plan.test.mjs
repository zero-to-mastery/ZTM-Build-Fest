import assert from "node:assert/strict";
import test from "node:test";
import { describePartialCapture, remainingCaptureSteps } from "./capture-plan.js";

const ID = "a".repeat(32);

test("a fresh draft needs add, then date, then pin, in order", () => {
  const steps = remainingCaptureSteps({ items: [], pins: [] }, { id: ID, text: "Eggs", classification: "shopping", planningDate: 20261013, pinned: true });
  assert.deepEqual(steps.map((step) => step.type), ["add", "set-item-planning-date", "pin"]);
  assert.equal(steps[0].id, ID);
  assert.equal(steps[1].itemId, ID);
  assert.equal(steps[2].targetId, ID);
});

test("a plain task without a date or pin needs only the add", () => {
  assert.deepEqual(remainingCaptureSteps({ items: [], pins: [] }, { id: ID, text: "Call", classification: "need", planningDate: null, pinned: false }).map((step) => step.type), ["add"]);
});

test("after the add committed, only the outstanding operations remain against the same id", () => {
  const state = { items: [{ itemId: ID, text: "Eggs", classification: "shopping", planningDate: null }], pins: [] };
  const steps = remainingCaptureSteps(state, { id: ID, text: "Eggs", classification: "shopping", planningDate: 20261013, pinned: true });
  assert.deepEqual(steps.map((step) => step.type), ["set-item-planning-date", "pin"]);
});

test("nothing remains once the projection already reflects the draft", () => {
  const state = { items: [{ itemId: ID, planningDate: 20261013 }], pins: [{ targetKind: "item", targetId: ID }] };
  assert.deepEqual(remainingCaptureSteps(state, { id: ID, text: "Eggs", classification: "shopping", planningDate: 20261013, pinned: true }), []);
});

test("a draft without an id is refused so no duplicate can be created", () => {
  assert.throws(() => remainingCaptureSteps({ items: [] }, { text: "Eggs" }), TypeError);
});

test("partial failures are described truthfully", () => {
  assert.equal(describePartialCapture({ type: "add" }, "To do"), "Couldn't save. Your text is still here.");
  assert.equal(describePartialCapture({ type: "create-routine" }, "To do"), "Couldn't save. Your text is still here.");
  assert.equal(describePartialCapture({ type: "set-item-planning-date" }, "Shopping"), "Saved to Shopping. Couldn't set the date.");
  assert.equal(describePartialCapture({ type: "pin" }, "To do"), "Saved to To do. Couldn't pin it.");
});

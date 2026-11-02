// #266: every destination after Today explains itself in one plain sentence,
// without renaming or reordering the five destinations.
import assert from "node:assert/strict";
import test from "node:test";
import { DESTINATION_DESCRIPTIONS } from "./constants.js";
import { SEGMENTS } from "../../routes.js";

test("each destination with sections has a plain one-sentence description", () => {
  for (const page of Object.keys(SEGMENTS)) {
    const description = DESTINATION_DESCRIPTIONS[page];
    assert.equal(typeof description, "string", page);
    assert.match(description, /^[A-Z].*\.$/s, `${page} reads as one sentence`);
    assert.ok(description.length <= 140, `${page} stays short enough to scan`);
  }
});

test("the descriptions name what is actually inside each destination", () => {
  assert.match(DESTINATION_DESCRIPTIONS.lists, /to do.*shopping.*staples/is);
  assert.match(DESTINATION_DESCRIPTIONS.routines, /checklists/i);
  assert.match(DESTINATION_DESCRIPTIONS.updates, /Handoffs.*Chat.*To talk about/s);
  assert.match(DESTINATION_DESCRIPTIONS.household, /people and devices.*privacy and recovery/is);
});

test("without chat access the Updates description never mentions Chat", () => {
  assert.doesNotMatch(DESTINATION_DESCRIPTIONS.updatesWithoutChat, /chat/i);
  assert.match(DESTINATION_DESCRIPTIONS.updatesWithoutChat, /Handoffs.*To talk about/s);
});

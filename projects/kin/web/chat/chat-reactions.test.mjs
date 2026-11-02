import assert from "node:assert/strict";
import test from "node:test";
import { QUICK_REACTIONS, reactionChips, reactionLabel, reactionNames } from "./chat-reactions.js";

test("a chip's accessible name says what, how many, and whether you are one", () => {
  assert.equal(reactionLabel("Thumbs up", 2, true), "Thumbs up, 2 people, including you");
  assert.equal(reactionLabel("Thumbs up", 1, false), "Thumbs up, 1 person");
  assert.equal(reactionLabel("Red heart", 1, true), "Red heart, 1 person, including you");
});

test("chips count, mark mine, and list who reacted with You first", () => {
  const names = reactionNames({ categories: [{ emoji: [["🎉", "party popper"], ["👍", "thumbs up"]] }] });
  assert.equal(names.get("👍"), "Thumbs up", "the quick set keeps its own names");
  assert.equal(names.get("🎉"), "Party popper");
  const chips = reactionChips(
    [{ emoji: "👍", actors: ["sam", "me"] }, { emoji: "🎉", actors: ["sam"] }, { emoji: "🦄", actors: ["me"] }],
    "me",
    { names, labelOf: (id) => id.toUpperCase() },
  );
  assert.deepEqual(chips.map(({ emoji, count, mine, who, label }) => [emoji, count, mine, who, label]), [
    ["👍", 2, true, ["You", "SAM"], "Thumbs up, 2 people, including you"],
    ["🎉", 1, false, ["SAM"], "Party popper, 1 person"],
    ["🦄", 1, true, ["You"], "🦄, 1 person, including you"],
  ]);
  assert.deepEqual(reactionChips(undefined, "me"), []);
  assert.equal(QUICK_REACTIONS.length, 6);
});

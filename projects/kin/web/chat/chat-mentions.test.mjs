import test from "node:test";
import assert from "node:assert/strict";
import { activeMention, mentionOptions, splitMentions, resolveMentions } from "./chat-mentions.js";

test("an @ being typed is found, but not inside a word", () => {
  assert.deepEqual(activeMention("hi @Ma", 6), { start: 3, query: "Ma" });
  assert.equal(activeMention("mail@Ma", 7), null);
  assert.equal(activeMention("hi @Ma rest", 11), null);
});

test("options match by prefix and always offer everyone", () => {
  const people = [{ id: "a", label: "Maya" }, { id: "b", label: "Ben" }];
  assert.deepEqual(mentionOptions(people, "ma").map((o) => o.label), ["Maya"]);
  assert.deepEqual(mentionOptions(people, "e").map((o) => o.label), ["everyone"]);
});

test("text splits around whole mentions only", () => {
  const entries = [{ id: "a", label: "Maya" }];
  assert.deepEqual(splitMentions("hey @Maya and @everyone, @Mayan", entries, true), [
    { text: "hey ", mention: false }, { text: "@Maya", mention: true }, { text: " and ", mention: false },
    { text: "@everyone", mention: true }, { text: ", @Mayan", mention: false },
  ]);
  assert.deepEqual(splitMentions("@Maya", entries, false), [{ text: "@Maya", mention: true }]);
});

test("only mentions still in the text are sent", () => {
  const chosen = new Map([["Maya", "b2"], ["Ben", "a1"]]);
  assert.deepEqual(resolveMentions("hi @Maya", chosen, true), { everyone: false, members: ["b2"] });
  assert.deepEqual(resolveMentions("@everyone @Ben", chosen, true), { everyone: true, members: ["a1"] });
});

test("a mention of me matches the label others see, and typed labels count", () => {
  const entries = [{ id: "me", label: "Adult 2" }];
  assert.deepEqual(splitMentions("ping @Adult 2 now", entries, false).filter((p) => p.mention).map((p) => p.text), ["@Adult 2"]);
  assert.deepEqual(resolveMentions("hi @Adult 2", new Map([["Adult 2", "me"]]), true), { everyone: false, members: ["me"] });
});

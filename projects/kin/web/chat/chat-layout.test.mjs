import assert from "node:assert/strict";
import test from "node:test";
import { bottomObstruction, chatHeight, MIN_CHAT_HEIGHT } from "./chat-layout.js";

test("the chat takes the visible height below its top, above the bottom bar", () => {
  // A 320×568 phone: the section starts 150px down; a 70px bar is fixed at the bottom.
  assert.equal(chatHeight({ viewportHeight: 568, sectionTop: 150, obstruction: 70 }), 568 - 150 - 70 - 8);
  // The keyboard opens: the visible area is 400px and has scrolled 40px down.
  assert.equal(chatHeight({ viewportHeight: 400, viewportTop: 40, sectionTop: 150, obstruction: 0 }), 400 - 110 - 8);
  // Never less than the minimum.
  assert.equal(chatHeight({ viewportHeight: 200, sectionTop: 150 }), MIN_CHAT_HEIGHT);
  assert.equal(chatHeight({ viewportHeight: Number.NaN, sectionTop: 0 }), null);
});

test("a fixed bar covers only what is inside the visible area", () => {
  assert.equal(bottomObstruction({ top: 498, height: 70 }, { viewportHeight: 568 }), 70);
  assert.equal(bottomObstruction({ top: 498, height: 70 }, { viewportHeight: 300 }), 0, "the keyboard covers the bar");
  assert.equal(bottomObstruction(null, { viewportHeight: 568 }), 0);
});

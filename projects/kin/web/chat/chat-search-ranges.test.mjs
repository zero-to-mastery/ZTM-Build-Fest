import assert from "node:assert/strict";
import test from "node:test";
import { excerptRanges } from "./chat-search-ranges.js";

const bytes = (text) => new TextEncoder().encode(text).length;

test("byte ranges become string indexes, over accents and astral characters", () => {
  const text = "café 👍 needle";
  const start = bytes("café 👍 ");
  const [range] = excerptRanges(text, 0, [[start, start + 6]]);
  assert.equal(text.slice(...range), "needle");
  const [accent] = excerptRanges(text, 0, [[0, bytes("café")]]);
  assert.equal(text.slice(...accent), "café");
});

test("an excerpt's offset is subtracted, and ranges outside it are dropped or cut", () => {
  const whole = "ééé needle here";
  const offset = bytes("ééé ");
  const excerpt = "needle here";
  assert.deepEqual(excerptRanges(excerpt, offset, [[offset, offset + 6]]), [[0, 6]]);
  assert.deepEqual(excerptRanges(excerpt, offset, [[0, 4]]), []);
  assert.deepEqual(excerptRanges(excerpt, offset, [[offset + 7, offset + 400]]), [[7, 11]]);
  assert.equal(whole.length, 15);
});

test("a range that splits a character is ignored", () => {
  assert.deepEqual(excerptRanges("é", 0, [[1, 2]]), []);
});

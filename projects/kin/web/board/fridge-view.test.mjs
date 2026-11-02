import test from "node:test";
import assert from "node:assert/strict";
import { ERASE_REACH, FRIDGE_COLOURS, FRIDGE_WIDTHS, KITCHEN_QUERY, fridgeSummary, kitchenScreenNote, pathPoints, strokeAt } from "./fridge-view.js";
import { PALETTE_COLOURS, PEN_WIDTHS } from "../wasm/kin-board.js";

const stroke = (id, author, points, width = 1) => ({ id, author, colour: 0, width, points: Uint16Array.from(points) });

test("the palette and widths match the board's indices", () => {
  assert.equal(FRIDGE_COLOURS.length, PALETTE_COLOURS);
  assert.equal(FRIDGE_WIDTHS.length, PEN_WIDTHS);
});

test("the eraser finds the topmost stroke near the pointer", () => {
  const strokes = [stroke("a", "m1", [0, 0, 1000, 0]), stroke("b", "m2", [500, -0, 500, 1000])];
  assert.equal(strokeAt(strokes, 500, 10)?.id, "b", "the later stroke is on top");
  assert.equal(strokeAt(strokes, 900, 20)?.id, "a");
  assert.equal(strokeAt(strokes, 900, 400), null, "too far from any stroke");
  // A dot is hit near its one point; a thick pen reaches further.
  assert.equal(strokeAt([stroke("dot", "m1", [100, 100])], 100 + ERASE_REACH, 100)?.id, "dot");
  assert.equal(strokeAt([stroke("thin", "m1", [0, 0, 0, 100], 0)], ERASE_REACH + 20, 50), null);
  assert.equal(strokeAt([stroke("thick", "m1", [0, 0, 0, 100], 2)], ERASE_REACH + 20, 50)?.id, "thick");
});

test("the summary names what is on the fridge without counting anyone", () => {
  const label = (id) => ({ m1: "Sam", m2: "Alex", m3: "you" })[id];
  assert.equal(fridgeSummary({ strokes: [], magnets: [] }, label), "The fridge is empty. Draw something for the household.");
  assert.equal(fridgeSummary({ strokes: [stroke("a", "m1", [0, 0])], magnets: [] }, label), "1 drawing by Sam.");
  assert.equal(
    fridgeSummary({ strokes: [stroke("a", "m1", [0, 0]), stroke("b", "m2", [0, 0]), stroke("c", "m1", [0, 0])], magnets: [{}] }, label),
    "3 drawings by Sam and Alex; 1 magnet.",
  );
  assert.equal(
    fridgeSummary({ strokes: ["m1", "m2", "m3"].map((author, index) => stroke(String(index), author, [0, 0])), magnets: [] }, label),
    "3 drawings by Sam, Alex and you.",
  );
});

test("a swipe is checked along its whole path, so it can't skip a thin line", () => {
  const points = pathPoints([0, 0], [0, 100], 24);
  assert.equal(points.length, 5);
  assert.deepEqual(points.at(-1), [0, 100]);
  assert.ok(points.every((point, index) => index === 0 || point[1] - points[index - 1][1] <= 24));
  // A line crossed between two far-apart samples is still found.
  const line = [{ id: "line", author: "m1", colour: 0, width: 0, points: Uint16Array.from([0, 500, 1000, 500]) }];
  const hits = pathPoints([400, 300], [400, 700], ERASE_REACH / 2).map(([x, y]) => strokeAt(line, x, y)?.id).filter(Boolean);
  assert.ok(hits.includes("line"));
  assert.deepEqual(pathPoints([5, 5], [5, 5], 24), [[5, 5]]);
});

test("kitchen-screen mode says how a shared screen locks (#324)", () => {
  assert.match(KITCHEN_QUERY, /min-width: 960px/);
  assert.match(KITCHEN_QUERY, /orientation: landscape/);
  assert.match(KITCHEN_QUERY, /pointer: coarse/);
  assert.equal(kitchenScreenNote(5), "Kin still locks after 5 minutes without use, as it does everywhere. Drawing counts as use.");
  assert.match(kitchenScreenNote(60), /after an hour/);
  assert.match(kitchenScreenNote(0), /Automatic lock is off/);
  assert.match(kitchenScreenNote(0), /Security/);
});

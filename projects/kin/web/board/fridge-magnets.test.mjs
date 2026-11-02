import test from "node:test";
import assert from "node:assert/strict";
import { KIN_MAGNETS, MAGNET_REGIONS, magnetName, magnetPosition, magnetTilt, nudge, regionPoint } from "./fridge-magnets.js";
import { KIN_MAGNETS as WIRE_KIN_MAGNETS, MAX_X, MAX_Y } from "../wasm/kin-board.js";

test("there is one drawn magnet for every Kin magnet number", () => {
  assert.equal(KIN_MAGNETS.length, WIRE_KIN_MAGNETS);
  KIN_MAGNETS.forEach((magnet, index) => {
    assert.equal(magnet.number, index + 1);
    assert.ok(magnet.name && magnet.path.startsWith("M"));
  });
  assert.equal(new Set(KIN_MAGNETS.map((magnet) => magnet.name)).size, KIN_MAGNETS.length);
});

test("Move to puts a magnet in one of nine regions on the board", () => {
  assert.equal(MAGNET_REGIONS.length, 9);
  assert.deepEqual(regionPoint("middle"), [Math.round(MAX_X / 2), Math.round(MAX_Y / 2)]);
  for (const region of MAGNET_REGIONS) {
    const [x, y] = regionPoint(region.id);
    assert.ok(x >= 0 && x <= MAX_X && y >= 0 && y <= MAX_Y);
  }
  assert.deepEqual(regionPoint("nowhere"), regionPoint("middle"));
});

test("arrow keys move 1%, Shift 10%, and stop at the edges", () => {
  assert.deepEqual(nudge([1000, 1000], "ArrowRight"), [1041, 1000]);
  assert.deepEqual(nudge([1000, 1000], "ArrowDown", { large: true }), [1000, 1546]);
  assert.deepEqual(nudge([10, 10], "ArrowLeft", { large: true }), [0, 10]);
  assert.deepEqual(nudge([MAX_X, MAX_Y], "ArrowDown"), [MAX_X, MAX_Y]);
  assert.equal(nudge([0, 0], "Enter"), null);
});

test("a magnet's tilt is small and the same every time for its ID", () => {
  const ids = Array.from({ length: 50 }, (_, index) => index.toString(16).padStart(32, "0"));
  for (const id of ids) {
    const tilt = magnetTilt(id);
    assert.ok(tilt >= -6 && tilt <= 6);
    assert.equal(magnetTilt(id), tilt);
  }
  assert.ok(new Set(ids.map(magnetTilt)).size > 3, "magnets don't all hang the same way");
});

test("magnets have names and positions", () => {
  assert.equal(magnetName({ kind: "note", text: "Milk please" }), "Note: Milk please");
  assert.equal(magnetName({ kind: "kin", number: 1 }), "Heart magnet");
  assert.equal(magnetName({ kind: "emoji", text: "🍕" }), "🍕 magnet");
  assert.deepEqual(magnetPosition({ x: 0, y: MAX_Y }), { left: "0%", top: "100%" });
});

// Simple view (#344) through the real engine: an item's emoji round-trips
// as event kind 64 and a member's things today come back from Rust. Needs
// the built kin_engine.wasm.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const asOf = 1_791_475_200_000;
const civilDate = 20261003;
const KID = id(0x22);

function household() {
  const records = [];
  let sequence = 0;
  const run = (command) => {
    sequence += 1;
    const result = engine.executeCommand(command, {
      eventId: id(sequence), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc),
      timestamp: asOf + sequence, logicalTime: BigInt(sequence),
    }, records, asOf, null, civilDate);
    records.push(result.encodedEvent);
    return result;
  };
  return { records, run };
}

test("an item's emoji and a member's things today round-trip through Rust", () => {
  const home = household();
  home.run({ type: "add", id: id(0x31), text: "Pack school bag", classification: "need" });
  home.run({ type: "add", id: id(0x32), text: "Someone else's", classification: "need" });
  home.run({ type: "change-responsibility", targetKind: "item", id: id(0x31), memberId: KID });
  home.run({ type: "set-item-emoji", itemId: id(0x31), emoji: "🎒" });
  assert.deepEqual(engine.itemEmojis(home.records, asOf, civilDate), new Map([[id(0x31), "🎒"]]));
  assert.deepEqual(engine.myThings(KID, home.records, asOf, civilDate), [{ kind: "item", itemId: id(0x31) }]);
  assert.deepEqual(engine.myThings(id(0x77), home.records, asOf, civilDate), []);
  // Rust refuses two emoji, no change, and an unknown item.
  assert.throws(() => home.run({ type: "set-item-emoji", itemId: id(0x31), emoji: "🎒🎒" }), (error) => error.code !== undefined);
  assert.throws(() => home.run({ type: "set-item-emoji", itemId: id(0x31), emoji: "🎒" }), (error) => error.code !== undefined);
  assert.throws(() => home.run({ type: "set-item-emoji", itemId: id(0x39), emoji: "⚽" }), (error) => error.code !== undefined);
  home.run({ type: "set-item-emoji", itemId: id(0x31), emoji: null });
  assert.deepEqual(engine.itemEmojis(home.records, asOf, civilDate), new Map());
});

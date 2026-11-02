// Store sections (#411) through the real engine: the list and an item's
// section round-trip as event kinds 66 and 67 and come back through
// kin_shopping_sections. Needs the built kin_engine.wasm.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const asOf = 1_791_475_200_000;
const civilDate = 20261003;

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

test("store sections round-trip through Rust", () => {
  const home = household();
  const read = () => engine.shoppingSections(home.records, asOf, civilDate);
  assert.deepEqual(read(), { sections: [], itemSections: new Map() });
  home.run({ type: "add", id: id(0x31), text: "Milk", classification: "shopping" });
  const result = home.run({ type: "set-shopping-sections", sections: [
    { sectionId: id(0x41), name: " Produce " }, { sectionId: id(0x42), name: "Dairy" },
  ] });
  assert.equal(result.metadata.kind, "SHOPPING_SECTIONS_SET");
  home.run({ type: "set-item-section", itemId: id(0x31), sectionId: id(0x42) });
  assert.deepEqual(read(), {
    sections: [{ sectionId: id(0x41), name: "Produce" }, { sectionId: id(0x42), name: "Dairy" }],
    itemSections: new Map([[id(0x31), id(0x42)]]),
  });
  const refused = (command) => assert.throws(() => home.run(command), (error) => error.code === 4);
  refused({ type: "set-item-section", itemId: id(0x31), sectionId: id(0x42) });
  refused({ type: "set-item-section", itemId: id(0x31), sectionId: id(0x49) });
  refused({ type: "set-shopping-sections", sections: [{ sectionId: id(0x41), name: "Dairy" }, { sectionId: id(0x42), name: "dairy" }] });
  home.run({ type: "set-shopping-sections", sections: [{ sectionId: id(0x41), name: "Produce" }] });
  assert.deepEqual(read().itemSections, new Map(), "Dairy is gone, so Milk has none");
});

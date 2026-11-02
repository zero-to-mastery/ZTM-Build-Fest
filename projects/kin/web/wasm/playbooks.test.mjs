import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = n => new Uint8Array(16).fill(n);
const records = [];
const run = (command, n) => {
  const result = engine.executeCommand(command, {
    eventId: id(n), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc),
    timestamp: 1_791_475_200_000 + n, logicalTime: BigInt(n),
  }, records, 1_791_475_200_000, null, 20261009);
  records.push(result.encodedEvent);
  return result.state;
};

test("protocol 19 Playbooks save, edit, archive and replay ordered Unicode entries", () => {
  const playbookId = id(0x42);
  let state = run({ type: "save-playbook", id: playbookId, title: "  Weekly reset  ", entries: ["Laundry 🧺", "Replace filter"] }, 1);
  assert.deepEqual(state.playbooks, [{ playbookId: "42".repeat(16), title: "Weekly reset", entries: ["Laundry 🧺", "Replace filter"], archived: false }]);
  const itemId = "51".repeat(16); const stepId = "52".repeat(16);
  run({ type: "add", id: itemId, text: "Weekly reset", classification: "need" }, 2);
  run({ type: "add-item-step", itemId, stepId, text: "Laundry 🧺" }, 3);
  state = run({ type: "save-playbook", id: playbookId, title: "Vacation prep", entries: ["Lock doors"] }, 4);
  assert.equal(state.playbooks[0].title, "Vacation prep");
  assert.deepEqual(state.playbooks[0].entries, ["Lock doors"]);
  assert.equal(state.items[0].text, "Weekly reset");
  assert.deepEqual(state.items[0].steps.map(step => step.text), ["Laundry 🧺"]);
  assert.deepEqual(engine.applyEvents([...records, ...records], 1_791_475_200_004, null, 20261009), state);
  state = run({ type: "archive-playbook", playbookId }, 5);
  assert.equal(state.playbooks[0].archived, true);
  assert.deepEqual(engine.applyEvents(records, 1_791_475_200_003, null, 20261009).playbooks, state.playbooks);
});

test("Playbook text bounds and empty templates fail closed", () => {
  assert.throws(() => engine.executeCommand({ type: "save-playbook", id: id(1), title: "x", entries: [] }, { eventId: id(2), householdId: id(3), actorId: id(4), deviceId: id(5), timestamp: 1, logicalTime: 1n }, [], 1, null, 20261009));
  assert.throws(() => engine.executeCommand({ type: "save-playbook", id: id(1), title: "x", entries: ["x".repeat(257)] }, { eventId: id(2), householdId: id(3), actorId: id(4), deviceId: id(5), timestamp: 1, logicalTime: 1n }, [], 1, null, 20261009));
});

// The sitter page (#442) through the real engine: the page round-trips as
// event kind 70 and comes back through kin_sitter_page. Needs the built
// kin_engine.wasm.
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

test("the sitter page round-trips through Rust", () => {
  const home = household();
  const read = () => engine.sitterPage(home.records, asOf, civilDate);
  assert.deepEqual(read(), { intro: "", entries: [] });
  home.run({ type: "create-note", id: id(0x41), noteId: id(0x41), areaId: null, title: "Bedtime", body: "Story, then lights out." });
  home.run({ type: "create-note", id: id(0x42), noteId: id(0x42), areaId: null, title: "Wi-Fi", body: "kin-guest" });
  const result = home.run({ type: "set-sitter-page", intro: " Thanks for helping!\n", entries: [
    { kind: "note", id: id(0x42) }, { kind: "note", id: id(0x41) },
  ] });
  assert.equal(result.metadata.kind, "SITTER_PAGE_SET");
  assert.deepEqual(read(), {
    intro: "Thanks for helping!",
    entries: [{ kind: "note", id: id(0x42) }, { kind: "note", id: id(0x41) }],
  });
  const refused = (command) => assert.throws(() => home.run(command), (error) => error.code === 4);
  refused({ type: "set-sitter-page", intro: "Thanks for helping!", entries: [{ kind: "note", id: id(0x42) }, { kind: "note", id: id(0x41) }] });
  refused({ type: "set-sitter-page", intro: "", entries: [{ kind: "routine", id: id(0x41) }] });
  home.run({ type: "archive-note", id: id(0x41), noteId: id(0x41) });
  assert.deepEqual(read().entries, [{ kind: "note", id: id(0x42) }], "the archived note is skipped");
});

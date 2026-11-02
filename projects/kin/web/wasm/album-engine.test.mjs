// The family album (#673) through the real engine: photos round-trip as
// event kinds 75 and 76 and come back through kin_album. Needs the built
// kin_engine.wasm.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const album = (byte) => `a1b0${byte.toString(16).padStart(2, "0").repeat(14)}`;
const asOf = 1_791_475_200_000;
const civilDate = 20261003;

function household() {
  const records = [];
  let sequence = 0;
  const run = (command, actor = 0xbb) => {
    sequence += 1;
    const result = engine.executeCommand(command, {
      eventId: id(sequence), householdId: id(0xaa), actorId: id(actor), deviceId: id(actor + 1),
      timestamp: asOf + sequence, logicalTime: BigInt(sequence),
    }, records, asOf, null, civilDate);
    records.push(result.encodedEvent);
    return result;
  };
  return { records, run };
}

test("the family album round-trips through Rust", () => {
  const home = household();
  const read = () => engine.album(home.records, asOf, civilDate);
  assert.deepEqual(read(), { photos: [], removed: [] });
  const first = home.run({ type: "add-album-photo", photoId: id(0x41), attachmentId: album(0x51), caption: " Beach day " });
  assert.equal(first.metadata.kind, "ALBUM_PHOTO_ADDED");
  home.run({ type: "add-album-photo", photoId: id(0x42), attachmentId: album(0x52), caption: "" }, 0xcc);
  assert.deepEqual(read().photos, [
    { photoId: id(0x42), attachmentId: album(0x52), addedBy: id(0xcc), addedAt: asOf + 2, caption: "" },
    { photoId: id(0x41), attachmentId: album(0x51), addedBy: id(0xbb), addedAt: asOf + 1, caption: "Beach day" },
  ]);
  const refused = (command) => assert.throws(() => home.run(command), (error) => error.code === 4);
  refused({ type: "add-album-photo", photoId: id(0x41), attachmentId: album(0x53), caption: "" });
  refused({ type: "add-album-photo", photoId: id(0x43), attachmentId: album(0x51), caption: "" });
  refused({ type: "remove-album-photo", photoId: id(0x49) });
  const removal = home.run({ type: "remove-album-photo", photoId: id(0x41) });
  assert.equal(removal.metadata.kind, "ALBUM_PHOTO_REMOVED");
  assert.deepEqual(read().removed, [{ photoId: id(0x41), attachmentId: album(0x51), removedAt: asOf + 6 }], "after three refused tries");
  // Undo puts the same image back under a new photo ID.
  home.run({ type: "add-album-photo", photoId: id(0x44), attachmentId: album(0x51), caption: "Beach day" });
  assert.deepEqual(read().photos.map((photo) => photo.photoId), [id(0x44), id(0x42)]);
});

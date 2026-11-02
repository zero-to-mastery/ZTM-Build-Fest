// A family photo (#673, ADR 0022 §5) is removed by whoever added it or a
// household admin: the single command append path reads the album and
// refuses "remove-album-photo" for anyone else, before anything reaches the
// store or Rust.
import assert from "node:assert/strict";
import test from "node:test";
import { AppendCommands } from "./append.js";
import { ALBUM_REMOVE_FORBIDDEN } from "../../../wasm/kin-album.js";

const SAM = "0a".repeat(16);
const ALEX = "0b".repeat(16);
const PHOTO = "11".repeat(16);

function appendWith({ memberId = ALEX, admin = false, hasLocalSyncBinding = true, photos = [{ photoId: PHOTO, addedBy: SAM }] } = {}) {
  const appended = [];
  const app = { householdAdmin: admin, hasLocalSyncBinding, syncCoordinator: memberId ? { identity: { memberId }, syncNow: async () => {} } : null };
  const session = {
    store: {
      album: async () => ({ photos, removed: [] }),
      append: async (command) => { appended.push(command); return { state: {}, snapshotBoundary: null }; },
    },
  };
  const ctx = {
    app,
    session: { captureSession: () => session, assertCurrentSession() {} },
    undo: { beforeChange() {} },
  };
  return { append: new AppendCommands(ctx), appended };
}

const command = { type: "remove-album-photo", photoId: PHOTO };

test("whoever added the photo, an admin, or a household that doesn't sync may remove it", async () => {
  for (const options of [{ memberId: SAM }, { memberId: ALEX, admin: true }, { memberId: null, hasLocalSyncBinding: false }]) {
    const { append, appended } = appendWith(options);
    await append.appendCommand(command);
    assert.deepEqual(appended, [command], JSON.stringify(options));
  }
});

test("anyone else may not", async () => {
  for (const options of [{ memberId: ALEX }, { memberId: null }, { memberId: ALEX, admin: "true" }]) {
    const { append, appended } = appendWith(options);
    await assert.rejects(append.appendCommand(command), (error) => error.code === "forbidden" && error.userMessage === ALBUM_REMOVE_FORBIDDEN);
    assert.deepEqual(appended, [], JSON.stringify(options));
  }
});

test("a photo that's already gone is left for Rust to refuse", async () => {
  const { append, appended } = appendWith({ photos: [] });
  await append.appendCommand(command);
  assert.equal(appended.length, 1);
});

test("adding a photo and other commands are not affected", async () => {
  const { append, appended } = appendWith({ memberId: ALEX });
  await append.appendCommand({ type: "add-album-photo", photoId: "22".repeat(16), attachmentId: `a1b0${"33".repeat(14)}`, caption: "" });
  await append.appendCommand({ type: "add", text: "Milk" });
  assert.equal(appended.length, 2);
});

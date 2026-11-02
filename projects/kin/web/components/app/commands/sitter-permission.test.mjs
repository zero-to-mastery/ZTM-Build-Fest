// The sitter page is Adult-only (#442, ADR 0017): the single command append
// path refuses "set-sitter-page" for Limited and Temporary members, and for a
// synced device whose member kind isn't known yet, before anything reaches
// the store or Rust.
import assert from "node:assert/strict";
import test from "node:test";
import { AppendCommands } from "./append.js";
import { SITTER_PAGE_FORBIDDEN } from "../../../wasm/kin-sitter.js";

function appendWith({ memberKind, hasLocalSyncBinding = true }) {
  const appended = [];
  const app = { householdStatus: memberKind === undefined ? null : { memberKind }, hasLocalSyncBinding };
  const session = { store: { append: async (command) => { appended.push(command); return { state: {}, snapshotBoundary: null }; } } };
  const ctx = {
    app,
    session: { captureSession: () => session, assertCurrentSession() {} },
    undo: { beforeChange() {} },
  };
  return { append: new AppendCommands(ctx), appended };
}

const command = { type: "set-sitter-page", intro: "", entries: [] };

test("Adults may change the sitter page", async () => {
  for (const options of [{ memberKind: "adult" }, { memberKind: undefined, hasLocalSyncBinding: false }]) {
    const { append, appended } = appendWith(options);
    await append.appendCommand(command);
    assert.deepEqual(appended, [command]);
  }
});

test("Limited and Temporary members, and an unknown kind, may not", async () => {
  for (const options of [{ memberKind: "limited" }, { memberKind: "temporary" }, { memberKind: undefined }, { memberKind: "owner" }]) {
    const { append, appended } = appendWith(options);
    await assert.rejects(append.appendCommand(command), (error) => error.code === "forbidden" && error.userMessage === SITTER_PAGE_FORBIDDEN);
    assert.deepEqual(appended, [], JSON.stringify(options));
  }
});

test("other commands are not affected", async () => {
  const { append, appended } = appendWith({ memberKind: "temporary" });
  await append.appendCommand({ type: "add", text: "Milk" });
  assert.equal(appended.length, 1);
});

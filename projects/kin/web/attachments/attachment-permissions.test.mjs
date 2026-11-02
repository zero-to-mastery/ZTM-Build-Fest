import assert from "node:assert/strict";
import test from "node:test";
import { canRemoveAttachments } from "./attachment-permissions.js";

test("only Adults (or a local-only household) can remove attachments", () => {
  assert.equal(canRemoveAttachments("adult"), true);
  assert.equal(canRemoveAttachments(null), true, "a local-only household has no server membership");
  assert.equal(canRemoveAttachments(undefined), true);
  assert.equal(canRemoveAttachments("limited"), false);
  assert.equal(canRemoveAttachments("temporary"), false);
});

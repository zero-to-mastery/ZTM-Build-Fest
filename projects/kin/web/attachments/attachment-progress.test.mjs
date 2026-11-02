import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentProgressKey,
  clearAttachmentProgress,
  getAttachmentProgress,
  setAttachmentProgress,
  subscribeAttachmentProgress,
} from "./attachment-progress.js";

test("progress is stored per parent and read back after a re-render", () => {
  clearAttachmentProgress();
  setAttachmentProgress("item", "a".repeat(32), { phase: "saving", message: "Saving securely…" });
  assert.deepEqual(getAttachmentProgress("item", "a".repeat(32)), { phase: "saving", message: "Saving securely…" });
  assert.equal(getAttachmentProgress("item", "b".repeat(32)), null);
  assert.equal(getAttachmentProgress("note", "a".repeat(32)), null);
});

test("subscribers hear changes for their parent key and clears", () => {
  clearAttachmentProgress();
  const seen = [];
  const stop = subscribeAttachmentProgress((key, progress) => seen.push([key, progress?.phase ?? null]));
  setAttachmentProgress("item", "1", { phase: "preparing", message: "Preparing photo…" });
  setAttachmentProgress("item", "1", { phase: "error", message: "Couldn't save." });
  clearAttachmentProgress("item", "1");
  clearAttachmentProgress("item", "1");
  stop();
  setAttachmentProgress("item", "1", { phase: "saved", message: "Saved on this device." });
  assert.deepEqual(seen, [
    [attachmentProgressKey("item", "1"), "preparing"],
    [attachmentProgressKey("item", "1"), "error"],
    [attachmentProgressKey("item", "1"), null],
  ]);
  clearAttachmentProgress();
});

test("clearing everything notifies each parent once and rejects unknown phases", () => {
  clearAttachmentProgress();
  setAttachmentProgress("item", "1", { phase: "saved", message: "Saved on this device." });
  setAttachmentProgress("note", "2", { phase: "error", message: "Couldn't save." });
  const cleared = [];
  const stop = subscribeAttachmentProgress((key, progress) => cleared.push([key, progress]));
  clearAttachmentProgress();
  stop();
  assert.deepEqual(cleared.sort(), [["item:1", null], ["note:2", null]]);
  assert.throws(() => setAttachmentProgress("item", "1", { phase: "uploading", message: "x" }), /known phase/);
  assert.throws(() => setAttachmentProgress("item", "1", { phase: "saved", message: "" }), /known phase/);
  assert.equal(getAttachmentProgress("item", "1"), null);
});

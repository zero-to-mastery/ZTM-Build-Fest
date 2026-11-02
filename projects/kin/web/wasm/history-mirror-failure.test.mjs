import assert from "node:assert/strict";
import test from "node:test";
import { HistoryMirror } from "./history-mirror.js";

function failingTruncateMirror() {
  const calls = [];
  const records = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
  const arena = {};
  const view = (length) => ({
    arena, epoch: 0, length,
    recordLength: (index) => records[index].length,
    copyRecordsTo: (target, offset, from, to) => {
      for (let index = from; index < to; index += 1) {
        target.set(records[index], offset);
        offset += records[index].length;
      }
    },
  });
  const mirror = new HistoryMirror({
    kin_history_reset: () => calls.push("reset"),
    kin_history_truncate: (length) => { calls.push(["truncate", length]); return 1; },
  }, (batch) => {
    const count = new DataView(batch.buffer).getUint32(0, true);
    calls.push(["append", ...batch.subarray(4 + count * 4)]);
  }, (bytes) => bytes);
  return { mirror, calls, view };
}

test("a failed truncate resets and resends the entire shorter view only once", () => {
  const { mirror, calls, view } = failingTruncateMirror();
  mirror.holdView(view(3));
  calls.length = 0;
  const shorter = view(2);
  mirror.holdView(shorter);
  assert.deepEqual(calls, [["truncate", 2], "reset", ["append", 1, 2]]);
  calls.length = 0;
  mirror.holdView(shorter);
  assert.deepEqual(calls, []);
});

test("a failed extras rollback forgets history so the next hold resends it", () => {
  const { mirror, calls, view } = failingTruncateMirror();
  const base = view(2);
  const rollback = mirror.hold({ base, extras: [new Uint8Array([9])] });
  calls.length = 0;
  assert.equal(rollback(), false);
  assert.deepEqual(calls, [["truncate", 2], "reset"]);
  assert.equal(mirror.arena, null);
  assert.equal(mirror.epoch, -1);
  assert.equal(mirror.length, 0);
  calls.length = 0;
  mirror.holdView(base);
  assert.deepEqual(calls, ["reset", ["append", 1, 2]]);
  calls.length = 0;
  mirror.holdView(base);
  assert.deepEqual(calls, []);
});

test("a failed resend after truncate still forgets the view and reports the error", () => {
  const { mirror, calls, view } = failingTruncateMirror();
  mirror.holdView(view(3));
  const append = mirror.appendBatch;
  const error = new Error("append failed");
  mirror.appendBatch = () => { throw error; };
  assert.throws(() => mirror.holdView(view(2)), (caught) => caught === error);
  assert.equal(mirror.arena, null);
  assert.equal(mirror.epoch, -1);
  assert.equal(mirror.length, 0);
  mirror.appendBatch = append;
  calls.length = 0;
  mirror.holdView(view(2));
  assert.deepEqual(calls, ["reset", ["append", 1, 2]]);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_QUARANTINE_ATTEMPTS, MAX_QUARANTINED_BYTES, MAX_QUARANTINED_EVENTS, QUARANTINE_MESSAGE,
  describeQuarantine, nextQuarantine, quarantineMessage, quarantineRetryItems,
} from "./quarantine.js";

const hex = (n) => `${n.toString(16).padStart(8, "0")}${"0".repeat(24)}`;
const refusal = (n, size = 8) => ({ eventId: hex(n), encoded: new Uint8Array(size).fill(n & 0xff), reason: "not-applicable" });

test("a refused event is kept with its bytes, reason, first-seen time and one attempt", () => {
  const { quarantine, added, dropped } = nextQuarantine([], [refusal(1)], { now: 1000, retried: false });
  assert.equal(added, 1);
  assert.equal(dropped, 0);
  assert.deepEqual(quarantine, [{ eventId: hex(1), encoded: refusal(1).encoded, reason: "not-applicable", firstSeenAt: 1000, attempts: 1 }]);
  assert.deepEqual(quarantineRetryItems(quarantine), [{ encodedEvent: quarantine[0].encoded, retry: true }]);
});

test("a retried event that applies leaves; one refused again counts another attempt and is not new", () => {
  const first = nextQuarantine([], [refusal(1), refusal(2)], { now: 1000, retried: false }).quarantine;
  const second = nextQuarantine(first, [refusal(2)], { now: 2000, retried: true });
  assert.equal(second.added, 0, "a kept event refused again does not alert again");
  assert.deepEqual(second.quarantine.map((row) => [row.eventId, row.attempts, row.firstSeenAt]), [[hex(2), 2, 1000]]);
  const cleared = nextQuarantine(second.quarantine, [], { now: 3000, retried: true });
  assert.deepEqual(cleared.quarantine, [], "no quarantine remains once everything applied");
});

test("kept rows are unchanged when a commit did not retry them", () => {
  const first = nextQuarantine([], [refusal(1)], { now: 1000, retried: false }).quarantine;
  const next = nextQuarantine(first, [refusal(3)], { now: 2000, retried: false });
  assert.deepEqual(next.quarantine.map((row) => [row.eventId, row.attempts]), [[hex(1), 1], [hex(3), 1]]);
  assert.equal(next.added, 1);
});

test("an event refused twice in one batch is one row", () => {
  const { quarantine, added } = nextQuarantine([], [refusal(1), refusal(1)], { now: 1, retried: false });
  assert.equal(quarantine.length, 1);
  assert.equal(added, 1);
});

test("unreadable bytes are counted but never kept", () => {
  const { quarantine, added, dropped } = nextQuarantine([], [{ eventId: null, encoded: null, reason: "unreadable" }], { now: 1, retried: false });
  assert.deepEqual(quarantine, []);
  assert.equal(added, 1);
  assert.equal(dropped, 1);
});

test("the row bound keeps the oldest rows and counts the rest", () => {
  const many = Array.from({ length: MAX_QUARANTINED_EVENTS + 7 }, (_, index) => refusal(index + 1));
  const { quarantine, added, dropped } = nextQuarantine([], many, { now: 5, retried: false });
  assert.equal(quarantine.length, MAX_QUARANTINED_EVENTS);
  assert.equal(added, MAX_QUARANTINED_EVENTS + 7);
  assert.equal(dropped, 7);
  // Kept rows are not counted again as dropped when the bound is reached later.
  const later = nextQuarantine(quarantine, [refusal(9999)], { now: 6, retried: false });
  assert.equal(later.quarantine.length, MAX_QUARANTINED_EVENTS);
  assert.equal(later.dropped, 1);
  assert.ok(!later.quarantine.some((row) => row.eventId === hex(9999)), "older rows win");
});

test("the byte bound is enforced", () => {
  const size = Math.floor(MAX_QUARANTINED_BYTES / 3) + 1;
  const { quarantine, dropped } = nextQuarantine([], [refusal(1, size), refusal(2, size), refusal(3, size)], { now: 1, retried: false });
  assert.equal(quarantine.length, 2);
  assert.equal(dropped, 1);
});

test("the review message names kept events and reasons in plain text", () => {
  const { quarantine } = nextQuarantine([], [refusal(0xab), { ...refusal(0xcd), reason: "unknown" }], { now: 1, retried: false });
  const lines = describeQuarantine(quarantine);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^000000ab0000… was not applied because it doesn't fit this device's household history yet \(tried 1 time\)\.$/);
  const message = quarantineMessage(quarantine);
  assert.ok(!message.includes("tried"), "the live notice doesn't change with each retry");
  assert.ok(message.includes(hex(0xab).slice(0, 12)) && message.includes(hex(0xcd).slice(0, 12)));
  assert.ok(!/[\u0000-\u0008]/.test(message), "no raw bytes in the message");
  assert.equal(quarantineMessage([]), QUARANTINE_MESSAGE, "the existing message stays when there is nothing to show");
  const several = nextQuarantine([], Array.from({ length: 6 }, (_, i) => refusal(i + 1)), { now: 1, retried: false }).quarantine;
  assert.equal(describeQuarantine(several).at(-1), "…and 1 more.");
});

test("a kept event already in history or arriving again in the page is not replayed from the kept copy", () => {
  const { quarantine } = nextQuarantine([], [refusal(1), refusal(2), refusal(3)], { now: 1, retried: false });
  const items = quarantineRetryItems(quarantine, { isKnown: (eventId) => eventId === hex(2) });
  assert.deepEqual(items.map((item) => item.encodedEvent[0]), [1, 3]);
  // Not refused again, the skipped row leaves once the commit retried.
  const next = nextQuarantine(quarantine, [refusal(1), refusal(3)], { now: 2, retried: true });
  assert.deepEqual(next.quarantine.map((row) => row.eventId), [hex(1), hex(3)]);
});

test("a kept row is never pushed out by a newer refusal, even with equal or earlier clocks", () => {
  const full = nextQuarantine([], Array.from({ length: MAX_QUARANTINED_EVENTS }, (_, i) => refusal(i + 10)), { now: 50, retried: false }).quarantine;
  // A new event with a smaller ID and an earlier clock still loses to kept rows.
  const next = nextQuarantine(full, [refusal(1)], { now: 1, retried: false });
  assert.deepEqual(next.quarantine.map((row) => row.eventId), full.map((row) => row.eventId));
  assert.equal(next.dropped, 1);
});

test("a row refused too many times moves to the count", () => {
  let quarantine = nextQuarantine([], [refusal(1), refusal(2)], { now: 1, retried: false }).quarantine;
  let dropped = 0;
  for (let attempt = 2; attempt <= MAX_QUARANTINE_ATTEMPTS + 1; attempt += 1) {
    const next = nextQuarantine(quarantine, [refusal(1)], { now: attempt, retried: false });
    quarantine = next.quarantine;
    dropped += next.dropped;
  }
  assert.deepEqual(quarantine.map((row) => row.eventId), [hex(2)]);
  assert.equal(dropped, 1);
});

test("an event this version of Kin can't apply is described plainly", () => {
  const { quarantine } = nextQuarantine([], [{ ...refusal(1), reason: "unsupported" }], { now: 1, retried: false });
  assert.match(describeQuarantine(quarantine)[0], /this version of Kin can't apply it/);
});

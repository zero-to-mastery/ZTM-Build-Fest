// The logic of <ob-reading-path> (ADR 0215): what stored progress means and what the status line
// says. Storage, keyboard and layout behaviour is covered in a browser by
// tests/browser/reading-path-pages.spec.mjs.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define() {} };
const { nextUnread, parseProgress, serializeProgress, statusText, storageKey, summarize, withRead } =
  await import("../../web/components/ob-reading-path.js");

const steps = [
  { key: "post:a", optional: false },
  { key: "atlas:b", optional: false },
  { key: "post:c", optional: true },
  { key: "post:d", optional: false },
];
const keys = steps.map((step) => step.key);

test("progress is read only for steps the path still has", () => {
  const raw = JSON.stringify({ version: 1, read: ["post:a", "post:gone", 7, "atlas:b"] });
  assert.deepEqual([...parseProgress(raw, keys)], ["post:a", "atlas:b"]);
});

test("anything that is not the stored shape is no progress", () => {
  for (const raw of [null, undefined, "", "{", "[]", "null", '{"version":2,"read":["post:a"]}', '{"version":1}', '{"version":1,"read":"post:a"}', "x".repeat(30000)]) {
    assert.equal(parseProgress(raw, keys).size, 0, String(raw).slice(0, 20));
  }
});

test("progress is written in the path's order and round trips", () => {
  const read = new Set(["post:d", "post:a"]);
  const text = serializeProgress(read, keys);
  assert.equal(text, '{"version":1,"read":["post:a","post:d"]}');
  assert.deepEqual([...parseProgress(text, keys)], ["post:a", "post:d"]);
  assert.equal(serializeProgress(new Set(["unknown"]), keys), '{"version":1,"read":[]}');
});

test("marking a step does not change the set it came from", () => {
  const before = new Set(["post:a"]);
  const after = withRead(before, "atlas:b", true);
  assert.deepEqual([...before], ["post:a"]);
  assert.deepEqual([...after], ["post:a", "atlas:b"]);
  assert.deepEqual([...withRead(after, "post:a", false)], ["atlas:b"]);
});

test("optional steps never count toward finishing", () => {
  const counts = summarize(steps, new Set(["post:a", "atlas:b", "post:d"]));
  assert.deepEqual(counts, { required: 3, requiredRead: 3, optional: 1, optionalRead: 0, started: true, complete: true });
  assert.equal(summarize(steps, new Set(["post:c"])).complete, false);
  assert.equal(summarize(steps, new Set()).started, false);
});

test("the status says what is read, and that it stays in this browser", () => {
  assert.match(statusText(steps, new Set()), /not marked any step as read.*stays in this browser/);
  assert.match(statusText(steps, new Set(["post:a"])), /^1 of 3 steps read, and 0 of 1 optional step\. Saved in this browser only\.$/);
  assert.match(statusText(steps, new Set(["post:a", "atlas:b", "post:d"])), /every step that is not optional/);
});

test("the resume point is the first required step not yet read", () => {
  assert.equal(nextUnread(steps, new Set()), 0);
  assert.equal(nextUnread(steps, new Set(["post:a"])), 1);
  assert.equal(nextUnread(steps, new Set(["post:a", "atlas:b"])), 3);
  assert.equal(nextUnread(steps, new Set(keys)), -1);
});

test("progress for each path has its own key", () => {
  assert.notEqual(storageKey("one"), storageKey("two"));
  assert.match(storageKey("one"), /^openblog:reading-path:one$/);
});

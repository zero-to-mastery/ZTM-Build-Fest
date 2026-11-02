// The sitter page (#441): phone links and resolving entries live.
import assert from "node:assert/strict";
import test from "node:test";
import { phoneHref, resolveEntries } from "./sitter-view.js";

test("phone-like values become tel: links; other text doesn't", () => {
  assert.equal(phoneHref("(304) 555-0142"), "tel:3045550142");
  assert.equal(phoneHref("+44 20 7946 0958"), "tel:+442079460958");
  assert.equal(phoneHref("911"), null, "too short to be sure");
  assert.equal(phoneHref("Dr. Patel"), null);
  assert.equal(phoneHref("Wi-Fi: kin-home"), null);
  assert.equal(phoneHref(""), null);
});

test("entries are joined with live records; archived and unknown ones drop out", () => {
  const state = {
    notes: [{ noteId: "n1", title: "Bedtime", body: "8pm", archived: false }, { noteId: "n2", title: "Old", archived: true }],
    referenceRecords: [{ recordId: "r1", title: "Doctor", fields: [], archived: false }],
    routines: [{ routineId: "t1", text: "Feed the cat", status: "active" }],
  };
  const page = { intro: "", entries: [
    { kind: "routine", id: "t1" }, { kind: "note", id: "n2" }, { kind: "note", id: "n1" },
    { kind: "reference-record", id: "r1" }, { kind: "note", id: "missing" },
  ] };
  assert.deepEqual(resolveEntries(page, state).map((entry) => `${entry.kind}:${entry.id}`), ["routine:t1", "note:n1", "reference-record:r1"]);
  assert.deepEqual(resolveEntries(null, state), []);
});

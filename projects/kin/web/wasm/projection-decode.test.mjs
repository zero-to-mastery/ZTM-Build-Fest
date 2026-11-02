// The bridge decodes only protocol-24 projections and fails closed on any
// truncated, extended or inconsistent buffer (KinEngineError code 6).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { decodeProjection, encodeAddedRecord, encodeHandoffAddedRecord, KinEngineError, loadKinEngine } from "./kin-engine.js";

const fixtures = new URL("../../rust/fixtures/golden/", import.meta.url);
const load = async (name) => new Uint8Array(await readFile(new URL(name, fixtures)));
const failsClosed = (bytes, message) =>
  assert.throws(() => decodeProjection(bytes), (error) => error instanceof KinEngineError && error.code === 6, message);

test("golden projections decode with counts that match their headers", async () => {
  for (const name of ["empty", "full", "distributed", "pulse-expiry", "bulk"]) {
    const bytes = await load(`${name}.kins`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const state = decodeProjection(bytes);
    assert.equal(state.items.length, view.getUint32(8, true), name);
    assert.equal(state.handoffs.length, view.getUint32(12, true), name);
    assert.equal(state.talks.length, view.getUint32(16, true), name);
    assert.equal(state.pulses.length, view.getUint32(20, true), name);
    assert.equal(state.routines.length, view.getUint32(52, true), name);
    assert.equal(state.summary.entries.length, view.getUint32(24, true), name);
  }
  const full = decodeProjection(await load("full.kins"));
  assert.equal(full.mode, "guests");
  assert.ok(full.routines.every((routine) => routine.status === "archived" ? routine.nextOn === null : routine.nextOn > 0));
  assert.ok(full.items.some((item) => item.steps.length && item.areaId && item.planningDate));
});

test("every truncation and any trailing byte fail closed", async () => {
  const bytes = await load("full.kins");
  for (let length = 0; length < bytes.length; length += 1) failsClosed(bytes.slice(0, length), `length ${length}`);
  failsClosed(Uint8Array.from([...bytes, 0]), "trailing byte");
});

test("other versions, reserved bytes, modes and summary flags fail closed", async () => {
  const bytes = await load("full.kins");
  const mutate = (offset, value) => {
    const copy = bytes.slice();
    copy[offset] = value;
    return copy;
  };
  for (const version of [0, 1, 23, 25, 255]) failsClosed(mutate(4, version), `version ${version}`);
  for (const offset of [6, 7, 33, 34, 35, 69, 70, 71]) failsClosed(mutate(offset, 1), `reserved ${offset}`);
  failsClosed(mutate(68, 4), "mode code");
  failsClosed(mutate(32, 2), "through flag");
  const empty = await load("empty.kins");
  const withThrough = empty.slice();
  withThrough[36] = 1; // through ID without the present flag
  failsClosed(withThrough, "through ID without flag");
  const counted = empty.slice();
  new DataView(counted.buffer).setUint32(8, 1, true); // an Item with no record
  failsClosed(counted, "declared Item without a record");
});

// Incremental decoding: sections whose revision did not change are reused.
const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const wasmUrl = `data:application/wasm;base64,${wasm.toString("base64")}`;
const id = (value) => new Uint8Array(16).fill(value);
const identity = (sequence) => ({ eventId: id(sequence), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc), timestamp: 1234 + sequence, logicalTime: sequence });
const item = (sequence, text) => encodeAddedRecord({ ...identity(sequence), itemId: id(0x40 + sequence), text, classification: "need" });
const handoff = (sequence, text) => encodeHandoffAddedRecord({ ...identity(sequence), handoffId: id(0x60 + sequence), text });
const SECTION_NAMES = ["items", "handoffs", "talks", "pulses", "routines", "areas", "notes", "pins", "playbooks", "referenceRecords", "maintenanceEvents"];

test("an engine reuses the unchanged sections of the last state it decoded", async () => {
  const engine = await loadKinEngine(wasmUrl);
  const project = (rows) => engine.applyEvents(rows, 5000, null, 20261014);
  const rows = [item(1, "Milk")];
  const first = project(rows);
  const same = project(rows);
  assert.deepEqual(same, first);
  for (const name of SECTION_NAMES) assert.equal(same[name], first[name], `${name} reused`);
  assert.equal(same.summary, first.summary);
  assert.notEqual(same, first, "each decode returns a new state object");

  const withHandoff = project([...rows, handoff(2, "Bins are out")]);
  assert.equal(withHandoff.items, same.items, "Items unchanged");
  assert.notEqual(withHandoff.handoffs, same.handoffs);
  assert.notEqual(withHandoff.summary, same.summary, "the summary counts the Handoff");
  assert.equal(withHandoff.handoffs[0].text, "Bins are out");

  // A command's candidate projection takes part too.
  const command = engine.executeCommand({ type: "add-talk", talkId: id(0x73), text: "Rota" }, identity(3), [...rows, handoff(2, "Bins are out")], 5000, null, 20261014);
  assert.equal(command.state.items, withHandoff.items);
  assert.equal(command.state.talks[0].text, "Rota");

  // Another engine instance shares nothing, and agrees with a full decode.
  const other = await loadKinEngine(wasmUrl);
  const fresh = other.applyEvents([...rows, handoff(2, "Bins are out")], 5000, null, 20261014);
  assert.notEqual(fresh.items, withHandoff.items);
  assert.deepEqual(fresh, withHandoff);
  assert.notEqual(project(rows).items, fresh.items);
});

// Rebuilds a projection from its sections with chosen revisions.
function rebuild(bytes, { revisions, replace = {} }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections = [];
  let offset = 208;
  for (let index = 0; index < 14; index += 1) {
    const length = view.getUint32(96 + index * 8 + 4, true);
    sections.push(replace[index] ?? bytes.slice(offset, offset + length));
    offset += length;
  }
  const out = new Uint8Array(208 + sections.reduce((total, section) => total + section.length, 0));
  out.set(bytes.subarray(0, 96));
  const table = new DataView(out.buffer, 96, 112);
  let at = 208;
  sections.forEach((section, index) => {
    table.setUint32(index * 8, revisions[index], true);
    table.setUint32(index * 8 + 4, section.length, true);
    out.set(section, at);
    at += section.length;
  });
  return out;
}

test("revision 0 always decodes, and reused sections are still cross-checked", async () => {
  const full = await load("full.kins");
  const stampedBy = {}; // any object stands in for an engine instance
  const ones = Array(14).fill(1);
  const first = decodeProjection(rebuild(full, { revisions: ones }), { stampedBy });
  const unversioned = decodeProjection(rebuild(full, { revisions: Array(14).fill(0) }), { previous: first, stampedBy });
  assert.notEqual(unversioned.items, first.items);
  assert.deepEqual(unversioned, first);

  // Items keep revision 1 and are reused, but the Areas they reference are gone.
  assert.ok(first.items.some((entry) => entry.areaId));
  const noAreas = rebuild(full, { revisions: ones.map((value, index) => (index === 5 ? 2 : value)), replace: { 5: new Uint8Array(0) } });
  new DataView(noAreas.buffer).setUint32(56, 0, true);
  failsClosed(noAreas, "parsed without previous state");
  assert.throws(() => decodeProjection(noAreas, { previous: first, stampedBy }), (error) => error instanceof KinEngineError && error.code === 6);

  // A reused section whose header count no longer matches fails closed.
  const recounted = rebuild(full, { revisions: ones });
  new DataView(recounted.buffer).setUint32(12, first.handoffs.length + 1, true);
  assert.throws(() => decodeProjection(recounted, { previous: first, stampedBy }), /inconsistent state/);
});

test("the section table must cover the body exactly", async () => {
  const empty = await load("empty.kins");
  const longer = empty.slice();
  new DataView(longer.buffer).setUint32(96 + 4, 1, true); // Items claims one byte
  failsClosed(longer, "table longer than body");
  failsClosed(Uint8Array.from([...empty, 0]), "body longer than table");
});

test("invalid text, dates and duplicate Items in record sections fail closed with code 6", async () => {
  const full = await load("full.kins");
  const view = new DataView(full.buffer, full.byteOffset, full.byteLength);
  const sectionStart = (index) => {
    let offset = 208;
    for (let i = 0; i < index; i += 1) offset += view.getUint32(96 + i * 8 + 4, true);
    return offset;
  };
  const mutate = (change) => { const copy = full.slice(); change(copy, new DataView(copy.buffer)); return copy; };
  assert.ok(view.getUint32(76, true) > 0, "fixture has a Playbook");
  failsClosed(mutate((bytes) => { bytes[sectionStart(8) + 22] = 0xff; }), "invalid UTF-8 Playbook title");
  assert.ok(view.getUint32(80, true) > 0, "fixture has a Reference Record");
  failsClosed(mutate((bytes) => { bytes[sectionStart(9) + 36] = 0xff; }), "invalid UTF-8 reference title");
  assert.ok(view.getUint32(84, true) > 0, "fixture has a Maintenance event");
  failsClosed(mutate((bytes, data) => data.setUint32(sectionStart(10) + 36, 20261399, true)), "invalid next date");
  failsClosed(mutate((bytes, data) => data.setUint32(sectionStart(10) + 32, 20261399, true)), "invalid performed date");
  assert.ok(view.getUint32(8, true) > 1, "fixture has two Items");
  failsClosed(mutate((bytes) => {
    // Copy the first Item's ID over the second's.
    const first = sectionStart(0), second = first + 48 + view.getUint32(first + 44, true);
    bytes.copyWithin(second, first, first + 16);
  }), "duplicate Item ID");
});

test("a decode failure after Rust stamped, or interleaved projectionBytes, never reuses stale sections", async () => {
  const engine = await loadKinEngine(wasmUrl);
  const project = (rows) => engine.applyEvents(rows, 5000, null, 20261014);
  const one = [item(1, "Milk")];
  const two = [...one, item(2, "Eggs")];
  const first = project(one);
  // Bytes for `two` are stamped but never decoded into a state.
  engine.projectionBytes(two, 5000, null, 20261014);
  const back = project(one);
  assert.deepEqual(back, first);
  const after = project(two);
  assert.equal(after.items.length, 2);
  assert.deepEqual(after, (await loadKinEngine(wasmUrl)).applyEvents(two, 5000, null, 20261014));
});

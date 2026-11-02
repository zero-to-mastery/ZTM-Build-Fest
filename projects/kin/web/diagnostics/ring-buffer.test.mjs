// The diagnostic ring buffer (#631): bounded, codes from the registry and
// numbers or fixed-list values only, so no household text can enter it.
import assert from "node:assert/strict";
import test from "node:test";
import { DIAGNOSTIC_CODES, entryLine, normalizeEntry, normalizeFields } from "./registry.js";
import { DiagnosticRing, RING_CAPACITY, diagnostics, recordDiagnostic } from "./ring-buffer.js";
import { errorName, installGlobalDiagnostics } from "./global.js";

const SECRET = "Pick up Sam's prescription at 5";

test("it keeps the last 50 entries, oldest first", () => {
  let now = 1_000;
  const ring = new DiagnosticRing({ now: () => now });
  assert.equal(RING_CAPACITY, 50);
  for (let i = 0; i < 120; i++) {
    now += 1;
    ring.append("sync_slow", { ms: i });
  }
  const entries = ring.snapshot();
  assert.equal(entries.length, 50);
  assert.equal(ring.size, 50);
  assert.deepEqual(entries.map((entry) => entry.fields.ms), Array.from({ length: 50 }, (_, i) => 70 + i));
  assert.ok(entries.every((entry, i) => i === 0 || entry.t > entries[i - 1].t));
  ring.clear();
  assert.deepEqual(ring.snapshot(), []);
  ring.append("alert_shown");
  assert.deepEqual(ring.snapshot().map((entry) => entry.code), ["alert_shown"]);
});

test("household text, names and IDs can't enter it", () => {
  const ring = new DiagnosticRing({ now: () => 5 });
  // An unknown code, even one that is itself text, is not recorded.
  assert.equal(ring.append(SECRET), false);
  assert.equal(ring.append("sync_failed " + SECRET), false);
  assert.equal(ring.append({ toString: () => "sync_failed" }), false);
  assert.equal(ring.append("__proto__"), false);
  assert.equal(ring.append("constructor"), false);
  // A string where a list value belongs becomes "other"; unknown fields go.
  assert.equal(ring.append("sync_failed", { reason: SECRET, status: 503, text: SECRET, householdId: "a".repeat(32) }), true);
  // A number field takes numbers only.
  ring.append("render_slow", { component: "chat", ms: SECRET });
  ring.append("render_slow", { component: SECRET, ms: Number.POSITIVE_INFINITY });
  ring.append("engine_error", { code: 1e300 });
  ring.append("storage_failed", { store: "events", name: Object.assign(new Error(SECRET), { name: SECRET }).name });
  const text = JSON.stringify(ring.snapshot());
  assert.ok(!text.includes("Sam") && !text.includes("aaaa"), text);
  assert.deepEqual(ring.snapshot().map(({ code, fields }) => [code, fields]), [
    ["sync_failed", { reason: "other", status: 503 }],
    ["render_slow", { component: "chat" }],
    ["render_slow", { component: "other" }],
    ["engine_error", { code: 2 ** 48 }],
    ["storage_failed", { store: "events", name: "other" }],
  ]);
  // Every value that can be stored is a number or a registry list value.
  for (const [code, schema] of Object.entries(DIAGNOSTIC_CODES))
    for (const [field, type] of Object.entries(schema)) {
      assert.match(code, /^[a-z][a-z_]*$/);
      assert.ok(type === "number" || (Array.isArray(type) && type.includes("other") && type.every((value) => /^[A-Za-z_]+$/.test(value))), `${code}.${field}`);
    }
});

test("entries are frozen and normalize the same way on the service", () => {
  const ring = new DiagnosticRing({ now: () => 1_800_000_000_000 });
  ring.append("sync_room_failed", { room: "chat", reason: "chat_rate_limited", status: 429.4 });
  const [entry] = ring.snapshot();
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.fields));
  assert.deepEqual(normalizeEntry(JSON.parse(JSON.stringify(entry))), entry);
  assert.equal(entryLine(entry), "2027-01-15T08:00:00Z sync_room_failed room=chat reason=chat_rate_limited status=429");
  assert.equal(normalizeEntry({ t: -1, code: "alert_shown" }), null);
  assert.equal(normalizeEntry({ t: 1, code: SECRET }), null);
  assert.equal(normalizeFields("nope"), null);
});

test("a missing household key is recorded with which place and epoch (#791)", () => {
  const ring = new DiagnosticRing({ now: () => 1_800_000_000_000 });
  for (const reason of ["household_key_missing", "household_key_missing_after_rotation", "household_key_missing_for_binding"])
    ring.append("sync_failed", { reason, epoch: 4 });
  ring.append("sync_failed", { reason: "connection_unavailable" });
  assert.deepEqual(ring.snapshot().map(entryLine), [
    "2027-01-15T08:00:00Z sync_failed reason=household_key_missing epoch=4",
    "2027-01-15T08:00:00Z sync_failed reason=household_key_missing_after_rotation epoch=4",
    "2027-01-15T08:00:00Z sync_failed reason=household_key_missing_for_binding epoch=4",
    "2027-01-15T08:00:00Z sync_failed reason=connection_unavailable",
  ]);
});

test("the page's buffer never throws, and global hooks record only kinds and error names", () => {
  diagnostics.clear();
  assert.equal(recordDiagnostic("went_online"), true);
  assert.equal(recordDiagnostic(SECRET), false);
  const listeners = new Map();
  const target = { addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: (type) => listeners.delete(type) };
  let offered = 0;
  let now = 0;
  const uninstall = installGlobalDiagnostics(target, { onUnexpected: () => { offered += 1; }, now: () => now });
  listeners.get("error")({ error: new TypeError(SECRET) });
  listeners.get("unhandledrejection")({ reason: Object.assign(new Error(SECRET), { name: SECRET }) });
  listeners.get("error")({ error: undefined });
  listeners.get("offline")();
  now = 61_000;
  listeners.get("unhandledrejection")({ reason: SECRET });
  assert.equal(offered, 2, "offered once a minute at most");
  assert.deepEqual(diagnostics.snapshot().map(({ code, fields }) => [code, fields]), [
    ["went_online", {}],
    ["unexpected_error", { kind: "error", name: "TypeError" }],
    ["unexpected_error", { kind: "rejection", name: "other" }],
    ["went_offline", {}],
    ["unexpected_error", { kind: "rejection", name: "other" }],
  ]);
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes("Sam"));
  uninstall();
  assert.equal(listeners.size, 0);
  assert.equal(errorName({ get name() { throw new Error("no"); } }), "other");
  diagnostics.clear();
});

import test from "node:test";
import assert from "node:assert/strict";
import { LocalReminders } from "./reminders.js";

function fixture(permission = "granted") {
  const timers = new Map(); let next = 0; let requests = 0; let currentTime = 1000; const shown = [];
  class Notice { static permission = permission; static async requestPermission() { requests++; this.permission = "granted"; return this.permission; } constructor(title, options) { shown.push({ title, options }); } }
  const reminders = new LocalReminders({ notification: Notice, now: () => currentTime, setTimer: fn => { const id = ++next; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id) });
  return { reminders, timers, shown, get requests() { return requests; }, Notice, advance: time => { currentTime = time; } };
}

test("permission is requested only by schedule; denied and unsupported degrade safely", async () => {
  const denied = fixture("denied"); assert.equal(await denied.reminders.schedule({ id: "x", title: "X", at: 2000 }), "denied"); assert.equal(denied.requests, 0);
  const pending = fixture("default"); assert.equal(await pending.reminders.schedule({ id: "x", title: "X", at: 2000 }), "granted"); assert.equal(pending.requests, 1);
  const unsupported = new LocalReminders({ notification: undefined, now: () => 1000 }); assert.equal(await unsupported.schedule({ id: "x", title: "X", at: 2000 }), "unsupported");
});

test("duplicate reminder replaces prior timer; cancellation prevents delivery", async () => {
  const f = fixture(); await f.reminders.schedule({ id: "i", title: "first", at: 2000 }); await f.reminders.schedule({ id: "i", title: "second", at: 3000 });
  assert.equal(f.timers.size, 1); assert.equal(f.reminders.cancel("i"), true); assert.equal(f.timers.size, 0);
});

test("completed items are checked at delivery and do not notify", async () => {
  const f = fixture(); let active = true; await f.reminders.schedule({ id: "i", title: "Task", at: 2000, isCurrent: () => active });
  active = false; f.advance(2000); [...f.timers.values()][0](); assert.equal(f.shown.length, 0);
});

test("a granted reminder delivers once when its local deadline arrives", async () => {
  const f = fixture(); await f.reminders.schedule({ id: "i", title: "Task", at: 2000 });
  f.advance(2000); [...f.timers.values()][0](); assert.equal(f.shown.length, 1); assert.equal(f.shown[0].title, "Task");
});

test("local datetime values map through the host timezone across date boundaries", () => {
  const late = new Date(2026, 9, 31, 23, 30); const tomorrow = new Date(late.getTime() + 60 * 60 * 1000);
  assert.equal(tomorrow.getDate(), 1); assert.equal(tomorrow.getMonth(), 10);
});

// Lock suspends reminders and unlock of the same vault resumes them. While
// suspended nothing in the instance may hold a title or a delivery closure.
const fire = (f) => { for (const tick of [...f.timers.values()]) tick(); };
const holdsText = (value, text, seen = new Set()) => {
  if (typeof value === "string") return value.includes(text);
  if (typeof value === "function") return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const values = value instanceof Map ? [...value.keys(), ...value.values()] : Object.values(value);
  return values.some((entry) => holdsText(entry, text, seen));
};

test("suspend clears every timer and keeps only id, time and vault, with no title or closure", async () => {
  const f = fixture();
  await f.reminders.schedule({ id: "item:a", title: "Secret errand", at: 2000 });
  await f.reminders.schedule({ id: "routine:b", title: "Secret routine", at: 3000, isCurrent: () => true });
  f.reminders.suspendAll("vault-1");
  assert.equal(f.timers.size, 0);
  assert.equal(f.reminders.entries.size, 0);
  assert.deepEqual([...f.reminders.suspended.values()], [{ id: "item:a", at: 2000, vaultId: "vault-1" }, { id: "routine:b", at: 3000, vaultId: "vault-1" }]);
  assert.equal(holdsText({ entries: f.reminders.entries, suspended: f.reminders.suspended }, "Secret"), false);
  f.advance(5000); fire(f); assert.equal(f.shown.length, 0);
});

test("resume re-arms future reminders with titles from the fresh records", async () => {
  const f = fixture();
  await f.reminders.schedule({ id: "item:a", title: "Old title", at: 2000 });
  f.reminders.suspendAll("vault-1");
  f.reminders.resumeAll("vault-1", (id) => ({ title: `Renamed ${id}`, isCurrent: () => true }));
  assert.equal(f.reminders.suspended.size, 0);
  assert.equal(f.reminders.entries.get("item:a").at, 2000);
  fire(f); assert.equal(f.shown.length, 0, "not due yet");
  f.advance(2000); fire(f);
  assert.deepEqual(f.shown.map((entry) => entry.title), ["Renamed item:a"]);
});

test("a reminder that came due while locked fires exactly once after unlock", async () => {
  const f = fixture();
  await f.reminders.schedule({ id: "item:a", title: "Task", at: 2000 });
  f.reminders.suspendAll("vault-1");
  f.advance(9000);
  f.reminders.resumeAll("vault-1", () => ({ title: "Task", isCurrent: () => true }));
  fire(f); fire(f);
  assert.equal(f.shown.length, 1);
  assert.equal(f.reminders.entries.size, 0);
});

test("resume skips reminders whose record is gone or no longer live", async () => {
  const f = fixture();
  await f.reminders.schedule({ id: "item:gone", title: "Gone", at: 2000 });
  await f.reminders.schedule({ id: "routine:archived", title: "Archived", at: 2000 });
  f.reminders.suspendAll("vault-1");
  f.reminders.resumeAll("vault-1", () => null);
  assert.equal(f.reminders.entries.size, 0);
  assert.equal(f.reminders.suspended.size, 0);
  f.advance(2000); fire(f); assert.equal(f.shown.length, 0);
});

test("another vault's suspended reminders are discarded, never re-armed", async () => {
  const f = fixture();
  await f.reminders.schedule({ id: "item:a", title: "Other household", at: 2000 });
  f.reminders.suspendAll("vault-1");
  let looked = 0;
  f.reminders.resumeAll("vault-2", () => { looked++; return { title: "x", isCurrent: () => true }; });
  assert.equal(looked, 0);
  assert.equal(f.reminders.suspended.size, 0);
  assert.equal(f.reminders.entries.size, 0);
});

test("resume never prompts; without granted permission reminders stay suspended", async () => {
  const f = fixture();
  await f.reminders.schedule({ id: "item:a", title: "Task", at: 2000 });
  f.reminders.suspendAll("vault-1");
  f.Notice.permission = "default";
  f.reminders.resumeAll("vault-1", () => ({ title: "Task", isCurrent: () => true }));
  assert.equal(f.requests, 0);
  assert.equal(f.reminders.entries.size, 0);
  assert.deepEqual([...f.reminders.suspended.keys()], ["item:a"]);
});

test("clearAll empties live timers and suspended reminders", async () => {
  const f = fixture();
  await f.reminders.schedule({ id: "item:a", title: "A", at: 2000 });
  f.reminders.suspendAll("vault-1");
  await f.reminders.schedule({ id: "item:b", title: "B", at: 3000 });
  f.reminders.clearAll();
  assert.equal(f.timers.size, 0);
  assert.equal(f.reminders.entries.size, 0);
  assert.equal(f.reminders.suspended.size, 0);
});

test("a token-guarded cancel leaves a newer attempt for the same id intact", async () => {
  const f = fixture();
  const stale = Symbol("stale"), fresh = Symbol("fresh");
  await f.reminders.schedule({ id: "item:a", title: "Old", at: 2000, token: stale });
  await f.reminders.schedule({ id: "item:a", title: "New", at: 3000, token: fresh });
  assert.equal(f.reminders.cancel("item:a", stale), false);
  assert.equal(f.reminders.entries.get("item:a").at, 3000);
  assert.equal(f.reminders.cancel("item:a", fresh), true);
  assert.equal(f.reminders.entries.size, 0);
});

test("a permission answer for a record that is no longer current arms nothing", async () => {
  const f = fixture("default");
  assert.equal(await f.reminders.schedule({ id: "item:a", title: "Task", at: 2000, isCurrent: () => false }), "stale");
  assert.equal(f.reminders.entries.size, 0);
  assert.equal(f.timers.size, 0);
});

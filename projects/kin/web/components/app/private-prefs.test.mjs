// The controller that keeps a device in step with the member's reminders and
// settings (#520), against a stand-in private log whose reducer mirrors
// rust/src/private_prefs.rs (the real records and replay are tested there):
// the one-time move of this device's reminders, arming and disarming as
// other devices change things, dismissal clearing everywhere, settings
// following or not ("Use different settings on this device"), and the
// device-only fallback without private storage.
import test from "node:test";
import assert from "node:assert/strict";
import { LocalReminders } from "../../reminders.js";
import { PrivatePrefsController } from "./private-prefs.js";

const A = `item:${"0a".repeat(16)}`;
const B = `item:${"0b".repeat(16)}`;
const HOUR = 3_600_000;

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
}

/** A private log: commands change a projection the way Rust replays them. */
function fakeLog() {
  const listeners = new Set();
  const log = {
    active: true, reason: "ready", changes: [],
    reminders: new Map(), settings: new Map(),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { for (const listener of listeners) listener(log); },
    projection() {
      return {
        reminders: [...log.reminders.values()].map((reminder) => ({ ...reminder })),
        settings: Object.fromEntries([...log.settings].map(([key, value]) => [key, { value }])),
      };
    },
    // Another device's change, arriving by sync.
    remote(command) { log.apply(command); log.notify(); },
    apply(command) {
      if (command.type === "set-reminder") {
        const now = log.reminders.get(command.reminderId);
        if (now?.at === command.at && now.timeZone === command.timeZone && now.utcOffsetMinutes === command.utcOffsetMinutes) throw Object.assign(new Error("unchanged"), { code: 4 });
        log.reminders.set(command.reminderId, { reminderId: command.reminderId, at: command.at, timeZone: command.timeZone, utcOffsetMinutes: command.utcOffsetMinutes });
      } else if (command.type === "clear-reminder") {
        const now = log.reminders.get(command.reminderId);
        if (!now || (command.reason !== "canceled" && now.at !== command.at)) throw Object.assign(new Error("unchanged"), { code: 4 });
        log.reminders.delete(command.reminderId);
      } else if (command.type === "set-setting") {
        if ((log.settings.get(command.key) ?? "") === command.value) throw Object.assign(new Error("unchanged"), { code: 4 });
        if (command.value) log.settings.set(command.key, command.value); else log.settings.delete(command.key);
      }
    },
    async execute(command) {
      log.apply(command);
      log.changes.push(command);
      log.notify();
    },
  };
  return log;
}

class FakeNotification {
  static permission = "granted";
  static shown = [];
  static async requestPermission() { return FakeNotification.permission; }
  constructor(title, options) { this.title = title; this.options = options; this.closed = false; FakeNotification.shown.push(this); }
  close() { this.closed = true; this.onclose?.(); }
}

function setup({ now = 1_792_490_000_000 } = {}) {
  globalThis.localStorage = memoryStorage();
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  const clock = { now };
  const timers = new Map();
  let nextTimer = 0;
  const localReminders = new LocalReminders({
    notification: FakeNotification, now: () => clock.now,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, due: clock.now + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const session = { id: 1 };
  const statuses = [];
  const app = { localReminders, personalAppearance: null, personalSettings: null };
  const ctx = {
    app,
    session: { captureSession: () => session, isCurrentSession: (value) => value === session },
    records: { reminderTarget: (id) => ({ title: `Thing ${id.slice(-4)}`, isCurrent: () => true }), renderReminders() {} },
    badge: { choice: "off", setChoice(value) { this.choice = value; return true; } },
    status: { setStatus: (text) => statuses.push(text) },
    appearance: { applyAppearance() {} },
  };
  const controller = new PrivatePrefsController(ctx);
  ctx.privatePrefs = controller;
  const realNow = Date.now;
  Date.now = () => clock.now;
  const settle = async () => { for (let index = 0; index < 20; index += 1) await controller.work; };
  // Runs every timer due by `clock.now`.
  const advance = (ms) => {
    clock.now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= clock.now) { timers.delete(id); timer.callback(); }
  };
  return { controller, ctx, app, localReminders, session, statuses, clock, settle, advance, restore: () => { Date.now = realNow; } };
}

test("reminders set on this device before private storage move in once, without duplicates", async (t) => {
  const s = setup();
  t.after(s.restore);
  // Set while this device had no private log: device-only, as before.
  const local = await s.controller.setReminder({ id: A, title: "Milk", at: s.clock.now + HOUR });
  assert.deepEqual(local, { result: "granted", synced: false });
  const b = await s.controller.setReminder({ id: B, title: "Bread", at: s.clock.now + 2 * HOUR });
  assert.equal(b.synced, false);
  const log = fakeLog();
  // Another device already reminds about B: B keeps that one.
  log.reminders.set(B, { reminderId: B, at: s.clock.now + 5 * HOUR, timeZone: "Europe/Paris", utcOffsetMinutes: 60 });
  s.controller.attach(log, s.session);
  await s.settle();
  assert.deepEqual(log.changes.filter((change) => change.type === "set-reminder").map((change) => [change.reminderId, change.at]), [[A, s.clock.now + HOUR]]);
  assert.equal(log.reminders.get(B).at, s.clock.now + 5 * HOUR);
  // B's local timer now follows the synced instant.
  assert.equal(s.localReminders.entries.get(B).at, s.clock.now + 5 * HOUR);
  // Attaching again (a new unlock, another pass) moves nothing more.
  s.controller.attach(log, s.session);
  await s.settle();
  assert.equal(log.changes.filter((change) => change.type === "set-reminder").length, 1);
});

test("a synced reminder goes off here, and dismissing it clears it for every device", async (t) => {
  const s = setup();
  t.after(s.restore);
  const log = fakeLog();
  s.controller.attach(log, s.session);
  await s.settle();
  const set = await s.controller.setReminder({ id: A, title: "Milk", at: s.clock.now + HOUR });
  assert.deepEqual(set, { result: "granted", synced: true });
  await s.settle();
  const change = log.changes.find((entry) => entry.type === "set-reminder");
  assert.equal(change.at, s.clock.now + HOUR);
  assert.ok(Number.isInteger(change.utcOffsetMinutes) && typeof change.timeZone === "string", "absolute instant plus the setter's zone");
  assert.ok(s.localReminders.entries.has(A), "armed here");
  assert.equal(s.controller.reminderView().get(A).scope, "devices");
  s.advance(HOUR);
  assert.equal(FakeNotification.shown.length, 1);
  const shown = FakeNotification.shown[0];
  assert.equal(shown.title, "Thing 0a0a");
  // Re-reconciling after it fired never fires it twice.
  await s.controller.refresh();
  await s.settle();
  assert.equal(FakeNotification.shown.length, 1);
  shown.close();
  await s.settle();
  assert.deepEqual(log.changes.at(-1), { type: "clear-reminder", reminderId: A, reason: "dismissed", at: s.clock.now });
  assert.equal(log.reminders.size, 0);
});

test("cleared or moved on another device: this device disarms, and closes what it showed", async (t) => {
  const s = setup();
  t.after(s.restore);
  const log = fakeLog();
  log.reminders.set(A, { reminderId: A, at: s.clock.now + HOUR, timeZone: "", utcOffsetMinutes: 0 });
  log.reminders.set(B, { reminderId: B, at: s.clock.now + HOUR, timeZone: "", utcOffsetMinutes: 0 });
  s.controller.attach(log, s.session);
  await s.settle();
  assert.ok(s.localReminders.entries.has(A) && s.localReminders.entries.has(B));
  // Moved to later elsewhere: re-armed for the new instant.
  log.remote({ type: "set-reminder", reminderId: B, at: s.clock.now + 3 * HOUR, timeZone: "", utcOffsetMinutes: 0 });
  await s.settle();
  assert.equal(s.localReminders.entries.get(B).at, s.clock.now + 3 * HOUR);
  // A fires on both devices; the other device's member dismisses it there.
  s.advance(HOUR);
  const shown = FakeNotification.shown.find((notification) => notification.title === "Thing 0a0a");
  assert.ok(shown && !shown.closed);
  log.remote({ type: "clear-reminder", reminderId: A, reason: "dismissed", at: s.clock.now });
  await s.settle();
  assert.equal(shown.closed, true, "closed here too");
  assert.equal(log.changes.length, 0, "closing it quietly writes nothing back");
  // B is canceled elsewhere before it is due: it never goes off here.
  log.remote({ type: "clear-reminder", reminderId: B, reason: "canceled", at: 0 });
  await s.settle();
  assert.equal(s.localReminders.entries.has(B), false);
  s.advance(3 * HOUR);
  assert.equal(FakeNotification.shown.length, 1);
});

test("without notification permission or with alerts off, reminders are kept but quiet here", async (t) => {
  const s = setup();
  t.after(s.restore);
  FakeNotification.permission = "denied";
  const log = fakeLog();
  s.controller.attach(log, s.session);
  await s.settle();
  const set = await s.controller.setReminder({ id: A, title: "Milk", at: s.clock.now + HOUR });
  assert.deepEqual(set, { result: "denied", synced: true }, "saved for the member's other devices");
  await s.settle();
  assert.ok(log.reminders.has(A));
  assert.equal(s.localReminders.entries.has(A), false);
  assert.ok(s.controller.reminderView().has(A), "still shown beside its item");
  FakeNotification.permission = "granted";
  await s.controller.setDisplaySetting("reminder-alerts", "off");
  await s.settle();
  assert.equal(s.localReminders.entries.has(A), false);
  assert.equal(log.settings.get("reminder-alerts"), "off", "a notification preference that follows the member");
});

test("finishing the thing clears its reminder everywhere", async (t) => {
  const s = setup();
  t.after(s.restore);
  const log = fakeLog();
  s.controller.attach(log, s.session);
  await s.settle();
  await s.controller.setReminder({ id: A, title: "Milk", at: s.clock.now + HOUR });
  await s.settle();
  await s.controller.endReminder(A, "done");
  await s.settle();
  assert.deepEqual(log.changes.at(-1), { type: "clear-reminder", reminderId: A, reason: "done", at: s.clock.now + HOUR });
  assert.equal(s.localReminders.entries.has(A), false);
  // Nothing to clear is not an error.
  assert.equal(await s.controller.endReminder(B, "done"), false);
});

test("settings follow the member unless this device uses its own", async (t) => {
  const s = setup();
  t.after(s.restore);
  // This device had a larger text size before private storage: it seeds it.
  globalThis.localStorage.setItem("kin.text-size", "large");
  s.app.personalAppearance = { version: 2 };
  const log = fakeLog();
  log.settings.set("motion", "reduce");
  s.controller.attach(log, s.session);
  await s.settle();
  assert.equal(log.settings.get("text-size"), "large", "seeded from the first device");
  assert.equal(globalThis.localStorage.getItem("kin.motion"), "reduce", "synced value applied here");
  // Another device picks the larger size and an app icon count.
  log.remote({ type: "set-setting", key: "text-size", value: "larger" });
  log.remote({ type: "set-setting", key: "app-badge", value: "messages" });
  await s.settle();
  assert.equal(globalThis.localStorage.getItem("kin.text-size"), "larger");
  assert.equal(s.ctx.badge.choice, "messages");
  // The kitchen tablet keeps its own.
  s.controller.setDeviceOnly(true);
  log.remote({ type: "set-setting", key: "text-size", value: "standard" });
  await s.settle();
  assert.equal(globalThis.localStorage.getItem("kin.text-size"), "larger");
  await s.controller.setDisplaySetting("motion", "system");
  await s.settle();
  assert.equal(log.settings.get("motion"), "reduce", "a device-only change stays here");
  assert.equal(s.controller.scope, "device-only");
  // Following again: the member's settings win.
  s.controller.setDeviceOnly(false);
  await s.settle();
  assert.equal(globalThis.localStorage.getItem("kin.text-size"), null, "standard is the default, kept as nothing");
  assert.equal(globalThis.localStorage.getItem("kin.motion"), "reduce");
  assert.equal(s.controller.scope, "synced");
});

test("the member key is made on the first private change, not before", async (t) => {
  const s = setup();
  t.after(s.restore);
  const log = fakeLog();
  log.active = false;
  log.reason = "no_member_key";
  let enabled = 0;
  log.enable = async () => { enabled += 1; log.active = true; log.reason = "ready"; log.notify(); return "ready"; };
  s.controller.attach(log, s.session);
  await s.settle();
  assert.equal(enabled, 0, "nothing to bring: no key yet");
  assert.equal(s.controller.scope, "synced", "but reminders and settings will follow the member");
  const set = await s.controller.setReminder({ id: A, title: "Milk", at: s.clock.now + HOUR });
  await s.settle();
  assert.deepEqual(set, { result: "granted", synced: true });
  assert.equal(enabled, 1);
  assert.ok(log.reminders.has(A));
  // A device with its own reminder to bring makes the key when it opens.
  const other = setup();

  await other.controller.setReminder({ id: B, title: "Bread", at: other.clock.now + HOUR });
  const fresh = fakeLog();
  fresh.active = false;
  fresh.reason = "no_member_key";
  fresh.enable = async () => { fresh.active = true; fresh.reason = "ready"; fresh.notify(); return "ready"; };
  other.controller.attach(fresh, other.session);
  await other.settle();
  assert.ok(fresh.reminders.has(B), "moved in once the key exists");
  other.restore();
});

test("with no private storage, everything stays on this device and says so", async (t) => {
  const s = setup();
  t.after(s.restore);
  assert.equal(s.controller.scope, "device");
  assert.equal(s.controller.settingsView().scope, "device");
  const set = await s.controller.setReminder({ id: A, title: "Milk", at: s.clock.now + HOUR });
  assert.deepEqual(set, { result: "granted", synced: false });
  assert.equal(s.controller.reminderView().get(A).scope, "device");
  // The household turned private storage off for this member.
  const log = fakeLog();
  log.active = false;
  log.reason = "off";
  s.controller.attach(log, s.session);
  await s.settle();
  assert.equal(s.controller.scope, "off");
  assert.equal(log.changes.length, 0);
  // Locked: the private log is gone; the reminder stays this device's.
  s.controller.detach();
  assert.equal(s.controller.scope, "device");
});

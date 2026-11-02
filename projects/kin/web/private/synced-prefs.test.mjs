// The helpers behind reminders and settings that follow a member (#520):
// the one-time move of a device's reminders (no duplicates, safe to run
// again), what each device arms, how a reminder set in another time zone
// reads, and how theme settings map to this device's appearance.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LATE_WINDOW_MS, SYNCED_SETTING_DEFAULTS, appearanceSettings, applyAppearanceSettings, changedSettings,
  describeSyncedReminder, migrationPlan, reminderPlan, settingsPlan, zoneSnapshot,
} from "./synced-prefs.js";

const A = `item:${"0a".repeat(16)}`;
const B = `item:${"0b".repeat(16)}`;
const R = `routine:${"0c".repeat(16)}`;
const NOW = 1_792_490_000_000;
const HOUR = 3_600_000;
const NINE_NEW_YORK = 1_792_501_200_000; // 2026-10-20 13:00 UTC
const synced = (reminderId, at, extra = {}) => ({ reminderId, at, utcOffsetMinutes: -240, timeZone: "America/New_York", ...extra });

// --- Moving this device's reminders in ----------------------------------

test("a device's own reminders move in once, and a thing already reminded keeps the synced one", () => {
  const local = new Map([[A, { at: NOW + HOUR }], [B, { at: NOW + 2 * HOUR }], [R, { at: NOW + 3 * HOUR }]]);
  // B already has a reminder from another device: it is not duplicated.
  const plan = migrationPlan(local, [synced(B, NOW + 5 * HOUR)], NOW);
  assert.deepEqual(plan, [{ reminderId: A, at: NOW + HOUR }, { reminderId: R, at: NOW + 3 * HOUR }]);
  // Running it again once those arrived plans nothing: idempotent.
  const after = [synced(A, NOW + HOUR), synced(B, NOW + 5 * HOUR), synced(R, NOW + 3 * HOUR)];
  assert.deepEqual(migrationPlan(local, after, NOW), []);
});

test("past reminders and anything that isn't an item or routine stay local", () => {
  const local = new Map([[A, { at: NOW - 1 }], ["note:abc", { at: NOW + HOUR }], [`item:${"0".repeat(32)}`, { at: NOW + HOUR }], [B, { at: Number.NaN }]]);
  assert.deepEqual(migrationPlan(local, [], NOW), []);
});

// --- Scheduling from the log --------------------------------------------

test("each device arms what is upcoming, once per instant", () => {
  const reminders = [synced(A, NOW + HOUR), synced(B, NOW - LATE_WINDOW_MS + 1000), synced(R, NOW - LATE_WINDOW_MS - 1)];
  const plan = reminderPlan(reminders, { now: NOW });
  assert.deepEqual([...plan.visible.keys()], [A, B], "long past is quiet and not shown");
  assert.deepEqual(plan.arm.map((reminder) => reminder.reminderId), [A, B], "just due still fires on a late device");
  assert.deepEqual(plan.cancel, []);
  // Armed already for that instant, or fired already: nothing to do.
  const again = reminderPlan(reminders, { now: NOW, armed: new Map([[A, { at: NOW + HOUR }]]), fired: new Set([`${B}@${NOW - LATE_WINDOW_MS + 1000}`]) });
  assert.deepEqual(again.arm, []);
});

test("a reminder cleared or moved on another device is disarmed here", () => {
  const armed = new Map([[A, { at: NOW + HOUR }], [B, { at: NOW + HOUR }]]);
  // A was dismissed elsewhere (gone); B was moved to later.
  const plan = reminderPlan([synced(B, NOW + 2 * HOUR)], { now: NOW, armed });
  assert.deepEqual(plan.cancel.sort(), [A, B]);
  assert.deepEqual(plan.arm.map((reminder) => [reminder.reminderId, reminder.at]), [[B, NOW + 2 * HOUR]]);
});

test("with alerts off or no permission nothing is armed, and armed ones stop", () => {
  const plan = reminderPlan([synced(A, NOW + HOUR)], { now: NOW, alerts: false, armed: new Map([[A, { at: NOW + HOUR }]]) });
  assert.deepEqual(plan.arm, []);
  assert.deepEqual(plan.cancel, [A]);
  assert.ok(plan.visible.has(A), "still shown beside its item");
});

// --- Clocks and time zones ----------------------------------------------

test("a reminder keeps an absolute instant with the setter's zone and offset", () => {
  assert.deepEqual(zoneSnapshot(NINE_NEW_YORK, { timeZone: "America/New_York", offsetAt: () => -240 }), { timeZone: "America/New_York", utcOffsetMinutes: -240 });
  assert.deepEqual(zoneSnapshot(NINE_NEW_YORK, { timeZone: "Not a zone!", offsetAt: () => 330 }), { timeZone: "", utcOffsetMinutes: 330 });
  assert.deepEqual(zoneSnapshot(NINE_NEW_YORK, { timeZone: "Pacific/Kiritimati", offsetAt: () => 900 }).utcOffsetMinutes, 840, "clamped to the widest real offset");
  // The browser's own reading is an integer offset and a plain zone name.
  const own = zoneSnapshot(NINE_NEW_YORK);
  assert.ok(Number.isInteger(own.utcOffsetMinutes) && /^[A-Za-z0-9/_+-]*$/.test(own.timeZone));
});

test("a reminder set in New York reads in Paris time, with New York's beside it", () => {
  const reminder = synced(A, NINE_NEW_YORK);
  const paris = describeSyncedReminder(reminder, { timeZone: "Europe/Paris", locale: "en-US" });
  assert.match(paris.when, /3:00\s?PM/);
  assert.match(paris.where, /^9:00\s?AM in America\/New_York, where it was set$/);
  // The same zone, or a different zone whose clock reads the same, adds nothing.
  assert.equal(describeSyncedReminder(reminder, { timeZone: "America/New_York", locale: "en-US" }).where, "");
  assert.equal(describeSyncedReminder(reminder, { timeZone: "America/Toronto", locale: "en-US" }).where, "");
  // Unknown setter zone, or one this browser can't name: just this device's time.
  assert.equal(describeSyncedReminder({ ...reminder, timeZone: "" }, { timeZone: "Asia/Tokyo", locale: "en-US" }).where, "");
  assert.equal(describeSyncedReminder({ ...reminder, timeZone: "Mars/Olympus_Mons" }, { timeZone: "Asia/Tokyo", locale: "en-US" }).where, "");
});

test("across a daylight-saving change the instant, not the wall clock, is kept", () => {
  // Set in London on 2026-10-24 for 09:00 on 2026-10-26 (after the clocks
  // go back on the 25th): 09:00 GMT is 09:00 UTC. A device in New York
  // (still on daylight time until Nov 1) reads 5:00 AM.
  const at = Date.UTC(2026, 9, 26, 9, 0);
  const reminder = { reminderId: A, at, utcOffsetMinutes: 0, timeZone: "Europe/London" };
  const there = describeSyncedReminder(reminder, { timeZone: "America/New_York", locale: "en-US" });
  assert.match(there.when, /5:00\s?AM/);
  assert.match(there.where, /^9:00\s?AM in Europe\/London/);
});

// --- Settings ------------------------------------------------------------

test("this device's appearance reads as the two theme settings", () => {
  assert.deepEqual(appearanceSettings({ version: 2 }), { "theme-mode": "household", "theme-color": "household" });
  assert.deepEqual(appearanceSettings({ version: 1, mode: "dark", colorSource: "preset", seed: "#397052" }), { "theme-mode": "dark", "theme-color": "preset-397052" });
  assert.deepEqual(appearanceSettings({ version: 2, colorSource: "default", seed: "#984D38", manual: null }), { "theme-mode": "household", "theme-color": "default" });
  assert.equal(appearanceSettings({ version: 2, colorSource: "background", seed: "#123456", image: {} })["theme-color"], null, "a picture's color stays here");
});

test("synced theme settings apply to this device's appearance, keeping its picture", () => {
  const image = { seed: "#123456", type: "image/webp", bytes: new Uint8Array(4) };
  const next = applyAppearanceSettings({ version: 2, owner: "o", image }, { "theme-mode": "dark", "theme-color": "preset-397052" });
  assert.deepEqual(next, { version: 2, owner: "o", image, mode: "dark", colorSource: "preset", seed: "#397052", manual: { source: "preset", seed: "#397052", name: "Forest" } });
  const back = applyAppearanceSettings(next, { "theme-mode": "household", "theme-color": "household" });
  assert.deepEqual(back, { version: 2, owner: "o", image });
  const custom = applyAppearanceSettings({ version: 2 }, { "theme-color": "custom-a14f69" });
  assert.deepEqual(custom.manual, { source: "custom", seed: "#A14F69", name: "Custom color" });
  assert.equal(applyAppearanceSettings(next, { "theme-mode": "dark" }), null, "nothing changes");
  assert.equal(applyAppearanceSettings({ version: 2 }, { "theme-color": "sepia" }), null, "an unknown value is ignored");
});

test("synced values win; this device's non-default values seed keys nothing synced yet", () => {
  const local = { ...SYNCED_SETTING_DEFAULTS, "theme-mode": "light", "text-size": "large", "app-badge": "messages" };
  const plan = settingsPlan(local, { "theme-mode": { value: "dark" }, "text-size": { value: "large" } });
  assert.deepEqual(plan.apply, { "theme-mode": "dark" });
  assert.deepEqual(plan.seed, [{ key: "app-badge", value: "messages" }]);
  // A device on all defaults seeds nothing.
  assert.deepEqual(settingsPlan({ ...SYNCED_SETTING_DEFAULTS }, {}).seed, []);
});

test("a change on this device writes only keys that differ from the synced value", () => {
  const local = { ...SYNCED_SETTING_DEFAULTS, "theme-mode": "dark", "text-size": "standard", motion: "reduce" };
  assert.deepEqual(changedSettings(local, { "theme-mode": { value: "dark" }, "text-size": { value: "larger" } }, ["theme-mode", "text-size", "motion", "nope"]), [
    { key: "text-size", value: "standard" },
    { key: "motion", value: "reduce" },
  ]);
  // Back to a default nothing synced: nothing to write.
  assert.deepEqual(changedSettings({ motion: "system" }, {}, ["motion"]), []);
});

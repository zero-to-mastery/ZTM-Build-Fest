// The kitchen display's pure parts (#670, #671, #672): panels as data, the
// night schedule and settings, the quiet timer, and how leaving (and a
// child's reward, #705) is confirmed.
import assert from "node:assert/strict";
import test from "node:test";
import { PANELS, REGIONS, orientationOf, panelsByRegion, validPanel, visiblePanels } from "./panels.js";
import {
  DEFAULT_IDLE_MINUTES, DEFAULT_NIGHT, DISPLAY_KEY, clockText, displayOnFor, isNight, msUntilNextChange, nightText,
  normalizeSettings, parseClock, readDisplaySettings, writeDisplaySettings,
} from "./schedule.js";
import { IdleTimer } from "./idle.js";
import { ADULT_CHECKS, askAdult, confirmOwner, leaveMethods, methodsText } from "./leave.js";
import { FEATURES, featureById, isFeatureOn, withFeature } from "../features.js";

const memory = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values };
};

test("every panel is valid data, in a known region, with a real feature or none", () => {
  assert.ok(PANELS.length >= 6);
  assert.equal(new Set(PANELS.map((entry) => entry.id)).size, PANELS.length, "ids are unique");
  for (const entry of PANELS) {
    assert.ok(validPanel(entry), entry.id);
    assert.ok(Object.isFrozen(entry), `${entry.id} is frozen`);
    assert.ok(REGIONS.includes(entry.region));
    if (entry.featureId) assert.ok(featureById(entry.featureId), `${entry.id} needs ${entry.featureId}, a real feature`);
  }
  // What the ADR lists, and nothing private or administrative.
  const ids = PANELS.map((entry) => entry.id);
  for (const id of ["today", "week", "chores", "meals", "shopping", "fridge", "chat"]) assert.ok(ids.includes(id), id);
  for (const id of ["journal", "mine", "reminders", "search", "household", "features", "settings"]) assert.ok(!ids.includes(id), `${id} is never a panel`);
  for (const entry of PANELS) assert.ok(!["journal", "mine"].includes(entry.featureId), `${entry.id} isn't private`);
  // The shopping list is always on (ADR 0021): it has no feature.
  assert.equal(PANELS.find((entry) => entry.id === "shopping").featureId, null);
});

test("a panel record from elsewhere (a future add-on) must have the same shape", () => {
  const good = { id: "weather", component: "kin-weather", region: "now", featureId: null, size: "s", label: "Weather" };
  assert.ok(validPanel(good));
  for (const bad of [null, {}, { ...good, id: "Weather!" }, { ...good, component: "div" }, { ...good, region: "sky" }, { ...good, size: "xl" }, { ...good, label: "" }, { ...good, featureId: 3 }])
    assert.equal(validPanel(bad), false, JSON.stringify(bad));
  const shown = visiblePanels([...PANELS, good, { ...good, label: "Twice" }, { ...good, id: "bad", region: "sky" }]);
  assert.deepEqual(shown.map((entry) => entry.id), [...PANELS.map((entry) => entry.id), "weather"], "invalid and repeated records are left out");
});

test("a switched-off feature takes its panel away, and the rest keep their order", () => {
  let off = 0;
  for (const id of ["chores", "meals"]) off = withFeature(off, id, false);
  const shown = visiblePanels(PANELS, { isOn: (id) => isFeatureOn(off, id) });
  assert.deepEqual(shown.map((entry) => entry.id), PANELS.map((entry) => entry.id).filter((id) => id !== "chores" && id !== "meals"));
  const noChat = visiblePanels(PANELS, { unavailable: ["chat"] });
  assert.ok(!noChat.some((entry) => entry.id === "chat"), "Chat leaves without access");
  const allOff = FEATURES.reduce((value, entry) => withFeature(value, entry.id, false), 0);
  assert.deepEqual(visiblePanels(PANELS, { isOn: (id) => isFeatureOn(allOff, id) }).map((entry) => entry.id), ["shopping"], "the shopping list always stays");
  const regions = panelsByRegion(shown);
  assert.deepEqual([...regions.keys()], [...REGIONS]);
  assert.deepEqual(regions.get("now").map((entry) => entry.id), ["today", "chat"]);
  assert.deepEqual(regions.get("chores"), []);
});

test("the fridge panel is the fridge's own element on the board, and leaves with its feature or access (#700)", () => {
  const fridge = PANELS.find((entry) => entry.id === "fridge");
  assert.deepEqual({ component: fridge.component, region: fridge.region, featureId: fridge.featureId, size: fridge.size },
    { component: "kin-fridge", region: "board", featureId: "fridge", size: "l" }, "laid out by display.css, not a copy of the fridge");
  const off = withFeature(0, "fridge", false);
  assert.ok(!visiblePanels(PANELS, { isOn: (id) => isFeatureOn(off, id) }).some((entry) => entry.id === "fridge"), "Fridge off: no panel");
  assert.ok(!visiblePanels(PANELS, { unavailable: ["fridge"] }).some((entry) => entry.id === "fridge"), "no access: no panel");
  assert.deepEqual(panelsByRegion(visiblePanels(PANELS, { isOn: (id) => isFeatureOn(off, id) })).get("board"), [], "and the board region is empty");
});

test("orientation follows the screen's shape", () => {
  assert.equal(orientationOf(800, 1280), "portrait");
  assert.equal(orientationOf(1280, 800), "landscape");
  assert.equal(orientationOf(1000, 1000), "landscape");
});

test("the Kitchen display feature has bit 17 and its own switch", () => {
  const entry = featureById("display");
  assert.equal(entry?.bit, 17);
  assert.equal(entry.label, "Kitchen display");
  assert.equal(isFeatureOn(withFeature(0, "display", false), "display"), false);
});

test("clock times read and write as HH:MM", () => {
  assert.equal(parseClock("21:00"), 1260);
  assert.equal(parseClock(" 06:30 "), 390);
  for (const bad of ["24:00", "6:30", "06:60", "", null, "ab:cd"]) assert.equal(parseClock(bad), null, String(bad));
  assert.equal(clockText(390), "06:30");
  assert.equal(clockText(-30), "23:30");
  assert.equal(clockText(1440 + 5), "00:05");
});

test("the night runs over midnight by default, and from equal to to means none", () => {
  assert.deepEqual({ ...DEFAULT_NIGHT }, { from: 1260, to: 390 });
  assert.equal(isNight(1259), false);
  assert.equal(isNight(1260), true);
  assert.equal(isNight(0), true);
  assert.equal(isNight(389), true);
  assert.equal(isNight(390), false);
  assert.equal(isNight(720), false);
  const nap = { from: 780, to: 900 };
  assert.equal(isNight(800, nap), true);
  assert.equal(isNight(900, nap), false);
  assert.equal(isNight(100, { from: 600, to: 600 }), false);
  assert.equal(nightText(), "The screen dims from 21:00 to 06:30.");
  assert.equal(nightText({ from: 60, to: 60 }), "The screen doesn't dim at night.");
});

test("one timer follows the schedule: the time until the night starts or ends", () => {
  const at = (h, m, s = 0) => new Date(2026, 9, 22, h, m, s);
  assert.equal(msUntilNextChange(at(20, 0)), 60 * 60_000, "an hour until 21:00");
  assert.equal(msUntilNextChange(at(21, 0)), (9 * 60 + 30) * 60_000, "at 21:00 the next change is 06:30");
  assert.equal(msUntilNextChange(at(6, 29, 30)), 30_000);
  assert.equal(msUntilNextChange(at(12, 0), { from: 60, to: 60 }), null);
  assert.ok(msUntilNextChange(at(6, 29, 59)) >= 1000, "at least a second");
});

test("settings are kept per device for one vault, checked, with defaults", () => {
  const storage = memory();
  const vaultId = "ab".repeat(16);
  assert.deepEqual(readDisplaySettings(storage), { vaultId: null, on: false, night: { from: 1260, to: 390 }, idleMinutes: DEFAULT_IDLE_MINUTES });
  assert.ok(writeDisplaySettings({ vaultId, on: true, night: { from: 1320, to: 420 }, idleMinutes: 10 }, storage));
  const kept = readDisplaySettings(storage);
  assert.deepEqual(kept, { vaultId, on: true, night: { from: 1320, to: 420 }, idleMinutes: 10 });
  assert.ok(displayOnFor(kept, vaultId));
  assert.equal(displayOnFor(kept, "cd".repeat(16)), false, "another household's vault isn't a display");
  assert.equal(displayOnFor({ ...kept, on: false }, vaultId), false);
  storage.setItem(DISPLAY_KEY, "{not json");
  assert.equal(readDisplaySettings(storage).on, false);
  assert.deepEqual(normalizeSettings({ vaultId: "x", on: "yes", night: { from: 5000, to: -1 }, idleMinutes: 7 }),
    { vaultId: null, on: false, night: { from: 1260, to: 390 }, idleMinutes: DEFAULT_IDLE_MINUTES });
  const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.equal(writeDisplaySettings({ on: true }, refusing), false);
});

function fakeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, delay) => { const id = next++; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

test("the quiet timer goes idle after its minutes, and a touch brings the panels back", () => {
  const clock = fakeTimers();
  const log = [];
  const idle = new IdleTimer({ minutes: 5, onIdle: () => log.push("idle"), onActive: () => log.push("active"), ...clock });
  idle.start();
  clock.advance(4 * 60_000);
  assert.deepEqual(log, []);
  assert.equal(idle.poke(), false, "a touch before then just starts again");
  clock.advance(4 * 60_000);
  assert.deepEqual(log, []);
  clock.advance(60_000);
  assert.deepEqual(log, ["idle"]);
  assert.equal(idle.idle, true);
  assert.equal(idle.poke(), true);
  assert.deepEqual(log, ["idle", "active"]);
  idle.setMinutes(1);
  clock.advance(60_000);
  assert.deepEqual(log, ["idle", "active", "idle"]);
  idle.poke();
  idle.sleep();
  assert.deepEqual(log, ["idle", "active", "idle", "active", "idle"], "sleep() goes idle at once");
  idle.stop();
  assert.equal(idle.poke(), false, "stopped, nothing happens");
  clock.advance(10 * 60_000);
  assert.equal(log.length, 5);
});

test("leaving asks for the passkey or password, or the backup key on a device with neither", () => {
  const manifest = (...types) => ({ vaultId: "ab".repeat(16), wrappers: types.map((type, index) => ({ id: String(index), type })) });
  assert.deepEqual(leaveMethods(manifest("recovery", "password")), ["password"]);
  assert.deepEqual(leaveMethods(manifest("password", "prf", "recovery")), ["passkey", "password"]);
  assert.deepEqual(leaveMethods(manifest("recovery")), ["backup-key"]);
  assert.deepEqual(leaveMethods(manifest("prf")), ["passkey"]);
  assert.deepEqual(leaveMethods(null), []);
  const rotating = { phase: "root-rotating", wrappers: [{ type: "recovery" }], rotation: { candidateManifest: manifest("password") } };
  assert.deepEqual(leaveMethods(rotating), ["password"], "mid key replacement, the new manifest decides");
  assert.equal(methodsText(["passkey", "password"]), "your passkey or your password");
  assert.equal(methodsText(["backup-key"]), "this household's backup key");
});

test("confirming opens this device's vault with the secret and locks that copy again", async () => {
  const vaultId = "ab".repeat(16);
  const manifest = { vaultId, wrappers: [{ id: "w-pass", type: "password" }, { id: "w-key", type: "prf" }, { id: "w-rec", type: "recovery" }] };
  const calls = [];
  const locked = [];
  const unlock = async (opened, secret, wrapperId) => {
    calls.push([opened.vaultId, wrapperId ?? "recovery", [...secret]]);
    if (secret[0] !== 7) throw Object.assign(new Error("no"), { code: "unlock_failed" });
    return { lock: () => locked.push(wrapperId ?? "recovery") };
  };
  const passwordKeys = async (wrapper, password) => ({ localKek: new Uint8Array([password === "right" ? 7 : 1]), authKey: new Uint8Array([9]), passwordKey: new Uint8Array([9]) });
  assert.equal(await confirmOwner({ manifest, method: "password", secret: "right", vaultId }, { unlock, passwordKeys }), true);
  assert.deepEqual(locked, ["w-pass"], "the copy that opened is locked at once");
  await assert.rejects(confirmOwner({ manifest, method: "password", secret: "wrong", vaultId }, { unlock, passwordKeys }), (error) => error.code === "unlock_failed");
  const prf = async () => ({ secret: new Uint8Array([7]) });
  assert.equal(await confirmOwner({ manifest, method: "passkey", vaultId }, { unlock, prf }), true);
  assert.deepEqual(locked, ["w-pass", "w-key"]);
  const cancelled = async () => { throw new DOMException("cancelled", "NotAllowedError"); };
  await assert.rejects(confirmOwner({ manifest, method: "passkey", vaultId }, { unlock, prf: cancelled }), (error) => error.name === "NotAllowedError");
  assert.equal(await confirmOwner({ manifest, method: "backup-key", secret: new Uint8Array([7]), vaultId }, { unlock }), true);
  await assert.rejects(confirmOwner({ manifest, method: "password", secret: "right", vaultId: "cd".repeat(16) }, { unlock, passwordKeys }), (error) => error.code === "wrong_vault");
  await assert.rejects(confirmOwner({ manifest, method: "nothing", vaultId }, { unlock }), (error) => error.code === "unlock_failed");
});

test("one check for leaving and for a child's reward (#705): the device's methods, its own words, and only a real confirmation counts", async () => {
  const vaultId = "ab".repeat(16);
  const manifest = { vaultId, wrappers: [{ id: "w-pass", type: "password" }, { id: "w-rec", type: "recovery" }] };
  const confirmed = [];
  const confirm = async (options) => {
    confirmed.push(options);
    if (options.secret !== "right") throw Object.assign(new Error("no"), { code: "unlock_failed" });
    return true;
  };
  let shown = null;
  // The dialog: a wrong secret first (refused, it stays open), then the right one.
  const ask = async (options) => {
    shown = options;
    await assert.rejects(options.check("password", "wrong"), (error) => error.code === "unlock_failed");
    await options.check("password", "right");
    return true;
  };
  assert.equal(await askAdult("reward", { readManifest: async () => manifest, vaultId, ask, confirm }), true);
  assert.deepEqual(shown.methods, ["password"]);
  assert.equal(shown.purpose, "reward");
  assert.equal(shown.title, "Change a reward");
  assert.match(shown.lead, /change a child's reward/);
  assert.deepEqual(confirmed.map((entry) => [entry.method, entry.secret, entry.vaultId, entry.manifest === manifest]),
    [["password", "wrong", vaultId, true], ["password", "right", vaultId, true]], "checked against this device's vault");

  // Cancelled: false.
  assert.equal(await askAdult("reward", { readManifest: async () => manifest, vaultId, ask: async () => false, confirm }), false);
  // A device from before accounts: the backup key, as for leaving.
  await askAdult("reward", { readManifest: async () => ({ vaultId, wrappers: [{ type: "recovery" }] }), ask: async (options) => { shown = options; return false; } });
  assert.deepEqual(shown.methods, ["backup-key"]);
  // No way to confirm (an unreadable manifest): never true, whatever the dialog says.
  assert.equal(await askAdult("reward", { readManifest: async () => { throw new Error("storage"); }, ask: async (options) => { shown = options; return true; } }), false);
  assert.deepEqual(shown.methods, []);
  // Leaving keeps its words; an unknown purpose asks nothing.
  assert.equal(ADULT_CHECKS.leave.title, "Leave kitchen display");
  assert.equal(ADULT_CHECKS.leave.stay, "Stay in display mode");
  let asked = false;
  assert.equal(await askAdult("journal", { readManifest: async () => manifest, ask: async () => { asked = true; return true; } }), false);
  assert.equal(asked, false);
});

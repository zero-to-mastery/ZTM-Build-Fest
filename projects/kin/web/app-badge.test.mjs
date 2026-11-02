// The count on the app icon (#476, #477): the per-device choice and the pure
// count from the chat's unread number and the projection.
import assert from "node:assert/strict";
import test from "node:test";
import { APP_BADGE_KEY, appBadgeCount, appBadgeSupported, myThingsToday, readAppBadgeChoice, writeAppBadgeChoice } from "./app-badge.js";

const TODAY = 20261020;
const ME = "member-me";
const THEM = "member-them";

const memory = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
};

const state = {
  mode: "normal",
  items: [
    { itemId: "mine-today", classification: "need", status: "active", planningDate: TODAY },
    { itemId: "mine-shopping-today", classification: "shopping", status: "active", planningDate: TODAY },
    { itemId: "mine-tomorrow", classification: "need", status: "active", planningDate: TODAY + 1 },
    { itemId: "mine-done", classification: "need", status: "completed", planningDate: TODAY },
    { itemId: "mine-undated", classification: "need", status: "active", planningDate: null },
    { itemId: "theirs-today", classification: "need", status: "active", planningDate: TODAY },
    { itemId: "nobodys-today", classification: "need", status: "active", planningDate: TODAY },
  ],
  routines: [
    { routineId: "mine-daily", cadence: "daily", status: "active", occurrenceStatus: "open" },
    { routineId: "mine-daily-done", cadence: "daily", status: "active", occurrenceStatus: "completed" },
    { routineId: "mine-weekly", cadence: "weekly", status: "active", occurrenceStatus: "open" },
    { routineId: "theirs-daily", cadence: "weekdays", status: "active", occurrenceStatus: "open" },
  ],
  responsibilities: [
    ...["mine-today", "mine-shopping-today", "mine-tomorrow", "mine-done", "mine-undated"].map((targetId) => ({ targetKind: "item", targetId, memberId: ME })),
    { targetKind: "item", targetId: "theirs-today", memberId: THEM },
    ...["mine-daily", "mine-daily-done", "mine-weekly"].map((targetId) => ({ targetKind: "routine", targetId, memberId: ME })),
    { targetKind: "routine", targetId: "theirs-daily", memberId: THEM },
  ],
};

test("the choice is per device, Off unless set, and unknown values read as Off", () => {
  const storage = memory();
  assert.equal(readAppBadgeChoice(storage), "off");
  assert.equal(writeAppBadgeChoice("messages-and-mine", storage), true);
  assert.equal(storage.values.get(APP_BADGE_KEY), "messages-and-mine");
  assert.equal(readAppBadgeChoice(storage), "messages-and-mine");
  writeAppBadgeChoice("off", storage);
  assert.equal(storage.values.has(APP_BADGE_KEY), false, "Off leaves nothing stored");
  storage.setItem(APP_BADGE_KEY, "everything");
  assert.equal(readAppBadgeChoice(storage), "off");
  assert.throws(() => writeAppBadgeChoice("everything", storage), RangeError);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readAppBadgeChoice(blocked), "off");
  assert.equal(writeAppBadgeChoice("messages", blocked), false, "storage that refuses is reported");
});

test("the setting is offered only where the Badging API exists", () => {
  assert.equal(appBadgeSupported({ setAppBadge() {}, clearAppBadge() {} }), true);
  assert.equal(appBadgeSupported({ setAppBadge() {} }), false);
  assert.equal(appBadgeSupported({}), false);
  assert.equal(appBadgeSupported(undefined), false);
});

test("my things today: my items planned today and my open routines due today", () => {
  const count = myThingsToday({ ...state, memberId: ME, civilDate: TODAY });
  // mine-today, mine-shopping-today, mine-daily.
  assert.equal(count, 3);
  assert.equal(myThingsToday({ ...state, memberId: THEM, civilDate: TODAY }), 2, "theirs-today and theirs-daily");
  assert.equal(myThingsToday({ ...state, memberId: null, civilDate: TODAY }), 0, "no member, nothing");
  assert.equal(myThingsToday({ ...state, mode: "vacation", memberId: ME, civilDate: TODAY }), 2, "a paused household's routines don't count");
  assert.equal(myThingsToday({ ...state, memberId: ME, civilDate: TODAY + 1 }), 2, "tomorrow: mine-tomorrow and the daily routine");
});

test("the icon count follows the choice and never goes negative", () => {
  const base = { unread: 4, state, memberId: ME, civilDate: TODAY };
  assert.equal(appBadgeCount({ ...base, choice: "off" }), 0);
  assert.equal(appBadgeCount({ ...base }), 0, "Off by default");
  assert.equal(appBadgeCount({ ...base, choice: "messages" }), 4);
  assert.equal(appBadgeCount({ ...base, choice: "messages-and-mine" }), 7);
  assert.equal(appBadgeCount({ ...base, choice: "messages-and-mine", unread: -2 }), 3);
  assert.equal(appBadgeCount({ ...base, choice: "messages", unread: Number.NaN }), 0);
  assert.equal(appBadgeCount({ ...base, choice: "messages-and-mine", state: null }), 4, "no projection: messages only");
  assert.equal(appBadgeCount({ ...base, choice: "everything" }), 0);
});

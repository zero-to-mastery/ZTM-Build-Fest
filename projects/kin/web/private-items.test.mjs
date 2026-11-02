import test from "node:test";
import assert from "node:assert/strict";
import {
  canMakePrivate, composePrivateToday, mergePrivateIntoWeek, nextMakePrivateStep, nextShareStep, privateCopyId, privateLabel,
  sharedItemId, shareAudience, showPrivateOnToday,
} from "./private-items.js";

const TODAY = 20261003;
const item = (id, text, date = null, completed = false) => ({ id: String(id).padStart(32, "0"), text, date, completed, note: "" });

test("private items are named as private wherever they show", () => {
  assert.equal(privateLabel("Dentist"), "Private: Dentist");
});

test("dated private items show on Today only with the setting on and never in Simple view", () => {
  assert.equal(showPrivateOnToday({ onToday: true }), true);
  assert.equal(showPrivateOnToday({ onToday: false }), false);
  assert.equal(showPrivateOnToday({ onToday: true, simpleView: true }), false, "a shared kitchen screen never shows them");
  assert.equal(showPrivateOnToday(), true, "on by default");
});

test("Today's private part follows Today's rules: earlier, today, coming up, and today's done", () => {
  const items = [
    item(1, "Undated"),
    item(2, "Today b", TODAY),
    item(3, "Today a", TODAY),
    item(4, "Earlier", 20261001),
    item(5, "Earlier and done", 20261001, true),
    item(6, "Later", 20261010),
    item(7, "Sooner", 20261004),
    item(8, "Done today", TODAY, true),
  ];
  const view = composePrivateToday(items, TODAY);
  assert.deepEqual(view.today.map((entry) => entry.text), ["Today a", "Today b"]);
  assert.deepEqual(view.earlier.map((entry) => entry.text), ["Earlier"]);
  assert.deepEqual(view.upcoming.map((entry) => entry.text), ["Sooner", "Later"]);
  assert.deepEqual(view.completed.map((entry) => entry.text), ["Done today"]);
  assert.throws(() => composePrivateToday(items, null), TypeError);
  assert.deepEqual(composePrivateToday([], TODAY), { earlier: [], today: [], upcoming: [], completed: [] });
});

test("This week gains each day's private items; open ones from before the week join its first day", () => {
  const days = [{ date: TODAY, items: [{ itemId: "x" }] }, { date: 20261004, items: [] }, { date: 20261005, items: [] }];
  const merged = mergePrivateIntoWeek(days, [
    item(1, "Tomorrow", 20261004),
    item(2, "Today done", TODAY, true),
    item(3, "Today open", TODAY),
    item(4, "From before", 20260920),
    item(5, "Before and done", 20260920, true),
    item(6, "Next month", 20261103),
    item(7, "No date"),
  ]);
  assert.deepEqual(merged.map((day) => day.privateItems.map((entry) => entry.text)), [
    ["From before", "Today open", "Today done"],
    ["Tomorrow"],
    [],
  ]);
  assert.deepEqual(merged[0].items, [{ itemId: "x" }], "Rust's day is kept as it was");
  assert.equal(days[0].privateItems, undefined, "the input is not changed");
  assert.deepEqual(mergePrivateIntoWeek([], [item(1, "x", TODAY)]), []);
});

test("moving IDs are derived one way and differ by direction", async () => {
  const id = "5b".repeat(16);
  const shared = await sharedItemId(id);
  assert.match(shared, /^[a-f0-9]{32}$/);
  assert.equal(await sharedItemId(id), shared, "the same on every retry");
  assert.notEqual(shared, id);
  const copy = await privateCopyId(id);
  assert.notEqual(copy, shared);
  assert.notEqual(await privateCopyId(shared), id, "a round trip never lands on the original");
  await assert.rejects(sharedItemId("nope"), TypeError);
});

test("sharing adds to To do, plans the same date, then deletes the private item; a retry resumes", () => {
  const privateItem = item(1, "Surprise party", 20261010);
  const target = "ab".repeat(16);
  const household = (extra = {}) => ({ items: [{ itemId: target, text: "Surprise party", status: "active", planningDate: null, ...extra }] });
  assert.deepEqual(nextShareStep(privateItem, target, { items: [] }, [privateItem]),
    { log: "household", command: { type: "add", id: target, text: "Surprise party", classification: "need" } });
  assert.deepEqual(nextShareStep(privateItem, target, household(), [privateItem]),
    { log: "household", command: { type: "set-item-planning-date", itemId: target, planningDate: 20261010 } });
  // After a failure here, the retry finds the household item already made.
  assert.deepEqual(nextShareStep(privateItem, target, household({ planningDate: 20261010 }), [privateItem]),
    { log: "private", command: { type: "delete-private-item", itemId: privateItem.id } });
  assert.equal(nextShareStep(privateItem, target, household({ planningDate: 20261010 }), []), null);
  // Someone archived it meanwhile: it still counts as shared.
  assert.deepEqual(nextShareStep(privateItem, target, household({ status: "archived" }), [privateItem]).command.type, "delete-private-item");
  // No date: no date step.
  assert.equal(nextShareStep(item(1, "x"), target, household(), [item(1, "x")]).command.type, "delete-private-item");
});

test("Make private copies (with its date, and done if it was), then archives; a retry resumes", () => {
  const record = { itemId: "cd".repeat(16), text: "Book flights", status: "completed", planningDate: 20261012, createdBy: "01".repeat(16) };
  const target = "ef".repeat(16);
  const state = (status = "completed") => ({ items: [{ ...record, status }] });
  assert.deepEqual(nextMakePrivateStep(record, target, state(), []),
    { log: "private", command: { type: "add-private-item", itemId: target, text: "Book flights", date: 20261012 } });
  const copy = { id: target, text: "Book flights", date: 20261012, completed: false };
  assert.deepEqual(nextMakePrivateStep(record, target, state(), [copy]),
    { log: "private", command: { type: "complete-private-item", itemId: target } });
  assert.deepEqual(nextMakePrivateStep(record, target, state(), [{ ...copy, completed: true }]),
    { log: "household", command: { type: "archive", itemId: record.itemId } });
  assert.equal(nextMakePrivateStep(record, target, state("archived"), [{ ...copy, completed: true }]), null);
  // A copy the member deleted since is never made again.
  assert.deepEqual(nextMakePrivateStep(record, target, state(), [], true).command.type, "archive");
});

test("only the member who added a household item can make it private", () => {
  const me = "01".repeat(16);
  assert.equal(canMakePrivate({ createdBy: me, status: "active" }, me), true);
  assert.equal(canMakePrivate({ createdBy: "02".repeat(16), status: "active" }, me), false);
  assert.equal(canMakePrivate({ createdBy: me, status: "archived" }, me), false);
  assert.equal(canMakePrivate(null, me), false);
  assert.equal(canMakePrivate({ createdBy: me, status: "active" }, null), false);
});

test("the share confirmation names who will see it", () => {
  assert.equal(shareAudience([]), null);
  assert.equal(shareAudience(["Alex"]), "Alex");
  assert.equal(shareAudience(["Alex", "Sam"]), "Alex and Sam");
  assert.equal(shareAudience(["Alex", "Sam", "Jo", "Sam"]), "Alex, Sam and Jo");
});

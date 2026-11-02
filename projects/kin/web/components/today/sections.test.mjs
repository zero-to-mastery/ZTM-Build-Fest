// Today first-use actions must stay helpful without creating extra household state.
// Native DOM stand-in, using the existing native Custom Element conventions.
import assert from "node:assert/strict";
import test from "node:test";
import { installDom, recordEvents } from "../qr-test-dom.mjs";

installDom();
const { TodaySections } = await import("./sections.js");

const setup = () => {
  const host = document.createElement("kin-today");
  host.isDisabled = false;
  return { host, sections: new TodaySections({ host }), events: recordEvents(host) };
};

test("an empty household offers a task and a direct shopping destination", () => {
  const { host, sections, events } = setup();
  const empty = sections.createTodayEmpty({ allDone: false, hasItems: false });
  const add = empty.byText("Add a task for today");
  const shopping = empty.byClass("today-shopping-link");

  assert.match(empty.textContent, /Nothing to do yet/);
  assert.ok(add, "an existing Quick add command remains available");
  assert.equal(shopping?.tagName, "A", "Shopping uses a native link");
  assert.equal(shopping.href, "#lists/shopping", "the link opens the existing shopping route");
  add.click();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "kin:open-quick-add");
  assert.equal(events[0].detail.opener, add);
  assert.equal(host.isDisabled, false);
});

test("populated households reuse the Shopping link in the empty-state explanation", () => {
  const { sections } = setup();
  const empty = sections.createTodayEmpty({ allDone: false, hasItems: true });
  const links = [...empty.all()].filter((node) => node.tagName === "A");
  assert.equal(links.length, 2, "To do and Shopping remain in the existing explanation");
  assert.deepEqual(links.map((node) => node.href), ["#lists/todo", "#lists/shopping"]);
  assert.equal(empty.byClass("today-shopping-link"), null, "do not duplicate the Shopping action");
});

test("a completed day does not prompt users to add more work", () => {
  const { sections } = setup();
  const empty = sections.createTodayEmpty({ allDone: true, hasItems: true });
  assert.match(empty.textContent, /Everything planned for today is done/);
  assert.equal(empty.byText("Add a task for today"), null);
  assert.equal(empty.byClass("today-shopping-link"), null);
});

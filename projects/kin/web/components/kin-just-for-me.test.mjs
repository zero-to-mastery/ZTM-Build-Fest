import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.isConnected = true;
  }
  append(...children) {
    for (const value of children) {
      const child = typeof value === "string" ? Object.assign(new ElementStub("#text"), { textContent: value }) : value;
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  contains(node) { return node ? node === this || descendants(this).includes(node) : false; }
  focus() { globalThis.document.activeElement = this; }
  showModal() { this.open = true; }
  close(value) { this.open = false; this.returnValue = value; this.listeners.close?.(); }
  querySelectorAll(selector) {
    if (selector === "[data-focus-key]") return descendants(this).filter((node) => node.dataset.focusKey);
    const className = selector.slice(1);
    return descendants(this).filter((node) => String(node.className ?? "").split(" ").includes(className));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
globalThis.HTMLElement = class extends ElementStub {};
const components = {};
globalThis.customElements = { get: (name) => components[name], define: (name, component) => { components[name] = component; } };
globalThis.document = { activeElement: null, body: new ElementStub("body"), createElement: (tagName) => new ElementStub(tagName) };
await import("./kin-just-for-me.js");
const KinJustForMe = components["kin-just-for-me"];

const CONFLICT = "That changed meanwhile, maybe on another of your devices. Have a look and try again.";

/** Applies `command` the way Rust does, refusing one that changes nothing
 * (private_items.rs check_command, shown as a conflict); false when refused. */
function apply(state, command) {
  const item = state.items.find((entry) => entry.id === command.itemId);
  const change = (fields) => { Object.assign(item, fields); return true; };
  switch (command.type) {
    case "add-private-item": state.items.push({ id: command.itemId, text: command.text, date: command.date, completed: false, addedAt: 99 }); return true;
    case "delete-private-item":
      if (!item) return false;
      state.items = state.items.filter((entry) => entry !== item);
      state.deleted.set(item.id, item);
      return true;
    case "restore-private-item":
      if (item || !state.deleted.has(command.itemId)) return false;
      state.items.push(state.deleted.get(command.itemId));
      state.deleted.delete(command.itemId);
      return true;
    case "complete-private-item": return Boolean(item && !item.completed) && change({ completed: true });
    case "reopen-private-item": return Boolean(item?.completed) && change({ completed: false });
    case "edit-private-item": return Boolean(item && item.text !== command.text) && change({ text: command.text });
    case "date-private-item": return Boolean(item && (item.date ?? null) !== command.date) && change({ date: command.date });
    case "set-private-item-note": return Boolean(item && (item.note ?? "") !== command.note) && change({ note: command.note });
    case "set-private-items-on-today":
      if (command.on === state.onToday) return false;
      state.onToday = command.on;
      return true;
    default: return false;
  }
}

/** A controller whose saves finish only when the test says so, and which
 * redraws the list after each one as PrivateItemsController.run does. */
function slowController(element, start) {
  const runs = [];
  const state = { items: start.map((item) => ({ ...item })), deleted: new Map(), onToday: true };
  return {
    runs,
    async run(command) {
      let finish;
      const saved = new Promise((done) => { finish = done; });
      runs.push({ command, finish });
      await saved;
      if (!apply(state, command)) throw Object.assign(new Error("refused"), { userMessage: CONFLICT });
      element.update({ items: state.items.map((item) => ({ ...item })), onToday: state.onToday });
    },
    shareAudience: () => "Sam",
    async share(item) { runs.push({ command: { type: "share", itemId: item.id } }); return { message: "Shared." }; },
  };
}

const settle = () => new Promise((done) => setImmediate(done));
const byKey = (element, key) => element.findByKey(key);

function justForMe(items) {
  const element = new KinJustForMe();
  element.controller = slowController(element, items);
  element.connectedCallback();
  element.update({ availability: { state: "ready" }, items, today: 20261026 });
  return element;
}

const items = () => [
  { id: "a", text: "Call the dentist", completed: false, addedAt: 1 },
  { id: "b", text: "Birthday card", completed: false, addedAt: 2 },
  { id: "c", text: "Book the vet", completed: false, addedAt: 3 },
];

test("a tap made while a change is saving runs after it, not never (#792)", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  const first = byKey(element, "a:done");
  first.checked = true;
  first.listeners.change();
  const second = byKey(element, "b:done");
  second.checked = true;
  second.listeners.change();
  await settle();
  assert.deepEqual(runs.map((run) => run.command), [{ type: "complete-private-item", itemId: "a" }], "one change at a time");

  runs[0].finish();
  await settle();
  assert.equal(element.feedbackText.textContent, "Done: “Call the dentist”.");
  assert.deepEqual(runs.map((run) => run.command.itemId), ["a", "b"], "the second tap runs once the first is saved");
  runs[1].finish();
  await settle();
  assert.equal(element.feedbackText.textContent, "Done: “Birthday card”.");
});

test("Enter twice while saving adds the item once, and a later add still goes through", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  element.input.value = "Gift for Sam";
  element.form.listeners.submit({ preventDefault() {} });
  element.form.listeners.submit({ preventDefault() {} });
  assert.equal(element.input.value, "", "the words move into the change straight away");
  element.input.value = "Book the vet";
  element.form.listeners.submit({ preventDefault() {} });
  await settle();
  runs[0].finish();
  await settle();
  runs[1].finish();
  await settle();
  assert.deepEqual(runs.map((run) => run.command.text), ["Gift for Sam", "Book the vet"]);
  assert.equal(element.feedbackText.textContent, "Added “Book the vet”. Only you can see it.");
});

test("an add that can't be saved gives its words back when the field is still empty", async () => {
  const element = justForMe(items());
  element.controller.run = async () => { throw Object.assign(new Error("no"), { userMessage: "Kin couldn't save that private change. Try again." }); };
  element.input.value = "Gift for Sam";
  element.dateInput.value = "2026-11-02";
  await element.add();
  assert.equal(element.input.value, "Gift for Sam");
  assert.equal(element.dateInput.value, "2026-11-02");
  assert.equal(element.feedbackText.textContent, "Kin couldn't save that private change. Try again.");
});

test("a delete offers Undo and focuses it, unless a change was tapped behind it", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  const removing = element.remove(items()[0]);
  await settle();
  runs[0].finish();
  await removing;
  assert.equal(element.undoButton.hidden, false, "the delete offers Undo");
  assert.equal(document.activeElement, element.undoButton);

  const again = element.remove(items()[1]);
  const box = byKey(element, "c:done");
  box.focus();
  box.checked = true;
  box.listeners.change();
  await settle();
  runs[1].finish();
  await again;
  await settle();
  assert.deepEqual(runs.map((run) => run.command.type), ["delete-private-item", "delete-private-item", "complete-private-item"]);
  assert.equal(element.undoButton.hidden, true, "the change tapped behind the delete ends its Undo");
  assert.equal(document.activeElement.dataset.focusKey, "c:done", "focus stays where the last tap was");
  runs[2].finish();
  await settle();
});

test("sharing confirmed while a change is saving shares after it", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  const box = byKey(element, "a:done");
  box.checked = true;
  box.listeners.change();
  element.openShare(items()[1], null);
  assert.equal(element.shareDialog.open, true, "Share opens while a change saves");
  element.shareDialog.close("share");
  await settle();
  assert.equal(runs.length, 1);
  runs[0].finish();
  await settle();
  assert.deepEqual(runs.map((run) => run.command.type), ["complete-private-item", "share"]);
  assert.equal(element.feedbackText.textContent, "Shared.");
});

/** Lets every waiting change save, in turn. */
const finishAll = async (runs) => {
  await settle();
  for (let index = 0; index < runs.length; index += 1) {
    runs[index].finish();
    await settle();
  }
};

test("a second tap on Delete or Undo while it saves does nothing more, not a conflict", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  const remove = byKey(element, "a:delete");
  remove.listeners.click();
  remove.listeners.click();
  await finishAll(runs);
  assert.deepEqual(runs.map((run) => run.command.type), ["delete-private-item"]);
  assert.equal(element.feedbackText.textContent, "Deleted “Call the dentist”.");
  assert.equal(element.undoButton.hidden, false);

  element.undoButton.listeners.click();
  element.undoButton.listeners.click();
  await finishAll(runs);
  assert.deepEqual(runs.map((run) => run.command.type), ["delete-private-item", "restore-private-item"]);
  assert.equal(element.feedbackText.textContent, "Restored “Call the dentist”.");
});

test("a second tap on Save, Save date or Save note while it saves does nothing more", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  byKey(element, "a:text").value = "Call the dentist at 9";
  byKey(element, "a:save-text").listeners.click();
  byKey(element, "a:save-text").listeners.click();
  byKey(element, "b:date").value = "2026-11-02";
  byKey(element, "b:save-date").listeners.click();
  byKey(element, "b:save-date").listeners.click();
  byKey(element, "c:note").value = "Ask about Friday";
  byKey(element, "c:save-note").listeners.click();
  byKey(element, "c:save-note").listeners.click();
  await finishAll(runs);
  assert.deepEqual(runs.map((run) => run.command.type), ["edit-private-item", "date-private-item", "set-private-item-note"]);
  assert.equal(element.feedbackText.textContent, "Note saved.");
});

test("a tick or setting waiting its turn stays shown as tapped when the list redraws", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  const first = byKey(element, "a:done");
  first.checked = true;
  first.listeners.change();
  const second = byKey(element, "b:done");
  second.checked = true;
  second.listeners.change();
  element.settingBox.checked = false;
  element.settingBox.listeners.change();
  await settle();
  runs[0].finish();
  await settle();
  assert.equal(runs.length, 2, "the list redrew while the tick on b waits");
  assert.equal(byKey(element, "b:done").checked, true, "b still shows ticked");
  assert.equal(element.settingBox.checked, false, "the setting still shows off");
  await finishAll(runs);
  assert.deepEqual(runs.map((run) => run.command.type), ["complete-private-item", "complete-private-item", "set-private-items-on-today"]);
  assert.equal(element.feedbackText.textContent, "Your private things stay in Just for me only.");
});

test("when two waiting adds both fail, the second one's words are named, not lost", async () => {
  const element = justForMe(items());
  const runs = [];
  element.controller.run = (command) => new Promise((_, fail) => {
    runs.push({ command, finish: () => fail(Object.assign(new Error("no"), { userMessage: "Kin couldn't save that private change. Try again." })) });
  });
  element.input.value = "Gift for Sam";
  const first = element.add();
  element.input.value = "Ring Gran";
  const second = element.add();
  await finishAll(runs);
  await Promise.all([first, second]);
  assert.equal(element.input.value, "Gift for Sam", "the first add's words come back to the empty field");
  assert.equal(element.feedbackText.textContent, "“Ring Gran” wasn't added. Kin couldn't save that private change. Try again.");
});

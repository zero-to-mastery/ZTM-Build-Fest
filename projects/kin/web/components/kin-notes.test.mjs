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
  get options() { return this.children.filter((child) => child.tagName === "option"); }
  append(...children) {
    for (const value of children) {
      const child = typeof value === "string" ? Object.assign(new ElementStub("#text"), { textContent: value }) : value;
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  dispatchEvent(event) { this.events ??= []; this.events.push(event); return true; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  contains(node) { return node ? descendants(this).includes(node) : false; }
  focus() { globalThis.document.activeElement = this; }
  matches(selector) { return selector === ":disabled" ? this.disabled : false; }
  querySelectorAll(selector) {
    const tags = selector.split(",");
    return descendants(this).filter((node) => tags.includes(node.tagName)
      || (selector === "[data-focus-id]" && node.dataset.focusId));
  }
}

const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
globalThis.HTMLElement = class extends ElementStub {};
globalThis.CustomEvent ??= class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
const components = {};
globalThis.customElements = { define: (name, component) => { components[name] = component; } };
globalThis.document = { activeElement: null, body: new ElementStub("body"), createElement: (tagName) => new ElementStub(tagName) };
await import("./kin-notes.js");
const KinNotes = components["kin-notes"];

const maintenanceForm = (notes) => descendants(notes)
  .filter((node) => node.tagName === "form")
  .at(-1);

test("maintenance drafts survive renders and clear only after their matching save", () => {
  const notes = new KinNotes();
  notes.referenceRecords = [{ recordId: "record-1", title: "Furnace", areaId: null, fields: [] }];
  notes.render();

  let form = maintenanceForm(notes);
  let [summary, performed, nextOn, routine] = form.children;
  summary.value = "Changed filter"; summary.listeners.input();
  performed.value = "2026-10-15"; performed.listeners.input();
  nextOn.value = "2027-04-15"; nextOn.listeners.input();

  notes.disabled = true;
  notes.disabled = false;
  form = maintenanceForm(notes);
  [summary, performed, nextOn, routine] = form.children;
  assert.deepEqual([summary.value, performed.value, nextOn.value, routine.value],
    ["Changed filter", "2026-10-15", "2027-04-15", ""]);

  form.listeners.submit({ preventDefault() {} });
  const detail = notes.events.at(-1).detail;
  assert.equal(notes.events.at(-1).type, "kin:save-maintenance-event");
  assert.deepEqual({ ...detail, maintenanceId: "generated" }, {
    maintenanceId: "generated",
    recordId: "record-1",
    performedOn: 20261015,
    summary: "Changed filter",
    nextOn: 20270415,
    routineId: null,
  });

  notes.updateMaintenanceDraft("record-1", { summary: "Newer edit", performed: "2026-10-15", nextOn: "", routineId: "" });
  notes.clearMaintenanceDraft(detail);
  assert.equal(notes.maintenanceDrafts.get("record-1").summary, "Newer edit", "a delayed completion cannot clear newer text");

  notes.updateMaintenanceDraft("record-1", { summary: "Changed filter", performed: "2026-10-15", nextOn: "2027-04-15", routineId: "" });
  notes.clearMaintenanceDraft(detail);
  notes.render();
  assert.equal(notes.maintenanceDrafts.has("record-1"), false);
  assert.deepEqual(maintenanceForm(notes).children.slice(0, 4).map((control) => control.value), ["", "", "", ""]);
});

test("a fresh Notes component contains no private editor drafts", () => {
  const prior = new KinNotes();
  prior.editor.title = "Private Note draft";
  prior.referenceEditor = { title: "Private Reference draft" };
  prior.updateMaintenanceDraft("record-1", { summary: "Private Maintenance draft" });

  const replacement = new KinNotes();
  assert.equal(replacement.editor.title, "");
  assert.equal(replacement.referenceEditor, null);
  assert.equal(replacement.maintenanceDrafts.size, 0);
});

test("a maintenance draft is discarded when its Reference is archived elsewhere", () => {
  const notes = new KinNotes();
  notes.referenceRecords = [{ recordId: "record-1", title: "Furnace", areaId: null, fields: [] }];
  notes.updateMaintenanceDraft("record-1", { summary: "Private Maintenance draft" });
  notes.referenceRecords = [{ recordId: "record-1", title: "Furnace", areaId: null, fields: [], archived: true }];

  notes.render();
  assert.equal(notes.maintenanceDrafts.size, 0);
});

test("ending busy does not steal focus moved from Notes to header search", () => {
  const notes = new KinNotes();
  notes.render();
  const title = notes.querySelectorAll("[data-focus-id]")
    .find((node) => node.dataset.focusId === "title");
  const search = new ElementStub("a");

  notes.pendingFocus = title.dataset.focusId;
  search.focus();
  notes.settleDeferredFocus();

  assert.equal(document.activeElement, search);
  assert.equal(notes.pendingFocus, null);
});

test("a note with no area is shown in a No area group", () => {
  const notes = new KinNotes();
  notes.areas = [{ areaId: "area-1", name: "Kitchen", archived: false }];
  notes.notes = [
    { noteId: "n2", title: "Loose", body: "kept", areaId: null, archived: false },
    { noteId: "n1", title: "Wifi", body: "hall", areaId: "area-1", archived: false },
    { noteId: "n3", title: "Hidden", body: "gone", areaId: null, archived: true },
  ];
  const text = (node) => node.textContent;
  const groups = descendants(notes).filter((node) => node.className === "note-group").map(text);
  assert.deepEqual(groups, ["Kitchen", "No area"]);
  const rows = descendants(notes).filter((node) => node.className === "note-row");
  assert.deepEqual(rows.map((row) => row.dataset.noteId), ["n1", "n2"]);
  assert.deepEqual(rows.map((row) => row.children.find((child) => child.tagName === "h4").textContent), ["Wifi", "Loose"]);
});

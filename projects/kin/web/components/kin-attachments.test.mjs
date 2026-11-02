import assert from "node:assert/strict";
import test from "node:test";
import { clearAttachmentProgress, setAttachmentProgress } from "../attachments/attachment-progress.js";

// Minimal DOM stubs so the component renders under node:test without a browser.
class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {} };
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.isConnected = true;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get childElementCount() { return this.children.length; }
  get className() { return this.attributes.class ?? ""; }
  set className(value) { this.attributes.class = value; }
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.find?.(predicate);
      if (nested) return nested;
    }
    return null;
  }
  all(predicate, out = []) {
    for (const child of this.children) { if (predicate(child)) out.push(child); child.all?.(predicate, out); }
    return out;
  }
}

globalThis.HTMLElement = class extends ElementStub {
  dispatchEvent(event) { this.dispatched ??= []; this.dispatched.push(event); return true; }
};
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; this.bubbles = init?.bubbles; this.composed = init?.composed; } };
globalThis.customElements = { define: (name, component) => { if (name === "kin-attachments") globalThis.KinAttachmentsUnderTest = component; } };
globalThis.document = { createElement: (tagName) => new ElementStub(tagName) };
await import("./kin-attachments.js");
const KinAttachments = globalThis.KinAttachmentsUnderTest;

const ITEM = "a".repeat(32);
const parent = { kind: "item", id: ITEM, label: "Fridge shelf photo" };

function mount(mode, records = []) {
  const element = new KinAttachments();
  element.mode = mode;
  element.parentRecord = parent;
  element.attachments = records;
  element.connectedCallback();
  return element;
}

test.beforeEach(() => clearAttachmentProgress());

test("item rows render no file input and no duplicate attach control", () => {
  const element = mount("tiles");
  assert.equal(element.children.length, 0, "nothing renders until there is progress or a saved file");
  assert.equal(element.find((node) => node.tagName === "input"), null);
  assert.equal(element.find((node) => node.className === "attachment-add"), null);
});

test("notes keep a real button that asks the app to open its picker", () => {
  const element = mount("full");
  const button = element.find((node) => node.className === "attachment-add");
  assert.equal(button.tagName, "button");
  assert.equal(button.type, "button");
  assert.equal(button.getAttribute("aria-label"), "Add a photo or file to Fridge shelf photo");
  assert.equal(element.find((node) => node.tagName === "input"), null, "the component owns no file input of its own");
  button.listeners.click();
  const [event] = element.dispatched;
  assert.equal(event.type, "kin:pick-attachment");
  assert.deepEqual({ ...event.detail, opener: undefined }, { parentKind: "item", parentId: ITEM, label: "Fridge shelf photo", opener: undefined });
  assert.equal(event.detail.opener, button);
  assert.ok(event.bubbles && event.composed);
});

test("read-only parents expose no attach control", () => {
  const element = new KinAttachments();
  element.parentRecord = { ...parent, readonly: true };
  element.attachments = [];
  element.connectedCallback();
  assert.equal(element.find((node) => node.className === "attachment-add"), null);
});

test("capture progress for this parent survives a fresh render and follows updates", () => {
  setAttachmentProgress("item", ITEM, { phase: "saving", message: "Saving securely…" });
  const element = mount("tiles");
  const status = () => element.find((node) => node.className === "attachment-status");
  assert.equal(status().textContent, "Saving securely…");
  assert.equal(status().getAttribute("role"), "status");
  assert.equal(status().dataset.phase, "saving");

  setAttachmentProgress("item", ITEM, { phase: "error", message: "Kin can't attach this kind of file (text/plain). Choose a JPEG, PNG or WebP photo, or a PDF." });
  assert.equal(status().getAttribute("role"), "alert", "errors are announced assertively");
  assert.equal(status().dataset.phase, "error");
  assert.match(status().textContent, /text\/plain/);

  setAttachmentProgress("item", "b".repeat(32), { phase: "saved", message: "other.png is saved on this device." });
  assert.match(status().textContent, /text\/plain/, "another parent's progress does not leak into this row");

  clearAttachmentProgress("item", ITEM);
  assert.equal(status(), null, "a cleared status disappears");
  element.disconnectedCallback();
  setAttachmentProgress("item", ITEM, { phase: "saved", message: "late" });
  assert.equal(status(), null, "a disconnected row stops listening");
});

test("saved files render as tiles under their own parent only, with readable state", () => {
  const mine = { attachmentId: "c".repeat(32), parentKind: "item", parentId: ITEM, name: "fridge-shelf.jpg", size: 2048, type: "image/jpeg", state: "queued" };
  const theirs = { ...mine, attachmentId: "d".repeat(32), parentId: "b".repeat(32), name: "other.jpg" };
  const element = mount("tiles", [mine, theirs]);
  const tiles = element.all((node) => typeof node.className === "string" && node.className.startsWith("attachment-tile "));
  assert.equal(tiles.length, 1);
  const names = element.all((node) => node.className === "attachment-name").map((node) => node.textContent);
  assert.deepEqual(names, ["fridge-shelf.jpg"]);
  const meta = element.find((node) => node.className === "attachment-meta").textContent;
  assert.equal(meta, "Photo · 2 KB · Saved here, waiting to sync");
  assert.ok(element.find((node) => node.getAttribute("aria-label") === "View fridge-shelf.jpg"), "image tiles open the viewer");
  assert.ok(element.find((node) => node.getAttribute("aria-label") === "Remove fridge-shelf.jpg"));
});

test("compact rows render one small control per attachment with its name and state for assistive technology", () => {
  const photo = { attachmentId: "e".repeat(32), parentKind: "item", parentId: ITEM, name: "fridge-shelf.jpg", size: 2048, type: "image/jpeg", state: "queued" };
  const document_ = { ...photo, attachmentId: "f".repeat(32), name: "receipt.pdf", type: "application/pdf", state: "synced" };
  const element = mount("compact", [photo, document_]);
  assert.equal(element.find((node) => node.className === "attachment-add"), null, "the row's own Add photo button is not duplicated");
  assert.equal(element.find((node) => node.className === "attachment-name"), null, "names belong to the detail view's full tiles");
  const strip = element.find((node) => node.className === "attachment-strip");
  assert.equal(strip.children.length, 2);
  const image = element.find((node) => node.className === "attachment-thumb attachment-thumb-small");
  assert.equal(image.getAttribute("aria-label"), "View fridge-shelf.jpg (Photo, Saved here, waiting to sync)");
  image.listeners.click();
  assert.equal(element.dispatched.at(-1).type, "kin:view-attachment");
  const pdf = element.find((node) => node.className === "attachment-icon attachment-icon-small");
  assert.equal(pdf.getAttribute("aria-label"), "Open receipt.pdf (PDF, Synced)");
  pdf.listeners.click();
  assert.equal(element.dispatched.at(-1).type, "kin:open-attachment");
  const empty = mount("compact");
  assert.equal(empty.children.length, 0, "a row without attachments or progress renders nothing");
});

test("Limited and Temporary members are not offered Remove; Adults are", () => {
  const record = { attachmentId: "c".repeat(32), parentKind: "item", parentId: ITEM, name: "receipt.pdf", size: 2048, type: "application/pdf", state: "synced" };
  for (const [memberKind, offered] of [["adult", true], [null, true], ["limited", false], ["temporary", false]]) {
    const element = new KinAttachments();
    element.closest = (selector) => (selector === "kin-app" ? { householdStatus: { memberKind } } : null);
    element.mode = "tiles";
    element.parentRecord = parent;
    element.attachments = [record];
    element.connectedCallback();
    const remove = element.find((node) => node.getAttribute("aria-label") === "Remove receipt.pdf");
    assert.equal(Boolean(remove), offered, String(memberKind));
    assert.ok(element.find((node) => node.getAttribute("aria-label") === "Open receipt.pdf"), "everyone can still open it");
  }
});

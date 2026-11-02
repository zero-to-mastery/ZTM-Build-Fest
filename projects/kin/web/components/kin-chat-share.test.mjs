import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define() {} };
const { noteTitleFrom, oneLine, SHARE_KINDS } = await import("./kin-chat-share.js");
const { ChatShareController } = await import("./app/chat-share.js");

test("a message becomes a one-line item, and a note title is its first line", () => {
  assert.equal(oneLine("  Milk\n\n and   eggs "), "Milk and eggs");
  assert.equal(noteTitleFrom("\n  Boiler code is 4821\nsticks"), "Boiler code is 4821");
  const long = noteTitleFrom("x".repeat(200));
  assert.ok(Array.from(long).length <= 80 && long.endsWith("…"));
  assert.equal(noteTitleFrom("   "), "");
  assert.deepEqual(Object.keys(SHARE_KINDS), ["shopping", "todo", "handoff", "note"]);
});

function controller({ itemSaves = true, handoffSaves = true, noteSaves = true, attachFails = [] } = {}) {
  const calls = [];
  const app = {
    store: {}, engine: {}, vault: { locked: false }, busy: false, attachmentRows: [],
    chatShare: { open(detail) { this.opened = detail; } },
  };
  const ctx = {
    app,
    status: { clearAlert() {} },
    items: { async handleAddItem(event) { calls.push(["item", event.detail]); if (itemSaves) event.detail.composer.clearIfMatches(); else event.detail.composer.showResult("Nope", { kind: "error" }); } },
    conversations: { async saveHandoff(command) { calls.push(["handoff", command]); return handoffSaves; } },
    records: { async saveNote(action, detail, options) { calls.push(["note", action, detail, options]); return noteSaves; } },
    attachments: { async handleAddAttachment(event) {
      calls.push(["attach", event.detail.parentKind, event.detail.parentId, event.detail.file.name]);
      return attachFails.includes(event.detail.file.name) ? { ok: false, message: "Too big." } : { ok: true };
    } },
  };
  return { share: new ChatShareController(ctx), calls, app };
}

const file = (name) => ({ name, size: 3, type: "image/png", load: async () => new Blob(["abc"], { type: "image/png" }) });

test("shopping and to-do items go through the normal add command, with no trace of the message", async () => {
  const { share, calls } = controller();
  const result = await share.save({ kind: "shopping", text: "Milk", files: [] });
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], "item");
  assert.equal(calls[0][1].classification, "shopping");
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["cadence", "classification", "composer", "id", "pinned", "planningDate", "revision", "text"]);
  assert.equal(result.itemId, calls[0][1].id);
  assert.equal((await share.save({ kind: "todo", text: "Fix", files: [] })).ok, true);
  assert.equal(calls[1][1].classification, "need");
});

test("only the chosen files become attachments, and a failed one is named without undoing the record", async () => {
  const { share, calls } = controller({ attachFails: ["b.png"] });
  const none = await share.save({ kind: "todo", text: "Look", files: [] });
  assert.equal(none.ok && calls.filter((call) => call[0] === "attach").length, 0);
  const some = await share.save({ kind: "todo", text: "Look", files: [file("a.png"), file("b.png")] });
  assert.equal(some.ok, true);
  assert.deepEqual(calls.filter((call) => call[0] === "attach").map((call) => call[3]), ["a.png", "b.png"]);
  assert.equal(calls.filter((call) => call[0] === "attach")[0][1], "item");
  assert.equal(some.problems.length, 1);
  assert.match(some.problems[0], /b\.png.*Too big/u);
});

test("a note keeps the notes editor alone, and attaches to the new note", async () => {
  const { share, calls } = controller();
  const result = await share.save({ kind: "note", title: "Code", body: "4821", files: [file("a.png")] });
  assert.equal(result.ok, true);
  const note = calls.find((call) => call[0] === "note");
  assert.deepEqual(note[3], { fromChat: true });
  assert.equal(note[2].areaId, null);
  assert.equal(calls.find((call) => call[0] === "attach")[1], "note");
  assert.equal(calls.find((call) => call[0] === "attach")[2], note[2].noteId);
});

test("a handoff carries text only", async () => {
  const { share, calls } = controller();
  const result = await share.save({ kind: "handoff", text: "Heads up", files: [file("a.png")] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["handoff", { type: "add-handoff", text: "Heads up" }]]);
});

test("a save that fails says so and copies no files", async () => {
  const failing = controller({ itemSaves: false });
  const item = await failing.share.save({ kind: "shopping", text: "Milk", files: [file("a.png")] });
  assert.equal(item.ok, false);
  assert.equal(item.message, "Nope");
  assert.equal(failing.calls.some((call) => call[0] === "attach"), false);
  assert.equal((await controller({ noteSaves: false }).share.save({ kind: "note", title: "t", body: "", files: [] })).ok, false);
  assert.equal((await controller({ handoffSaves: false }).share.save({ kind: "handoff", text: "x", files: [] })).ok, false);
  const busy = controller();
  busy.app.busy = true;
  assert.equal((await busy.share.save({ kind: "handoff", text: "x", files: [] })).ok, false);
  const locked = controller();
  locked.app.vault.locked = true;
  assert.equal((await locked.share.save({ kind: "handoff", text: "x", files: [] })).ok, false);
});

test("a failed item leaves no half-saved capture, and an existing one blocks the share", async () => {
  const failing = controller({ itemSaves: false });
  await failing.share.save({ kind: "todo", text: "x", files: [] });
  assert.equal(failing.app.pendingCapture ?? null, null);
  const blocked = controller();
  blocked.app.pendingCapture = { draft: {} };
  const result = await blocked.share.save({ kind: "todo", text: "x", files: [] });
  assert.equal(result.ok, false);
  assert.equal(blocked.calls.length, 0);
});

test("a note title also fits 256 bytes", () => {
  const title = noteTitleFrom("😀".repeat(79));
  assert.ok(new TextEncoder().encode(title).length <= 256, title.length);
  assert.ok(title.length > 10);
});

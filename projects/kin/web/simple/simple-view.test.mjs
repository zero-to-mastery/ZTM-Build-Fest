import assert from "node:assert/strict";
import test from "node:test";
import { buildCards, pictureFor } from "./simple-view.js";

const id = (n) => n.toString(16).padStart(2, "0").repeat(16);

test("the picture is the emoji, else the first present image by attach order, else none", () => {
  const bindings = [
    { attachmentId: id(1), parentKind: "item", parentId: id(9), removed: false },
    { attachmentId: id(2), parentKind: "item", parentId: id(9), removed: true },
    { attachmentId: id(3), parentKind: "item", parentId: id(9), removed: false },
    { attachmentId: id(4), parentKind: "item", parentId: id(9), removed: false },
  ];
  const rows = [
    { attachmentId: id(1), parentKind: "item", parentId: id(9), type: "application/pdf", state: "ready" },
    { attachmentId: id(2), parentKind: "item", parentId: id(9), type: "image/png", state: "ready" },
    { attachmentId: id(3), parentKind: "item", parentId: id(9), type: null, state: "download-needed" },
    { attachmentId: id(4), parentKind: "item", parentId: id(9), type: "image/jpeg", state: "ready" },
  ];
  assert.deepEqual(pictureFor(id(9), { emojis: new Map([[id(9), "🧦"]]), bindings, rows }), { emoji: "🧦" });
  assert.equal(pictureFor(id(9), { bindings, rows }).attachment.attachmentId, id(4), "removed, non-image and undownloaded ones are skipped");
  assert.equal(pictureFor(id(8), { bindings, rows }), null);
});

test("cards follow Rust's order and an item done this session keeps its place with Undo", () => {
  const state = {
    items: [{ itemId: id(1), text: "Pack bag", status: "completed" }, { itemId: id(2), text: "Tidy room", status: "active" }],
    routines: [{ routineId: id(5), text: "Feed the fish" }],
    attachments: [],
  };
  const things = [{ kind: "item", itemId: id(2) }, { kind: "routine", routineId: id(5), occurrenceKey: 20261003, done: true }];
  const done = new Map([[`item:${id(1)}`, { id: id(1), index: 0 }]]);
  const cards = buildCards(things, { state, emojis: new Map([[id(2), "🧹"]]), doneThisSession: done });
  assert.deepEqual(cards.map((card) => [card.kind, card.text, card.done]), [
    ["item", "Pack bag", true],
    ["item", "Tidy room", false],
    ["routine", "Feed the fish", true],
  ]);
  assert.deepEqual(cards[1].picture, { emoji: "🧹" });
  assert.equal(cards[2].occurrenceKey, 20261003);
  // Reopened elsewhere: Rust lists it again and the session entry adds nothing twice.
  const reopened = { ...state, items: [{ ...state.items[0], status: "active" }, state.items[1]] };
  assert.equal(buildCards([{ kind: "item", itemId: id(1) }, ...things], { state: reopened, emojis: new Map(), doneThisSession: done }).length, 3);
});

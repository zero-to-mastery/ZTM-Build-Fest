// Issue #171: the packet's entity ID is the command's own entity, never a
// reference it carries (a note's area, a maintenance entry's routine). Pure
// JS: no WASM needed. engine-entity-id.test.mjs covers the replayed result.
import assert from "node:assert/strict";
import test from "node:test";
import { commandEntityId } from "./kin-engine.js";

const OWN = "a".repeat(32);
const AREA = "b".repeat(32);
const ROUTINE = "c".repeat(32);
const RECORD = "d".repeat(32);
const ITEM = "e".repeat(32);
const PARENT = "f".repeat(32);
const FALLBACK = "1".repeat(32);

// Every command type the engine encodes with an entity ID, with each one's
// own field set to OWN and every reference it can carry set to something else.
const CASES = [
  ["add", { itemId: OWN }],
  ["complete", { itemId: OWN }],
  ["reopen", { itemId: OWN }],
  ["archive", { itemId: OWN }],
  ["add-handoff", { handoffId: OWN }],
  ["acknowledge-handoff", { handoffId: OWN }],
  ["archive-handoff", { handoffId: OWN }],
  ["add-talk", { talkId: OWN }],
  ["resolve-talk", { talkId: OWN }],
  ["reopen-talk", { talkId: OWN }],
  ["archive-talk", { talkId: OWN }],
  ["create-routine", { routineId: OWN }],
  ["complete-routine-occurrence", { routineId: OWN }],
  ["reopen-routine-occurrence", { routineId: OWN }],
  ["archive-routine", { routineId: OWN }],
  ["create-area", { areaId: OWN }],
  ["rename-area", { areaId: OWN }],
  ["archive-area", { areaId: OWN }],
  ["change-item-area", { itemId: OWN, areaId: AREA }],
  ["create-note", { noteId: OWN, areaId: AREA }],
  ["update-note", { noteId: OWN, areaId: AREA }],
  ["archive-note", { noteId: OWN }],
  ["add-item-step", { stepId: OWN, itemId: ITEM }],
  ["complete-item-step", { stepId: OWN, itemId: ITEM }],
  ["reopen-item-step", { stepId: OWN, itemId: ITEM }],
  ["archive-item-step", { stepId: OWN, itemId: ITEM }],
  ["set-item-planning-date", { itemId: OWN }],
  ["pin", { targetId: OWN }],
  ["unpin", { targetId: OWN }],
  ["save-playbook", { playbookId: OWN }],
  ["archive-playbook", { playbookId: OWN }],
  ["save-reference-record", { recordId: OWN, areaId: AREA }],
  ["archive-reference-record", { recordId: OWN }],
  ["save-maintenance-event", { maintenanceId: OWN, recordId: RECORD, routineId: ROUTINE }],
  ["archive-maintenance-event", { maintenanceId: OWN }],
  ["bind-attachment", { attachmentId: OWN, parentId: PARENT }],
  ["remove-attachment", { attachmentId: OWN }],
  ["change-responsibility", { targetId: OWN, itemId: ITEM, routineId: ROUTINE }],
  ["nickname-device", { targetDeviceId: OWN }],
  ["post-chat-message", { messageId: OWN }],
  ["edit-chat-message", { messageId: OWN }],
  ["delete-chat-message", { messageId: OWN }],
];

test("each command type carries its own entity ID, never a reference it holds", () => {
  for (const [type, fields] of CASES) {
    assert.equal(commandEntityId({ type, ...fields }), OWN, type);
  }
});

test("the reported cases: a note or reference in an area, maintenance linked to a routine", () => {
  assert.equal(commandEntityId({ type: "create-note", noteId: OWN, id: OWN, areaId: AREA }), OWN);
  assert.equal(commandEntityId({ type: "update-note", noteId: OWN, id: OWN, areaId: AREA }), OWN);
  assert.equal(commandEntityId({ type: "save-reference-record", recordId: OWN, id: OWN, areaId: AREA }), OWN);
  assert.equal(
    commandEntityId({ type: "save-maintenance-event", maintenanceId: OWN, id: OWN, recordId: RECORD, routineId: ROUTINE }),
    OWN,
  );
});

test("without its own field, a command falls back to id, then the caller's entityId", () => {
  // Callers such as capture ("add") and attachments send only `id`.
  assert.equal(commandEntityId({ type: "add", id: OWN }), OWN);
  assert.equal(commandEntityId({ type: "bind-attachment", id: OWN, parentId: PARENT }), OWN);
  assert.equal(commandEntityId({ type: "change-responsibility", id: OWN, routineId: ROUTINE }), OWN);
  // A new note with an area but no ID yet takes the fresh fallback, not the area.
  assert.equal(commandEntityId({ type: "create-note", areaId: AREA }, { entityId: FALLBACK }), FALLBACK);
  assert.equal(commandEntityId({ type: "create-area", areaId: null }, { entityId: FALLBACK }), FALLBACK);
});

test("an unknown command type is refused", () => {
  for (const type of ["nope", "constructor", "toString", "__proto__", "hasOwnProperty"])
    assert.throws(() => commandEntityId({ type, id: OWN }), (error) => error.code === 2, type);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PLAYBOOK_ENTRIES,
  MAX_REFERENCE_FIELDS,
  validatePlaybook,
  validateReferenceRecord,
} from "./household-validation.js";

const reference = (title = "Home", fields = [{ fieldId: "a", label: "Network", value: "Home" }]) =>
  validateReferenceRecord(title, fields);

test("Reference Record validator mirrors UTF-8 byte, count, and control limits", () => {
  assert.equal(reference("A".repeat(128)).valid, true);
  assert.equal(reference("界".repeat(42)).valid, true);
  assert.equal(reference("界".repeat(43)).errors.title, "This title is too long.");
  assert.equal(reference("Home", [{ fieldId: "a", label: "", value: "ok" }]).errors.fields[0].label, "Field labels can't be empty.");
  assert.equal(reference("Home", [{ fieldId: "a", label: "L".repeat(65), value: "ok" }]).errors.fields[0].label, "This field label is too long.");
  assert.equal(reference("Home", [{ fieldId: "a", label: "L", value: "V".repeat(1025) }]).errors.fields[0].value, "This field value is too long.");
  assert.match(reference("Home", Array.from({ length: MAX_REFERENCE_FIELDS + 1 }, (_, i) => ({ fieldId: String(i), label: "L", value: "V" }))).errors.count, /16/);
  assert.equal(reference("Home\nTitle").errors.title, "This title can't contain control characters.");
  assert.equal(reference("Home", [{ fieldId: "a", label: "L", value: "ok\u0001" }]).errors.fields[0].value, "Field values can contain line breaks and tabs, but no other control characters.");
});

test("Playbook validator uses the same trimmed UTF-8 rules for create and edit", () => {
  assert.equal(validatePlaybook("T".repeat(128), ["Step"]).valid, true);
  assert.equal(validatePlaybook("界".repeat(43), ["Step"]).errors.title, "This checklist name is too long.");
  assert.equal(validatePlaybook("  Weekly reset  ", ["  Check filter  "]).entries[0], "Check filter");
  assert.equal(validatePlaybook("Plan", [""]).errors.entries[0], "Checklist steps can't be empty.");
  assert.equal(validatePlaybook("Plan", ["S".repeat(257)]).errors.entries[0], "This step is too long.");
  assert.match(validatePlaybook("Plan", Array.from({ length: MAX_PLAYBOOK_ENTRIES + 1 }, () => "Step")).errors.count, /16/);
  assert.equal(validatePlaybook("Plan\nTitle", ["Step"]).errors.title, "This checklist name can't contain control characters.");
  const edit = validatePlaybook("Edited title", ["Changed later"]);
  const create = validatePlaybook("Edited title", ["Changed later"]);
  assert.deepEqual(edit, create);
});

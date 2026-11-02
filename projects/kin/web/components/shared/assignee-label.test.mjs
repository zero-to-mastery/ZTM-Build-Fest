import assert from "node:assert/strict";
import test from "node:test";
import { assigneeLabel } from "./assignee-label.js";

const me = "a".repeat(32), kid = "b".repeat(32), sam = "c".repeat(32), gone = "d".repeat(32);

test("assignees are You, a preferred name, or a numbered member — never 'adult'", () => {
  const people = { memberId: me, memberIds: [me, kid, sam], names: new Map([[sam, "Sam"]]) };
  assert.equal(assigneeLabel(null, people), "Unassigned");
  assert.equal(assigneeLabel(me, people), "You");
  assert.equal(assigneeLabel(sam, people), "Sam");
  assert.equal(assigneeLabel(kid, people), "Household member 1");
  assert.equal(assigneeLabel(gone, people), "A former household member");
  assert.equal(assigneeLabel(kid, { ...people, names: new Map([[kid, "  you "]]) }), "Household member 1", "a name posing as You isn't shown");
  assert.equal(assigneeLabel(kid, { memberId: me }), "A former household member", "no member list");
});

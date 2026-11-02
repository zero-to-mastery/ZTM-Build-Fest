// How an assignee is named (#344): "You", the member's preferred name
// (v1.3.0), else "Household member N" among the other current members, else
// "A former household member". Never "Household adult N": children can be
// assigned things too. A preferred name that would pass for "You" isn't
// shown (misleadingMemberName). Presentation only.
import { misleadingMemberName } from "../household/member-labels.js";

/** `context` is a responsibility context: { memberId, memberIds, names }. */
export function assigneeLabel(ownerId, { memberId = null, memberIds = [], names = null } = {}) {
  if (!ownerId) return "Unassigned";
  if (ownerId === memberId) return "You";
  const name = names?.get?.(ownerId);
  if (typeof name === "string" && name.trim() && !misleadingMemberName(name)) return name;
  const index = [...new Set(memberIds)].filter((id) => id && id !== memberId).indexOf(ownerId);
  return index >= 0 ? `Household member ${index + 1}` : "A former household member";
}

// The chore chart without the DOM (#676, ADR 0022 §6): who is on the chart,
// their colour, and each card's chores, built from Rust's chart (kin-chores.js
// decodeChoreChart) and the household state. Pure: no DOM, no storage.
//
// Colours: a member's own colour (event kind 74, MEMBER_COLOUR_SET: an index
// into this 12-colour palette) when they chose one; otherwise the palette by
// join order, as the Calendar's defaultMemberColour.
// Colour is never the only signal: every card shows the name.
//
// Points are for children, and for an Adult only when a household admin
// allows it and they joined themselves. There are no streaks, no adult-only
// views and nothing older than this week.
import { pictureFor } from "../simple/simple-view.js";
import { assigneeLabel } from "../components/shared/assignee-label.js";

/** Twelve colours, each with white text at 4.5:1 or better (WCAG 2.2 AA),
 * in the order members get them when they have none of their own. */
export const CHORE_PALETTE = Object.freeze([
  "#1f5fae", "#b3261e", "#1b7a3a", "#7b3fa0", "#a0521b", "#00727a",
  "#ad1f6b", "#4b5a14", "#5c4bb3", "#8a3d00", "#0a6650", "#6d4c41",
]);

/** A member's colour: their own (`colours`, memberId -> CSS colour) or the
 * palette's by their place in the household (`order`, member IDs in join
 * order). */
export function memberColour(memberId, { order = [], colours = null } = {}) {
  const own = colours?.get?.(memberId);
  if (typeof own === "string" && own) return own;
  const index = Math.max(0, order.indexOf(memberId));
  return CHORE_PALETTE[index % CHORE_PALETTE.length];
}

/** "12 of 20 for Movie night", or "Movie night reached!" once the goal is
 * met; "12 points this week" without a reward. */
export function rewardLine(points, reward) {
  if (!reward) return points === 1 ? "1 point this week" : `${points} points this week`;
  if (points >= reward.goal) return `${reward.text} reached!`;
  return `${points} of ${reward.goal} for ${reward.text}`;
}

/** The chart's query members: children (Limited members) and Adults among
 * the active members, in join order. Temporary members are never on it. */
export function chartMembers(memberIds = [], kinds = new Map()) {
  const members = [];
  for (const memberId of memberIds) {
    const kind = kinds.get?.(memberId);
    if (kind === "limited") members.push({ memberId, kind: "child" });
    else if (kind === "adult") members.push({ memberId, kind: "adult" });
  }
  return members.slice(0, 32);
}

/**
 * The cards: [{ memberId, name, colour, adult, self, points, reward, line,
 * progress (0–1, or null without a reward), today: [chore], week: [{ date,
 * chores: [chore] }] }] where a chore is { key, kind, id, text, picture,
 * done, today, points, occurrenceKey }. Chores whose record isn't in the
 * state (not synced yet) are left out.
 */
export function buildChoreChart(chart, { state, emojis = new Map(), rows = [], order = [], names = null, colours = null, selfId = null } = {}) {
  if (!chart) return [];
  const items = new Map((state?.items ?? []).map((item) => [item.itemId, item]));
  const routines = new Map((state?.routines ?? []).map((routine) => [routine.routineId, routine]));
  const bindings = state?.attachments ?? [];
  return chart.members.map((member) => {
    const chores = [];
    for (const chore of member.chores) {
      const record = chore.kind === "item" ? items.get(chore.id) : routines.get(chore.id);
      if (!record) continue;
      chores.push({
        key: chore.kind === "item" ? `item:${chore.id}` : `routine:${chore.id}:${chore.occurrenceKey}`,
        kind: chore.kind, id: chore.id, text: record.text, date: chore.date, done: chore.done, today: chore.today,
        points: chore.points, occurrenceKey: chore.occurrenceKey,
        picture: chore.kind === "item" ? pictureFor(chore.id, { emojis, bindings, rows }) : null,
      });
    }
    const week = [];
    for (const chore of chores.filter((entry) => !entry.today && entry.date !== chart.today)) {
      const day = week.at(-1)?.date === chore.date ? week.at(-1) : (week.push({ date: chore.date, chores: [] }), week.at(-1));
      day.chores.push(chore);
    }
    return {
      memberId: member.memberId,
      // As everywhere else in Kin: "You", a preferred name, or "Household
      // member N".
      name: assigneeLabel(member.memberId, { memberId: selfId, memberIds: order, names }),
      colour: memberColour(member.memberId, { order, colours }),
      adult: member.adult,
      self: member.memberId === selfId,
      points: member.points,
      reward: member.reward,
      line: rewardLine(member.points, member.reward),
      progress: member.reward ? Math.min(1, member.points / member.reward.goal) : null,
      today: chores.filter((entry) => entry.today || entry.date === chart.today),
      week,
    };
  });
}

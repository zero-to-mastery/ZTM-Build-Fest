// The chore chart's cards without the DOM (#676): colours, the points and
// reward line, who is on the query, and the cards built from Rust's chart.
import assert from "node:assert/strict";
import test from "node:test";
import { CHORE_PALETTE, buildChoreChart, chartMembers, memberColour, rewardLine } from "./chore-chart-view.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const ME = id(1), MIA = id(2), LEO = id(3), SITTER = id(4);

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("every palette colour carries white text at 4.5:1 or better", () => {
  assert.equal(CHORE_PALETTE.length, 12);
  assert.equal(new Set(CHORE_PALETTE).size, 12);
  for (const colour of CHORE_PALETTE) {
    const ratio = 1.05 / (luminance(colour) + 0.05);
    assert.ok(ratio >= 4.5, `${colour}: ${ratio.toFixed(2)}`);
  }
});

test("colours: a member's own, else the palette by join order", () => {
  const order = [ME, MIA, LEO];
  assert.equal(memberColour(MIA, { order }), CHORE_PALETTE[1]);
  assert.equal(memberColour(LEO, { order }), CHORE_PALETTE[2]);
  assert.equal(memberColour(MIA, { order, colours: new Map([[MIA, "#123456"]]) }), "#123456");
  const many = Array.from({ length: 14 }, (_, n) => id(n + 1));
  assert.equal(memberColour(id(14), { order: many }), CHORE_PALETTE[1], "the palette repeats");
});

test("the points line names the reward", () => {
  assert.equal(rewardLine(12, { goal: 20, text: "Movie night" }), "12 of 20 for Movie night");
  assert.equal(rewardLine(20, { goal: 20, text: "Movie night" }), "Movie night reached!");
  assert.equal(rewardLine(1, null), "1 point this week");
  assert.equal(rewardLine(0, null), "0 points this week");
});

test("the query names children and Adults in join order, never Temporary members", () => {
  const kinds = new Map([[ME, "adult"], [MIA, "limited"], [SITTER, "temporary"], [LEO, "limited"]]);
  assert.deepEqual(chartMembers([ME, MIA, SITTER, LEO, id(9)], kinds), [
    { memberId: ME, kind: "adult" }, { memberId: MIA, kind: "child" }, { memberId: LEO, kind: "child" },
  ]);
});

test("cards: today's jobs with pictures, the rest of the week by day, and the reward", () => {
  const state = {
    items: [{ itemId: id(0x40), text: "Tidy room" }],
    routines: [{ routineId: id(0x30), text: "Feed the cat" }],
    attachments: [],
  };
  const chart = {
    start: 20260928, today: 20260930, routinesPaused: false, points: new Map(),
    members: [{
      memberId: MIA, adult: false, points: 12, reward: { goal: 20, text: "Movie night" },
      chores: [
        { kind: "routine", id: id(0x30), date: 20260928, occurrenceKey: 20260928, done: true, today: false, points: 2 },
        { kind: "routine", id: id(0x30), date: 20260929, occurrenceKey: 20260929, done: false, today: false, points: 2 },
        { kind: "item", id: id(0x40), date: 20260930, occurrenceKey: null, done: false, today: true, points: 1 },
        { kind: "routine", id: id(0x30), date: 20260930, occurrenceKey: 20260930, done: true, today: true, points: 2 },
        { kind: "routine", id: id(0x30), date: 20261001, occurrenceKey: 20261001, done: false, today: false, points: 2 },
        { kind: "item", id: id(0x99), date: 20261001, occurrenceKey: null, done: false, today: false, points: 1 },
      ],
    }],
  };
  const [card] = buildChoreChart(chart, { state, emojis: new Map([[id(0x40), "🧸"]]), order: [ME, MIA], names: new Map([[MIA, "Mia"]]), selfId: ME });
  assert.equal(card.name, "Mia");
  assert.equal(card.colour, CHORE_PALETTE[1]);
  assert.equal(card.line, "12 of 20 for Movie night");
  assert.equal(card.progress, 0.6);
  assert.deepEqual(card.today.map((chore) => [chore.text, chore.done, chore.picture]), [["Tidy room", false, { emoji: "🧸" }], ["Feed the cat", true, null]]);
  assert.deepEqual(card.week.map((day) => [day.date, day.chores.map((chore) => chore.done)]), [
    [20260928, [true]], [20260929, [false]], [20261001, [false]],
  ], "a chore not on this device yet is left out");
  assert.equal(card.today[1].key, `routine:${id(0x30)}:20260930`);
  const [unnamed] = buildChoreChart({ ...chart, members: [{ ...chart.members[0], reward: null }] }, { state, order: [ME, MIA], selfId: ME });
  assert.equal(unnamed.name, "Household member 1");
  assert.equal(unnamed.progress, null);
  assert.deepEqual(buildChoreChart(null, { state }), []);
});

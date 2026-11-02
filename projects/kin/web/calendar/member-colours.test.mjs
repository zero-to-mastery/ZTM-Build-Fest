// Members' colours (#663): twelve, distinct names, enough contrast in light
// and dark, the same values in calendar.css, defaults by join order.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MEMBER_PALETTE, SURFACES, calendarPeople, colourIndexFor, contrastRatio } from "./member-colours.js";

test("twelve named colours, each 3:1 against Kin's light and dark surfaces", () => {
  assert.equal(MEMBER_PALETTE.length, 12);
  assert.equal(new Set(MEMBER_PALETTE.map((entry) => entry.name)).size, 12);
  for (const entry of MEMBER_PALETTE) {
    for (const surface of SURFACES.light) assert.ok(contrastRatio(entry.light, surface) >= 3, `${entry.name} on ${surface}: ${contrastRatio(entry.light, surface).toFixed(2)}`);
    for (const surface of SURFACES.dark) assert.ok(contrastRatio(entry.dark, surface) >= 3, `${entry.name} (dark) on ${surface}: ${contrastRatio(entry.dark, surface).toFixed(2)}`);
  }
  assert.equal(contrastRatio("#000000", "#ffffff").toFixed(1), "21.0");
});

test("calendar.css carries the palette's values for light, dark and the forced dark appearance", async () => {
  const css = await readFile(new URL("../styles/calendar.css", import.meta.url), "utf8");
  MEMBER_PALETTE.forEach((entry, index) => {
    assert.ok(css.includes(`.member-colour-${index} { --member: ${entry.light}; }`), `light ${index}`);
    assert.equal(css.split(`.member-colour-${index} { --member: ${entry.dark}; }`).length - 1, 2, `dark ${index}, by system and by choice`);
  });
  assert.match(css, /@media \(forced-colors: active\)/);
});

test("a member's own choice, else a default by join order", () => {
  const colours = new Map([["b", 7]]);
  assert.equal(colourIndexFor("a", colours, ["a", "b", "c"]), 0);
  assert.equal(colourIndexFor("b", colours, ["a", "b", "c"]), 7);
  assert.equal(colourIndexFor("c", colours, ["a", "b", "c"]), 2);
  assert.equal(colourIndexFor("gone", colours, ["a", "b", "c"]), 3, "someone not listed comes after everyone listed");
  const people = calendarPeople({ memberIds: ["a", "b"], myId: "c", colours, labelOf: (id) => id.toUpperCase() });
  assert.deepEqual(people, [
    { memberId: "a", label: "A", colour: 0, chosen: false },
    { memberId: "b", label: "B", colour: 7, chosen: true },
    { memberId: "c", label: "C", colour: 2, chosen: false },
  ]);
});

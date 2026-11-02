// Members' calendar colours (#660, ADR 0022 §1): twelve named colours, each
// with a light-theme and a dark-theme value. Pure: no DOM.
//
// A member picks one in Identity & appearance (kind 74, synced like a
// name); without a choice they have a default by join order
// (kin-calendar.js `defaultMemberColour`). Colour is never the only signal:
// every place that shows it also shows the person's name. Each value is a
// graphic, not text, so it needs 3:1 against the surfaces it sits on (WCAG
// 1.4.11); member-colours.test.mjs checks every one against Kin's light and
// dark surfaces, and that styles/calendar.css carries the same values. In
// forced colours the swatches become system-coloured outlines and the names
// still say who.
import { MEMBER_COLOURS, defaultMemberColour } from "../wasm/kin-calendar.js";

export const MEMBER_PALETTE = Object.freeze([
  Object.freeze({ name: "Red", light: "#c0392b", dark: "#ff8a80" }),
  Object.freeze({ name: "Orange", light: "#b45309", dark: "#ffab5e" }),
  Object.freeze({ name: "Gold", light: "#8a6500", dark: "#f2c94c" }),
  Object.freeze({ name: "Olive", light: "#5f7000", dark: "#c5d36b" }),
  Object.freeze({ name: "Green", light: "#2e7d32", dark: "#7fd39a" }),
  Object.freeze({ name: "Teal", light: "#00796b", dark: "#5fd4c4" }),
  Object.freeze({ name: "Sky", light: "#0369a1", dark: "#7cc8f0" }),
  Object.freeze({ name: "Blue", light: "#1d4ed8", dark: "#93b4ff" }),
  Object.freeze({ name: "Indigo", light: "#5b3fc4", dark: "#b3a6ff" }),
  Object.freeze({ name: "Purple", light: "#8e3fae", dark: "#dba6f2" }),
  Object.freeze({ name: "Pink", light: "#b42a6c", dark: "#ff9fcf" }),
  Object.freeze({ name: "Brown", light: "#7a4f2c", dark: "#d9ad85" }),
]);

if (MEMBER_PALETTE.length !== MEMBER_COLOURS) throw new Error("The palette must have one entry per member colour.");

/** Kin's default surfaces, which a swatch must stand out from. */
export const SURFACES = Object.freeze({
  light: Object.freeze(["#fffdfa", "#f3f1e9", "#f1e8de"]),
  dark: Object.freeze(["#242b26", "#171d19", "#303a33"]),
});

function luminance(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** WCAG contrast ratio between two "#rrggbb" colours. */
export function contrastRatio(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/**
 * A member's colour index (0–11): their choice from `colours` (a Map
 * memberId → index, from KCAL), else the default for their place in
 * `memberIds` (join order). Someone no longer listed keeps their choice,
 * or gets the default after everyone listed.
 */
export function colourIndexFor(memberId, colours, memberIds = []) {
  const chosen = colours?.get?.(memberId);
  if (Number.isInteger(chosen)) return chosen;
  const index = memberIds.indexOf(memberId);
  return defaultMemberColour(index >= 0 ? index : memberIds.length);
}

export function colourName(index) {
  return MEMBER_PALETTE[index]?.name ?? "";
}

/** The class name app.css colours a swatch with. */
export function colourClass(index) {
  return `member-colour-${index}`;
}

/**
 * The people a calendar names, in join order: [{ memberId, label, colour,
 * chosen }]. `label` comes from `labelOf` (assignee-label.js), so "You",
 * a preferred name or "Household member 2".
 */
export function calendarPeople({ memberIds = [], myId = null, colours = new Map(), labelOf = (id) => id } = {}) {
  const ids = [...new Set([...memberIds, ...(myId && !memberIds.includes(myId) ? [myId] : [])])];
  return ids.map((memberId) => ({
    memberId,
    label: labelOf(memberId),
    colour: colourIndexFor(memberId, colours, ids),
    chosen: Number.isInteger(colours?.get?.(memberId)),
  }));
}

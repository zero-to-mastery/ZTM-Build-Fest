// Fridge magnets without the DOM (#322): where "Move to" puts a magnet, how
// far a key press moves it, its hand-hung tilt, the twelve Kin-drawn magnets
// and what each is called.
import { MAX_X, MAX_Y } from "../wasm/kin-board.js";

/** The nine named regions "Move to" offers, as board fractions. */
export const MAGNET_REGIONS = Object.freeze([
  Object.freeze({ id: "top-left", label: "Top left", fx: 1 / 6, fy: 1 / 6 }),
  Object.freeze({ id: "top", label: "Top", fx: 1 / 2, fy: 1 / 6 }),
  Object.freeze({ id: "top-right", label: "Top right", fx: 5 / 6, fy: 1 / 6 }),
  Object.freeze({ id: "left", label: "Left", fx: 1 / 6, fy: 1 / 2 }),
  Object.freeze({ id: "middle", label: "Middle", fx: 1 / 2, fy: 1 / 2 }),
  Object.freeze({ id: "right", label: "Right", fx: 5 / 6, fy: 1 / 2 }),
  Object.freeze({ id: "bottom-left", label: "Bottom left", fx: 1 / 6, fy: 5 / 6 }),
  Object.freeze({ id: "bottom", label: "Bottom", fx: 1 / 2, fy: 5 / 6 }),
  Object.freeze({ id: "bottom-right", label: "Bottom right", fx: 5 / 6, fy: 5 / 6 }),
]);

const clampX = (x) => Math.min(MAX_X, Math.max(0, Math.round(x)));
const clampY = (y) => Math.min(MAX_Y, Math.max(0, Math.round(y)));

/** A region's point on the board. */
export function regionPoint(id) {
  const region = MAGNET_REGIONS.find((entry) => entry.id === id) ?? MAGNET_REGIONS[4];
  return [clampX(region.fx * MAX_X), clampY(region.fy * MAX_Y)];
}

/** Where an arrow key moves a magnet: 1% of the board, 10% with Shift. */
export function nudge([x, y], key, { large = false } = {}) {
  const step = large ? 0.1 : 0.01;
  const dx = { ArrowLeft: -1, ArrowRight: 1 }[key] ?? 0;
  const dy = { ArrowUp: -1, ArrowDown: 1 }[key] ?? 0;
  if (!dx && !dy) return null;
  return [clampX(x + dx * step * MAX_X), clampY(y + dy * step * MAX_Y)];
}

/** A small fixed tilt (−6° to 6°) from the magnet's ID, so magnets look
 * hand-hung without anyone rotating them. */
export function magnetTilt(id) {
  let hash = 0;
  for (const character of String(id)) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return ((Math.abs(hash) % 13) - 6);
}

/** The twelve Kin-drawn magnets, numbered 1–12 on the wire: a name and a
 * small SVG drawn here (no icon packs). Paths use a 24-unit box. */
export const KIN_MAGNETS = Object.freeze([
  Object.freeze({ number: 1, name: "Heart", fill: "#e2504a", path: "M12 21s-7-4.4-9.3-9C1 8.4 3.2 4.5 6.9 4.5c2 0 3.6 1.1 5.1 3 1.5-1.9 3.1-3 5.1-3 3.7 0 5.9 3.9 4.2 7.5C19 16.6 12 21 12 21z" }),
  Object.freeze({ number: 2, name: "Star", fill: "#f2b705", path: "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5-4.8-4.6 6.6-.9z" }),
  Object.freeze({ number: 3, name: "Sun", fill: "#f39c12", path: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M4.9 19.1l2.1-2.1m10-10 2.1-2.1" }),
  Object.freeze({ number: 4, name: "Moon", fill: "#6c7ae0", path: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" }),
  Object.freeze({ number: 5, name: "Flower", fill: "#d65db1", path: "M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM12 2a3 3 0 0 1 3 3c0 1.2-.7 2.3-1.7 2.8A3 3 0 0 1 19 9a3 3 0 0 1-2.8 4.3c.5 1 .3 2.4-.6 3.3A3 3 0 0 1 12 17a3 3 0 0 1-3.6-.4 3 3 0 0 1-.6-3.3A3 3 0 0 1 5 9a3 3 0 0 1 5.7-1.2A3 3 0 0 1 9 5a3 3 0 0 1 3-3z" }),
  Object.freeze({ number: 6, name: "House", fill: "#c0703c", path: "M3 11 12 3l9 8v10h-6v-6H9v6H3z" }),
  Object.freeze({ number: 7, name: "Smile", fill: "#f5c542", path: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8.5 9a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zm7 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zM7 14h10a5 5 0 0 1-10 0z" }),
  Object.freeze({ number: 8, name: "Paw", fill: "#8d6e63", path: "M12 12c3 0 6 3.5 6 6.5 0 2-1.8 2.5-3 2.5-1.4 0-2-.8-3-.8s-1.6.8-3 .8c-1.2 0-3-.5-3-2.5C6 15.5 9 12 12 12zM5 7.5a2 2.5 0 1 1 0 5 2 2.5 0 0 1 0-5zm14 0a2 2.5 0 1 1 0 5 2 2.5 0 0 1 0-5zM9 3a2 2.5 0 1 1 0 5 2 2.5 0 0 1 0-5zm6 0a2 2.5 0 1 1 0 5 2 2.5 0 0 1 0-5z" }),
  Object.freeze({ number: 9, name: "Music note", fill: "#3f8efc", path: "M9 18.5V5l11-2v13.5a3 3 0 1 1-2-2.8V6.3l-7 1.3v10.9a3 3 0 1 1-2-2.8z" }),
  Object.freeze({ number: 10, name: "Check mark", fill: "#2e9e5b", path: "M9.5 16.2 4.8 11.5 3 13.3l6.5 6.5L21 8.3l-1.8-1.8z" }),
  Object.freeze({ number: 11, name: "Leaf", fill: "#5aa84f", path: "M20 3C9 3 4 8.5 4 15c0 1.5.4 2.8 1 4l1.5-1.5C6.2 16.7 6 15.9 6 15c0-3 2-6 6-7-3 2-5 4.5-5.5 8.5C8 18 9.5 18.5 11 18.5 17 18.5 20 13 20 3z" }),
  Object.freeze({ number: 12, name: "Cloud", fill: "#8fa8bf", path: "M7 19a5 5 0 0 1-.8-9.9A6 6 0 0 1 17.6 7.6 4.5 4.5 0 0 1 17.5 19z" }),
]);

/** The visible text a screen reader hears for a magnet. */
export function magnetName(magnet) {
  if (magnet.kind === "note") return `Note: ${magnet.text}`;
  if (magnet.kind === "kin") return `${KIN_MAGNETS[magnet.number - 1]?.name ?? "Kin"} magnet`;
  return `${magnet.text} magnet`;
}

/** The fraction of the board a magnet's centre sits at, for CSS. */
export function magnetPosition(magnet) {
  return { left: `${(magnet.x / MAX_X) * 100}%`, top: `${(magnet.y / MAX_Y) * 100}%` };
}

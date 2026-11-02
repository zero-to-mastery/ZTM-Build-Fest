// What the fridge view draws and says, without the DOM (#317): its palette
// and pen widths, hit-testing for the eraser, and the text summary.

/** How close (in board units) a pointer must come to a stroke to erase it. */
export const ERASE_REACH = 48;

/** The palette, by index. Names are what people see and hear. */
export const FRIDGE_COLOURS = Object.freeze(["Black", "Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Brown"]);
/** Pen widths in board units (the door is 4096 units wide). */
export const FRIDGE_WIDTHS = Object.freeze([
  Object.freeze({ label: "Thin", units: 10 }),
  Object.freeze({ label: "Medium", units: 24 }),
  Object.freeze({ label: "Thick", units: 56 }),
]);

/** Distance squared from point p to the segment a–b. */
function segmentDistance2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const length2 = dx * dx + dy * dy;
  let t = length2 ? ((px - ax) * dx + (py - ay) * dy) / length2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}

/** The topmost visible stroke within `reach` board units of (x, y), or null. */
export function strokeAt(strokes, x, y, reach = ERASE_REACH) {
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const { points, width } = strokes[index];
    const limit = reach + (FRIDGE_WIDTHS[width]?.units ?? 0) / 2;
    const limit2 = limit * limit;
    if (points.length === 2) {
      if ((points[0] - x) ** 2 + (points[1] - y) ** 2 <= limit2) return strokes[index];
      continue;
    }
    for (let p = 2; p < points.length; p += 2)
      if (segmentDistance2(x, y, points[p - 2], points[p - 1], points[p], points[p + 1]) <= limit2) return strokes[index];
  }
  return null;
}

/** "3 drawings by Sam and Alex" style summary text. */
export function fridgeSummary(board, labelOf = (id) => id) {
  const strokes = board?.strokes ?? [];
  const magnets = board?.magnets ?? [];
  if (!strokes.length && !magnets.length) return "The fridge is empty. Draw something for the household.";
  const authors = [...new Set(strokes.map((stroke) => stroke.author))].map(labelOf);
  const list = authors.length <= 2 ? authors.join(" and ") : `${authors.slice(0, -1).join(", ")} and ${authors.at(-1)}`;
  const parts = [];
  if (strokes.length) parts.push(`${strokes.length} ${strokes.length === 1 ? "drawing" : "drawings"} by ${list}`);
  if (magnets.length) parts.push(`${magnets.length} ${magnets.length === 1 ? "magnet" : "magnets"}`);
  return `${parts.join("; ")}.`;
}


/** Points from `from` to `to` (excluding `from`, including `to`) no more
 * than `step` board units apart, for erasing along a swipe. */
export function pathPoints(from, to, step) {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const count = Math.max(1, Math.ceil(distance / step));
  return Array.from({ length: count }, (_, index) => {
    const t = (index + 1) / count;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  });
}

/** When the fridge takes the kitchen-screen layout (#324): a wide landscape
 * touch screen, such as a tablet on the kitchen counter. */
export const KITCHEN_QUERY = "(min-width: 960px) and (orientation: landscape) and (pointer: coarse)";

/** What a shared screen should know about locking (#324). Kitchen-screen
 * mode and full screen never change automatic lock: Kin locks after the
 * chosen time without use, and drawing counts as use. */
export function kitchenScreenNote(autoLockMinutes) {
  if (!autoLockMinutes) return "Automatic lock is off, so anyone at this screen can open the rest of Kin. If this screen is shared, turn it on in Security.";
  const period = autoLockMinutes === 60 ? "an hour" : `${autoLockMinutes} minutes`;
  return `Kin still locks after ${period} without use, as it does everywhere. Drawing counts as use.`;
}

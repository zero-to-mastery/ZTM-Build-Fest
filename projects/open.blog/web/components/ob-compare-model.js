// The pure part of <ob-compare>: where the reveal sits, what it is called, and whether the control
// is offered at all. No DOM, so it is tested on its own.

/** A reveal position, kept to a whole number from 0 (all "after") to 100 (all "before"). */
export function clampPosition(value, fallback = 50) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, Math.round(number)));
}

/** The position under a pointer, given the stage's bounding box. */
export function positionFromPointer(clientX, rect) {
  if (!rect || !(rect.width > 0)) return 50;
  return clampPosition(((clientX - rect.left) / rect.width) * 100);
}

/** What a screen reader says for the range: how much of each picture shows. */
export function valueText(position, beforeLabel = "Before", afterLabel = "After") {
  const pos = clampPosition(position);
  if (pos >= 100) return `${beforeLabel} only`;
  if (pos <= 0) return `${afterLabel} only`;
  return `${pos}% ${beforeLabel}, ${100 - pos}% ${afterLabel}`;
}

/**
 * The control is offered only when it can be used as intended: a reader who asked for reduced motion
 * keeps the two pictures side by side, and so does a pair that is not two pictures.
 */
export function shouldEnhance({ reducedMotion = false, pictures = 0 } = {}) {
  return !reducedMotion && pictures === 2;
}

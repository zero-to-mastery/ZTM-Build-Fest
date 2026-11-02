// Pure parts of <ob-native-lab>: what this browser supports and the readouts shown for it. The
// lab never pretends: an unsupported feature says so and its control is disabled or hidden,
// with no imitation substituted.

// env: { document, probe (an element), IntersectionObserver, ResizeObserver }
export function detectSupport(env) {
  return {
    transitions: typeof env.document?.startViewTransition === "function",
    animations: typeof env.probe?.animate === "function",
    popover: typeof env.probe?.showPopover === "function",
    intersection: typeof env.IntersectionObserver !== "undefined",
    resize: typeof env.ResizeObserver !== "undefined",
  };
}

const yesNo = (value) => (value ? "yes" : "no");

export function motionSupportLabel(support) {
  return `Transitions: ${yesNo(support.transitions)} / Animations: ${yesNo(support.animations)}`;
}

export function observerSupportLabel(support) {
  return `Intersection: ${yesNo(support.intersection)} / Resize: ${yesNo(support.resize)}`;
}

export function popoverSupportLabel(support) {
  return support.popover ? "Native popover supported" : "Popover unavailable";
}

export function motionReady(support) {
  return support.transitions
    ? "Ready. Choose a layout or pulse the card."
    : "View Transitions unavailable: layout changes still work instantly.";
}

export function popoverReady(support) {
  return support.popover
    ? "Closed. Open to enter the browser's top layer."
    : "This browser lacks native popovers. The trigger stays hidden; no imitation overlay is substituted.";
}

export const popoverToggled = (state) => (state === "open"
  ? "Open in the top layer. Escape or click outside to dismiss."
  : "Closed. The popover left the top layer.");

// How a layout change is carried out: through a View Transition only when one exists and the
// reader has not asked for reduced motion.
export function layoutPlan(support, reducedMotion) {
  if (reducedMotion) return { transition: false, status: "Layout updated without motion, following your preference." };
  if (!support.transitions) return { transition: false, status: "Layout updated instantly; View Transitions unavailable." };
  return { transition: true, status: "Layout updated through the View Transitions API." };
}

export const intersectionLabel = (ratio) => `${Math.round(ratio * 100)}% visible in demo viewport`;

export const sizeLabel = (width, height) => `${Math.round(width)} × ${Math.round(height)} CSS px`;

export const PULSE_KEYFRAMES = [
  { transform: "translateY(0) scale(1)" },
  { transform: "translateY(-8px) scale(1.025)", offset: 0.5 },
  { transform: "translateY(0) scale(1)" },
];

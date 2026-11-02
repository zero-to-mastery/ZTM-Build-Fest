// Chat fits the screen (#310): the chat section is exactly as tall as the
// part of the screen left below its top edge, so the message list is the
// only thing that scrolls and the composer stays in view — above the bottom
// navigation and, on phones, above the on-screen keyboard.
//
// The visible area is the visual viewport where the browser has one (iOS
// shrinks it when the keyboard opens; the layout viewport stays tall), else
// the window. Everything here is measured in CSS pixels.

/** The minimum height the chat keeps, however little room there is: enough
 * for a few messages and the composer. */
export const MIN_CHAT_HEIGHT = 160;

/**
 * The chat section's height.
 * - `viewportHeight`, `viewportTop`: the visible area's height and its top
 *   within the layout viewport (visualViewport.height / offsetTop).
 * - `sectionTop`: the section's top in the layout viewport
 *   (getBoundingClientRect().top).
 * - `obstruction`: how much of the visible area's bottom is covered by fixed
 *   UI (the phone's bottom navigation), or 0.
 * - `gap`: breathing room kept below the section.
 */
export function chatHeight({ viewportHeight, viewportTop = 0, sectionTop, obstruction = 0, gap = 8, min = MIN_CHAT_HEIGHT }) {
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(sectionTop)) return null;
  const visibleTop = Math.max(0, sectionTop - viewportTop);
  const height = Math.floor(viewportHeight - visibleTop - Math.max(0, obstruction) - gap);
  return Math.max(min, height);
}

/** How much of the visible area's bottom `rect` (a fixed bar) covers. */
export function bottomObstruction(rect, { viewportHeight, viewportTop = 0 }) {
  if (!rect || !rect.height) return 0;
  const visibleBottom = viewportTop + viewportHeight;
  return Math.max(0, Math.min(rect.height, visibleBottom - rect.top));
}

const px = (value) => Number.parseFloat(value) || 0;

/**
 * The layout space below `section` down to the end of the page: its own
 * bottom margin, each ancestor's bottom padding, border and margin, and any
 * in-flow content after it. The section leaves this much room, so the page
 * itself never scrolls. Siblings beside it (a grid or a row) don't count.
 */
export function spaceBelow(section) {
  let total = 0;
  for (let node = section; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    total += px(style.marginBottom);
    if (node !== section) total += px(style.paddingBottom) + px(style.borderBottomWidth);
    const parent = node.parentElement;
    if (!parent) break;
    const layout = getComputedStyle(parent);
    const stacked = layout.display.includes("flex") ? layout.flexDirection.startsWith("column") : !layout.display.includes("grid");
    if (!stacked) continue;
    for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      const look = getComputedStyle(sibling);
      if (look.display === "none" || look.position === "absolute" || look.position === "fixed") continue;
      total += sibling.getBoundingClientRect().height + px(look.marginTop) + px(look.marginBottom);
    }
  }
  return Math.ceil(total);
}

/**
 * Keeps `section` sized while it's shown. `bar()` returns the fixed bottom
 * navigation (or null). Returns a function that stops it.
 */
export function fitChat(section, { bar = () => null, onComposer = () => {} } = {}) {
  const view = globalThis.visualViewport ?? null;
  let frame = 0;
  const measure = () => {
    frame = 0;
    if (!section.isConnected || !section.getClientRects().length) return;
    const viewportHeight = view ? view.height : globalThis.innerHeight;
    const viewportTop = view ? view.offsetTop : 0;
    const navigation = bar();
    const fixed = navigation && getComputedStyle(navigation).position === "fixed" && navigation.getClientRects().length
      ? navigation.getBoundingClientRect() : null;
    const height = chatHeight({
      viewportHeight,
      viewportTop,
      sectionTop: section.getBoundingClientRect().top,
      obstruction: bottomObstruction(fixed, { viewportHeight, viewportTop }),
      gap: 8 + spaceBelow(section),
    });
    if (height === null) return;
    section.style.setProperty("--chat-height", `${height}px`);
    section.classList.add("chat-fit");
    onComposer();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  observer?.observe(section);
  observer?.observe(document.documentElement);
  view?.addEventListener("resize", schedule);
  view?.addEventListener("scroll", schedule);
  globalThis.addEventListener("resize", schedule);
  globalThis.addEventListener("kin-route-change", schedule);
  schedule();
  return Object.assign(() => {
    if (frame) cancelAnimationFrame(frame);
    observer?.disconnect();
    view?.removeEventListener("resize", schedule);
    view?.removeEventListener("scroll", schedule);
    globalThis.removeEventListener("resize", schedule);
    globalThis.removeEventListener("kin-route-change", schedule);
    section.classList.remove("chat-fit");
    section.style.removeProperty("--chat-height");
  }, { schedule });
}

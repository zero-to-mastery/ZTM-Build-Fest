// Focus continuity across re-renders. A snapshot keeps the focused control and
// a description of it; restoring refocuses the same node when it survived,
// otherwise the caller's `find` locates its replacement.

/**
 * @param root     element whose descendants may hold focus
 * @param describe (control) => keys that identify a replacement control
 * @param fallback a remembered control to use when nothing in `root` has
 *                 focus (for example it was lost to a disabled control); it
 *                 must itself be inside `root`, or nothing is captured
 */
export function captureFocus(root, { describe = () => ({}), fallback = null } = {}) {
  const active = globalThis.document?.activeElement;
  const control = root.contains(active) ? active : fallback?.isConnected ? fallback : null;
  if (!control || !root.contains(control)) return null;
  return { root, control, ...describe(control) };
}

export function isVisible(node) {
  return Boolean(node?.isConnected) && !node.closest("[hidden]");
}

/** Opens any collapsed `<details>` between `node` and `root`. */
export function revealWithin(node, root) {
  for (let current = node.parentElement; current && current !== root; current = current.parentElement)
    if (current.localName === "details" && !current.open) current.open = true;
}

/**
 * @param find   (snapshot) => replacement element, or null
 * @param reveal open collapsed <details> ancestors of the target first
 * @returns the element that received focus, or null
 */
export function restoreFocus(snapshot, { find = () => null, reveal = false } = {}) {
  if (!snapshot) return null;
  const target = isVisible(snapshot.control) ? snapshot.control : find(snapshot);
  if (!target) return null;
  if (reveal) revealWithin(target, snapshot.root);
  target.focus();
  return target;
}

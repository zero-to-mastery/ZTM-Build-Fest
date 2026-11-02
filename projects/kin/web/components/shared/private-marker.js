// The "Private" marker (#510, #514): one look for a member's private things
// wherever they show beside household things (Today, This week) and on the
// Just for me list. The icon is a static constant, never household text.
import { LOCK_ICON } from "./icons.js";
import { privateLabel } from "../../private-items.js";

/** A visible "Private" tag with a lock; decorative for assistive tech,
 * which hears "Private: …" from the control's own name instead. */
export function privateMarker({ text = "Private" } = {}) {
  const marker = document.createElement("span");
  marker.className = "private-marker";
  marker.setAttribute("aria-hidden", "true");
  const icon = document.createElement("span");
  icon.className = "private-marker-icon";
  icon.innerHTML = LOCK_ICON;
  marker.append(icon, text);
  return marker;
}

/**
 * A private item's row beside household things: a checkbox named
 * "Private: <text>" that completes or reopens it, the marker and the text.
 * `onToggle(itemId, completed)` runs on change; `focusKey` keeps focus
 * across re-renders.
 */
export function privateItemRow(item, { onToggle, disabled = false, className = "", meta = null } = {}) {
  const row = document.createElement("li");
  row.className = `private-row private-elsewhere ${className}`.trim();
  row.dataset.privateId = item.id;
  const label = document.createElement("label");
  label.className = "private-check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = Boolean(item.completed);
  box.disabled = disabled;
  box.dataset.focusKey = `private:${item.id}`;
  box.setAttribute("aria-label", privateLabel(item.text));
  box.addEventListener("change", () => onToggle?.(item.id, box.checked));
  const text = document.createElement("span");
  text.className = "private-text";
  text.textContent = item.text;
  label.append(box, privateMarker(), text);
  row.append(label);
  if (meta) {
    const line = document.createElement("span");
    line.className = "private-meta";
    line.textContent = meta;
    row.append(line);
  }
  return row;
}

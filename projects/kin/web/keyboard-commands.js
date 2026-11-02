// Workspace keyboard commands. Pure: no DOM access, no storage, no household
// data. The command palette offers only this fixed allowlist; the app maps
// each id onto its existing navigation and Quick add methods. Nothing typed
// into the palette is evaluated, stored, or sent anywhere.

export const COMMANDS = Object.freeze([
  Object.freeze({ id: "today", label: "Go to Today", description: "See what the household needs today.", keywords: "home dashboard" }),
  Object.freeze({ id: "todo", label: "Go to To do", description: "Open the household to-do list.", keywords: "list tasks needs" }),
  Object.freeze({ id: "shopping", label: "Go to Shopping", description: "Open the shopping list.", keywords: "list groceries buy" }),
  Object.freeze({ id: "search", label: "Search household", description: "Find items, notes, handoffs, and topics.", keywords: "find look", shortcut: "/" }),
  Object.freeze({ id: "quick-add", label: "Quick add a task", description: "Capture a task without leaving this page.", keywords: "new create capture", shortcut: "N" }),
  Object.freeze({ id: "shortcuts", label: "Keyboard shortcuts", description: "Show every keyboard shortcut.", keywords: "help keys", shortcut: "?" }),
]);

// Rendered by the shortcut help. Modifier conventions differ by platform, so
// the palette entry lists both rather than guessing the keyboard in use.
// Keys in a combo are pressed together unless `either` marks alternatives.
export const SHORTCUTS = Object.freeze([
  Object.freeze({ action: "Open the command palette", combos: Object.freeze([
    Object.freeze({ keys: Object.freeze(["Ctrl", "K"]), platform: "Windows and Linux" }),
    Object.freeze({ keys: Object.freeze(["Cmd", "K"]), platform: "Mac" }),
  ]) }),
  Object.freeze({ action: "Quick add a task", combos: Object.freeze([Object.freeze({ keys: Object.freeze(["N"]) })]) }),
  Object.freeze({ action: "Search household", combos: Object.freeze([Object.freeze({ keys: Object.freeze(["/"]) })]) }),
  Object.freeze({ action: "Show keyboard shortcuts", combos: Object.freeze([Object.freeze({ keys: Object.freeze(["?"]) })]) }),
  Object.freeze({ action: "Undo your last change", combos: Object.freeze([
    Object.freeze({ keys: Object.freeze(["Ctrl", "Z"]), platform: "Windows and Linux" }),
    Object.freeze({ keys: Object.freeze(["Cmd", "Z"]), platform: "Mac" }),
  ]) }),
  Object.freeze({ action: "Redo what you undid", combos: Object.freeze([
    Object.freeze({ keys: Object.freeze(["Ctrl", "Shift", "Z"]), platform: "Windows and Linux" }),
    Object.freeze({ keys: Object.freeze(["Ctrl", "Y"]), platform: "Windows and Linux" }),
    Object.freeze({ keys: Object.freeze(["Cmd", "Shift", "Z"]), platform: "Mac" }),
  ]) }),
  Object.freeze({ action: "Close the open dialog or item details", combos: Object.freeze([Object.freeze({ keys: Object.freeze(["Esc"]) })]) }),
  Object.freeze({ action: "Choose a command in the palette", combos: Object.freeze([Object.freeze({ keys: Object.freeze(["↑", "↓"]), either: true })]) }),
  Object.freeze({ action: "Run the chosen command", combos: Object.freeze([Object.freeze({ keys: Object.freeze(["Enter"]) })]) }),
]);

const normalize = (value) => String(value ?? "").toLocaleLowerCase().replace(/\s+/g, " ").trim();

// Every query word must appear in the command's label, description, or
// keywords. Label-prefix matches come first; otherwise the allowlist order holds.
export function filterCommands(query, commands = COMMANDS) {
  const words = normalize(query).split(" ").filter(Boolean);
  if (!words.length) return [...commands];
  const matches = commands.filter((command) => {
    const haystack = normalize(`${command.label} ${command.description} ${command.keywords ?? ""}`);
    return words.every((word) => haystack.includes(word));
  });
  const phrase = words.join(" ");
  const leading = (command) => {
    const label = normalize(command.label);
    return label.startsWith(phrase) || label.split(" ").some((word) => word.startsWith(phrase)) ? 0 : 1;
  };
  return matches.map((command, index) => ({ command, index }))
    .sort((a, b) => leading(a.command) - leading(b.command) || a.index - b.index)
    .map(({ command }) => command);
}

// Maps a keydown to a shortcut id, or null. Ctrl+K is reserved for Windows and
// Linux because Ctrl+K deletes to the end of the line in Mac text fields; Cmd+K
// opens the palette everywhere. IME composition and auto-repeat never trigger.
export function shortcutForKey(event, { mac = false } = {}) {
  if (!event || event.isComposing || event.keyCode === 229 || event.repeat) return null;
  const key = String(event.key ?? "");
  if (event.altKey) return null;
  if (event.ctrlKey || event.metaKey) {
    if (event.ctrlKey && event.metaKey) return null;
    if (event.ctrlKey && mac) return null;
    // Non-Latin layouts report their own letter; the physical key still counts.
    const is = (letter) => key.toLowerCase() === letter || (event.code === `Key${letter.toUpperCase()}` && !/^[a-z]$/i.test(key));
    // Undo and redo your own recent changes (#315): Ctrl/Cmd+Z, and
    // Shift+Ctrl/Cmd+Z or Ctrl+Y. The caller leaves text fields to the
    // browser's own undo.
    if (is("z")) return event.shiftKey ? "redo" : "undo";
    if (is("y") && event.ctrlKey && !event.shiftKey) return "redo";
    if (event.shiftKey) return null;
    return is("k") ? "palette" : null;
  }
  // Shift is allowed: "?" and, on many layouts, "/" need it.
  if (key === "n" || key === "N") return "quick-add";
  if (key === "/") return "search";
  if (key === "?") return "shortcuts";
  return null;
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

export function isEditableElement(element) {
  if (!element || typeof element !== "object") return false;
  if (element.isContentEditable) return true;
  const tag = String(element.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has(String(element.type ?? "text").toLowerCase());
  return TEXT_ROLES.has(element.getAttribute?.("role") ?? "");
}

// The composed path reaches inside open shadow roots, where event.target has
// been retargeted to the host; the deep active element covers the rest.
export function isTypingContext(event, activeElement = null) {
  const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
  if (isEditableElement(path[0] ?? event?.target)) return true;
  let active = activeElement;
  while (active) {
    if (isEditableElement(active)) return true;
    active = active.shadowRoot?.activeElement ?? null;
  }
  return false;
}

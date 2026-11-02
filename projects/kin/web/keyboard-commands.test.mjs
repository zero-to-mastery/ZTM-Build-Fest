import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, filterCommands, isEditableElement, isTypingContext, shortcutForKey, SHORTCUTS } from "./keyboard-commands.js";
import { resolveRoute, routeHash, SEGMENTS } from "./routes.js";

const key = (value, extra = {}) => ({ key: value, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 0, ...extra });

test("the palette offers a fixed allowlist of existing destinations and actions", () => {
  assert.deepEqual(COMMANDS.map((command) => command.id), ["today", "todo", "shopping", "search", "quick-add", "shortcuts"]);
  assert.ok(Object.isFrozen(COMMANDS) && COMMANDS.every(Object.isFrozen));
  for (const command of COMMANDS) assert.ok(command.label && command.description, command.id);
  // Navigation commands name views that exist in the router.
  assert.equal(resolveRoute({ hash: "#today" }).page, "today");
  assert.equal(resolveRoute({ hash: "#search" }).page, "search");
  for (const id of ["todo", "shopping"]) {
    assert.ok(SEGMENTS.lists.some((entry) => entry.id === id), id);
    assert.equal(resolveRoute({ hash: routeHash("lists", id) }).segment, id);
  }
});

test("an empty query lists every command in allowlist order", () => {
  assert.deepEqual(filterCommands("").map((command) => command.id), COMMANDS.map((command) => command.id));
  assert.deepEqual(filterCommands("   ").map((command) => command.id), COMMANDS.map((command) => command.id));
});

test("filtering matches every word across label, description, and keywords", () => {
  assert.deepEqual(filterCommands("shop").map((command) => command.id), ["shopping"]);
  assert.deepEqual(filterCommands("SHOPPING list").map((command) => command.id), ["shopping"]);
  assert.deepEqual(filterCommands("groceries").map((command) => command.id), ["shopping"]);
  assert.deepEqual(filterCommands("quick").map((command) => command.id), ["quick-add"]);
  assert.deepEqual(filterCommands("keys").map((command) => command.id), ["shortcuts"]);
  assert.deepEqual(filterCommands("zzz nothing"), []);
});

test("label-prefix matches rank first and ties keep allowlist order", () => {
  // "go" begins three labels; "Shortcuts" mentions nothing about going.
  assert.deepEqual(filterCommands("go").map((command) => command.id), ["today", "todo", "shopping"]);
  // "search" is a label word for Search and only a description word elsewhere.
  assert.equal(filterCommands("search")[0].id, "search");
  // "task" begins a label word in Quick add; To do only lists it as a keyword.
  assert.deepEqual(filterCommands("task").map((command) => command.id), ["quick-add", "todo"]);
});

test("filtering treats input as plain text", () => {
  for (const hostile of ["<img src=x onerror=alert(1)>", "${process.exit()}", ".*", "(", "\\"])
    assert.deepEqual(filterCommands(hostile), [], hostile);
});

test("Ctrl+K opens the palette on Windows and Linux; Cmd+K everywhere", () => {
  assert.equal(shortcutForKey(key("k", { ctrlKey: true })), "palette");
  assert.equal(shortcutForKey(key("K", { ctrlKey: true })), "palette");
  assert.equal(shortcutForKey(key("k", { metaKey: true })), "palette");
  assert.equal(shortcutForKey(key("k", { metaKey: true }), { mac: true }), "palette");
  // Mac text fields use Ctrl+K to delete to the end of the line.
  assert.equal(shortcutForKey(key("k", { ctrlKey: true }), { mac: true }), null);
  // Non-Latin layouts still use the physical K key.
  assert.equal(shortcutForKey(key("л", { code: "KeyK", ctrlKey: true })), "palette");
  assert.equal(shortcutForKey(key("j", { code: "KeyK", ctrlKey: true })), null);
});

test("modified keys other than Ctrl/Cmd+K are left to the browser", () => {
  assert.equal(shortcutForKey(key("k", { ctrlKey: true, shiftKey: true })), null);
  assert.equal(shortcutForKey(key("k", { ctrlKey: true, altKey: true })), null, "AltGr");
  assert.equal(shortcutForKey(key("k", { ctrlKey: true, metaKey: true })), null);
  assert.equal(shortcutForKey(key("n", { ctrlKey: true })), null, "Ctrl+N stays a browser shortcut");
  assert.equal(shortcutForKey(key("n", { metaKey: true })), null);
  assert.equal(shortcutForKey(key("n", { altKey: true })), null);
  assert.equal(shortcutForKey(key("/", { ctrlKey: true })), null);
  assert.equal(shortcutForKey(key("f", { ctrlKey: true })), null);
});

test("single-key shortcuts map N, /, and ?", () => {
  assert.equal(shortcutForKey(key("n")), "quick-add");
  assert.equal(shortcutForKey(key("N", { shiftKey: true })), "quick-add");
  assert.equal(shortcutForKey(key("/")), "search");
  assert.equal(shortcutForKey(key("/", { shiftKey: true })), "search", "layouts where / needs Shift");
  assert.equal(shortcutForKey(key("?", { shiftKey: true })), "shortcuts");
  for (const other of ["a", "k", "Escape", "Enter", "Tab", " ", "ArrowDown", "F1"]) assert.equal(shortcutForKey(key(other)), null, other);
});

test("IME composition and auto-repeat never trigger a shortcut", () => {
  assert.equal(shortcutForKey(key("n", { isComposing: true })), null);
  assert.equal(shortcutForKey(key("Process", { keyCode: 229 })), null);
  assert.equal(shortcutForKey(key("k", { ctrlKey: true, isComposing: true })), null);
  assert.equal(shortcutForKey(key("n", { repeat: true })), null);
  assert.equal(shortcutForKey(key("k", { ctrlKey: true, repeat: true })), null);
  assert.equal(shortcutForKey(null), null);
});

const element = (tagName, { type, role, editable = false, shadowActive = null } = {}) => ({
  tagName, type, isContentEditable: editable,
  getAttribute: (name) => (name === "role" ? role ?? null : null),
  shadowRoot: shadowActive ? { activeElement: shadowActive } : null,
});

test("text fields, selects, and contenteditable count as typing", () => {
  for (const type of ["text", "search", "email", "number", "date", "password", "url", undefined])
    assert.equal(isEditableElement(element("INPUT", { type })), true, String(type));
  assert.equal(isEditableElement(element("TEXTAREA")), true);
  assert.equal(isEditableElement(element("SELECT")), true);
  assert.equal(isEditableElement(element("DIV", { editable: true })), true);
  assert.equal(isEditableElement(element("DIV", { role: "textbox" })), true);
  for (const type of ["button", "checkbox", "radio", "submit", "reset", "range", "file", "color"])
    assert.equal(isEditableElement(element("INPUT", { type })), false, type);
  assert.equal(isEditableElement(element("BUTTON")), false);
  assert.equal(isEditableElement(element("A")), false);
  assert.equal(isEditableElement(null), false);
});

test("typing context reaches through nested shadow roots", () => {
  const inner = element("INPUT", { type: "text" });
  const host = element("X-OUTER", { shadowActive: element("X-INNER", { shadowActive: inner }) });
  // event.target is retargeted to the host; composedPath()[0] is the real field.
  assert.equal(isTypingContext({ target: host, composedPath: () => [inner, host] }), true);
  // Without a usable path, the deep active element still reveals the field.
  assert.equal(isTypingContext({ target: host, composedPath: () => [] }, host), true);
  const button = element("BUTTON");
  assert.equal(isTypingContext({ target: button, composedPath: () => [button] }, button), false);
});

test("the shortcut help documents every shortcut, with both modifier conventions", () => {
  const actions = SHORTCUTS.map((entry) => entry.action);
  for (const action of ["Open the command palette", "Quick add a task", "Search household", "Show keyboard shortcuts", "Close the open dialog or item details"])
    assert.ok(actions.includes(action), action);
  const palette = SHORTCUTS.find((entry) => entry.action === "Open the command palette");
  assert.deepEqual(palette.combos.map((combo) => [combo.keys.join("+"), combo.platform]), [["Ctrl+K", "Windows and Linux"], ["Cmd+K", "Mac"]]);
  for (const command of COMMANDS.filter((entry) => entry.shortcut))
    assert.ok(SHORTCUTS.some((entry) => entry.combos.some((combo) => combo.keys.join("") === command.shortcut)), command.id);
});

test("Ctrl/Cmd+Z undoes and Shift+Ctrl/Cmd+Z or Ctrl+Y redoes (#315)", () => {
  assert.equal(shortcutForKey(key("z", { ctrlKey: true })), "undo");
  assert.equal(shortcutForKey(key("z", { metaKey: true }), { mac: true }), "undo");
  assert.equal(shortcutForKey(key("Z", { ctrlKey: true, shiftKey: true })), "redo");
  assert.equal(shortcutForKey(key("z", { metaKey: true, shiftKey: true }), { mac: true }), "redo");
  assert.equal(shortcutForKey(key("y", { ctrlKey: true })), "redo");
  assert.equal(shortcutForKey(key("я", { code: "KeyZ", ctrlKey: true })), "undo", "the physical Z key on another layout");
  assert.equal(shortcutForKey(key("z", { ctrlKey: true }), { mac: true }), null, "Ctrl+Z isn't undo on a Mac");
  assert.equal(shortcutForKey(key("y", { metaKey: true }), { mac: true }), null);
  assert.equal(shortcutForKey(key("y", { ctrlKey: true, shiftKey: true })), null);
  assert.equal(shortcutForKey(key("z")), null, "a plain Z types");
  assert.equal(shortcutForKey(key("z", { ctrlKey: true, altKey: true })), null);
  assert.equal(shortcutForKey(key("z", { ctrlKey: true, repeat: true })), null);
  assert.ok(SHORTCUTS.some((entry) => entry.action === "Undo your last change"));
  assert.ok(SHORTCUTS.some((entry) => entry.action === "Redo what you undid"));
});

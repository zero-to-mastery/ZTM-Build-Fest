import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

class Node {
  constructor(tag = "") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.style = { setProperty: () => {} };
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(name, value) {
    this[name] = String(value);
  }
  hasAttribute(name) {
    return this[name] !== undefined;
  }
  addEventListener(name, callback) {
    (this.listeners ||= {})[name] = [...(this.listeners[name] || []), callback];
    this[name] = () => this.listeners[name].forEach((listener) => listener());
  }
  focus() {
    globalThis.focused = this;
  }
}

let Sandbox;
globalThis.HTMLElement = class extends Node {};
globalThis.customElements = { get: () => null, define: (_name, constructor) => (Sandbox = constructor) };
globalThis.document = {
  createElement: (tag) => new Node(tag),
  createDocumentFragment: () => new Node("fragment"),
  createTextNode: (text) => Object.assign(new Node("#text"), { textContent: text }),
};

await import("../../web/components/ob-web-sandbox.js");

const has = (node, className) => (node.className || "").split(/\s+/).includes(className);
function findAll(root, className, found = []) {
  if (has(root, className)) found.push(root);
  for (const child of root.children || []) findAll(child, className, found);
  return found;
}

function fixture(source = "---html\n<h1>Hi</h1>\n<p>Two</p>\n---css\nh1 { color: red; }\n---js\nconsole.log(1);") {
  const code = new Node("code");
  code.textContent = source;
  const pre = new Node("pre");
  pre.querySelector = (selector) => (selector === "code" ? code : null);
  const sandbox = new Sandbox();
  sandbox.children = [pre];
  sandbox.querySelector = (selector) => (selector === "pre" ? pre : null);
  sandbox.connectedCallback();
  return sandbox;
}

test("each sandbox source uses the shared highlighted code editor", () => {
  const sandbox = fixture();
  const shells = findAll(sandbox, "ob-code-editor-shell");
  assert.equal(shells.length, 3);
  assert.deepEqual(findAll(sandbox, "ob-code-editor-label").map((label) => label.textContent), ["HTML", "CSS", "JavaScript"]);
  assert.equal(findAll(sandbox, "ob-code-cursor").length, 3);
  const editors = findAll(sandbox, "ob-code-editor");
  assert.deepEqual(editors.map((editor) => editor["aria-label"]), ["Editable HTML", "Editable CSS", "Editable JavaScript"]);
  assert.ok(editors.every((editor) => has(editor, "ob-web-sandbox-editor") && editor.wrap === "off"));
  const painted = findAll(sandbox, "ob-code-editor-decoration").map((decoration) => decoration.children[0]);
  assert.deepEqual(painted.map((code) => code.className), ["language-html", "language-css", "language-js"]);
  assert.ok(painted.every((code) => code.dataset.highlighted === "true"), "sources are syntax highlighted");
});

test("tabs switch whole editor shells and Reset repaints the original source", () => {
  const sandbox = fixture();
  const [htmlShell, cssShell] = findAll(sandbox, "ob-code-editor-shell");
  const tabs = findAll(sandbox, "ob-web-sandbox-tab");
  assert.equal(htmlShell.hidden, false);
  assert.equal(cssShell.hidden, true);
  tabs[1].click();
  assert.equal(htmlShell.hidden, true);
  assert.equal(cssShell.hidden, false);
  assert.equal(tabs[1]["aria-pressed"], "true");
  const css = findAll(sandbox, "ob-code-editor")[1];
  assert.equal(globalThis.focused, css);

  css.value = "h1 { color: blue; }";
  css.input();
  const painted = findAll(sandbox, "ob-code-editor-decoration")[1].children[0];
  assert.ok(JSON.stringify(painted.children).includes("blue"), "edits repaint the highlighted copy");
  findAll(sandbox, "ob-web-sandbox-reset")[0].click();
  assert.equal(css.value, "h1 { color: red; }");
  assert.ok(!JSON.stringify(painted.children).includes("blue"), "Reset repaints the original source");
});

test("sandbox controls and notes share the editable-code styles", () => {
  const sandbox = fixture();
  const [controls] = findAll(sandbox, "ob-code-editor-controls");
  assert.ok(controls && has(controls, "ob-web-sandbox-controls"));
  assert.ok(has(findAll(sandbox, "ob-web-sandbox-run")[0], "ob-code-editor-run"));
  assert.ok(has(findAll(sandbox, "ob-web-sandbox-warning")[0], "ob-code-editor-note"));
  assert.ok(has(findAll(sandbox, "ob-web-sandbox-status")[0], "ob-code-editor-status"));

  const styles = fs.readFileSync(new URL("../../web/base.css", import.meta.url), "utf8");
  assert.match(styles, /\.ob-code-editor-shell\s*\{/);
  assert.match(styles, /\.ob-code-editor-controls button\s*,/);
  assert.match(styles, /\.ob-code-editor-controls \.ob-code-editor-run\s*\{/);
  assert.match(styles, /\.ob-code-editor-shell\[data-line-numbers="true"\] \.ob-code-editor\s*\{/);
  assert.doesNotMatch(styles, /\.ob-web-sandbox-editor\s*\{/, "no separate sandbox editor styling");
  assert.doesNotMatch(styles, /\.ob-rust-editor-shell\s*\{/, "Rust uses the shared editor styles");
});

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
    this.classList = {
      add: (...names) => (this.className = [...new Set([...(this.className || "").split(/\s+/).filter(Boolean), ...names])].join(" ")),
    };
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
  removeAttribute(name) {
    delete this[name];
  }
  addEventListener(name, callback) {
    this[name] = callback;
  }
  focus() {
    this.focused = true;
  }
}

let Playground;
globalThis.HTMLElement = class extends Node {};
globalThis.customElements = {
  get: () => null,
  define: (_name, constructor) => (Playground = constructor),
};
globalThis.document = {
  createElement: (tag) => new Node(tag),
  createDocumentFragment: () => new Node("fragment"),
};

let copied;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { writeText: async (value) => (copied = value) } },
});

await import("../../web/components/ob-rust-playground.js");

test("the enhanced-state CSS hides only the original source block", () => {
  const css = fs.readFileSync(new URL("../../web/base.css", import.meta.url), "utf8");
  assert.match(css, /ob-rust-playground\[data-enhanced="true"\] > pre\.ob-rust-source\s*{/);
  assert.doesNotMatch(css, /ob-rust-playground\[data-enhanced="true"\] > pre\s*{/);
});

function find(root, className) {
  if ((root.className || "").split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const match = find(child, className);
    if (match) return match;
  }
  return null;
}

function fixture(source = 'fn main() { println!("start"); }\n', options = {}) {
  const code = new Node("code");
  code.textContent = source;
  Object.assign(code.dataset, options.codeDataset);
  const pre = new Node("pre");
  pre.querySelector = (selector) => (selector === "code" ? code : null);
  const playground = new Playground();
  Object.assign(playground.dataset, options.playgroundDataset);
  playground.children = [pre];
  playground.querySelector = (selector) => (selector === "pre" ? pre : null);
  playground.connectedCallback();
  return { playground, editor: find(playground, "ob-rust-editor") };
}

test("looks like an editor and can omit the external Playground link", () => {
  const { playground } = fixture(undefined, {
    playgroundDataset: { playgroundLink: "false" },
    codeDataset: { lineNumbers: "true", lineStart: "10", highlightLines: "2" },
  });

  assert.ok(find(playground, "ob-rust-editor-shell"));
  assert.ok(find(playground, "ob-rust-editor-bar"));
  assert.ok(find(playground, "ob-rust-cursor"));
  assert.equal(find(playground, "ob-rust-external"), null);
  assert.equal(
    find(playground, "ob-rust-notice").textContent,
    "Code runs on the official Rust Playground. open.blog does not store it.",
  );

  const decoration = find(playground, "ob-rust-editor-decoration");
  const painted = decoration.children[0];
  assert.equal(painted.dataset.lineNumbers, "true");
  assert.equal(painted.dataset.lineStart, "10");
  assert.equal(painted.dataset.highlightLines, "2");
  assert.equal(find(playground, "ob-rust-editor-shell").dataset.lineNumbers, "true");

  const css = fs.readFileSync(new URL("../../web/base.css", import.meta.url), "utf8");
  assert.match(css, /@keyframes ob-code-cursor-blink/);
  assert.match(css, /caret-color:/);
  assert.match(css, /\.ob-code-editor-controls button\[aria-disabled="true"\]\s*{/);
});

test("edits, resets, copies, and updates the external fallback", async () => {
  const { playground, editor } = fixture();
  const reset = find(playground, "ob-rust-reset");
  const copy = find(playground, "ob-rust-copy");
  const external = find(playground, "ob-rust-external");

  editor.value = 'fn main() { println!("changed"); }';
  editor.input();
  assert.match(new URL(external.href).searchParams.get("code"), /changed/);
  await copy.click();
  assert.match(copied, /changed/);
  reset.click();
  assert.match(editor.value, /start/);
  assert.equal(editor.focused, true);
});

test("shows Playground output as text and reports compilation failures", async () => {
  let sent;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body).code;
    return {
      ok: true,
      headers: { get: () => "100" },
      json: async () => ({ success: false, stdout: "", stderr: "error: nope\n" }),
    };
  };
  const { playground, editor } = fixture();
  editor.value = "fn main() { nope(); }";
  const run = find(playground, "ob-rust-run");
  const status = find(playground, "ob-rust-status");
  const output = find(playground, "ob-rust-output");
  const outputPanel = find(playground, "ob-rust-output-panel");
  await run.click();

  assert.equal(sent, editor.value);
  assert.equal(status.textContent, "Compilation failed.");
  assert.equal(output.textContent, "error: nope\n");
  assert.equal(output.hidden, false);
  assert.equal(outputPanel.hidden, false);
});

test("keeps Run focusable and ignores duplicate runs while compiling", async () => {
  let finish;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    await new Promise((resolve) => (finish = resolve));
    return {
      ok: true,
      headers: { get: () => "100" },
      json: async () => ({ success: true, stdout: "done\n", stderr: "" }),
    };
  };

  const { playground } = fixture();
  const run = find(playground, "ob-rust-run");
  run.focus();
  const first = run.click();
  const duplicate = run.click();

  assert.equal(run.focused, true);
  assert.equal(run.disabled, undefined);
  assert.equal(run["aria-disabled"], "true");
  assert.equal(requests, 1);

  finish();
  await Promise.all([first, duplicate]);
  assert.equal(run["aria-disabled"], undefined);
  assert.equal(run.focused, true);
});

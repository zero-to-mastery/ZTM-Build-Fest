import test from "node:test";
import assert from "node:assert/strict";

class Node {
  constructor(tag = "") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.style = { setProperty: () => {} };
    this.classList = { add: (...names) => (this.className = names.join(" ")) };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = String(value); }
  hasAttribute(name) { return this[name] !== undefined; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, callback) { this[name] = callback; }
  focus() { this.focused = true; }
}

let Runner;
globalThis.HTMLElement = class extends Node {};
globalThis.customElements = { get: () => null, define: (_name, constructor) => (Runner = constructor) };
globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
let copied = "";
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value) => (copied = value) } } });

await import("../../web/components/ob-code-runner.js");

function find(root, className) {
  if ((root.className || "").split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const match = find(child, className);
    if (match) return match;
  }
  return null;
}

function fixture() {
  const code = new Node("code");
  code.textContent = "print(input())\n";
  code.dataset.runnable = "python";
  const pre = new Node("pre");
  pre.querySelector = (selector) => (selector === "code" ? code : null);
  const runner = new Runner();
  runner.dataset.language = "python";
  runner.dataset.endpoint = "https://runner.example/execute";
  runner.children = [pre];
  runner.querySelector = (selector) => (selector === "pre" ? pre : null);
  runner.connectedCallback();
  return { runner, editor: find(runner, "ob-code-runner-editor") };
}

test("progressively enhances source with accessible runner controls and disclosure", () => {
  const { runner, editor } = fixture();
  assert.equal(editor["aria-label"], "Editable Python code");
  assert.equal(find(runner, "ob-code-runner-stdin")["aria-label"], "Standard input (optional)");
  assert.equal(find(runner, "ob-code-runner-output")["aria-label"], "Python program output");
  assert.match(find(runner, "ob-code-runner-notice").textContent, /external sandbox service/);
  assert.match(find(runner, "ob-code-runner-notice").textContent, /source and standard input/);
});

test("runs, resets, and copies configured-language lessons", async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ success: true, stdout: "hello\n", stderr: "", exitCode: 0 }));
  };
  const { runner, editor } = fixture();
  editor.value = "print('changed')";
  find(runner, "ob-code-runner-stdin").value = "hello\n";
  await find(runner, "ob-code-runner-run").click();
  assert.deepEqual(JSON.parse(request.options.body), { language: "python", source: "print('changed')", stdin: "hello\n" });
  assert.equal(find(runner, "ob-code-runner-output").textContent, "hello\n");
  await find(runner, "ob-code-runner-copy").click();
  assert.equal(copied, "print('changed')");
  find(runner, "ob-code-runner-reset").click();
  assert.equal(editor.value, "print(input())\n");
  assert.equal(find(runner, "ob-code-runner-status").textContent, "Reset to the post's example.");
  assert.equal(editor.focused, true);
});

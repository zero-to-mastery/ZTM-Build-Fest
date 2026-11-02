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
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} } } });

await import("../../web/components/ob-rust-playground.js");

function find(root, className) {
  if ((root.className || "").split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const match = find(child, className);
    if (match) return match;
  }
  return null;
}

const STARTER = "fn add(a: u32, b: u32) -> u32 {\n    0\n}\n";
const CHECKS = "/// Add them together.\n#[test]\nfn adds() {\n    assert_eq!(add(2, 3), 5);\n}\n";

function fixture({ checks = CHECKS } = {}) {
  const code = new Node("code");
  code.textContent = STARTER;
  const pre = new Node("pre");
  pre.querySelector = (selector) => (selector === "code" ? code : null);
  let script = null;
  if (checks !== null) {
    script = new Node("script");
    script.textContent = JSON.stringify(checks);
  }
  const playground = new Playground();
  playground.children = [pre];
  playground.querySelector = (selector) =>
    selector === "pre" ? pre : selector === "script[data-ob-rust-checks]" ? script : null;
  playground.connectedCallback();
  return { playground, editor: find(playground, "ob-rust-editor") };
}

function playgroundReplies(body) {
  const sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, headers: { get: () => "100" }, json: async () => body };
  };
  return sent;
}

test("only a fence with hidden checks gets a Check button, and the checks never enter the editor", () => {
  const plain = fixture({ checks: null });
  assert.equal(find(plain.playground, "ob-rust-check"), null);

  const checked = fixture();
  assert.ok(find(checked.playground, "ob-rust-check"));
  assert.equal(find(checked.playground, "ob-rust-check").textContent, "Check my code");
  assert.equal(checked.editor.value, STARTER);
  assert.doesNotMatch(checked.editor.value, /assert_eq|#\[test\]/);
});

test("a malformed or empty checks element is ignored, so the fence is still just runnable", () => {
  assert.equal(find(fixture({ checks: "   " }).playground, "ob-rust-check"), null);
  const code = new Node("code");
  code.textContent = STARTER;
  const pre = new Node("pre");
  pre.querySelector = () => code;
  const script = new Node("script");
  script.textContent = "{not json";
  const playground = new Playground();
  playground.children = [pre];
  playground.querySelector = (selector) => (selector === "pre" ? pre : selector === "script[data-ob-rust-checks]" ? script : null);
  playground.connectedCallback();
  assert.equal(find(playground, "ob-rust-check"), null);
});

test("checking sends the reader's code with the hidden tests in test mode, and Run still does not", async () => {
  const sent = playgroundReplies({ success: true, stdout: "test ob_checks::adds ... ok\n", stderr: "" });
  const { playground, editor } = fixture();
  editor.value = "fn add(a: u32, b: u32) -> u32 { a + b }";
  await find(playground, "ob-rust-check").click();
  await find(playground, "ob-rust-run").click();

  assert.equal(sent.length, 2);
  assert.equal(sent[0].tests, true);
  assert.equal(sent[0].crateType, "lib");
  assert.match(sent[0].code, /^fn add\(a: u32, b: u32\) -> u32 \{ a \+ b \}/);
  assert.match(sent[0].code, /assert_eq!\(add\(2, 3\), 5\)/);
  assert.equal(sent[1].tests, false);
  assert.equal(sent[1].crateType, "bin");
  assert.equal(sent[1].code, editor.value, "Run sends only what the reader wrote");
});

test("a passing check says so and shows no console output", async () => {
  playgroundReplies({ success: true, stdout: "running 1 test\ntest ob_checks::adds ... ok\n", stderr: "" });
  const { playground } = fixture();
  await find(playground, "ob-rust-check").click();

  const panel = find(playground, "ob-rust-check-panel");
  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.state, "passed");
  assert.equal(find(playground, "ob-rust-check-summary").textContent, "The check passed.");
  assert.equal(find(playground, "ob-rust-status").textContent, "The check passed.");
  assert.equal(find(playground, "ob-rust-check-list").children.length, 0);
  assert.equal(find(playground, "ob-rust-output-panel").hidden, true);
});

test("a failing check shows the author's feedback, not the raw assertion", async () => {
  playgroundReplies({
    success: false,
    stdout: "test ob_checks::adds ... FAILED\n",
    stderr: "assertion `left == right` failed\n  left: 0\n right: 5\n",
  });
  const { playground } = fixture();
  await find(playground, "ob-rust-check").click();

  assert.equal(find(playground, "ob-rust-check-panel").dataset.state, "failed");
  assert.equal(find(playground, "ob-rust-check-summary").textContent, "0 of 1 checks passed.");
  const items = find(playground, "ob-rust-check-list").children;
  assert.deepEqual(items.map((item) => item.textContent), ["Add them together."]);
  assert.equal(find(playground, "ob-rust-output-panel").hidden, true, "the assertion text would spoil the check");
  assert.equal(find(playground, "ob-rust-output").textContent, "");
});

test("code that does not compile shows the compiler output", async () => {
  playgroundReplies({ success: false, stdout: "", stderr: "error[E0308]: mismatched types\n" });
  const { playground } = fixture();
  await find(playground, "ob-rust-check").click();

  assert.equal(find(playground, "ob-rust-check-panel").dataset.state, "compile-error");
  assert.equal(find(playground, "ob-rust-status").textContent, "Your code does not compile yet.");
  assert.match(find(playground, "ob-rust-output").textContent, /E0308/);
  assert.equal(find(playground, "ob-rust-output-panel").hidden, false);
});

test("a network failure is reported, never counted as a pass or a fail", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => "1" } });
  const { playground } = fixture();
  await find(playground, "ob-rust-check").click();

  assert.equal(find(playground, "ob-rust-status").textContent, "Could not run this example here.");
  assert.match(find(playground, "ob-rust-output").textContent, /HTTP 503/);
  assert.equal(find(playground, "ob-rust-check-panel").hidden, true);
});

test("Run and Check share one request at a time, and Reset clears the verdict", async () => {
  let finish;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    await new Promise((resolve) => (finish = resolve));
    return { ok: true, headers: { get: () => "100" }, json: async () => ({ success: true, stdout: "test ob_checks::adds ... ok\n", stderr: "" }) };
  };
  const { playground } = fixture();
  const check = find(playground, "ob-rust-check");
  const run = find(playground, "ob-rust-run");
  const first = check.click();
  const duplicate = run.click();
  assert.equal(requests, 1, "a run is ignored while a check is in flight");
  finish();
  await Promise.all([first, duplicate]);
  assert.equal(find(playground, "ob-rust-check-panel").hidden, false);

  find(playground, "ob-rust-reset").click();
  assert.equal(find(playground, "ob-rust-check-panel").hidden, true);
});

import test from "node:test";
import assert from "node:assert/strict";

import { Editor, bindAssistantInteractionControl, codeInteractionMarkdown } from "../../web/admin/admin.js";

class DomNode {
  constructor(tag = "") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this._text = "";
    this.value = "";
  }
  append(...children) {
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) {
        this.children.push(child instanceof DomNode ? child : Object.assign(new DomNode("#text"), { textContent: String(child) }));
      }
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }
  click() {
    return this.listeners.click?.({ type: "click", currentTarget: this });
  }
  focus() {
    this.focused = true;
  }
  close() {
    this.open = false;
  }
  remove() {
    this.removed = true;
  }
  showModal() {
    this.open = true;
  }
  set textContent(value) {
    this._text = String(value);
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }
  querySelector(selector) {
    if (selector.startsWith("#") && this.attributes.id === selector.slice(1)) return this;
    for (const child of this.children) {
      const match = child.querySelector?.(selector);
      if (match) return match;
    }
    return null;
  }
}

const findByText = (node, tag, text) => {
  if (node.tagName === tag.toUpperCase() && node.textContent.includes(text)) return node;
  for (const child of node.children) {
    const match = findByText(child, tag, text);
    if (match) return match;
  }
  return null;
};

test("Assistant Interactions click opens the existing knowledge-check proposal dialog", () => {
  const previousNode = globalThis.Node;
  const previousElement = globalThis.HTMLElement;
  const previousDocument = globalThis.document;
  globalThis.Node = DomNode;
  globalThis.HTMLElement = DomNode;
  const body = new DomNode("body");
  globalThis.document = {
    activeElement: null,
    body,
    createElement: (tag) => new DomNode(tag),
    createTextNode: (text) => Object.assign(new DomNode("#text"), { textContent: text }),
  };
  try {
    const editor = new Editor({ meta: { quizGeneration: false } }, { kind: "posts", fields: {}, body: "Draft body" });
    editor.ui = { body: Object.assign(new DomNode("textarea"), { value: "Draft body", selectionStart: 10, selectionEnd: 10 }) };
    editor.editorMode = "markdown";
    let captured = 0;
    editor.captureVisualSelection = () => { captured += 1; };
    const button = new DomNode("button");
    bindAssistantInteractionControl(editor, button);

    button.click();

    const dialog = body.children.find((child) => child.tagName === "DIALOG");
    assert.ok(dialog);
    assert.equal(dialog.open, true);
    assert.equal(captured, 1);
    assert.match(dialog.textContent, /Add a knowledge check/);
    assert.match(dialog.textContent, /Insert/);
  } finally {
    if (previousNode === undefined) delete globalThis.Node;
    else globalThis.Node = previousNode;
    if (previousElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousElement;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("Visual knowledge-check targets preserve selection and insertion returns to the visible editor", () => {
  const previousDocument = globalThis.document;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  let markerNode;
  globalThis.document = {
    createTextNode: (text) => {
      markerNode = {
        textContent: text,
        parentNode: { normalize() {} },
        remove() {},
      };
      return markerNode;
    },
  };
  globalThis.requestAnimationFrame = (callback) => callback();
  try {
    const editor = new Editor({ meta: {} }, { kind: "posts", fields: {}, body: "Before after\n" });
    const body = {
      value: "Before after\n",
      dispatchEvent() {
        this.inputEvents = (this.inputEvents || 0) + 1;
      },
    };
    const richBody = { contains: () => true, focus() { this.focused = true; } };
    editor.ui = { body, richBody };
    editor.editorMode = "visual";
    editor.visualDirty = false;
    const range = {
      commonAncestorContainer: {},
      cloneRange() { return this; },
      toString: () => "selected words",
      collapse() {},
      insertNode() {},
    };
    editor.visualSelection = range;
    editor.richEditorMarkdown = () => `Before ${markerNode.textContent}after\n`;
    const target = editor.knowledgeCheckTarget();
    assert.deepEqual(target, { markdown: "Before after\n", at: 7, selected: "selected words" });

    let rendered = 0;
    let pane = "";
    editor.renderRichEditor = () => { rendered += 1; };
    editor.activatePane = (value) => { pane = value; };
    editor.insertKnowledgeCheckBlocks(["```quiz\nQuestion?\n- [x] Yes\n- [ ] No\n```"], target);
    assert.match(body.value, /```quiz/);
    assert.equal(body.inputEvents, 1);
    assert.equal(rendered, 1);
    assert.equal(pane, "write");
    assert.equal(richBody.focused, true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});

test("runnable-code proposals remain editable until explicit insertion", async () => {
  const previousNode = globalThis.Node;
  const previousElement = globalThis.HTMLElement;
  const previousDocument = globalThis.document;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.Node = DomNode;
  globalThis.HTMLElement = DomNode;
  globalThis.requestAnimationFrame = (callback) => callback();
  const bodyRoot = new DomNode("body");
  globalThis.document = {
    activeElement: null,
    body: bodyRoot,
    createElement: (tag) => new DomNode(tag),
    createTextNode: (text) => Object.assign(new DomNode("#text"), { textContent: text }),
  };
  try {
    let resolveFirstGeneration;
    let generationCalls = 0;
    const generated = {
      kind: "challenge",
      title: "Move the lantern",
      instructions: "Complete the ownership transfer.",
      code: "fn main() {\n    // TODO: move the lantern\n}",
      expectedOutput: "moved",
      hint: "Pass it by value.",
      explanation: "The callee owns it.",
    };
    const body = Object.assign(new DomNode("textarea"), {
      value: "# Ownership\n\nMove values safely.",
      selectionStart: 13,
      selectionEnd: 13,
      dispatchEvent() { this.inputEvents = (this.inputEvents || 0) + 1; },
    });
    const app = {
      meta: { codeInteractionGeneration: true, codeRunnerLanguages: ["rust", "web", "python"] },
      api: {
        async call(method, path, request) {
          assert.equal(method, "POST");
          assert.equal(path, "assistant/code-interaction");
          assert.equal(request.json.kind, "challenge");
          assert.equal(request.json.language, "rust");
          assert.match(request.json.context, /Ownership/);
          generationCalls += 1;
          if (generationCalls === 1) return new Promise((resolve) => { resolveFirstGeneration = resolve; });
          return generated;
        },
      },
    };
    const editor = new Editor(app, { kind: "posts", fields: {}, body: body.value });
    editor.ui = { body };
    editor.editorMode = "markdown";
    editor.captureVisualSelection = () => {};
    editor.activatePane = () => {};
    const button = new DomNode("button");
    bindAssistantInteractionControl(editor, button, "code");
    button.click();

    const dialog = bodyRoot.children.find((child) => child.tagName === "DIALOG");
    assert.ok(dialog);
    assert.match(dialog.textContent, /Add runnable code/);
    assert.match(dialog.textContent, /Python/);
    const kind = dialog.querySelector("#oba-code-interaction-kind");
    kind.value = "challenge";
    kind.listeners.change();
    const generate = findByText(dialog, "button", "Generate draft");
    const delayed = generate.click();
    dialog.querySelector("#oba-code-interaction-name").value = "My in-progress title";
    resolveFirstGeneration(generated);
    await delayed;
    assert.equal(dialog.querySelector("#oba-code-interaction-name").value, "My in-progress title", "a delayed response cannot overwrite edits");
    assert.match(dialog.textContent, /returned draft was not applied/);
    await generate.click();

    assert.equal(body.value, "# Ownership\n\nMove values safely.", "generation does not mutate the draft");
    assert.equal(dialog.querySelector("#oba-code-interaction-name").value, "Move the lantern");
    assert.match(dialog.querySelector("#oba-code-interaction-code").value, /\/\/ TODO/);

    findByText(dialog, "button", "Insert into draft").click();
    assert.match(body.value, /\*\*Coding challenge: Move the lantern\*\*/);
    assert.match(body.value, /```rust runnable title="Move the lantern"/);
    assert.match(body.value, /\*\*Expected result:\*\* moved/);
    assert.match(body.value, /> \[!TIP\]/);
    assert.equal(body.inputEvents, 1);
  } finally {
    if (previousNode === undefined) delete globalThis.Node;
    else globalThis.Node = previousNode;
    if (previousElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousElement;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});

test("code interaction Markdown escapes authored prose but preserves runnable Rust", () => {
  const markdown = codeInteractionMarkdown({
    kind: "example",
    title: "Borrow *safely*",
    instructions: "Try [this] first.",
    code: "fn main() { println!(\"ok\"); }",
    explanation: "Notice _why_ it works.",
  });
  assert.match(markdown, /Runnable example: Borrow \\\*safely\\\*/);
  assert.match(markdown, /Try \\\[this\\\] first\\\./);
  assert.match(markdown, /```rust runnable/);
  assert.match(markdown, /println!/);
});

test("code interaction Markdown emits native web and configured-runner fences", () => {
  const web = codeInteractionMarkdown({
    kind: "challenge",
    language: "web",
    title: "Reveal",
    instructions: "Complete the handler.",
    code: "---html\n<button>Reveal</button>\n---js\n// TODO: handle click",
    expectedOutput: "The text appears.",
  });
  assert.match(web, /```web runnable title="Reveal"/);
  assert.match(web, /---html/);

  const python = codeInteractionMarkdown({
    kind: "example",
    language: " Python ",
    title: "Echo",
    instructions: "Enter text.",
    code: "print(input())",
  });
  assert.match(python, /```python runnable title="Echo"/);
});

test("non-AI runnable-code authoring preserves a Visual selection and returns focus", () => {
  const previousNode = globalThis.Node;
  const previousElement = globalThis.HTMLElement;
  const previousDocument = globalThis.document;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.Node = DomNode;
  globalThis.HTMLElement = DomNode;
  globalThis.requestAnimationFrame = (callback) => callback();
  const bodyRoot = new DomNode("body");
  let markerNode;
  globalThis.document = {
    activeElement: null,
    body: bodyRoot,
    createElement: (tag) => new DomNode(tag),
    createTextNode: (text) => {
      const node = Object.assign(new DomNode("#text"), { textContent: text, parentNode: { normalize() {} } });
      node.remove = () => {};
      if (text.startsWith("OPENBLOGKNOWLEDGECHECKCURSOR")) markerNode = node;
      return node;
    },
  };
  try {
    const body = Object.assign(new DomNode("textarea"), {
      value: "Before after\n",
      dispatchEvent() { this.inputEvents = (this.inputEvents || 0) + 1; },
    });
    const richBody = new DomNode("div");
    richBody.contains = () => true;
    const editor = new Editor({ meta: { codeInteractionGeneration: false } }, { kind: "posts", fields: {}, body: body.value });
    editor.ui = { body, richBody };
    editor.editorMode = "visual";
    editor.visualDirty = false;
    editor.visualSelection = {
      commonAncestorContainer: {},
      cloneRange() { return this; },
      toString: () => "selected words",
      collapse() {},
      insertNode() {},
    };
    editor.captureVisualSelection = () => {};
    editor.richEditorMarkdown = () => `Before ${markerNode.textContent}after\n`;
    let rendered = 0;
    editor.renderRichEditor = () => { rendered += 1; };
    editor.activatePane = () => {};

    editor.openCodeInteraction();
    const dialog = bodyRoot.children.find((child) => child.tagName === "DIALOG");
    assert.ok(dialog);
    assert.equal(findByText(dialog, "button", "Generate draft"), null, "manual authoring does not require a provider");
    dialog.querySelector("#oba-code-interaction-name").value = "Borrow once";
    dialog.querySelector("#oba-code-interaction-instructions").value = "Run the complete example.";
    dialog.querySelector("#oba-code-interaction-code").value = "fn main() { println!(\"borrowed\"); }";
    findByText(dialog, "button", "Insert into draft").click();

    assert.match(body.value, /^Before\s+\*\*Runnable example: Borrow once\*\*/);
    assert.match(body.value, /```rust runnable/);
    assert.match(body.value, /after$/m);
    assert.equal(body.inputEvents, 1);
    assert.equal(rendered, 1);
    assert.equal(richBody.focused, true);
  } finally {
    if (previousNode === undefined) delete globalThis.Node;
    else globalThis.Node = previousNode;
    if (previousElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousElement;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});

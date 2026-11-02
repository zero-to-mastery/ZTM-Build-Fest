import test from "node:test";
import assert from "node:assert/strict";

import { Editor, assistantStatusPresentation, bindAssistantAutocompleteControls } from "../../web/admin/admin.js";

function markdownEditor(call) {
  const editor = new Editor({ meta: {}, api: { call } }, { kind: "posts", path: "posts/draft.md", fields: {}, body: "" });
  const value = "The lantern opened into a quiet hall";
  const body = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    },
    dispatchEvent() {
      this.inputEvents = (this.inputEvents || 0) + 1;
    },
    focus() {
      this.focused = true;
    },
  };
  editor.ui = {
    body,
    title: { value: "Unsaved title" },
    assistantCompletion: { hidden: true },
    assistantCompletionText: { textContent: "" },
    assistantAutocompleteStatus: { textContent: "" },
  };
  editor.editorMode = "markdown";
  editor.assistantAutocompleteEnabled = true;
  editor.assistantAutocompleteGeneration = 1;
  editor.assistantContextSelected = new Set(["portable:author"]);
  editor.collect = () => ({ draft: "true" });
  return editor;
}

test("autocomplete status exposes the provider capability", () => {
  assert.match(assistantStatusPresentation({ configured: true, capabilities: { autocomplete: true } }).capabilities, /Autocomplete/);
});

test("Markdown autocomplete sends the bounded unsaved snapshot and inserts only after acceptance", async () => {
  let outbound;
  const editor = markdownEditor(async (method, path, request) => {
    outbound = { method, path, request };
    return { completion: " beyond the rain." };
  });

  await editor.requestAssistantAutocomplete(1);

  assert.equal(outbound.method, "POST");
  assert.equal(outbound.path, "assistant/complete");
  assert.equal(outbound.request.json.source.markdown, "The lantern opened into a quiet hall");
  assert.equal(outbound.request.json.source.editorMode, "markdown");
  assert.deepEqual(outbound.request.json.contextIds, ["portable:author"]);
  assert.equal(editor.ui.body.value, "The lantern opened into a quiet hall", "a returned completion is still only a proposal");
  assert.equal(editor.ui.assistantCompletion.hidden, false);

  assert.equal(editor.acceptAssistantCompletion(), true);
  assert.equal(editor.ui.body.value, "The lantern opened into a quiet hall beyond the rain.");
  assert.equal(editor.ui.body.inputEvents, 1);
  assert.equal(editor.ui.assistantCompletion.hidden, true);
});

test("autocomplete drops a response after the draft or caret generation changes", async () => {
  let resolve;
  const provider = new Promise((done) => (resolve = done));
  const editor = markdownEditor(() => provider);
  const request = editor.requestAssistantAutocomplete(1);
  editor.ui.body.value += ".";
  editor.ui.body.selectionStart = editor.ui.body.selectionEnd = editor.ui.body.value.length;
  editor.assistantAutocompleteGeneration = 2;
  resolve({ completion: " stale text" });
  await request;

  assert.equal(editor.ui.assistantCompletion.hidden, true);
  assert.equal(editor.ui.body.value, "The lantern opened into a quiet hall.");
});

test("autocomplete drops responses after title, metadata, or selected context changes", async () => {
  for (const change of [
    (editor) => (editor.ui.title.value = "Changed title"),
    (editor) => (editor.collect = () => ({ draft: "false" })),
    (editor) => editor.assistantContextSelected.add("portable:site"),
  ]) {
    let resolve;
    const provider = new Promise((done) => (resolve = done));
    const editor = markdownEditor(() => provider);
    const request = editor.requestAssistantAutocomplete(1);
    change(editor);
    resolve({ completion: " stale text" });
    await request;
    assert.equal(editor.ui.assistantCompletion.hidden, true);
  }
});

test("mounted autocomplete controls require opt-in and wire input, Tab, and Escape", () => {
  const ui = {
    body: new EventTarget(),
    richBody: new EventTarget(),
    assistantAutocompleteToggle: Object.assign(new EventTarget(), { checked: false }),
    assistantCompletion: { hidden: false },
  };
  const calls = [];
  const editor = {
    scheduleAssistantAutocomplete: () => calls.push("schedule"),
    setAssistantAutocomplete: (enabled) => calls.push(`enabled:${enabled}`),
    acceptAssistantCompletion: () => calls.push("accept"),
    dismissAssistantCompletion: () => calls.push("dismiss"),
  };
  bindAssistantAutocompleteControls(editor, ui);

  ui.body.dispatchEvent(new Event("input"));
  ui.assistantAutocompleteToggle.checked = true;
  ui.assistantAutocompleteToggle.dispatchEvent(new Event("change"));
  const tab = new Event("keydown", { cancelable: true });
  Object.defineProperty(tab, "key", { value: "Tab" });
  ui.body.dispatchEvent(tab);
  const escape = new Event("keydown", { cancelable: true });
  Object.defineProperty(escape, "key", { value: "Escape" });
  ui.richBody.dispatchEvent(escape);

  assert.deepEqual(calls, ["schedule", "enabled:true", "accept", "dismiss"]);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(escape.defaultPrevented, true);
});

test("disposing an editor cancels and invalidates an in-flight autocomplete request", async () => {
  let resolve;
  let signal;
  const provider = new Promise((done) => (resolve = done));
  const editor = markdownEditor((_method, _path, request) => {
    signal = request.signal;
    return provider;
  });
  const request = editor.requestAssistantAutocomplete(1);
  editor.dispose();
  assert.equal(signal?.aborted, true);
  resolve({ completion: " should never appear" });
  await request;
  assert.equal(editor.ui.assistantCompletion.hidden, true);
  assert.equal(editor.assistantAutocompleteEnabled, false);
});

test("Visual autocomplete inserts plain text through the existing visual dirty path", () => {
  const editor = markdownEditor(async () => ({ completion: "" }));
  const textNode = { nodeType: 3 };
  const inserted = [];
  const range = {
    startContainer: textNode,
    startOffset: 4,
    endContainer: textNode,
    endOffset: 4,
    deleteContents() {},
    insertNode(node) {
      inserted.push(node.textContent);
    },
    setStartAfter() {},
    collapse() {},
  };
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges() {},
    addRange() {},
  };
  const previousSelection = globalThis.getSelection;
  const previousDocument = globalThis.document;
  globalThis.getSelection = () => selection;
  globalThis.document = { createTextNode: (text) => ({ textContent: text }) };
  try {
    editor.editorMode = "visual";
    editor.ui.richBody = { focus() { this.focused = true; } };
    editor.assistantCompletionCapture = {
      mode: "visual",
      markdown: editor.ui.body.value,
      range,
      title: "Unsaved title",
      metadata: { draft: "true" },
      contextIds: ["portable:author"],
    };
    editor.assistantCompletionText = " softly";
    let visualChanges = 0;
    editor.visualChanged = () => {
      visualChanges += 1;
    };

    assert.equal(editor.acceptAssistantCompletion(), true);
    assert.deepEqual(inserted, [" softly"]);
    assert.equal(visualChanges, 1);
    assert.equal(editor.ui.richBody.focused, true);
  } finally {
    if (previousSelection === undefined) delete globalThis.getSelection;
    else globalThis.getSelection = previousSelection;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

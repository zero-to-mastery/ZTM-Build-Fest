import test from "node:test";
import assert from "node:assert/strict";

import { Editor, VOICE_REQUEST_BUDGET, assistantContextDisclosure, assistantContextLabel, assistantReviewSummary, assistantVoiceBudget } from "../../web/admin/admin.js";

const sample = (name, characters, extra = {}) => ({
  id: `voice:private:${name}`,
  kind: "voiceSample",
  name,
  path: `.openblog/private/context/voice/${name}`,
  visibility: "private",
  stage: "rough",
  pack: "stories",
  prompt: "a-mistake-i-made",
  characters,
  exists: true,
  valid: true,
  ...extra,
});

test("a voice sample is disclosed with its stage, pack, visibility and size", () => {
  const document = sample("2026-10-28-a-mistake-i-made-rough.md", 120);
  assert.equal(assistantContextLabel(document), ".openblog/private/context/voice/2026-10-28-a-mistake-i-made-rough.md · Voice sample · rough · stories · Private · 120 characters");
  const disclosure = assistantContextDisclosure([document], new Set([document.id]));
  assert.deepEqual(disclosure.documents[0], { name: document.name, visibility: "private", characters: 120, kind: "voiceSample", path: document.path, stage: "rough", pack: "stories" });
  assert.equal(disclosure.totalCharacters, 120);
  assert.deepEqual(assistantReviewSummary({ context: [document], selectedContextIds: new Set([document.id]) }).context, [assistantContextLabel(document)]);
});

test("existing context kinds keep their disclosure wording", () => {
  const author = { id: "portable:author", name: "author.md", visibility: "portable", characters: 5, exists: true, valid: true };
  assert.equal(assistantContextLabel(author), "author.md · Portable · 5 characters");
  assert.deepEqual(assistantContextDisclosure([author], new Set([author.id])).documents, [{ name: "author.md", visibility: "portable", characters: 5 }]);
});

test("the voice budget counts selected, valid samples only", () => {
  const documents = [sample("a-rough.md", 100), sample("b-rough.md", 50), sample("c-rough.md", 10, { valid: false }), { id: "portable:author", name: "author.md", characters: 999999, exists: true, valid: true }];
  const budget = assistantVoiceBudget(documents, new Set(documents.map((document) => document.id)));
  assert.equal(budget.samples, 2);
  assert.equal(budget.characters, 150);
  assert.equal(budget.over, false);
  assert.equal(budget.message, "");
  assert.equal(assistantVoiceBudget(documents, new Set()).samples, 0);
});

test("a selection over the request budget is refused with a plain reason", () => {
  const tooMany = Array.from({ length: VOICE_REQUEST_BUDGET.samples + 1 }, (_, index) => sample(`s${index}-rough.md`, 10));
  const many = assistantVoiceBudget(tooMany, new Set(tooMany.map((document) => document.id)));
  assert.equal(many.over, true);
  assert.match(many.message, /at most 8/);
  const tooLong = [sample("long-rough.md", VOICE_REQUEST_BUDGET.characters + 1)];
  const long = assistantVoiceBudget(tooLong, new Set([tooLong[0].id]));
  assert.equal(long.over, true);
  assert.match(long.message, /at most 120000/);
  const custom = assistantVoiceBudget(tooLong, new Set([tooLong[0].id]), { samples: 2, characters: 500000 });
  assert.equal(custom.over, false);
});

function autocompleteEditor(call, documents, selected) {
  const editor = new Editor({ meta: {}, api: { call } }, { kind: "posts", path: "posts/draft.md", fields: {}, body: "" });
  const value = "The lantern opened into a quiet hall";
  editor.ui = {
    body: { value, selectionStart: value.length, selectionEnd: value.length },
    title: { value: "Unsaved title" },
    assistantCompletion: { hidden: true },
    assistantCompletionText: { textContent: "" },
    assistantAutocompleteStatus: { textContent: "" },
  };
  editor.editorMode = "markdown";
  editor.assistantAutocompleteEnabled = true;
  editor.assistantAutocompleteGeneration = 1;
  editor.assistantContextDocuments = documents;
  editor.assistantContextSelected = new Set(selected);
  editor.collect = () => ({ draft: "true" });
  return editor;
}

test("autocomplete refuses an over-budget voice selection before any request", async () => {
  const calls = [];
  const documents = Array.from({ length: 9 }, (_, index) => sample(`s${index}-rough.md`, 10));
  const editor = autocompleteEditor(async (...args) => calls.push(args), documents, documents.map((document) => document.id));
  await editor.requestAssistantAutocomplete(1);
  assert.deepEqual(calls, []);
  assert.match(editor.ui.assistantAutocompleteStatus.textContent, /at most 8/);
});

test("autocomplete names selected voice samples by id and sends nothing else about them", async () => {
  const calls = [];
  const documents = [sample("a-rough.md", 10)];
  const editor = autocompleteEditor(async (method, path, request) => {
    calls.push({ method, path, request });
    return { completion: "" };
  }, documents, [documents[0].id]);
  await editor.requestAssistantAutocomplete(1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].request.json.contextIds, ["voice:private:a-rough.md"]);
  assert.equal(JSON.stringify(calls[0].request).includes("characters"), false, "the browser names a sample; it never supplies its text or size");
});

// ---- proposing and approving a voice guide (#456) -------------------------------------------

import { voiceGuideDiffLines, voiceGuideSaveRequest, voiceGuidePortableNote } from "../../web/admin/admin.js";

test("a diff is classified line by line and never relies on colour alone", () => {
  const lines = voiceGuideDiffLines("--- voice.md (saved)\n+++ voice.md (proposed)\n@@ -1,2 +1,2 @@\n # Voice guide\n-- Likes lists\n+- Starts with so\n");
  assert.deepEqual(lines.map((line) => line.kind), ["header", "header", "header", "context", "remove", "add"]);
  assert.equal(lines[4].text, "-- Likes lists");
  assert.deepEqual(voiceGuideDiffLines(""), []);
});

test("a save request carries the revision the proposal was made against and an explicit destination", () => {
  const proposal = { targets: { portable: { exists: true, valid: true, etag: "abc" }, private: { exists: false, valid: true, etag: null } } };
  assert.deepEqual(voiceGuideSaveRequest(proposal, "portable", "# Voice guide\n"), { contextType: "voice", visibility: "portable", content: "# Voice guide\n", etag: "abc" });
  assert.deepEqual(voiceGuideSaveRequest(proposal, "private", "# Voice guide\n"), { contextType: "voice", visibility: "private", content: "# Voice guide\n", etag: null });
  assert.equal(voiceGuideSaveRequest(proposal, "everyone", "x"), null);
  assert.equal(voiceGuideSaveRequest(proposal, "portable", "   "), null);
  assert.equal(voiceGuideSaveRequest({ targets: { portable: { exists: true, valid: false, etag: "x" } } }, "portable", "x"), null);
  assert.equal(voiceGuideSaveRequest({}, "portable", "x"), null);
});

function guideEditor(call, documents, selected) {
  const editor = new Editor({ meta: {}, api: { call } }, { kind: "posts", path: "posts/draft.md", fields: {}, body: "" });
  const node = () => ({ textContent: "", disabled: false, replaceChildren(...children) { this.children = children; }, focus() { this.focused = true; } });
  editor.ui = { voiceGuideStatus: node(), voiceGuidePropose: node(), voiceGuideResult: node() };
  editor.assistantContextDocuments = documents;
  editor.assistantContextSelected = new Set(selected);
  editor.assistantProviderStatus = { destination: "https://assistant.example" };
  editor.assistantStatusLoaded = true;
  return editor;
}

test("proposing a guide names the selected samples and writes nothing; a failure leaves no guide", async () => {
  const documents = [sample("a-rough.md", 10)];
  const calls = [];
  const editor = guideEditor(async (method, path, request) => {
    calls.push({ method, path, request });
    return { markdown: "# Voice guide\n", diff: "+# Voice guide\n", targets: {}, current: { exists: false } };
  }, documents, [documents[0].id, "portable:author"]);
  editor.field = (_id, _label, control) => control;
  editor.renderVoiceGuideProposal = () => {};
  await editor.proposeVoiceGuide();
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [["POST", "assistant/voice-guide"]]);
  assert.deepEqual(calls[0].request.json, { sampleIds: ["voice:private:a-rough.md"] });
  assert.match(editor.ui.voiceGuideStatus.textContent, /Nothing is saved until you choose Save/);

  const failing = guideEditor(async () => {
    throw new Error("The provider's voice guide was rejected because a quote does not occur. Nothing was shown.");
  }, documents, [documents[0].id]);
  await failing.proposeVoiceGuide();
  assert.equal(failing.voiceGuideProposal, null);
  assert.match(failing.ui.voiceGuideStatus.textContent, /Your files are unchanged/);
});

test("proposing with no sample, or over budget, makes no request", async () => {
  const calls = [];
  const none = guideEditor(async (...args) => calls.push(args), [sample("a-rough.md", 10)], []);
  await none.proposeVoiceGuide();
  const many = Array.from({ length: 9 }, (_, index) => sample(`s${index}-rough.md`, 10));
  const over = guideEditor(async (...args) => calls.push(args), many, many.map((document) => document.id));
  await over.proposeVoiceGuide();
  assert.deepEqual(calls, []);
  assert.match(none.ui.voiceGuideStatus.textContent, /Select at least one voice sample/);
  assert.match(over.ui.voiceGuideStatus.textContent, /at most 8/);
});

test("saving writes only through the context save with an explicit destination, and discarding writes nothing", async () => {
  const calls = [];
  const editor = guideEditor(async (method, path, request) => {
    calls.push({ method, path, request });
    return {};
  }, [], []);
  editor.voiceGuideProposal = { targets: { portable: { exists: false, valid: true, etag: null }, private: { exists: true, valid: true, etag: "r1" } } };
  editor.renderVoiceGuideProposal = () => {};
  editor.loadAssistantContext = async () => {};
  editor.discardVoiceGuide();
  assert.deepEqual(calls, []);
  assert.equal(editor.voiceGuideProposal, null);

  editor.voiceGuideProposal = { targets: { portable: { exists: false, valid: true, etag: null }, private: { exists: true, valid: true, etag: "r1" } } };
  await editor.saveVoiceGuide("private", "# Voice guide\n- mine\n");
  assert.deepEqual(calls, [{ method: "PUT", path: "assistant/context", request: { json: { contextType: "voice", visibility: "private", content: "# Voice guide\n- mine\n", etag: "r1" } } }]);
  assert.match(editor.ui.voiceGuideStatus.textContent, /saved as private/);
});

// ---- voice match reuses the apply and undo path (#459) -----------------------------------------

import { applyAssistantSuggestion } from "../../web/admin/admin.js";

test("an anchored voice-match suggestion applies to exactly its passage and the original text comes back from the same finding", () => {
  const markdown = "Opening.\n\nIt is what it is, and so on.";
  const finding = { evidence: "It is what it is", suggestion: "That is that", range: { start: 10, end: 26 } };
  const applied = applyAssistantSuggestion(markdown, finding);
  assert.equal(applied.ok, true);
  assert.equal(applied.markdown, "Opening.\n\nThat is that, and so on.");
  // Undo restores the text from the evidence the review quoted.
  const undone = applyAssistantSuggestion(applied.markdown, { evidence: finding.suggestion, suggestion: finding.evidence, range: { start: applied.start, end: applied.end } });
  assert.equal(undone.markdown, markdown);
});

test("an advice-only voice-match finding has no replacement to apply", () => {
  const advice = { evidence: "Words the author never wrote", suggestion: null, range: { start: 0, end: 0 } };
  assert.deepEqual(applyAssistantSuggestion("Opening.", advice), { ok: false, error: "This finding does not include an applicable replacement." });
  assert.equal(applyAssistantSuggestion("Opening.", { ...advice, suggestion: "Warmer" }).ok, false, "evidence that is not in the draft is never applied");
});

// ---- autocomplete discloses the voice guide before it is enabled (#460) --------------------------

import { assistantAutocompleteDisclosure } from "../../web/admin/admin.js";

const guideDocument = { id: "portable:voice", name: "voice.md", contextType: "voice", visibility: "portable", characters: 321, exists: true, valid: true };

test("the autocomplete disclosure lists the voice guide when it is selected, and nothing when no context is", () => {
  assert.equal(assistantAutocompleteDisclosure([guideDocument], new Set()), "");
  const text = assistantAutocompleteDisclosure([guideDocument], new Set([guideDocument.id]));
  assert.match(text, /voice\.md · Voice guide · Portable · 321 characters/);
  assert.match(text, /Each suggestion also sends the selected context/);
  assert.equal(assistantContextLabel({ ...guideDocument, visibility: "private" }), "voice.md · Voice guide · Private · 321 characters");
});

test("turning autocomplete on names the selected voice guide; the request names it by id", async () => {
  const calls = [];
  const editor = autocompleteEditor(async (method, path, request) => {
    calls.push({ method, path, request });
    return path === "assistant/status" ? { configured: true, capabilities: { autocomplete: true } } : { completion: "" };
  }, [guideDocument], [guideDocument.id]);
  editor.ui.assistantAutocompleteToggle = { checked: true };
  editor.loadAssistantStatus = async () => ({ configured: true, capabilities: { autocomplete: true } });
  await editor.setAssistantAutocomplete(true);
  assert.match(editor.ui.assistantAutocompleteStatus.textContent, /AI autocomplete is on\./);
  assert.match(editor.ui.assistantAutocompleteStatus.textContent, /voice\.md · Voice guide/);
  await editor.requestAssistantAutocomplete(editor.assistantAutocompleteGeneration);
  const completion = calls.find((call) => call.path === "assistant/complete");
  assert.deepEqual(completion.request.json.contextIds, ["portable:voice"]);

  const plain = autocompleteEditor(async () => ({ configured: true, capabilities: { autocomplete: true } }), [guideDocument], []);
  plain.ui.assistantAutocompleteToggle = { checked: true };
  plain.loadAssistantStatus = async () => ({ configured: true, capabilities: { autocomplete: true } });
  await plain.setAssistantAutocomplete(true);
  assert.equal(plain.ui.assistantAutocompleteStatus.textContent, "AI autocomplete is on. Suggestions appear after you pause typing; nothing is inserted automatically.");
});

test("a guide quoting private samples cannot be saved as portable", async () => {
  const targets = { portable: { exists: false, valid: true, etag: null }, private: { exists: false, valid: true, etag: null } };
  const proposal = { portableAllowed: false, targets };
  assert.equal(voiceGuideSaveRequest(proposal, "portable", "# Voice guide\n"), null);
  assert.equal(voiceGuideSaveRequest(proposal, "private", "# Voice guide\n").visibility, "private");
  assert.equal(voiceGuideSaveRequest({ portableAllowed: true, targets }, "portable", "x").visibility, "portable");

  assert.equal(voiceGuidePortableNote(proposal), "Quotes private samples; save as private");
  assert.equal(voiceGuidePortableNote({ portableAllowed: true }), "");
});

test("a proposal offers Save as private first, as the default, and Save as portable as a plain choice", async () => {
  const { withDom } = await import("./dom-shim.mjs");
  await withDom(async () => {
    const editor = guideEditor(async () => ({}), [], []);
    editor.field = (_id, _label, control) => control;
    editor.voiceGuideProposal = { markdown: "# Voice guide\n", diff: "", targets: {}, current: { exists: false }, portableAllowed: true };
    editor.renderVoiceGuideProposal();
    const buttons = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.tagName === "BUTTON" && node.dataset?.voiceGuideSave) buttons.push(node);
      for (const child of node.childNodes || []) walk(child);
    };
    for (const child of editor.ui.voiceGuideResult.children) walk(child);
    assert.deepEqual(buttons.map((b) => b.dataset.voiceGuideSave), ["private", "portable"]);
    assert.match(buttons[0].className, /oba-btn-primary/);
    assert.doesNotMatch(buttons[1].className, /oba-btn-primary/);
  })();
});

test("a merged voice guide is joined only once every change is decided, from the server's own lines", async () => {
  const { voiceGuideAssemble, voiceGuidePendingChanges } = await import("../../web/admin/admin.js");
  const lines = [
    "# Voice guide",
    "",
    "## Word choice",
    "",
    "- Says honestly: \"honestly it was\" (b.md)",
    { change: 0, current: "- Says plainly: \"plain words\" (gone.md) (one sample)", proposed: "- Says plainly, lower case: \"so i deleted\" (a.md) (one sample)" },
    "",
    "## What is not yet known",
    "",
    "- Endings",
  ];
  const merge = { changes: 1, lines };
  assert.equal(voiceGuideAssemble(lines, {}), null);
  assert.equal(voiceGuidePendingChanges(merge, {}), 1);
  assert.equal(voiceGuidePendingChanges(merge, { 0: "maybe" }), 1);
  const kept = voiceGuideAssemble(lines, { 0: "current" });
  assert.equal(kept, "# Voice guide\n\n## Word choice\n\n- Says honestly: \"honestly it was\" (b.md)\n- Says plainly: \"plain words\" (gone.md) (one sample)\n\n## What is not yet known\n\n- Endings\n");
  const taken = voiceGuideAssemble(lines, { 0: "proposed" });
  assert.ok(taken.includes("- Says plainly, lower case: "));
  assert.ok(!taken.includes("(gone.md)"));
  assert.equal(voiceGuidePendingChanges(merge, { 0: "proposed" }), 0);
  assert.equal(voiceGuideAssemble(["# Voice guide"], {}), "# Voice guide\n");
});

test("a kept trait's quote check is explained and the trait reads the way the guide writes it", async () => {
  const { voiceGuideCheckNote, voiceGuideTraitText } = await import("../../web/admin/admin.js");
  assert.equal(voiceGuideCheckNote("verified"), "");
  assert.match(voiceGuideCheckNote("sample-missing"), /no longer exists.*It is kept/);
  assert.match(voiceGuideCheckNote("not-in-sample"), /no longer word for word/);
  assert.equal(voiceGuideTraitText({ statement: "Plain", quote: "so i", sample: "a.md", oneSample: true }), "Plain: \"so i\" (a.md) (one sample)");
});

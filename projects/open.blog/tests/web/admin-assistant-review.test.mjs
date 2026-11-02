import test from "node:test";
import assert from "node:assert/strict";

import { Editor, applyAssistantSuggestion, assistantReviewGroups, assistantReviewSourceChanged, assistantReviewSummary } from "../../web/admin/admin.js";

test("assistant suggestions use Unicode code-point ranges and preserve unrelated text", () => {
  assert.deepEqual(applyAssistantSuggestion("Lead 🏮 glows", { evidence: "🏮", suggestion: "lantern", range: { start: 5, end: 6 } }), {
    ok: true,
    markdown: "Lead lantern glows",
    start: 5,
    sourceEnd: 6,
    end: 12,
  });
});

test("assistant suggestions re-anchor only one exact stale evidence match", () => {
  assert.equal(applyAssistantSuggestion("New intro. Draft body", { evidence: "Draft body", suggestion: "A clear guide", range: { start: 0, end: 10 } }).markdown, "New intro. A clear guide");
  assert.deepEqual(applyAssistantSuggestion("Draft body and Draft body", { evidence: "Draft body", suggestion: "A clear guide", range: { start: 50, end: 60 } }), {
    ok: false,
    error: "The reviewed text now appears more than once. Nothing was changed.",
  });
  assert.equal(applyAssistantSuggestion("Completely rewritten", { evidence: "Draft body", suggestion: "A clear guide", range: { start: 0, end: 10 } }).ok, false);
});

test("document review disclosure names every selected input before sending", () => {
  assert.deepEqual(
    assistantReviewSummary({
      title: "Unsaved title",
      markdown: "Draft body",
      skills: [{ id: "copy-review", name: "Copy review", version: "1.0.0" }],
      selectedSkillIds: new Set(["copy-review"]),
      context: [{ id: "private:author", name: "author.md", visibility: "private", characters: 42 }],
      selectedContextIds: new Set(["private:author"]),
      provider: { providerType: "generic-https", model: "writer-v1", destination: "https://assistant.example" },
    }),
    {
      scope: "Complete document",
      sourceCharacters: 24,
      skills: ["Copy review · 1.0.0"],
      context: ["author.md · Private · 42 characters"],
    provider: "Custom HTTPS · writer-v1 · https://assistant.example",
      research: "Off",
    },
  );
});

test("review disclosure distinguishes references and existing-post snapshots", () => {
  assert.deepEqual(
    assistantReviewSummary({
      context: [
        { id: "portable:reference:style.txt", name: "style.txt", visibility: "portable", kind: "reference", characters: 12 },
        { id: "post:posts/guide.md", name: "guide.md", path: "posts/guide.md", visibility: "source", kind: "postSnapshot", characters: 50 },
      ],
      selectedContextIds: new Set(["portable:reference:style.txt", "post:posts/guide.md"]),
    }).context,
    ["style.txt · Portable · 12 characters", "posts/guide.md · Post snapshot · 50 characters"],
  );
});

test("validated findings are grouped by skill and labelled as AI-generated advice", () => {
  const groups = assistantReviewGroups(
    {
      findings: [
        { id: "f1", skillId: "copy-review", severity: "medium", title: "Clarify this", evidence: "Draft", explanation: "Vague opening." },
        { id: "f2", skillId: "technical-review", severity: "note", title: "Verify claim", evidence: "always", explanation: "Needs support." },
      ],
    },
    [
      { id: "copy-review", name: "Copy review", version: "1.0.0" },
      { id: "technical-review", name: "Technical review", version: "1.0.0" },
    ],
  );
  assert.deepEqual(groups.map(({ id, name, label, findings }) => ({ id, name, label, ids: findings.map((finding) => finding.id) })), [
    { id: "copy-review", name: "Copy review", label: "AI-generated advice", ids: ["f1"] },
    { id: "technical-review", name: "Technical review", label: "AI-generated advice", ids: ["f2"] },
  ]);
});

test("review completion detects when the editor moved beyond the submitted snapshot", () => {
  const submitted = { title: "Draft", metadata: { draft: "true" }, markdown: "Original" };
  assert.equal(assistantReviewSourceChanged(submitted, { ...submitted }), false);
  assert.equal(assistantReviewSourceChanged(submitted, { ...submitted, markdown: "New edit" }), true);
});

test("controlled provider response renders through the mounted Review UI without changing the draft", async () => {
  class DomNode {
    constructor(tag = "") {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.listeners = {};
      this._text = "";
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = children;
      this._text = "";
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    }
    dispatchEvent(event) {
      this.dispatchedEvent = event;
      this.listeners[event.type]?.(event);
      return true;
    }
    click() {
      this.listeners.click?.({ type: "click", currentTarget: this, preventDefault() {} });
    }
    focus() {
      this.focused = true;
    }
    set textContent(value) {
      this._text = String(value);
      this.children = [];
    }
    get textContent() {
      return this._text + this.children.map((child) => child.textContent).join("");
    }
  }

  const previousNode = globalThis.Node;
  const previousDocument = globalThis.document;
  globalThis.Node = DomNode;
  globalThis.document = {
    createElement: (tag) => new DomNode(tag),
    createTextNode: (text) => {
      const node = new DomNode("#text");
      node.textContent = text;
      return node;
    },
  };
  try {
    let submitted;
    const calls = [];
    const app = {
      meta: {},
      api: {
        call: async (method, path, request) => {
          calls.push(path);
          if (path === "assistant/status") {
            return {
              providerType: "generic-https",
              model: "writer-v1",
              destination: "https://assistant.example",
              configured: true,
              capabilities: { review: true },
              message: "Assistant provider is ready.",
            };
          }
          submitted = { method, path, request };
          return {
            findings: [
              {
                id: "finding-1",
                skillId: "copy-review",
                severity: "medium",
                category: "clarity",
                title: "Clarify the opening",
                evidence: "Draft body",
                range: { start: 0, end: 10 },
                explanation: "Name the specific audience.",
                suggestion: "Draft body for new readers",
                verification: "unverified-advice",
              },
            ],
          };
        },
      },
    };
    const editor = new Editor(app, { kind: "posts", path: "posts/draft.md", fields: {}, credits: null });
    editor.ui = {
      title: { value: "Unsaved title" },
      body: Object.assign(new DomNode("textarea"), { value: "Draft body" }),
      assistantReviewRun: { disabled: false },
      assistantReviewUndo: Object.assign(new DomNode("button"), { hidden: true }),
      assistantReviewStatus: new DomNode("p"),
      assistantReviewResults: Object.assign(new DomNode("section"), { attributes: { role: "region", "aria-label": "Review results" } }),
      assistantStatus: new DomNode("p"),
      assistantStatusBadge: Object.assign(new DomNode("span"), { dataset: {} }),
      assistantProviderType: new DomNode("dd"),
      assistantModel: new DomNode("dd"),
      assistantDestination: new DomNode("dd"),
      assistantConfigured: new DomNode("dd"),
      assistantCapabilities: new DomNode("dd"),
    };
    editor.collect = () => ({ draft: "true" });
    let disclosedDestination = "";
    editor.renderAssistantReviewSummary = () => {
      disclosedDestination = editor.assistantProviderStatus?.destination || "";
    };
    editor.selectedAssistantSkills = new Set(["copy-review"]);
    editor.assistantContextSelected = new Set(["private:author"]);
    editor.assistantSkills = [{ id: "copy-review", name: "Copy review" }];
    editor.assistantAppliedFindingIds = new Set(["finding-1"]);
    editor.assistantAppliedReviewRanges = [{ start: 0, end: 10 }];
    editor.assistantSuggestionUndo = { before: "old", after: "older" };
    editor.ui.assistantReviewUndo.hidden = false;

    await editor.runAssistantReview();

    assert.deepEqual(calls, ["assistant/status", "assistant/review"]);
    assert.equal(disclosedDestination, "https://assistant.example");
    assert.deepEqual(submitted, {
      method: "POST",
      path: "assistant/review",
      request: {
        json: {
          source: { title: "Unsaved title", metadata: { draft: "true" }, markdown: "Draft body" },
          skillIds: ["copy-review"],
          contextIds: ["private:author"],
        },
      },
    });
    assert.equal(editor.ui.body.value, "Draft body");
    assert.equal(editor.ui.assistantReviewResults.textContent.includes("AI-generated advice"), true);
    assert.equal(editor.ui.assistantReviewResults.textContent.includes("Clarify the opening"), true);
    assert.equal(editor.ui.assistantReviewResults.attributes["aria-label"], "Review results");
    assert.equal(editor.ui.assistantReviewResults.focused, true);
    assert.equal(editor.ui.assistantReviewStatus.textContent, "1 AI-generated finding. Your draft is unchanged.");
    assert.deepEqual([...editor.assistantAppliedFindingIds], [], "a completed fresh review resets retired finding IDs");
    assert.deepEqual(editor.assistantAppliedReviewRanges, [], "a completed fresh review resets prior changed ranges");
    assert.equal(editor.ui.assistantReviewUndo.hidden, true);

    const descendants = (node) => [node, ...(node.children || []).flatMap(descendants)];
    const applyButton = descendants(editor.ui.assistantReviewResults).find((node) => node.tagName === "BUTTON" && node.textContent === "Apply suggestion");
    assert.ok(applyButton);
    applyButton.click();
    assert.equal(editor.ui.body.value, "Draft body for new readers");
    assert.equal(applyButton.disabled, true);
    assert.equal(editor.ui.assistantReviewUndo.hidden, false);
    assert.equal(editor.ui.assistantReviewStatus.textContent.includes("unsaved draft"), true);
    assert.equal(calls.length, 2, "applying is local and does not save or call the provider");

    applyButton.click();
    assert.equal(editor.ui.body.value, "Draft body for new readers", "the same finding cannot be applied twice");
    assert.equal(editor.applyAssistantReviewFinding({ id: "overlap", evidence: "body for", suggestion: "guide for", range: { start: 6, end: 14 } }), false);
    assert.equal(editor.ui.body.value, "Draft body for new readers", "an overlapping finding fails closed");

    assert.equal(editor.undoAssistantSuggestion(), true);
    assert.equal(editor.ui.body.value, "Draft body");
    assert.equal(applyButton.disabled, false);
    assert.equal(editor.ui.assistantReviewUndo.hidden, true);
    assert.equal(calls.length, 2, "undoing is local and does not save or call the provider");

    editor.ui.body.value = "alpha beta beta";
    assert.equal(editor.applyAssistantReviewFinding({ id: "delete", evidence: "alpha beta", suggestion: "", range: { start: 0, end: 10 } }), true);
    assert.equal(editor.ui.body.value, " beta");
    assert.equal(
      editor.applyAssistantReviewFinding({ id: "inside-deletion", evidence: "beta", suggestion: "gamma", range: { start: 6, end: 10 } }),
      false,
      "a finding whose reviewed range was consumed by a deletion cannot re-anchor elsewhere",
    );
    assert.equal(editor.ui.body.value, " beta");
    assert.equal(editor.undoAssistantSuggestion(), true);

    editor.ui.body.value = "one two three";
    assert.equal(editor.applyAssistantReviewFinding({ id: "first", evidence: "one", suggestion: "ONE", range: { start: 0, end: 3 } }), true);
    assert.equal(editor.applyAssistantReviewFinding({ id: "second", evidence: "two", suggestion: "TWO", range: { start: 4, end: 7 } }), true);
    assert.equal(editor.undoAssistantSuggestion(), true);
    editor.ui.body.value += "!";
    assert.equal(
      editor.applyAssistantReviewFinding({ id: "third", evidence: "three", suggestion: "THREE", range: { start: 8, end: 13 } }),
      false,
      "manual edits after undo still stale the review while an earlier application remains",
    );
    assert.equal(editor.ui.body.value, "ONE two three!");
  } finally {
    if (previousNode === undefined) delete globalThis.Node;
    else globalThis.Node = previousNode;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("a selection or section review sends a bounded passage in code points (ADR 0290)", async () => {
  const { assistantReviewPassage, assistantSkillSupportsScope, ASSISTANT_REVIEW_MAX_PASSAGE } = await import("../../web/admin/admin.js");
  const markdown = "Intro words.\n\n## One\n\nBody one.\n\n### Deeper\n\nMore.\n\n## Two\n\nBody two.";
  // A selection is trimmed of the whitespace around it.
  const at = markdown.indexOf("Body one.");
  assert.deepEqual(assistantReviewPassage(markdown, at - 2, at + 9, "selection"), { passage: { kind: "selection", start: at, end: at + 9 }, text: "Body one." });
  assert.deepEqual(assistantReviewPassage(markdown, at, at, "selection"), { error: "Select some text in the draft first." });
  // A section runs from the heading before the cursor to the next heading.
  const section = assistantReviewPassage(markdown, at + 2, at + 2, "section");
  assert.equal(section.text, "## One\n\nBody one.");
  assert.equal(section.passage.start, markdown.indexOf("## One"));
  // Before any heading, the section starts at the top.
  assert.equal(assistantReviewPassage(markdown, 3, 3, "section").text, "Intro words.");
  // The last section ends at the end.
  assert.equal(assistantReviewPassage(markdown, markdown.length, markdown.length, "section").text, "## Two\n\nBody two.");
  // Offsets count Unicode code points, as the server and the findings do.
  assert.deepEqual(assistantReviewPassage("😀 one two", 3, 6, "selection").passage, { kind: "selection", start: 2, end: 5 });
  assert.match(assistantReviewPassage("x".repeat(ASSISTANT_REVIEW_MAX_PASSAGE + 1), 0, ASSISTANT_REVIEW_MAX_PASSAGE + 1, "selection").error, /longer than/);
  assert.ok(assistantReviewPassage(markdown, 0, 4, "document").error);
  // A `#` comment inside fenced code is not a heading: the section is still the one around it.
  const code = "Intro.\n\n## Install\n\n```bash\n# install deps\nnpm ci\n```\n\nThen run it.\n\n~~~\n## not a heading either\n~~~\n\nDone.\n\n## Next\n\nLater.";
  const install = code.slice(code.indexOf("## Install"), code.indexOf("## Next")).trim();
  for (const cursor of [code.indexOf("Then run"), code.indexOf("npm ci"), code.indexOf("Install") + 2, code.indexOf("Done.")]) {
    const found = assistantReviewPassage(code, cursor, cursor, "section");
    assert.equal(found.text, install, `cursor at ${cursor}`);
    assert.equal(found.passage.start, code.indexOf("## Install"));
  }
  assert.equal(assistantReviewPassage(code, code.indexOf("## Next"), code.indexOf("## Next"), "section").text, "## Next\n\nLater.");
  // A skill is offered only for a scope it declares.
  assert.equal(assistantSkillSupportsScope({ scopes: ["selection", "section"] }, "document"), false);
  assert.equal(assistantSkillSupportsScope({ scopes: ["selection", "section"] }, "section"), true);
  assert.equal(assistantSkillSupportsScope({}, "document"), false);
});

test("the review disclosure names the scope that will be sent", () => {
  assert.equal(assistantReviewSummary({ scope: "selection" }).scope, "Selected text");
  assert.equal(assistantReviewSummary({ scope: "section" }).scope, "Current section");
  assert.equal(assistantReviewSummary({}).scope, "Complete document");
});

// The Before and after entry of Add something: the form, the picture picker, the engine's refusals
// shown inline, and the Visual editor's block for a `compare` fence (#498, ADR 0291).
import assert from "node:assert/strict";
import test from "node:test";

import { parseVisualMarkdown, visualBlocksToMarkdown } from "../../web/admin/admin.js";
import { buildPieceForm, editableBlockKind, openPieceDialog, parsePieceFence } from "../../web/admin/block-forms.js";
import { installDom, tick } from "./dom-shim.mjs";

const compare = {
  kind: "compare",
  label: "Before and after",
  summary: "Two pictures of the same thing, with a slider to compare them.",
  fields: [
    { name: "before", label: "Before picture", hint: "", input: "image", required: true, max: 2048 },
    { name: "before-alt", label: "Before description", hint: "", input: "text", required: true, max: 250 },
    { name: "after", label: "After picture", hint: "", input: "image", required: true, max: 2048 },
    { name: "after-alt", label: "After description", hint: "", input: "text", required: true, max: 250 },
    { name: "before-caption", label: "Before caption", hint: "", input: "text", required: false, max: 200 },
    { name: "after-caption", label: "After caption", hint: "", input: "text", required: false, max: 200 },
  ],
};
const FENCE = "```compare\nbefore: /images/a.jpg\nbefore-alt: The old floor\nafter: /images/b.jpg\nafter-alt: The new floor\n```\n";

const all = (root, selector) => root.querySelectorAll(selector);
const button = (root, text) => all(root, "button").find((node) => node.textContent === text);
const field = (root, label) => {
  const row = all(root, "label").find((node) => node.textContent === label);
  assert.ok(row, `no field labelled ${label}`);
  return root.querySelector(`#${row.attributes.for}`);
};

test("a compare fence is a protected block with its own label and an edit form", () => {
  assert.equal(parseVisualMarkdown(FENCE).find((block) => block.type === "protected")?.label, "Before and after");
  assert.equal(visualBlocksToMarkdown(parseVisualMarkdown(FENCE)), FENCE, "byte stable");
  assert.deepEqual(parsePieceFence(FENCE, compare).values[1], ["before-alt", "The old floor"]);
  assert.equal(editableBlockKind("Before and after", FENCE, [compare]), "piece");
  // A field the form does not have, or a repeat, would be lost: the block stays protected.
  assert.equal(editableBlockKind("Before and after", FENCE.replace("```\n", "after-label: Done\n```\n"), [compare]), "");
  assert.equal(editableBlockKind("Before and after", FENCE.replace("```\n", "after: /c.jpg\n```\n"), [compare]), "");
});

test("choosing a file uploads it and writes its address into the picture field", async () => {
  const dom = installDom();
  try {
    const uploads = [];
    const form = buildPieceForm(compare, [], { upload: async (file) => (uploads.push(file.name), file.name === "bad.jpg" ? null : `/images/${file.name}`) });
    const picker = all(form.element, "input").find((node) => node.attributes["data-picture-for"] === "before");
    picker.files = [{ name: "floor-before.jpg" }];
    await picker.dispatch("change");
    assert.deepEqual(form.values().slice(0, 1), [["before", "/images/floor-before.jpg"]]);
    picker.files = [{ name: "bad.jpg" }];
    await picker.dispatch("change");
    assert.equal(field(form.element, "Before picture (required)").value, "/images/floor-before.jpg", "a failed upload keeps what was there");
    assert.match(form.element.textContent, /bad\.jpg could not be uploaded/);
    assert.equal(all(form.element, "input").filter((node) => node.attributes["data-picture-for"]).length, 2);
    const without = buildPieceForm(compare);
    assert.equal(all(without.element, "input").filter((node) => node.attributes["data-picture-for"]).length, 0);
  } finally {
    dom.restore();
  }
});

test("the dialog lists Before and after, sends only what was filled in, and inserts what the engine wrote", async () => {
  const dom = installDom();
  try {
    const built = [];
    const inserted = [];
    const { dialog } = openPieceDialog({
      pieces: [compare],
      build: async (kind, values) => (built.push([kind, values]), { markdown: FENCE }),
      onInsert: (markdown) => (inserted.push(markdown), ""),
    });
    all(dialog, ".oba-piece-choice")[0].click();
    field(dialog, "Before picture (required)").value = "/images/a.jpg";
    field(dialog, "Before description (required)").value = "The old floor";
    field(dialog, "After picture (required)").value = "/images/b.jpg";
    field(dialog, "After description (required)").value = "The new floor";
    await button(dialog, "Insert").click();
    await tick();
    assert.deepEqual(built, [["compare", [["before", "/images/a.jpg"], ["before-alt", "The old floor"], ["after", "/images/b.jpg"], ["after-alt", "The new floor"]]]]);
    assert.deepEqual(inserted, [FENCE]);
  } finally {
    dom.restore();
  }
});

test("the engine's refusals appear inside the dialog and nothing is inserted", async () => {
  const dom = installDom();
  try {
    let inserted = 0;
    const problems = ["the before picture needs a description for people who cannot see it; add a `before-alt:` line"];
    const { dialog } = openPieceDialog({
      pieces: [compare],
      build: async () => ({ problems }),
      onInsert: () => (inserted++, ""),
    });
    all(dialog, ".oba-piece-choice")[0].click();
    await button(dialog, "Insert").click();
    await tick();
    const shown = all(dialog, ".oba-bf-problems")[0];
    assert.equal(shown.hidden, false);
    assert.match(shown.textContent, /needs a description for people who cannot see it/);
    assert.equal(inserted, 0);
    assert.ok(dialog.isConnected || dialog.parentNode, "the dialog stays open");
  } finally {
    dom.restore();
  }
});

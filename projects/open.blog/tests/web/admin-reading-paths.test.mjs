import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  pathFollowedIndex,
  readingPathDraft,
  readingPathErrorText,
  readingPathListText,
  readingPathMoveStep,
  readingPathMoveText,
  readingPathNewStep,
  readingPathOrder,
  readingPathPayload,
  readingPathProblems,
  readingPathSame,
  readingPathStateText,
  readingPathStepId,
} from "../../web/admin/admin.js";

// The editor's model, against the golden file the Rust contract tests round-trip byte for byte
// (crates/openblog-core/tests/fixtures/reading-path.json): one fixture, both sides.
const golden = JSON.parse(readFileSync(new URL("../../crates/openblog-core/tests/fixtures/reading-path.json", import.meta.url), "utf8"));
const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
const RELATIONSHIPS = ["next", "background", "builds-on", "contrasts-with", "responds-to", "applies", "influenced"].map((value) => ({ value }));
const without = (file) => {
  const { format: _format, version: _version, ...rest } = file;
  return rest;
};

test("the golden file survives the editor model unchanged, unknown fields included", () => {
  const draft = readingPathDraft(golden, "golden");
  assert.equal(draft.slug, "golden");
  assert.deepEqual(readingPathPayload(draft), without(golden));
  // Reading the payload back gives the same draft, so a form save is a fixed point.
  assert.ok(readingPathSame(draft, readingPathDraft(readingPathPayload(draft), "golden")));
  // The unknown top-level field is carried untouched.
  assert.deepEqual(draft["x-future"], { kept: [1, 2] });
});

test("empty optional fields are left out and listed defaults are not written", () => {
  const draft = readingPathDraft(golden, "g");
  draft.summary = "   ";
  draft.listed = true;
  draft.steps[0].rationale = "";
  draft.steps[0].difficulty = "";
  draft.steps[1].transition.basis = "stale";
  const payload = readingPathPayload(draft);
  assert.equal("summary" in payload, false);
  assert.equal("listed" in payload, false);
  assert.equal("rationale" in payload.steps[0], false);
  assert.equal("difficulty" in payload.steps[0], false);
  // A basis belongs to influenced alone.
  assert.equal("basis" in payload.steps[1].transition, false);
  draft.listed = false;
  assert.equal(readingPathPayload(draft).listed, false);
});

test("a step that moves to the front keeps its reason in memory but the file never carries it", () => {
  const draft = readingPathDraft(golden, "g");
  const moved = readingPathMoveStep(draft.steps, 1, 0);
  assert.equal(moved.index, 0);
  draft.steps = moved.steps;
  assert.equal(draft.steps[0].id, "plato");
  assert.equal(draft.steps[0].transition.why, "The first step assumes some knowledge of the man who wrote the image.");
  const payload = readingPathPayload(draft);
  assert.equal("transition" in payload.steps[0], false);
  // The step that moved down now follows something and needs words of its own.
  assert.ok(readingPathProblems(draft, RELATIONSHIPS).some((p) => p.step === "cave" && /Choose how/.test(p.message)));
  // Moving back restores it exactly.
  draft.steps = readingPathMoveStep(draft.steps, 0, 1).steps;
  assert.equal(readingPathPayload(draft).steps[1].transition.why, golden.steps[1].transition.why);
});

test("moving clamps, never loses a step and never reorders on a no-op", () => {
  const steps = ["a", "b", "c"].map((id) => ({ id }));
  assert.deepEqual(readingPathOrder(readingPathMoveStep(steps, 2, 0).steps), ["c", "a", "b"]);
  assert.deepEqual(readingPathOrder(readingPathMoveStep(steps, 0, 99).steps), ["b", "c", "a"]);
  assert.deepEqual(readingPathOrder(readingPathMoveStep(steps, 1, -5).steps), ["b", "a", "c"]);
  assert.equal(readingPathMoveStep(steps, 1, 1).steps, steps);
  assert.equal(readingPathMoveStep(steps, 7, 0).steps, steps);
  assert.equal(readingPathMoveText("Alpha", 1, 3), "Moved Alpha to position 2 of 3.");
});

test("a step follows the nearest earlier step that is not optional", () => {
  const steps = [{ optional: false }, { optional: true }, { optional: true }, { optional: false }];
  assert.equal(pathFollowedIndex(steps, 0), -1);
  assert.equal(pathFollowedIndex(steps, 1), 0);
  assert.equal(pathFollowedIndex(steps, 2), 0);
  assert.equal(pathFollowedIndex(steps, 3), 0);
});

test("new steps get unique plain ids and start without words, so the author writes them", () => {
  const steps = [];
  const one = readingPathNewStep(steps, "post", "The Cave!");
  assert.equal(one.id, "the-cave");
  assert.deepEqual(one.target, { kind: "post", slug: "The Cave!" });
  assert.deepEqual(one.transition, { relationship: "", why: "" });
  steps.push(one);
  assert.equal(readingPathStepId(steps, "post", "the cave"), "the-cave-2");
  assert.equal(readingPathNewStep(steps, "atlas", "plato").target.kind, "atlas");
  assert.equal(readingPathStepId([], "post", "日本語"), "post");
  assert.ok(readingPathStepId([], "post", "x".repeat(200)).length <= 64);
});

test("problems the server would refuse are found before sending, scoped to the step", () => {
  const draft = readingPathDraft(golden, "golden");
  assert.deepEqual(readingPathProblems(draft, RELATIONSHIPS), []);
  draft.title = " ";
  draft.steps[1].transition.why = "";
  draft.steps[2].transition.relationship = "";
  draft.steps[0].optional = true;
  const problems = readingPathProblems(draft, RELATIONSHIPS);
  assert.ok(problems.some((p) => p.step === null && /title/.test(p.message)));
  assert.ok(problems.some((p) => p.step === "plato" && /Say why/.test(p.message)));
  assert.ok(problems.some((p) => p.step === "stoics" && /Choose how/.test(p.message)));
  assert.ok(problems.some((p) => p.step === "cave" && /cannot be optional/.test(p.message)));
  // Influence joins two atlas entries and needs its basis.
  const posts = readingPathDraft({ title: "T", steps: [{ id: "a", target: { kind: "post", slug: "a" } }, { id: "b", target: { kind: "post", slug: "b" }, transition: { relationship: "influenced", why: "w" } }] }, "t");
  const found = readingPathProblems(posts, RELATIONSHIPS).map((p) => p.message).join("|");
  assert.match(found, /Influence joins two atlas entries/);
  assert.match(found, /Influence needs the id/);
  // A repeated target and a bad address name.
  const twice = readingPathDraft({ title: "T", steps: [{ id: "a", target: { kind: "post", slug: "x" } }, { id: "b", target: { kind: "post", slug: "x" }, transition: { relationship: "next", why: "w" } }] }, "Bad Slug");
  const messages = readingPathProblems(twice, RELATIONSHIPS).map((p) => p.message).join("|");
  assert.match(messages, /already a step/);
  assert.match(messages, /address name/);
});

test("step states are said in words, and an unpublished step says readers will not see it", () => {
  assert.deepEqual(readingPathStateText({ state: "published" }), { text: "Published", published: true });
  for (const state of ["draft", "scheduled", "missing", "unpublished"]) {
    const info = readingPathStateText({ state });
    assert.equal(info.published, false, state);
    assert.match(info.text, /readers will not see this step/, state);
  }
  assert.equal(readingPathStateText(undefined).published, null);
});

test("server messages are shown as the server wrote them and never as a stack", () => {
  assert.match(readingPathErrorText({ data: { conflict: true } }), /changed somewhere else/);
  assert.match(readingPathErrorText({ data: { exists: true } }), /already exists/);
  assert.equal(readingPathErrorText({ data: { error: "Plain" } }), "Plain");
  assert.match(readingPathErrorText(new Error("boom")), /boom/);
  assert.match(readingPathErrorText({}), /Nothing was changed/);
  assert.match(readingPathListText({ valid: false, firstProblem: "broken" }), /Cannot be read: broken/);
  assert.match(readingPathListText({ valid: true, status: "published", steps: 1, shown: false }), /not shown to readers yet/);
  assert.equal(readingPathListText({ valid: true, status: "draft", steps: 2 }), "Draft · 2 steps");
});

test("the view is keyboard operable, labelled and never drag-only", () => {
  const view = admin.slice(admin.indexOf("async showReadingPathEditor"), admin.indexOf("// ---- research source library"));
  assert.ok(view.length > 1000);
  // No drag handling at all: reorder is by Move up and Move down.
  assert.doesNotMatch(view, /draggable|dragstart|dragover|ondrop/);
  assert.match(view, /Move \$\{title\} up/);
  assert.match(view, /aria-live": "polite"/);
  assert.match(view, /aria-required/);
  assert.match(view, /aria-pressed/);
  assert.match(view, /role: "group", "aria-label": `Order of step/);
  // Text from the server is only ever set as text, never as HTML.
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML/);
  // Unpublished steps are never offered: the picker reads the targets route only.
  assert.match(view, /reading-paths\/targets/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  comparisonAttributionAs,
  comparisonAttributionLabel,
  comparisonDraft,
  comparisonErrorText,
  comparisonEvidenceText,
  comparisonLeftOutText,
  comparisonListText,
  comparisonNewExplanation,
  comparisonNewId,
  comparisonNewInterpretation,
  comparisonPayload,
  comparisonProblems,
  comparisonSame,
  comparisonSetOrigin,
  comparisonStandingText,
} from "../../web/admin/admin.js";

// The editor's model, against the golden file the Rust contract tests round-trip byte for byte
// (crates/openblog-core/tests/fixtures/scholarly-comparison.json): one fixture, both sides.
const golden = JSON.parse(readFileSync(new URL("../../crates/openblog-core/tests/fixtures/scholarly-comparison.json", import.meta.url), "utf8"));
const without = (file) => {
  const { format: _format, version: _version, ...rest } = file;
  return rest;
};

test("the golden file survives the editor model unchanged, unknown fields and approvals included", () => {
  const draft = comparisonDraft(golden, "golden");
  assert.equal(draft.slug, "golden");
  assert.deepEqual(comparisonPayload(draft), without(golden));
  assert.ok(comparisonSame(draft, comparisonDraft(comparisonPayload(draft), "golden")));
  assert.equal(draft["x-note"], "kept as written");
  // The approval travels untouched, so a form save keeps the one the server stored.
  assert.equal(draft.explanations[0].approval.by, "The author");
});

test("empty optional fields are left out of what a save sends", () => {
  const draft = comparisonDraft(golden, "golden");
  draft.interpretations[0].uncertainty = "  ";
  draft.interpretations[0].language = "";
  draft.explanations[1].about = "";
  draft.relations[0].note = "";
  const out = comparisonPayload(draft);
  assert.ok(!("uncertainty" in out.interpretations[0]));
  assert.ok(!("language" in out.interpretations[0]));
  assert.ok(!("about" in out.explanations[1]));
  assert.ok(!("note" in out.relations[0]));
});

test("an author-written item is sent with no origin and an AI draft keeps its label", () => {
  const item = comparisonSetOrigin(comparisonNewExplanation([], "student"), true, "an assistant");
  assert.deepEqual(item.origin, { kind: "ai-draft", tool: "an assistant" });
  const out = comparisonPayload({ ...comparisonDraft(null, "x"), explanations: [item] });
  assert.equal(out.explanations[0].origin.tool, "an assistant");
  // Clearing the AI mark withdraws any approval along with it: a person's own words need none.
  item.approval = { by: "me", at: "2026-10-27T10:00:00Z", digest: "d" };
  comparisonSetOrigin(item, false);
  assert.ok(!("origin" in item) && !("approval" in item));
});

test("ids are unique lowercase slugs and new items carry no default attribution name", () => {
  const items = [{ id: "reading" }, { id: "reading-2" }];
  assert.equal(comparisonNewId(items, "Reading"), "reading-3");
  assert.equal(comparisonNewId([], "  !!! "), "item");
  assert.equal(comparisonNewInterpretation(items).attribution.name, "");
  const x = comparisonNewExplanation([], "scholarly", "political");
  assert.deepEqual([x.level, x.about, x.id], ["scholarly", "political", "scholarly-political"]);
  assert.deepEqual(comparisonAttributionAs({ kind: "named", name: "N", certainty: "uncertain" }, "anonymous"), { kind: "anonymous", description: "", certainty: "uncertain" });
});

test("local problems name the item and ask for attribution, text and the tool", () => {
  const draft = comparisonDraft(golden, "golden");
  assert.deepEqual(comparisonProblems(draft), []);
  draft.interpretations[1].attribution = comparisonAttributionAs(draft.interpretations[1].attribution, "named");
  draft.explanations[0].origin = { kind: "ai-draft", tool: " " };
  const found = comparisonProblems(draft).map((p) => [p.item, p.message]);
  assert.ok(found.some(([item, message]) => item === "epistemic" && /who held/i.test(message)));
  assert.ok(found.some(([item, message]) => item === "cave-beginner" && /AI tool/.test(message)));
  assert.ok(comparisonProblems({ ...draft, slug: "Bad Slug", title: "" }).some((p) => p.item === null));
});

test("states and errors are worded, not coloured", () => {
  assert.match(comparisonStandingText({ standing: "awaiting-approval" }), /not approved: readers do not see it/);
  assert.match(comparisonStandingText({ standing: "stale" }), /approve it again/);
  assert.match(comparisonEvidenceText({ state: "private" }), /readers will not see/);
  assert.match(comparisonEvidenceText({ state: "missing" }), /Not found/);
  assert.match(comparisonErrorText({ data: { stale: true } }), /Nothing was approved/);
  assert.match(comparisonErrorText({ data: { conflict: true } }), /Nothing was saved/);
  assert.match(comparisonListText({ valid: true, status: "published", interpretations: 2, explanations: 1, awaitingApproval: 1, shown: false }), /waiting for your approval.*not shown to readers/);
  assert.match(comparisonLeftOutText({ id: "easy", reason: "awaiting-approval" }), /AI draft not approved/);
  assert.equal(comparisonAttributionLabel({ kind: "source", source: "s" }, [{ id: "s", title: "Slings" }]), "Slings");
});

test("the editor never builds an approval itself", () => {
  const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
  const start = admin.indexOf("// ---- interpretation comparisons");
  const end = admin.indexOf("// ---- research source library");
  const block = admin.slice(start, end);
  assert.ok(!/\bapproval\s*=\s*\{/.test(block) && !/approval:\s*\{/.test(block), "only the server stamps an approval");
  assert.match(block, /comparisons\/\$\{approve \? "approve" : "revoke"\}/);
});

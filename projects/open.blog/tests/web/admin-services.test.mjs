// The Services screen's pure contract (ADR 0313, #511): the form read from a stored document, the fields a
// save sends (flattened `faq.<n>.*` keys, unknown keys kept), the checks that match the build's rules, and
// the server's problem sentences placed on the right entry. The screen itself is driven in a real browser
// at 400px (tests/browser/services.spec.mjs).
import assert from "node:assert/strict";
import test from "node:test";

import {
  LIMITS,
  PRICE_BAND_CHOICES,
  blankService,
  faqSlots,
  fieldsFromForm,
  formFromDocument,
  isServiceId,
  problemsFromServer,
  serviceErrorText,
  slugId,
  validateForm,
} from "../../web/admin/services.js";

const STORED = {
  version: "1",
  id: "hardwood-install",
  name: "Hardwood installation",
  summary: "Solid oak or maple floors.",
  includes: ["Removing the old floor", "Two coats of finish"],
  priceBand: "2k-10k",
  typicalTimeline: "2 to 4 days",
  "faq.1.question": "Can you match my floor?",
  "faq.1.answer": "Usually.",
  "faq.2.question": "Do I move out?",
  "faq.2.answer": "No.",
  "faq.10.question": "Tenth?",
  "faq.10.answer": "Yes.",
  future: "kept",
};

test("a stored service reads into the form in numeric question order and keeps unknown keys", () => {
  const form = formFromDocument(STORED, "Long text.\n");
  assert.equal(form.id, "hardwood-install");
  assert.deepEqual(form.includes, ["Removing the old floor", "Two coats of finish"]);
  assert.deepEqual(form.faq.map((entry) => entry.question), ["Can you match my floor?", "Do I move out?", "Tenth?"]);
  assert.deepEqual(form.extra, { future: "kept" });
  assert.equal(form.draft, false);
  assert.equal(form.body, "Long text.\n");
});

test("a save sends the form's answers, renumbered from 1, with every unknown key as it was", () => {
  const form = formFromDocument(STORED, "x");
  assert.deepEqual(fieldsFromForm(form), {
    version: "1",
    id: "hardwood-install",
    name: "Hardwood installation",
    summary: "Solid oak or maple floors.",
    includes: ["Removing the old floor", "Two coats of finish"],
    priceBand: "2k-10k",
    typicalTimeline: "2 to 4 days",
    "faq.1.question": "Can you match my floor?",
    "faq.1.answer": "Usually.",
    "faq.2.question": "Do I move out?",
    "faq.2.answer": "No.",
    "faq.3.question": "Tenth?",
    "faq.3.answer": "Yes.",
    future: "kept",
  });
});

test("removing a question leaves no stale flattened keys, and blank entries are not written", () => {
  const form = formFromDocument(STORED, "");
  form.faq.splice(0, 1);
  form.faq.push({ question: "  ", answer: "" });
  const fields = fieldsFromForm(form);
  assert.equal(fields["faq.1.question"], "Do I move out?");
  assert.equal(fields["faq.2.question"], "Tenth?");
  assert.ok(!("faq.3.question" in fields));
  assert.deepEqual(faqSlots(form), [0, 1]);
  const bare = fieldsFromForm(blankService());
  assert.deepEqual(bare, { version: "1" });
});

test("a draft is written with draft true and a published service has no draft key", () => {
  const form = formFromDocument({ ...STORED, draft: "true" }, "");
  assert.equal(form.draft, true);
  assert.equal(fieldsFromForm(form).draft, "true");
  form.draft = false;
  assert.ok(!("draft" in fieldsFromForm(form)));
});

test("ids follow the build's rule and a name makes a good one", () => {
  assert.equal(slugId("Hardwood floor installation!"), "hardwood-floor-installation");
  assert.equal(slugId("  Café & Bar  "), "cafe-bar");
  assert.ok(slugId("x".repeat(100)).length <= LIMITS.id);
  for (const good of ["a", "tile", "hardwood-install", "r2-d2"]) assert.ok(isServiceId(good), good);
  for (const bad of ["", "Tile", "two words", "-a", "a-", "page", "x".repeat(61)]) assert.ok(!isServiceId(bad), bad);
});

test("problems are plain, say which field, and match the build's rules", () => {
  assert.deepEqual(validateForm(formFromDocument(STORED, "")), []);
  const form = formFromDocument(STORED, "");
  Object.assign(form, { id: "Bad Id", name: "", summary: "a\nb", priceBand: "cheap", typicalTimeline: "t".repeat(81) });
  form.faq[1] = { question: "Only a question", answer: "" };
  form.faq[2] = { question: "", answer: "Only an answer" };
  const problems = validateForm(form);
  assert.deepEqual(problems.map((p) => p.field).sort(), ["faq", "faq", "id", "name", "priceBand", "summary", "typicalTimeline"].sort());
  const answer = problems.find((p) => p.field === "faq" && p.index === 1);
  assert.deepEqual([answer.part, answer.message], ["answer", "Add an answer."]);
  assert.equal(problems.find((p) => p.field === "faq" && p.index === 2).part, "question");
  for (const problem of problems) assert.ok(!/[<>]|undefined|null/.test(problem.message), problem.message);
});

test("a draft only needs an id and the list limits are the build's", () => {
  const draft = { ...blankService(), draft: true, id: "gutters" };
  assert.deepEqual(validateForm(draft), []);
  assert.equal(validateForm({ ...draft, id: "" }).length, 1);
  const many = formFromDocument(STORED, "");
  many.includes = Array.from({ length: LIMITS.includes + 1 }, (_, i) => `item ${i}`);
  many.faq = Array.from({ length: LIMITS.faq + 1 }, (_, i) => ({ question: `q${i}`, answer: "a" }));
  const fields = validateForm(many).map((p) => p.field);
  assert.ok(fields.includes("includes") && fields.includes("faq"));
});

test("the price band choices are the jobs' cost bands, in words, never numbers to add up", () => {
  assert.deepEqual(PRICE_BAND_CHOICES.map(([value]) => value), ["under-500", "500-2k", "2k-10k", "10k-50k", "over-50k", "ask"]);
  assert.equal(PRICE_BAND_CHOICES[1][1], "$500 to $2,000");
});

test("the server's sentences land on the field and the entry they are about", () => {
  const slots = [0, 2];
  const problems = problemsFromServer(
    [
      "services/hardwood.md: summary: use 1 to 300 characters of plain text on one line; faq entry 2: add an answer; faq entry 1: add a question and an answer, or remove the entry",
      "services/hardwood.md: priceBand: `cheap` is not a price band; use one of under-500, 500-2k",
      "A build problem with no field",
    ],
    slots,
  );
  assert.deepEqual(problems[0], { field: "summary", message: "Use 1 to 300 characters of plain text on one line." });
  assert.deepEqual(problems[1], { field: "faq", message: "Add an answer.", index: 2, part: "answer" });
  assert.deepEqual(problems[2], { field: "faq", message: "Add a question and an answer, or remove the entry.", index: 0 });
  assert.equal(problems[3].field, "priceBand");
  assert.deepEqual(problems[4], { field: "", message: "A build problem with no field." });
  assert.deepEqual(problemsFromServer(undefined), []);
});

test("error words say what to do", () => {
  assert.match(serviceErrorText({ status: 409 }), /Reload it/);
  assert.match(serviceErrorText({ status: 413 }), /too much/);
  assert.match(serviceErrorText({ status: 500, message: "Boom" }), /not saved\. Boom/);
  assert.match(serviceErrorText({}), /Check your connection/);
});

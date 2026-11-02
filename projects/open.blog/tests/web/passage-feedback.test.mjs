// The browser and hosted-function half of the typed-feedback contract (ADRs
// 0079 to 0081): the same fixtures as crates/openblog-core/tests/
// scholarly_feedback.rs, so the hosted function refuses and stores exactly what
// the build would, plus purity, the copy fallback and hostile input.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FEEDBACK_KINDS,
  MAX_SUBMISSION_JSON_BYTES,
  canonicalTime,
  feedbackCopyText,
  isWorkPath,
  readFeedbackSubmissionJson,
  receiveFeedback,
  submissionValue,
} from "../../web/components/passage-feedback.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/scholarly-feedback.json", import.meta.url), "utf8"));
const textOf = (item) => item.text ?? JSON.stringify(item.submission);

test("accepted fixtures produce the records the build produces", () => {
  for (const item of fixture.accepted) {
    const read = readFeedbackSubmissionJson(textOf(item));
    assert.equal(read.ok, true, `${item.name}: ${JSON.stringify(read.error)}`);
    assert.ok(Object.isFrozen(read.submission), item.name);
    const again = readFeedbackSubmissionJson(JSON.stringify(submissionValue(read.submission)));
    assert.deepEqual(again.submission, read.submission, item.name);
    assert.deepEqual(receiveFeedback(read.submission, fixture.receivedAt), item.record, item.name);
  }
});

test("refused fixtures report the build's codes and never repeat the reader's text", () => {
  for (const item of fixture.refused) {
    const read = readFeedbackSubmissionJson(textOf(item));
    assert.equal(read.ok, false, `${item.name}: should be refused`);
    assert.equal(read.error.code, item.code, item.name);
    assert.equal(read.error.target, item.target, item.name);
    for (const secret of ["ada@example.org", "secret", "Ring", "ecalovel", "irony"]) {
      assert.ok(!read.error.message.includes(secret), `${item.name}: ${read.error.message}`);
    }
  }
});

test("oversized submissions are refused before parsing", () => {
  const text = `{"pad":"${"a".repeat(MAX_SUBMISSION_JSON_BYTES)}"}`;
  assert.equal(readFeedbackSubmissionJson(text).error.code, "tooLarge");
  // Bytes, not UTF-16 units, as the build counts them.
  const wide = `{"pad":"${"é".repeat(MAX_SUBMISSION_JSON_BYTES / 2)}"}`;
  assert.equal(readFeedbackSubmissionJson(wide).error.code, "tooLarge");
});

test("reading is pure: inputs are untouched and records are fresh objects", () => {
  const item = fixture.accepted[1];
  const text = textOf(item);
  const first = readFeedbackSubmissionJson(text);
  const second = readFeedbackSubmissionJson(text);
  assert.notEqual(first.submission, second.submission);
  const record = receiveFeedback(first.submission, fixture.receivedAt);
  record.provenance.attribution.name = "changed";
  assert.equal(first.submission.attribution.name, "Ada Lovelace");
  assert.throws(() => receiveFeedback(first.submission, "2026-10-26T10:00:00.000Z"), TypeError);
  assert.throws(() => receiveFeedback(first.submission, fixture.receivedAt, "email"), TypeError);
});

test("a later seenAt is dropped, an earlier or equal one kept", () => {
  const base = readFeedbackSubmissionJson(textOf(fixture.accepted[1])).submission;
  assert.equal(receiveFeedback(base, "2026-10-26T09:58:00Z").provenance.seenAt, "2026-10-26T09:58:00Z");
  assert.equal(Object.hasOwn(receiveFeedback(base, "2026-10-26T09:57:59Z").provenance, "seenAt"), false);
});

test("the copy fallback is plain text whose last line the author can enter as is", () => {
  const submission = readFeedbackSubmissionJson(textOf(fixture.accepted[2])).submission;
  const text = feedbackCopyText(submission, "https://blog.example/posts/tides/");
  assert.match(text, /^Suggested correction about https:\/\/blog\.example\/posts\/tides\//);
  assert.match(text, /All of section #tides/);
  assert.match(text, /Suggested wording: The sun matters less\./);
  const last = text.split("\n").at(-1);
  const again = readFeedbackSubmissionJson(last);
  assert.equal(again.ok, true);
  assert.deepEqual(again.submission, submission);

  const quoted = readFeedbackSubmissionJson(textOf(fixture.accepted[0])).submission;
  assert.match(feedbackCopyText(quoted), /^Question about \/posts\/tides\/\nPassage: “The sun matters too\.” in section #tides/);
  const named = readFeedbackSubmissionJson(textOf(fixture.accepted[3])).submission;
  assert.match(feedbackCopyText(named), /Name: Grace \(not for publication\)/);
});

test("kinds name intent, and only a suggested correction needs a passage", () => {
  assert.deepEqual(Object.keys(FEEDBACK_KINDS), ["question", "source-suggestion", "correction-suggestion", "alternative-interpretation"]);
  assert.equal(FEEDBACK_KINDS["correction-suggestion"].label, "Suggested correction");
  for (const [id, rules] of Object.entries(FEEDBACK_KINDS)) {
    assert.match(id, /^[a-z][a-z0-9-]{0,39}$/);
    assert.equal(rules.workTarget, id !== "correction-suggestion");
  }
});

test("work paths and database times follow the build's rules", () => {
  assert.equal(isWorkPath("/旅の日記/"), true);
  for (const path of ["/", "posts/", "/a//b/", "/a/./", "/a\\b/", "/a b/", "/a\u0085b/", 7]) assert.equal(isWorkPath(path), false, String(path));
  assert.equal(canonicalTime("2026-10-26T10:00:00+00:00"), "2026-10-26T10:00:00Z");
  assert.equal(canonicalTime(new Date("2026-10-26T10:00:00.400Z")), "2026-10-26T10:00:00Z");
  assert.equal(canonicalTime("not a time"), null);
});

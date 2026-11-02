// The browser and hosted-function half of evidence submissions (ADR 0116): the same fixtures as
// crates/openblog-core/tests/evidence_corrections.rs, so the form and the hosted function refuse
// and store exactly what the build would, plus the dispatching reader, the copy fallback and
// hostile input. Nothing here can say whether an id the reader named exists.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EVIDENCE_KINDS,
  MAX_EVIDENCE_STORED_BYTES,
  MAX_SUBMISSION_JSON_BYTES,
  evidenceLines,
  feedbackCopyText,
  isLocatorKind,
  isPublicId,
  readEvidenceSubmissionJson,
  readFeedbackSubmissionJson,
  readSubmissionJson,
  receiveFeedback,
  submissionValue,
} from "../../web/components/passage-feedback.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/evidence-corrections.json", import.meta.url), "utf8"));
const textOf = (item) => item.text ?? JSON.stringify(item.submission);

test("accepted evidence fixtures produce the records the build produces", () => {
  for (const item of fixture.submissions.accepted) {
    const read = readEvidenceSubmissionJson(textOf(item));
    assert.equal(read.ok, true, `${item.name}: ${JSON.stringify(read.error)}`);
    assert.ok(Object.isFrozen(read.submission), item.name);
    if (read.submission.evidence) assert.ok(Object.isFrozen(read.submission.evidence), item.name);
    const again = readEvidenceSubmissionJson(JSON.stringify(submissionValue(read.submission)));
    assert.deepEqual(again.submission, read.submission, `${item.name}: canonical form reads back`);
    assert.deepEqual(receiveFeedback(read.submission, fixture.receivedAt), item.record, item.name);
  }
});

test("refused evidence fixtures report the build's codes, B5's own code for a B5 rule", () => {
  for (const item of fixture.submissions.refused) {
    const read = readEvidenceSubmissionJson(textOf(item));
    assert.equal(read.ok, false, `${item.name}: should be refused`);
    assert.equal(read.error.code, item.code, `${item.name}: ${read.error.message}`);
    assert.equal(read.error.feedbackCode, item.feedbackCode, item.name);
  }
});

test("a version 1 submission without evidence is byte for byte B5's", () => {
  const plain = fixture.submissions.accepted[0];
  const evidence = readEvidenceSubmissionJson(textOf(plain));
  const b5 = readFeedbackSubmissionJson(textOf(plain));
  assert.deepEqual(evidence.submission, b5.submission);
  assert.deepEqual(submissionValue(evidence.submission), submissionValue(b5.submission));
  assert.equal(submissionValue(evidence.submission).version, 1);
});

test("B5's reader still refuses version 2, and the dispatching reader follows the site", () => {
  const withEvidence = fixture.submissions.accepted[1];
  assert.equal(readFeedbackSubmissionJson(textOf(withEvidence)).error.code, "unsupportedVersion");
  // A site whose hosted service keeps no evidence reads every submission as B5's.
  assert.equal(readSubmissionJson(textOf(withEvidence)).error.code, "unsupportedVersion");
  const read = readSubmissionJson(textOf(withEvidence), { evidence: true });
  assert.equal(read.ok, true);
  assert.equal(read.submission.evidence.claim, "tide-height");
  // A question is still B5's own, version 1, on either site.
  const question = { ...fixture.submissions.accepted[0].submission, kind: "question", target: { version: 1, kind: "work" } };
  delete question.details;
  assert.equal(readSubmissionJson(JSON.stringify(question), { evidence: true }).ok, true);
  // A B5 rule broken inside a version 2 submission is reported by its B5 code, as the form expects.
  const broken = fixture.submissions.refused.find((item) => item.feedbackCode === "missingSource");
  const refused = readSubmissionJson(textOf(broken), { evidence: true });
  assert.deepEqual([refused.error.code, refused.error.feedbackCode], ["missingSource", undefined]);
  // Version 3 is newer than anything this version reads, on either site.
  const newer = { ...withEvidence.submission, version: 3 };
  assert.equal(readSubmissionJson(JSON.stringify(newer), { evidence: true }).error.code, "unsupportedVersion");
});

test("ids and locator kinds follow the build's shapes, and messages never repeat what was named", () => {
  for (const id of ["tide-height", "a", "noaa-2020", "x".repeat(64)]) assert.equal(isPublicId(id), true, id);
  for (const id of ["Tide", "-a", "a-", "a--b", "a_b", "../x", "https://x", "x".repeat(65), "", 7]) assert.equal(isPublicId(id), false, String(id));
  for (const kind of ["page", "timestamp", "x-table"]) assert.equal(isLocatorKind(kind), true, kind);
  for (const kind of ["Page", "x-", "x-T", "verse", "x--a"]) assert.equal(isLocatorKind(kind), false, kind);
  const base = { ...fixture.submissions.accepted[1].submission };
  const secret = "private-claim-of-the-author";
  for (const evidence of [{ claim: secret.toUpperCase() }, { evidenceLink: secret }, { source: "a", locators: [{ kind: "page", value: `${secret}\nmore` }] }]) {
    const read = readEvidenceSubmissionJson(JSON.stringify({ ...base, evidence }));
    assert.equal(read.ok, false);
    assert.ok(!read.error.message.toLowerCase().includes(secret), read.error.message);
  }
});

test("hostile and oversized evidence is refused before anything is stored", () => {
  const base = fixture.submissions.accepted[1].submission;
  const big = JSON.stringify({ ...base, evidence: { claim: "a", pad: "a".repeat(MAX_SUBMISSION_JSON_BYTES) } });
  assert.equal(readEvidenceSubmissionJson(big).error.code, "tooLarge");
  const cases = [
    [{ claim: "a", __proto__: { vote: 1 } }, true],
    [{ claim: "a", upvotes: 3 }, false],
    [{ claim: "a", stance: "refutes" }, false],
    [{ source: "a", locators: [{ kind: "page", value: "‮1" }] }, false],
    [{ source: "a", locators: "page 4" }, false],
    [{ claim: ["a"] }, false],
  ];
  for (const [evidence, ok] of cases) {
    assert.equal(readEvidenceSubmissionJson(JSON.stringify({ ...base, evidence })).ok, ok, JSON.stringify(evidence));
  }
  const deep = `{"version":2,"evidence":${"[".repeat(130)}${"]".repeat(130)}}`;
  assert.equal(readEvidenceSubmissionJson(deep).error.code, "malformed");
});

test("the copy fallback carries the evidence in words and a version 2 line the author can enter", () => {
  const submission = readEvidenceSubmissionJson(textOf(fixture.submissions.accepted[1])).submission;
  const text = feedbackCopyText(submission, "https://blog.example/posts/tides/");
  assert.match(text, /Claim: tide-height/);
  assert.match(text, /Evidence link questioned: tide-height-noaa/);
  assert.match(text, /Source offered: admiralty-1990 \(page 40–41, x-table T3\)/);
  assert.match(text, /The reader says it contradicts the passage\./);
  const again = readEvidenceSubmissionJson(text.split("\n").at(-1));
  assert.deepEqual(again.submission, submission);
  assert.deepEqual(evidenceLines(undefined), []);
});

test("only the two evidence kinds offer evidence, and no label calls a suggestion a correction", () => {
  assert.deepEqual(EVIDENCE_KINDS, ["source-suggestion", "correction-suggestion"]);
  const lines = evidenceLines({ claim: "a", citation: "b", source: "c", stance: "supports" }).join(" ");
  assert.doesNotMatch(lines, /\bcorrection\b|verified|true|false/i);
});

// jsonb::text, written independently of the reader's own count: ", " and ": " as separators.
const jsonbText = (value) => {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${jsonbText(item)}`).join(", ")}}`;
  return JSON.stringify(value);
};

test("every accepted block fits the hosted store's check, as Postgres writes jsonb as text", () => {
  // supabase/feedback.sql checks octet_length(evidence::text) <= 4096.
  const id = "a".repeat(64);
  let largestAccepted = 0;
  let refused = 0;
  for (const width of [1, 16, 32, 48, 64]) {
    for (const count of [1, 4, 8]) {
      for (const text of ["é".repeat(width), "\u{1D49C}".repeat(width)]) {
        const locators = Array.from({ length: count }, () => ({ kind: "x-" + "b".repeat(62), value: text, to: text }));
        const submission = { version: 2, kind: "source-suggestion", work: "/posts/x/", revision: "p1:" + "0".repeat(32), target: { version: 1, kind: "work" }, body: "hi", details: { sourceUrl: "https://example.org/" }, evidence: { claim: id, evidenceLink: id, citation: id, source: id, locators, stance: "supports" } };
        const read = readEvidenceSubmissionJson(JSON.stringify(submission));
        if (read.ok) largestAccepted = Math.max(largestAccepted, Buffer.byteLength(jsonbText(read.submission.evidence)));
        else {
          assert.equal(read.error.code, "evidenceTooLarge", `${width}x${count}`);
          refused += 1;
        }
      }
    }
  }
  assert.ok(refused > 0, "some are too large");
  assert.ok(largestAccepted > 2000 && largestAccepted <= MAX_EVIDENCE_STORED_BYTES, `largest accepted ${largestAccepted}`);
});

// The Third Perspective contract's browser and function half (#221, ADRs 0109 to 0114): every case
// of the shared fixture read and received exactly as the build reads it, the copy-and-send text,
// clarification consent changes made through a receipt, and the approval check that binds the text
// revision and the consent record a moderator saw.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_JSON_BYTES,
  RESPONSE_CATEGORIES,
  checkThirdPerspectiveApproval,
  consentInEffect,
  readThirdPerspectiveSubmissionJson,
  receiveThirdPerspective,
  reviseClarificationConsent,
  reviseConsent,
  submissionKind,
  thirdPerspectiveCopyText,
  thirdPerspectiveSubmissionValue,
} from "../../web/components/third-perspective.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/third-perspective-submissions.json", import.meta.url), "utf8"));

const textOf = (entry) => entry.text ?? JSON.stringify(entry.request);

test("every case of the shared fixture is read and received as the build reads and receives it", () => {
  assert.ok(fixture.cases.length >= 40);
  for (const entry of fixture.cases) {
    const read = readThirdPerspectiveSubmissionJson(textOf(entry));
    if (entry.expect.code) {
      assert.equal(read.ok, false, `${entry.name}: refused`);
      assert.equal(read.error.code, entry.expect.code, `${entry.name}: ${read.error.message}`);
      continue;
    }
    assert.ok(read.ok, `${entry.name}: ${read.error?.message}`);
    const { record, details, row } = receiveThirdPerspective(read.submission, fixture.receivedAt, fixture.receiptDigest);
    assert.deepEqual(record, entry.expect.record, `${entry.name}: the received record`);
    // The row keeps the copy in its columns and `details`, never the text twice.
    assert.deepEqual(details, { ...(record.category ? { category: record.category } : {}), intake: record.intake, consents: record.consents });
    assert.equal(row.kind, "third-perspective");
    assert.equal(row.body, record.body);
    assert.equal(row.reader_name, record.provenance.attribution.name ?? null);
    assert.equal(row.publish_name, record.provenance.attribution.publishName);
    assert.equal(row.clarification_consent, record.consents[0].clarification);
    assert.equal(row.seen_at, record.provenance.seenAt ?? null);
    // What the browser sends reads back as the same submission.
    const again = readThirdPerspectiveSubmissionJson(JSON.stringify(thirdPerspectiveSubmissionValue(read.submission)));
    assert.deepEqual(again.submission, read.submission, `${entry.name}: the sent value`);
  }
});

test("a submission larger than the bound is refused before it is read", () => {
  const value = { ...fixture.cases[0].request, body: "a".repeat(MAX_JSON_BYTES) };
  assert.equal(readThirdPerspectiveSubmissionJson(JSON.stringify(value)).error.code, "tooLarge");
});

test("the kind routes one request without reading anything else", () => {
  assert.equal(submissionKind(JSON.stringify(fixture.cases[0].request)), "third-perspective");
  assert.equal(submissionKind('{"kind":"question"}'), "question");
  assert.equal(submissionKind("not json"), null);
  assert.equal(submissionKind("[]"), null);
});

test("categories are optional descriptive prompts, never scores, votes or sides", () => {
  assert.deepEqual(RESPONSE_CATEGORIES.map((category) => category.id), ["another-reading", "connection", "experience", "question", "application"]);
  for (const category of RESPONSE_CATEGORIES) {
    assert.doesNotMatch(`${category.id} ${category.label} ${category.prompt}`, /score|rating|rank|vote|agree|correct|best|side/i);
  }
});

test("clarification consent changed through a receipt appends exactly the record the build appends", () => {
  for (const entry of fixture.consentChanges) {
    const record = entry.record;
    const details = { ...(record.category ? { category: record.category } : {}), intake: record.intake, consents: record.consents, ...(record.revisedAt ? { revisedAt: record.revisedAt } : {}) };
    const feature = entry.feature === undefined ? "keep" : entry.feature === "decline" ? "decline" : { agree: entry.feature };
    const outcome = reviseConsent({
      body: record.body,
      revision: record.revision,
      provenance: record.provenance,
      details,
      state: entry.moderation.state,
      approvedRevision: entry.moderation.approvedRevision,
      retained: entry.moderation.contentRetained,
    }, { clarification: entry.clarification, feature }, entry.at);
    if (entry.expect.code) assert.deepEqual(outcome, { ok: false, code: entry.expect.code }, entry.name);
    else assert.deepEqual(outcome.details.consents, entry.expect.consents, entry.name);
  }
});

test("changing what the reader may be asked never renews feature consent for edited text", () => {
  const record = fixture.consentChanges.find((entry) => entry.name.startsWith("changing what the reader is asked")).record;
  const copy = { body: record.body, revision: 2, provenance: record.provenance, details: { intake: record.intake, consents: record.consents, revisedAt: record.revisedAt }, state: "pending", approvedRevision: null, retained: true };
  const toggled = reviseClarificationConsent(copy, true, "2026-10-26T12:00:00Z");
  assert.equal(toggled.details.consents.at(-1).featureRevision, 1, "still bound to the text the reader agreed to");
  const approved = reviseClarificationConsent({ ...copy, state: "approved", approvedRevision: 2 }, true, "2026-10-26T12:00:00Z");
  assert.equal(approved.details.consents.at(-1).featureRevision, 1);
  assert.deepEqual(reviseConsent(copy, { clarification: false, feature: { agree: 1 } }, "2026-10-26T12:00:00Z"), { ok: false, code: "staleRevision" });
});

test("a widening change keeps room for narrowing and revocation; a narrowing one may use it", () => {
  const record = fixture.consentChanges[0].record;
  const consents = [record.consents[0]];
  for (let number = 2; number <= 46; number += 1) {
    consents.push({ number, givenAt: "2026-10-26T12:00:00Z", publish: true, attribution: { publishName: true }, clarification: number % 2 === 0 });
  }
  const copy = (list) => ({ body: record.body, revision: 1, provenance: record.provenance, details: { intake: record.intake, consents: list }, state: "pending", approvedRevision: null, retained: true });
  // 46 records end on agreeing to be asked; declining narrows and is taken up to record 49.
  assert.equal(consents.at(-1).clarification, true);
  const narrowed = reviseClarificationConsent(copy(consents), false, "2026-10-26T13:00:00Z");
  assert.ok(narrowed.ok);
  assert.equal(narrowed.details.consents.length, 47);
  // Agreeing again would widen past the 46 records a widening change may reach.
  assert.deepEqual(reviseClarificationConsent(copy(narrowed.details.consents), true, "2026-10-26T13:00:00Z"), { ok: false, code: "consentLimit" });
});

test("approval binds the text revision and consent record the moderator saw", () => {
  const details = { intake: { receiptDigest: "5e".repeat(32) }, consents: [{ number: 1, givenAt: "2026-10-26T10:00:00Z", publish: true, attribution: { publishName: false }, clarification: true }, { number: 2, givenAt: "2026-10-26T11:00:00Z", publish: true, attribution: { publishName: false }, clarification: false }] };
  const row = { status: "pending", item_revision: 1, details, purged_at: null };
  assert.deepEqual(consentInEffect(details).number, 2);
  assert.deepEqual(checkThirdPerspectiveApproval(row, 1, 2), { ok: true, consent: 2 });
  assert.deepEqual(checkThirdPerspectiveApproval(row, 1, 1), { ok: false, code: "staleConsent" });
  assert.deepEqual(checkThirdPerspectiveApproval({ ...row, item_revision: 2 }, 1, 2), { ok: false, code: "staleRevision" });
  assert.deepEqual(checkThirdPerspectiveApproval({ ...row, status: "clarification" }, 1, 2), { ok: false, code: "notPending" });
  assert.deepEqual(checkThirdPerspectiveApproval({ ...row, purged_at: "2026-10-27T10:00:00Z" }, 1, 2), { ok: false, code: "contentPurged" });
  assert.deepEqual(checkThirdPerspectiveApproval({ ...row, details: { ...details, consents: [...details.consents, { ...details.consents[1], number: 3, publish: false }] } }, 1, 3), { ok: false, code: "publicationNotConsented" });
});

test("the copy-and-send text keeps the reflection, its consent and, only when publishable, the record line", () => {
  const read = readThirdPerspectiveSubmissionJson(JSON.stringify(fixture.cases[1].request));
  const text = thirdPerspectiveCopyText(read.submission, "https://blog.example/posts/tides/");
  assert.match(text, /^Third Perspective on https:\/\/blog\.example\/posts\/tides\//);
  assert.match(text, /About: Section #methods/);
  assert.match(text, /Prompt: A connection/);
  assert.match(text, /Name: Ada \(may be shown if published\)/);
  assert.match(text, /may be asked to clarify: yes/);
  const line = text.split("\n").at(-1);
  assert.deepEqual(readThirdPerspectiveSubmissionJson(line).submission, read.submission, "the author can enter the record line");
  const privateOnly = thirdPerspectiveCopyText({ ...read.submission, consent: { publish: false, clarification: false, feature: false } });
  assert.match(privateOnly, /Not for publication: for the author only\./);
  assert.doesNotMatch(privateOnly, /open\.blog Third Perspective record/);
});

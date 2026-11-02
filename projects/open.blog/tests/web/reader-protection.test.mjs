// What readers are told by the receipt and abuse report components (#226, ADR 0107): receipts are
// recognised by shape alone, every state and failure is worded without naming a moderator, and a
// report's outcome never promises more than the service does. Interaction is covered in
// tests/browser/reader-protection.spec.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { get: () => undefined, define: () => {} };
const { isReceipt, receiptProblem, receiptStateText } = await import("../../web/components/feedback-receipt.js");
const { REPORT_GROUNDS, reportOutcome } = await import("../../web/components/ob-abuse-report.js");
const { REPORT_GROUNDS: hostedGrounds } = await import("../../netlify/lib/participation-moderation.mjs");

test("a receipt is 43 URL-safe characters and nothing else", () => {
  assert.ok(isReceipt("A".repeat(43)));
  assert.ok(isReceipt(` ${"a-_9".repeat(10)}abc `));
  for (const value of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}/`, 42, null, undefined]) {
    assert.equal(isReceipt(value), false, String(value));
  }
});

test("each state of a note is told in words, and deletion is said plainly", () => {
  assert.match(receiptStateText({ status: "pending" }), /Nothing is published unless they approve it/);
  const asked = receiptStateText({ status: "clarification", clarification: { reason: "needs-source" } });
  assert.match(asked, /because it needs a source/);
  assert.match(asked, /what you first wrote is never published/);
  assert.equal(receiptStateText({ status: "approved", published: true }), "Approved and published on the post.");
  assert.match(receiptStateText({ status: "withdrawn", purged: true }), /^You withdrew it\. Its text and your name were deleted/);
  assert.match(receiptStateText({ status: "rejected" }), /decided not to publish/);
  assert.equal(receiptStateText({ status: "deleted" }), "Its state is not one this page knows.");
  // No reason a moderator gave for a rejection reaches the reader.
  assert.doesNotMatch(receiptStateText({ status: "rejected", reason: "spam" }), /spam/i);
});

test("failures say what to do next and never repeat what the service said", () => {
  assert.match(receiptProblem(404, "unknownReceipt"), /No note matches this receipt/);
  assert.match(receiptProblem(404, "unavailable"), /does not offer receipts/);
  assert.match(receiptProblem(429), /Too many requests/);
  assert.match(receiptProblem(0), /did not answer/);
  assert.match(receiptProblem(422, "contentPurged"), /already deleted/);
  assert.match(receiptProblem(502), /write to the author/);
});

test("report grounds are the hosted function's, and outcomes are honest", () => {
  assert.deepEqual(REPORT_GROUNDS.map(([id]) => id), [...hostedGrounds]);
  assert.ok(reportOutcome(202).ok);
  assert.match(reportOutcome(202).message, /It is not published/);
  for (const status of [0, 404, 422, 429, 502]) assert.equal(reportOutcome(status).ok, false, String(status));
  // Untrusted text is never parsed as markup.
  for (const file of ["feedback-receipt.js", "ob-abuse-report.js"]) {
    const source = readFileSync(new URL(`../../web/components/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/);
    assert.match(source, /credentials: "omit"/);
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  }
});

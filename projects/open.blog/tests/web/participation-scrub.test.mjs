// The hosted function's mirror of the retention policy for an accepted suggestion for future work
// (ADR 0155): it is kept, and owes only the clearing of its private contact and unpublished name.
// The Rust policy is the authority; this is held to it case by case by
// tests/fixtures/participation-protection.json, and these cases name the edges for this kind.
import test from "node:test";
import assert from "node:assert/strict";
import { retentionStep } from "../../netlify/lib/participation-moderation.mjs";

const cutoffs = { pendingUntil: "2026-07-29T10:00:00Z", clarificationUntil: "2026-09-27T10:00:00Z", closedUntil: "2026-09-27T10:00:00Z", auditUntil: "2025-10-27T10:00:00Z" };

test("the policy's mirror keeps an accepted suggestion and owes only the clearing of its identity", () => {
  const cut = { ...cutoffs, comments: false };
  const item = { kind: "future-suggestion", state: "approved", since: "2026-09-27T10:00:00Z", retained: true };
  assert.equal(retentionStep(item, cut), "scrub-identity");
  assert.equal(retentionStep({ ...item, since: "2026-09-27T10:00:01Z" }, cut), null, "a second before the period");
  assert.equal(retentionStep({ ...item, identityHeld: false }, cut), null, "nothing private to clear");
  assert.equal(retentionStep({ ...item, retained: false }, cut), null);
  assert.equal(retentionStep({ ...item, state: "removed" }, cut), "purge-content", "a closed one is purged as any closed item");
  // Other kinds keep their steps: a published question is kept, an upheld report purged.
  assert.equal(retentionStep({ ...item, kind: "question" }, cut), null);
  assert.equal(retentionStep({ ...item, kind: "abuse-report" }, cut), "purge-content");
});

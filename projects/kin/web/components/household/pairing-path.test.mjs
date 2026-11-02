import assert from "node:assert/strict";
import test from "node:test";
import { inviterPathCopy, intentConflict, joinerPathCopy, pairingPath } from "./pairing-path.js";

test("device and replacement codes stay under the same member", () => {
  assert.equal(pairingPath("device"), "own-device");
  assert.equal(pairingPath("replacement"), "own-device");
});

test("invitations create a new member, and unknown purposes are treated as one", () => {
  for (const purpose of ["adult", "limited", "temporary", undefined, "unexpected"])
    assert.equal(pairingPath(purpose), "new-member", String(purpose));
  assert.equal(pairingPath("member-recovery"), "recovery");
});

test("the inviter is told which path the code is on before anyone claims it", () => {
  assert.equal(inviterPathCopy("device").title, "Adding your own device");
  assert.match(inviterPathCopy("device").detail, /under your member identity/);
  assert.match(inviterPathCopy("device").waiting, /your other device/);
  assert.equal(inviterPathCopy("adult").title, "Inviting another person");
  assert.match(inviterPathCopy("adult").detail, /separate household member/);
  // Invitation responses carry the role as memberKind, not purpose.
  assert.match(inviterPathCopy(undefined, "limited").detail, /Limited \(child or teen\) access/);
  assert.match(inviterPathCopy(undefined, "temporary").detail, /Temporary \(babysitter, caregiver or guest\) access/);
  assert.match(inviterPathCopy(undefined, "adult").detail, /Adult access/);
  assert.equal(inviterPathCopy(undefined, "limited").title, "Inviting another person");
});

test("the joining device is told what it is about to become", () => {
  assert.equal(joinerPathCopy("replacement").title, "Adding this device to your membership");
  assert.match(joinerPathCopy("device").detail, /doesn't create a new member/);
  assert.equal(joinerPathCopy("adult").title, "Joining as a new household member");
  assert.match(joinerPathCopy("adult").detail, /own member identity/);
  // The claim reports every invitation as "adult", so no role is promised.
  assert.doesNotMatch(joinerPathCopy("adult").detail, /Adult|Limited|Temporary/);
  assert.equal(joinerPathCopy("member-recovery").title, "Recovering your access");
});

test("a code that contradicts the chosen path is flagged, never silently switched", () => {
  assert.match(intentConflict("device", "adult"), /invitation for a new household member/);
  assert.match(intentConflict("device", "temporary"), /separate member/);
  assert.match(intentConflict("join", "device"), /adds a device to an existing member/);
  assert.match(intentConflict("join", "replacement"), /existing member/);
});

test("matching or unknown choices raise no conflict", () => {
  assert.equal(intentConflict("device", "device"), null);
  assert.equal(intentConflict("device", "replacement"), null);
  assert.equal(intentConflict("join", "adult"), null);
  assert.equal(intentConflict("join", "limited"), null);
  assert.equal(intentConflict(null, "adult"), null);
  assert.equal(intentConflict(undefined, "device"), null);
  assert.equal(intentConflict("phone", "device"), null);
  assert.equal(intentConflict("device", "member-recovery"), null);
});

test("the joining device always learns the next step and who takes it (#264)", async () => {
  const { CODE_ARRIVAL_COPY } = await import("./pairing-path.js");
  assert.match(joinerPathCopy("device").next, /^Next: on your other device/);
  assert.match(joinerPathCopy("adult").next, /^Next: the person who invited you/);
  assert.match(joinerPathCopy("member-recovery").next, /^Next: the other household adult/);
  for (const purpose of ["device", "replacement", "adult", "limited", "temporary", "member-recovery"])
    assert.match(joinerPathCopy(purpose).next, /key below matches/, purpose);
  assert.match(CODE_ARRIVAL_COPY, /never creates a new household/);
  assert.match(CODE_ARRIVAL_COPY, /approves it before anything is shared/);
});

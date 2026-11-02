import assert from "node:assert/strict";
import test from "node:test";
import { isEventEnvelopeValid } from "./sync-contract.mjs";

const envelope = () => ({
  protocolVersion: 1, envelopeVersion: 1,
  eventId: "a".repeat(32), householdId: "b".repeat(32), deviceId: "c".repeat(32),
  deviceSequence: 1, logicalTime: "1", keyEpoch: 1,
  nonce: Buffer.alloc(12).toString("base64url"),
  signature: Buffer.alloc(64).toString("base64url"),
  ciphertext: Buffer.alloc(16).toString("base64url"),
});

test("canonical base64url envelope fields are accepted", () => {
  assert.equal(isEventEnvelopeValid(envelope()), true);
});

for (const field of ["signature", "ciphertext"]) {
  test(`non-zero padding bits in ${field} are rejected`, () => {
    const value = envelope();
    const original = value[field];
    value[field] = `${original.slice(0, -1)}B`;
    assert.deepEqual(Buffer.from(value[field], "base64url"), Buffer.from(original, "base64url"));
    assert.equal(isEventEnvelopeValid(value), false);
  });
}

test("non-canonical nonce text is rejected", () => {
  const value = envelope();
  // Twelve bytes have no padding bits; an extra dangling sextet is ignored by
  // Buffer's permissive decoder, but is not a canonical nonce spelling.
  value.nonce += "B";
  assert.deepEqual(Buffer.from(value.nonce, "base64url"), Buffer.alloc(12));
  assert.equal(isEventEnvelopeValid(value), false);
});

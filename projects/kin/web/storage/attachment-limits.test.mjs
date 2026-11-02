import assert from "node:assert/strict";
import test from "node:test";
import { MAX_HOUSEHOLD_ATTACHMENT_BYTES, MAX_HOUSEHOLD_ATTACHMENTS, MAX_ATTACHMENT_PLAINTEXT_BYTES } from "../attachments/attachment-crypto.js";
import { EventStoreError, validateAttachmentAggregate } from "./event-store.js";

const MAX_CIPHERTEXT_BYTES = MAX_ATTACHMENT_PLAINTEXT_BYTES + 4096;
const record = (index, size) => ({ attachment_id: index.toString(16).padStart(32, "0"), ciphertext: new Uint8Array(size) });

test("browser storage accepts zero, one large and many attachments through the exact aggregate limit", () => {
  assert.doesNotThrow(() => validateAttachmentAggregate([], record(1, MAX_CIPHERTEXT_BYTES)));
  const rows = [];
  for (let index = 0; index < 12; index += 1) {
    const candidate = record(index + 1, MAX_CIPHERTEXT_BYTES);
    validateAttachmentAggregate(rows, candidate);
    rows.push(candidate);
  }
  const lastSize = MAX_HOUSEHOLD_ATTACHMENT_BYTES - 12 * MAX_CIPHERTEXT_BYTES;
  const last = record(13, lastSize);
  validateAttachmentAggregate(rows, last);
  rows.push(last);
  assert.equal(rows.length, 13);
  assert.equal(rows.reduce((sum, row) => sum + row.ciphertext.byteLength, 0), MAX_HOUSEHOLD_ATTACHMENT_BYTES);
});

test("browser storage rejects aggregate overflow and too many records with a clear limit", () => {
  const rows = Array.from({ length: MAX_HOUSEHOLD_ATTACHMENTS }, (_, index) => record(index + 1, 1));
  assert.throws(() => validateAttachmentAggregate(rows, record(65, 1)), (error) => error instanceof EventStoreError && /50 MiB/.test(error.message));
  const atLimit = [record(1, MAX_HOUSEHOLD_ATTACHMENT_BYTES)];
  assert.throws(() => validateAttachmentAggregate(atLimit, record(2, 1)), (error) => error instanceof EventStoreError && /50 MiB/.test(error.message));
});

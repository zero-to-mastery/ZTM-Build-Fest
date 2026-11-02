// Binary sync envelopes decode to exactly the objects that were encoded.
import assert from "node:assert/strict";
import test from "node:test";
import { decodeEnvelopeBatch, decodeEventPage, encodeEnvelopeBatch, encodeEventPage } from "./envelope-wire.js";
import { encryptEvent } from "./crypto.js";

const hex = (pair) => pair.repeat(16);

async function envelope(sequence, plaintextLength = 40) {
  const householdKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return encryptEvent({
    eventId: hex(sequence.toString(16).padStart(2, "0").slice(-2)), householdId: hex("ab"), deviceId: hex("cd"),
    deviceSequence: sequence, logicalTime: 9_007_199_254_740_991n - BigInt(sequence), keyEpoch: 3,
    plaintext: new Uint8Array(plaintextLength).fill(7), householdKey, signingKey: privateKey,
  });
}

test("a push batch round-trips real envelopes exactly", async () => {
  const envelopes = [await envelope(1), await envelope(2, 4_000), await envelope(3, 1)];
  const bytes = encodeEnvelopeBatch(envelopes);
  const decoded = decodeEnvelopeBatch(bytes);
  assert.deepEqual(decoded, envelopes);
  // Same key order too: the server compares canonical JSON of the fields.
  assert.deepEqual(decoded.map(Object.keys), envelopes.map(Object.keys));
  assert.deepEqual(decodeEnvelopeBatch(encodeEnvelopeBatch([])), []);
  // Smaller than the JSON it replaces.
  assert.ok(bytes.length < JSON.stringify({ events: envelopes }).length * 0.8);
});

test("push count limits reject the header before decoding records and include the boundary", async () => {
  const valid = await envelope(8);
  const bytes = encodeEnvelopeBatch(Array(21).fill(valid));
  class HeaderOnlyBytes extends Uint8Array {
    subarray(start, end) {
      assert.equal(start, 0, "an over-limit batch must not decode a record");
      assert.equal(end, 4, "only the header magic may be read as bytes");
      return super.subarray(start, end);
    }
  }
  assert.throws(() => decodeEnvelopeBatch(new HeaderOnlyBytes(bytes), { maxCount: 20 }), { code: "sync_batch_invalid" });
  assert.throws(() => decodeEnvelopeBatch(bytes.subarray(0, 8), { maxCount: 20 }), { code: "sync_batch_invalid" });
  assert.deepEqual(decodeEnvelopeBatch(encodeEnvelopeBatch(Array(20).fill(valid)), { maxCount: 20 }), Array(20).fill(valid));
  assert.deepEqual(decodeEnvelopeBatch(encodeEnvelopeBatch([]), { maxCount: 0 }), []);
  assert.throws(() => decodeEnvelopeBatch(encodeEnvelopeBatch([valid]), { maxCount: 0 }), { code: "sync_batch_invalid" });
  assert.deepEqual(decodeEnvelopeBatch(bytes), Array(21).fill(valid), "the default codec limit is unchanged");
});

test("a pull page round-trips events, cursors and hasMore", async () => {
  const page = {
    events: [{ cursor: "AAAAAAAAAAE", envelope: await envelope(4) }, { cursor: "AAAAAAAAAAI", envelope: await envelope(5) }],
    nextCursor: "AAAAAAAAAAI",
    hasMore: true,
  };
  assert.deepEqual(decodeEventPage(encodeEventPage(page)), page);
  const empty = { events: [], nextCursor: "AAAAAAAAAAA", hasMore: false };
  assert.deepEqual(decodeEventPage(encodeEventPage(empty)), empty);
});

test("truncated, extended and mislabeled bytes are refused", async () => {
  const bytes = encodeEnvelopeBatch([await envelope(6)]);
  for (let end = 0; end < bytes.length; end += 1)
    assert.throws(() => decodeEnvelopeBatch(bytes.subarray(0, end)), { code: "sync_batch_invalid" }, `truncated at ${end}`);
  assert.throws(() => decodeEnvelopeBatch(Uint8Array.from([...bytes, 0])), { code: "sync_batch_invalid" });
  const page = encodeEventPage({ events: [], nextCursor: "AAAAAAAAAAA", hasMore: false });
  assert.throws(() => decodeEnvelopeBatch(page), { code: "sync_batch_invalid" }, "a page is not a batch");
  const newer = bytes.slice();
  newer[4] = 2;
  assert.throws(() => decodeEnvelopeBatch(newer), /not supported/);
  const zeroEpoch = bytes.slice();
  new DataView(zeroEpoch.buffer).setUint32(8 + 64, 0, true);
  assert.throws(() => decodeEnvelopeBatch(zeroEpoch), { code: "sync_batch_invalid" });
  const flags = page.slice();
  flags[6] = 2;
  assert.throws(() => decodeEventPage(flags), { code: "sync_batch_invalid" });
});

test("only envelopes that round-trip exactly can be encoded", async () => {
  const valid = await envelope(7);
  for (const change of [
    { protocolVersion: 2 },
    { eventId: "AB".repeat(16) },
    { logicalTime: "01" },
    { logicalTime: "9007199254740992" },
    { nonce: valid.nonce.slice(0, -1) },
    // A non-canonical spelling: the unused low bits of the last character set.
    { signature: valid.signature.slice(0, -1) + (valid.signature.at(-1) === "B" ? "C" : "B") },
    { ciphertext: "AAAA" },
  ])
    assert.throws(() => encodeEnvelopeBatch([{ ...valid, ...change }]), { code: "sync_batch_invalid" }, JSON.stringify(change));
  assert.throws(() => encodeEventPage({ events: [], nextCursor: "AAAA", hasMore: false }), { code: "sync_batch_invalid" });
});

import assert from "node:assert/strict";
import test from "node:test";
import { DELIVERY_HEADER_BYTES, SCOPE, decodeEphemeralDelivery, encodeEphemeralRequest } from "./ephemeral-envelope.js";
import { LIVE_TYPE } from "./live-channel.js";
import { SCOPE as SERVER_SCOPE, decodeRequest, encodeDelivery } from "../../server/live/ephemeral.mjs";

const table = new Map([[7, { maxPayload: 64, scopes: [0, 1, 2] }]]);

test("a request the browser builds is the one the service reads", () => {
  assert.equal(LIVE_TYPE.EPHEMERAL, 6);
  assert.deepEqual(SCOPE, SERVER_SCOPE);
  const correlation = Uint8Array.from({ length: 16 }, (_, index) => index);
  const request = decodeRequest(Buffer.from(encodeEphemeralRequest({ category: 7, scope: SCOPE.DEVICE, correlation, targetId: "ab".repeat(16), payload: Uint8Array.of(1, 2, 3) })), table);
  assert.equal(request.targetId, "ab".repeat(16));
  assert.deepEqual([...request.correlation], [...correlation]);
  assert.deepEqual([...request.payload], [1, 2, 3]);
  const household = decodeRequest(Buffer.from(encodeEphemeralRequest({ category: 7, scope: SCOPE.HOUSEHOLD, correlation })), table);
  assert.equal(household.targetId, null);
});

test("a delivery from the service is read with its stamped sender, and nothing else is accepted", () => {
  const delivery = encodeDelivery({ categoryId: 7, scope: 1, correlation: Buffer.alloc(16, 5), senderMemberId: "cd".repeat(16), senderDeviceId: "ef".repeat(16), payload: Buffer.from("yo") });
  const read = decodeEphemeralDelivery(new Uint8Array(delivery));
  assert.deepEqual([read.category, read.scope, read.senderMemberId, read.senderDeviceId], [7, 1, "cd".repeat(16), "ef".repeat(16)]);
  assert.equal(new TextDecoder().decode(read.payload), "yo");
  const bad = (change) => { const copy = new Uint8Array(delivery); change(copy); return decodeEphemeralDelivery(copy); };
  assert.equal(bad((b) => { b[0] = 2; }), null);
  assert.equal(bad((b) => { b[2] = 9; }), null);
  assert.equal(bad((b) => { b[3] = 1; }), null);
  assert.equal(decodeEphemeralDelivery(new Uint8Array(delivery).subarray(0, DELIVERY_HEADER_BYTES - 1)), null);
  assert.equal(decodeEphemeralDelivery(new Uint8Array([...delivery, 0])), null);
});

test("the browser refuses to build a request the service would refuse", () => {
  const correlation = new Uint8Array(16);
  assert.throws(() => encodeEphemeralRequest({ category: 7, scope: SCOPE.MEMBER, correlation }), RangeError);
  assert.throws(() => encodeEphemeralRequest({ category: 7, scope: SCOPE.HOUSEHOLD, correlation, targetId: "ab".repeat(16) }), RangeError);
  assert.throws(() => encodeEphemeralRequest({ category: 7, scope: SCOPE.DEVICE, correlation, targetId: "XYZ" }), RangeError);
  assert.throws(() => encodeEphemeralRequest({ category: 7, scope: SCOPE.HOUSEHOLD, correlation, payload: new Uint8Array(5000) }), RangeError);
  assert.throws(() => encodeEphemeralRequest({ category: 300, scope: SCOPE.HOUSEHOLD, correlation }), RangeError);
});

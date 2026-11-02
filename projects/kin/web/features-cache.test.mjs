// The household's switched-off features as this device keeps them (#625).
import assert from "node:assert/strict";
import test from "node:test";
import { FEATURES_KEY, readFeatureCache, writeFeatureCache } from "./features-cache.js";

function memory() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

test("the set is kept per household and read back only for it", () => {
  const storage = memory();
  const household = "a".repeat(32);
  assert.equal(readFeatureCache(household, storage), null);
  assert.equal(writeFeatureCache({ scope: household, off: 6, revision: 3, noticed: 2 }, storage), true);
  assert.deepEqual(readFeatureCache(household, storage), { scope: household, off: 6, revision: 3, noticed: 2 });
  assert.equal(readFeatureCache("local", storage), null, "another household's set isn't this one's");
  assert.equal(readFeatureCache("b".repeat(32), storage), null);
});

test("noticed never names a feature that is on", () => {
  const storage = memory();
  writeFeatureCache({ scope: "local", off: 4, revision: 1, noticed: 6 }, storage);
  assert.equal(readFeatureCache("local", storage).noticed, 4);
  storage.setItem(FEATURES_KEY, JSON.stringify({ scope: "local", off: 4, revision: 1 }));
  assert.equal(readFeatureCache("local", storage).noticed, 4, "a record without it counts as already told");
});

test("damaged or refused storage reads as nothing and never throws", () => {
  const storage = memory();
  for (const raw of ["{", "null", "[]", JSON.stringify({ scope: "local", off: -1, revision: 0 }), JSON.stringify({ scope: "local", off: 1, revision: "1" })]) {
    storage.setItem(FEATURES_KEY, raw);
    assert.equal(readFeatureCache("local", storage), null, raw);
  }
  const refusing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readFeatureCache("local", refusing), null);
  assert.equal(writeFeatureCache({ scope: "local", off: 1, revision: 1, noticed: 0 }, refusing), false);
  assert.equal(readFeatureCache("local", null), null);
});

// The dedicated chat key (#123) is stored as an epoch of the key family
// "chat:<household>". The key store must open it with the household's device
// keys, as it opens household epochs.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeIndexedDB } from "../chat/fake-indexeddb.test-support.mjs";
import { createHouseholdEpochKey, generateProtectedDeviceKeys } from "./crypto.js";
import { SyncKeyStore } from "./key-store.js";

const HOUSEHOLD = "a".repeat(32);

test("the key store opens a chat key epoch with the household's device keys", async () => {
  const { keys, serializedKeys } = await generateProtectedDeviceKeys();
  const factory = fakeIndexedDB();
  const database = await new Promise((resolve, reject) => {
    const request = factory.open("kin-keys-test", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("devices", { keyPath: "deviceId" });
      request.result.createObjectStore("epochs", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(["devices"], "readwrite");
    transaction.objectStore("devices").put({ deviceId: "d".repeat(32), householdId: HOUSEHOLD, serializedKeys });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  const store = Object.create(SyncKeyStore.prototype);
  store.database = database;
  store.vault = { assertUnlocked() {} };
  const family = `chat:${HOUSEHOLD}`;
  const epoch = await createHouseholdEpochKey({ householdId: family, keyEpoch: 1, deviceKeys: keys });
  const record = { key: `${family}:1`, householdId: family, keyEpoch: 1, sealed: epoch.sealed, fingerprint: epoch.fingerprint };
  const opened = await store.hydrateEpoch(record);
  assert.equal(opened.householdKey instanceof CryptoKey, true);
  assert.equal(opened.keyEpoch, 1);
});

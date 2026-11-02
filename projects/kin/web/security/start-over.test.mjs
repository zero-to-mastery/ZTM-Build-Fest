// "Start over on this browser" (#592 follow-up): only Kin's own data goes,
// the session ends, and the next start opens Sign in.
import assert from "node:assert/strict";
import test from "node:test";
import { isKinDatabase, START_OVER_SIGN_IN_KEY, startOverOnThisBrowser, takeStartOverSignIn } from "./start-over.js";

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function fakeIndexedDB(names, { blocked = [] } = {}) {
  const deleted = [];
  return {
    deleted,
    databases: async () => names.map((name) => ({ name, version: 1 })),
    deleteDatabase(name) {
      const request = {};
      queueMicrotask(() => {
        if (blocked.includes(name)) return; // another tab never closes it
        deleted.push(name);
        request.onsuccess?.();
      });
      return request;
    },
  };
}

test("only Kin's databases and storage entries go; the session ends; Sign in is next", async () => {
  assert.equal(isKinDatabase("kin"), true);
  assert.equal(isKinDatabase("kin-private-log:a:b"), true);
  assert.equal(isKinDatabase("kindle"), false);
  assert.equal(isKinDatabase("other-app"), false);
  const indexedDB = fakeIndexedDB(["kin", "kin-crypto-keys", "kin-chat-log:abc", "kin-private-blobs:a:b", "other-app"]);
  const localStorage = memoryStorage({ "kin.backup-key-entry": "[]", "kin.account-passkey-offer-dismissed": "1", "theme": "dark" });
  const sessionStorage = memoryStorage({ "kin.compose.draft": "x", "elsewhere": "y" });
  const fetched = [];
  const result = await startOverOnThisBrowser({ indexedDB, localStorage, sessionStorage, fetchImpl: async (path, options) => { fetched.push([path, options.method]); return { ok: true }; } });
  assert.deepEqual(fetched, [["/api/logout", "POST"]]);
  assert.deepEqual(indexedDB.deleted.sort(), ["kin", "kin-chat-log:abc", "kin-crypto-keys", "kin-private-blobs:a:b", "kin-reload-resume"].sort());
  assert.equal(result.databases["other-app"], undefined, "another app's database stays");
  assert.deepEqual([...localStorage.map.keys()], ["theme"]);
  assert.deepEqual([...sessionStorage.map.keys()].sort(), ["elsewhere", START_OVER_SIGN_IN_KEY].sort());
  assert.equal(result.storage, 3);
  assert.equal(takeStartOverSignIn(sessionStorage), true);
  assert.equal(takeStartOverSignIn(sessionStorage), false, "once");
});

test("offline, or with a tab holding a database open, it still finishes", async () => {
  const indexedDB = fakeIndexedDB(["kin"], { blocked: ["kin"] });
  const result = await startOverOnThisBrowser({ indexedDB, localStorage: memoryStorage(), sessionStorage: memoryStorage(), wait: 20,
    fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(result.databases.kin, "pending");
  assert.equal(result.databases["kin-crypto-keys"], "deleted");
});

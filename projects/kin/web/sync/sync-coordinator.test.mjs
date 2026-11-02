import test from "node:test";
import assert from "node:assert/strict";
import { activeResponsibilityMemberIds, committedBatchUpdate, loadCachedHouseholdSettings, memberHasTrustAuthority, portableMembershipFromDirectory, SyncCoordinator } from "./sync-coordinator.js";
import { encodeEventPage } from "./envelope-wire.js";

const CURSORS = ["AAAAAAAAAAA", "AAAAAAAAAAE", "AAAAAAAAAAI", "AAAAAAAAAAM", "AAAAAAAAAAQ", "AAAAAAAAAAU", "AAAAAAAAAAY"];

function waitFor(check, timeout = 500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (check()) resolve();
      else if (Date.now() - started >= timeout) reject(new Error("timed out waiting for sync state"));
      else setTimeout(poll, 1);
    };
    poll();
  });
}

function catchUpHarness(pages) {
  let now = 0;
  let cursor = CURSORS[0];
  let pageIndex = 0;
  let bootstrapCalls = 0;
  let projectionCalls = 0;
  const states = [];
  const store = {
    async getSyncState() { return { syncCursor: cursor, initialized: true }; },
    async commitRemoteBatch({ nextCursor }) {
      cursor = nextCursor;
      return { added: 0, quarantined: 0, state: { items: [] }, snapshotBoundary: null };
    },
    async getSyncBootstrap() { bootstrapCalls += 1; return {}; },
    async getPendingOutbox() { return []; },
    async getPendingBindings() { return []; },
    async projectCurrent() { projectionCalls += 1; return { items: [] }; },
    async markSyncInitialized() {},
    async compactArchiveOutboxSequences() {},
  };
  const coordinator = new SyncCoordinator({
    store,
    engine: {},
    identity: { householdId: "11".repeat(16), deviceId: "device" },
    onState: (state) => states.push(state),
    now: () => now,
  });
  coordinator.keyStore = { vault: { assertUnlocked() {} }, getEpoch: async () => null, close() {} };
  coordinator.catchUp = { status: { currentEpoch: 1 }, devices: [], remoteBindings: [], startedAt: now };
  coordinator.request = async () => encodeEventPage(pages[Math.min(pageIndex++, pages.length - 1)]);
  coordinator.acknowledgeRemoteDuplicateEvents = async () => {};
  coordinator.pushPendingEvents = async () => {};
  return { coordinator, states, calls: () => ({ bootstrapCalls, projectionCalls, pageIndex }) };
}

test("long catch-ups refresh authorization context after thirty seconds", async () => {
  let now = 0;
  let statusCalls = 0;
  let directoryCalls = 0;
  let bindingCalls = 0;
  const pulled = [];
  const store = {
    async requeueAfterRelayReset() {},
    async updateSyncServerState() {},
    async getSyncBootstrap() { return { events: [], maxLogicalTime: 0n }; },
    async getSyncState() { return { initialized: true }; },
  };
  const coordinator = new SyncCoordinator({
    store,
    engine: {},
    identity: { householdId: "11".repeat(16), memberId: "22".repeat(16), deviceId: "device" },
    now: () => now,
  });
  coordinator.keyStore = {
    vault: { assertUnlocked() {} },
    async getEpoch() { return { householdKey: {} }; },
    close() {},
  };
  coordinator.deviceKeys = { pendingTransition: false, fingerprint: "fingerprint" };
  coordinator.request = async (path) => {
    assert.equal(path, "/api/sync/status");
    statusCalls += 1;
    return { enabled: true, currentEpoch: 1, eventCount: 1, memberKind: "limited", latestCursor: CURSORS[0] };
  };
  coordinator.loadDeviceDirectory = async () => {
    directoryCalls += 1;
    return [{ deviceId: "device", historyFromEpoch: 1, fingerprint: "fingerprint" }];
  };
  coordinator.receiveProvisioning = async () => {};
  coordinator.fetchBindings = async () => { bindingCalls += 1; return []; };
  coordinator.pushIdentityBindings = async () => {};
  coordinator.pullCatchUpPages = async (context) => { pulled.push(context); return { hasMore: true, advanced: true }; };
  const original = { status: { currentEpoch: 1 }, devices: [], remoteBindings: [], startedAt: 0 };
  coordinator.catchUp = original;

  now = 30_000;
  await coordinator.runOnce();
  assert.equal(pulled.at(-1), original, "the cached context is reused through thirty seconds");
  assert.deepEqual([statusCalls, directoryCalls, bindingCalls], [0, 0, 0]);

  now = 30_001;
  await coordinator.runOnce();
  assert.notEqual(pulled.at(-1), original, "an older context is rebuilt before another pull");
  assert.equal(pulled.at(-1).startedAt, now);
  assert.deepEqual([statusCalls, directoryCalls, bindingCalls], [2, 1, 1]);
});

test("empty sync polls do not publish a projection or snapshot boundary", () => {
  const state = { items: [] };
  const snapshotBoundary = { eventId: "ab", localSequence: 4 };
  assert.deepEqual(committedBatchUpdate({ added: 0, quarantined: 0, state, snapshotBoundary }), {
    added: 0,
    quarantined: 0,
  });
  assert.deepEqual(committedBatchUpdate({ added: 1, quarantined: 0, state, snapshotBoundary }), {
    added: 1,
    quarantined: 0,
    projection: state,
    snapshotBoundary,
  });
});

test("Responsibility participants include active member kinds and exclude removed or expired members", () => {
  const now = 5_000;
  const devices = [
    { memberId: "adult", memberKind: "adult", memberActive: true },
    { memberId: "limited", memberKind: "limited", memberActive: true },
    { memberId: "temporary", memberKind: "temporary", memberActive: true, memberExpiresAt: 6_000 },
    { memberId: "expired", memberKind: "temporary", memberActive: false, memberExpiresAt: now },
    { memberId: "removed", memberKind: "limited", memberActive: false, revokedAt: 4_000 },
  ];
  assert.deepEqual(activeResponsibilityMemberIds(devices, now), ["adult", "limited", "temporary"]);
});

test("portable membership snapshots preserve authoritative status, kinds, and absolute Temporary expiry", () => {
  const members = portableMembershipFromDirectory([
    { memberId: "11".repeat(16), memberKind: "adult", memberActive: true, memberStatus: "active" },
    { memberId: "22".repeat(16), memberKind: "limited", memberActive: false, memberStatus: "removed" },
    { memberId: "33".repeat(16), memberKind: "temporary", memberActive: true, memberStatus: "active", memberExpiresAt: 50_000 },
    { memberId: "44".repeat(16), memberKind: "temporary", memberActive: false, memberStatus: "expired", memberExpiresAt: 1_000 },
    { memberId: "55".repeat(16), memberKind: "adult", memberActive: false, memberStatus: "removed" },
    { memberId: "66".repeat(16), memberKind: "limited", memberActive: true, memberStatus: "active" },
    { memberId: "77".repeat(16), memberKind: "temporary", memberActive: false, memberStatus: "removed", memberExpiresAt: 1_000 },
  ], 10_000);
  assert.deepEqual(members, [
    { memberId: "11".repeat(16), memberKind: "adult", status: "active" },
    { memberId: "22".repeat(16), memberKind: "limited", status: "removed" },
    { memberId: "33".repeat(16), memberKind: "temporary", status: "active", expiresAt: 50_000 },
    { memberId: "44".repeat(16), memberKind: "temporary", status: "expired", expiresAt: 1_000 },
    { memberId: "55".repeat(16), memberKind: "adult", status: "removed" },
    { memberId: "66".repeat(16), memberKind: "limited", status: "active" },
    { memberId: "77".repeat(16), memberKind: "temporary", status: "removed", expiresAt: 1_000 },
  ]);
  assert.throws(() => portableMembershipFromDirectory([
    { memberId: "88".repeat(16), memberKind: "future", memberActive: true },
  ]), /validate current household membership/);
});

test("portable export requires authoritative status and never guesses from activity and expiry", () => {
  assert.throws(() => portableMembershipFromDirectory([
    { memberId: "77".repeat(16), memberKind: "temporary", memberActive: false, memberExpiresAt: 1_000 },
  ]), /validate current household membership/);
});

test("Temporary statuses survive archive restoration unchanged", () => {
  const id = "88".repeat(16);
  const expiredId = "99".repeat(16);
  const membership = portableMembershipFromDirectory([
    { memberId: id, memberKind: "temporary", memberActive: false, memberStatus: "removed", memberExpiresAt: 1_000 },
    { memberId: expiredId, memberKind: "temporary", memberActive: false, memberStatus: "expired", memberExpiresAt: 1_000 },
  ]);
  const packageSnapshot = { local_context: [{ portable_membership: membership }] };

  assert.deepEqual(packageSnapshot.local_context[0].portable_membership, [
    { memberId: id, memberKind: "temporary", status: "removed", expiresAt: 1_000 },
    { memberId: expiredId, memberKind: "temporary", status: "expired", expiresAt: 1_000 },
  ]);
});

test("unreachable household sync reports a plain paused state without changing saved data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const states = [];
  const coordinator = new SyncCoordinator({
    store: {},
    engine: {},
    identity: { deviceId: "device" },
    onState: (state) => states.push(state),
  });
  coordinator.runOnce = () => coordinator.request("/api/sync/status");
  try {
    await coordinator.syncNow();
    assert.equal(states.at(-1)?.state, "paused");
    assert.equal(states.at(-1)?.code, "connection_unavailable");
    assert.match(states.at(-1)?.message, /saved information remains on this device/i);
    assert.equal(coordinator.terminal, false);
  } finally {
    coordinator.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cold sync continues bounded relay history on later event-loop turns", async () => {
  const coordinator = new SyncCoordinator({
    store: {},
    engine: {},
    identity: { deviceId: "device" },
  });
  let runs = 0;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  coordinator.runOnce = async () => {
    runs += 1;
    if (runs === 3) finish();
    return runs < 3;
  };
  try {
    await coordinator.syncNow();
    assert.equal(runs, 1, "the first bounded group completes before continuation");
    let timeout;
    try {
      await Promise.race([
        finished,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("sync continuation timed out")), 500);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(runs, 3);
  } finally {
    coordinator.stop();
  }
});

test("stopping sync cancels a queued cold-history continuation", async () => {
  const coordinator = new SyncCoordinator({
    store: {},
    engine: {},
    identity: { deviceId: "device" },
  });
  let runs = 0;
  coordinator.runOnce = async () => {
    runs += 1;
    return true;
  };
  await coordinator.syncNow();
  coordinator.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runs, 1);
});

test("a hasMore page without committed cursor progress does not continue", async () => {
  const { coordinator, states, calls } = catchUpHarness([
    { events: [], nextCursor: CURSORS[0], hasMore: true },
  ]);
  try {
    await coordinator.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls().pageIndex, 1);
    assert.equal(coordinator.continuationTimer, null);
    assert.equal(states.at(-1).code, "sync_no_progress");
  } finally {
    coordinator.stop();
  }
});

test("an error mid-chain stops later continuation passes", async () => {
  const states = [];
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { deviceId: "device" }, onState: (state) => states.push(state) });
  let runs = 0;
  coordinator.runOnce = async () => {
    runs += 1;
    if (runs === 2) throw new Error("relay failed");
    return { hasMore: true, advanced: true };
  };
  try {
    await coordinator.syncNow();
    await waitFor(() => runs === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runs, 2);
    assert.equal(states.at(-1).state, "paused");
  } finally {
    coordinator.stop();
  }
});

test("a deleted household terminates a continuation chain", async () => {
  const states = [];
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { deviceId: "device" }, onState: (state) => states.push(state) });
  let runs = 0;
  coordinator.runOnce = async () => {
    runs += 1;
    if (runs === 2) throw Object.assign(new Error("deleted"), { code: "household_deleted" });
    return { hasMore: true, advanced: true };
  };
  try {
    await coordinator.syncNow();
    await waitFor(() => coordinator.terminal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runs, 2);
    assert.equal(states.at(-1).state, "deleted");
  } finally {
    coordinator.stop();
  }
});

test("a lock between passes stops the continuation chain", async () => {
  let locked = false;
  let runs = 0;
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { deviceId: "device" } });
  coordinator.keyStore = { vault: { assertUnlocked() { if (locked) throw Object.assign(new Error("locked"), { code: "locked" }); } }, close() {} };
  coordinator.runOnce = async () => {
    runs += 1;
    coordinator.keyStore.vault.assertUnlocked();
    return { hasMore: true, advanced: true };
  };
  try {
    await coordinator.syncNow();
    locked = true;
    await waitFor(() => runs === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runs, 2);
    assert.equal(coordinator.continuationTimer, null);
  } finally {
    coordinator.stop();
  }
});

test("the sliding request budget stays at or below 200 during a 10,000-event catch-up", () => {
  let now = 0;
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { deviceId: "device" }, now: () => now });
  const requests = [];
  for (let pass = 0; pass < 100; pass += 1) {
    const delay = coordinator.requestBudgetDelay(5);
    now += delay;
    for (let page = 0; page < 5; page += 1) {
      coordinator.recordRequest();
      requests.push(now);
    }
  }
  for (const timestamp of requests) {
    const inWindow = requests.filter((candidate) => candidate > timestamp - 60_000 && candidate <= timestamp).length;
    assert.ok(inWindow <= 200, `${inWindow} requests landed in one simulated minute`);
  }
  assert.equal(requests.length, 500);
  assert.ok(now >= 120_000);
});

test("sync_rate_limited stays in catching-up state and resumes", async () => {
  const states = [];
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { deviceId: "device" }, onState: (state) => states.push(state) });
  let runs = 0;
  coordinator.runOnce = async () => {
    runs += 1;
    if (runs === 1) throw Object.assign(new Error("limited"), { code: "sync_rate_limited", retryAfterMs: 1 });
    return { hasMore: false, advanced: true };
  };
  try {
    await coordinator.syncNow();
    assert.equal(states.at(-1).state, "syncing");
    assert.equal(states.at(-1).message, "Catching up…");
    assert.notEqual(states.at(-1).state, "paused");
    await waitFor(() => runs === 2);
  } finally {
    coordinator.stop();
  }
});

test("catch-up passes skip bootstrap and attachment reconciliation until the final page", async () => {
  const continuing = catchUpHarness([
    { events: [], nextCursor: CURSORS[1], hasMore: true },
  ]);
  await continuing.coordinator.syncNow();
  continuing.coordinator.stop();
  assert.deepEqual(continuing.calls(), { bootstrapCalls: 0, projectionCalls: 0, pageIndex: 2 });

  const finishing = catchUpHarness([
    { events: [], nextCursor: CURSORS[1], hasMore: false },
  ]);
  await finishing.coordinator.syncNow();
  finishing.coordinator.stop();
  assert.equal(finishing.calls().bootstrapCalls, 0);
  assert.equal(finishing.calls().projectionCalls, 1);
});

test("five catch-up pages coalesce state publication into one update", async () => {
  const pages = [1, 2, 3, 4, 5].map((index) => ({ events: [], nextCursor: CURSORS[index], hasMore: true }));
  const { coordinator, states, calls } = catchUpHarness(pages);
  await coordinator.syncNow();
  coordinator.stop();
  assert.equal(calls().pageIndex, 5);
  assert.equal(states.length, 1);
});

test("only Adult sessions attempt epoch rotation and key provisioning during sync", () => {
  assert.equal(memberHasTrustAuthority({ memberKind: "adult" }), true);
  assert.equal(memberHasTrustAuthority({ memberKind: "limited" }), false);
  assert.equal(memberHasTrustAuthority({ memberKind: "temporary", memberExpiresAt: 1 }), false);
  assert.equal(memberHasTrustAuthority({}), false);
  assert.equal(memberHasTrustAuthority(null), false);
});

test("offline household settings load only from the matching protected cache", async () => {
  const householdId = "11".repeat(16);
  const memberId = "12".repeat(16);
  const deviceId = "13".repeat(16);
  const cached = { householdId, revision: 4, keyEpoch: 2, ciphertext: "AQ", digest: "a".repeat(64) };
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId, deviceId: "device" } });
  coordinator.identity = { householdId, memberId, deviceId };
  coordinator.keyStore = {
    getDevice: async () => ({ householdId, memberId }),
    getCachedHouseholdSettings: async (requested) => requested === householdId ? cached : null,
  };
  coordinator.request = async () => { const error = new Error("offline"); error.code = "connection_unavailable"; throw error; };
  coordinator.loadCachedHouseholdSettings = async () => ({ version: 1, revision: cached.revision, name: "Cached Home" });
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  try {
    assert.deepEqual(await coordinator.loadHouseholdSettings(), { admin: false, adminRecorded: false,
      value: { version: 1, revision: 4, name: "Cached Home" }, offline: true });
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  }
});

test("startup cache restoration requires the locally bound household member and device", async () => {
  const identity = { householdId: "11".repeat(16), memberId: "22".repeat(16), deviceId: "33".repeat(16) };
  const cache = { householdId: identity.householdId, revision: 4, keyEpoch: 2, ciphertext: "AQ", digest: "a".repeat(64) };
  const keyStore = {
    getDevice: async () => ({ householdId: identity.householdId, memberId: identity.memberId }),
    getCachedHouseholdSettings: async () => cache,
    getEpoch: async () => null,
  };
  await assert.rejects(() => loadCachedHouseholdSettings(identity, { keyStore }), /key needed/);
  keyStore.getDevice = async () => ({ householdId: "44".repeat(16), memberId: identity.memberId });
  await assert.rejects(() => loadCachedHouseholdSettings(identity, { keyStore }), /match the local household settings cache/);
  await assert.rejects(() => loadCachedHouseholdSettings({ ...identity, deviceId: "invalid" }, { keyStore }), /identify/);
});

test("household settings are cached only after validation and newer protected revisions win", async () => {
  const householdId = "22".repeat(16);
  const server = { revision: 3, keyEpoch: 1, ciphertext: "AQ", digest: "b".repeat(64) };
  const newer = { householdId, revision: 5, keyEpoch: 2, ciphertext: "Ag", digest: "c".repeat(64) };
  const calls = [];
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId, deviceId: "device" } });
  coordinator.request = async () => ({ admin: true, adminRecorded: true, settings: server });
  coordinator.keyStore = { cacheHouseholdSettings: async (record) => { calls.push(record); return newer; } };
  coordinator.decryptCachedHouseholdSettings = async (record) => {
    calls.push(`decrypt:${record.revision}`);
    if (record.revision === 3) return { revision: 3, name: "Server" };
    return { revision: 5, name: "Newer cache" };
  };
  const result = await coordinator.loadHouseholdSettings();
  assert.deepEqual(calls.map((value) => typeof value === "string" ? value : `cache:${value.revision}`),
    ["decrypt:3", "cache:3", "decrypt:5"]);
  assert.equal(result.value.name, "Newer cache");

  calls.length = 0;
  coordinator.decryptCachedHouseholdSettings = async () => { throw new Error("tampered"); };
  await assert.rejects(() => coordinator.loadHouseholdSettings(), /tampered/);
  assert.deepEqual(calls, []);
});

test("an accepted household settings save is immediately available to offline startup", async () => {
  const householdId = "31".repeat(16);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const value = { version: 1, revision: 2, name: "Willow", appearance: {
    version: 1, owner: "household", mode: "light", colorSource: "default", seed: "#984D38", manual: null, image: null,
  }, brand: { version: 1, iconSource: "letter", icon: null } };
  const cached = [];
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId, deviceId: "device" } });
  coordinator.request = async (path) => path === "/api/sync/status" ? { currentEpoch: 4 } : { revision: 3 };
  coordinator.keyStore = {
    getEpoch: async () => ({ householdKey: key }),
    cacheHouseholdSettings: async (record) => { cached.push(record); return record; },
  };
  assert.deepEqual(await coordinator.saveHouseholdSettings(value), { ...value, revision: 3 });
  assert.equal(cached.length, 1);
  assert.equal(cached[0].householdId, householdId);
  assert.equal(cached[0].revision, 3);
  assert.equal(cached[0].keyEpoch, 4);
  assert.match(cached[0].ciphertext, /^[A-Za-z0-9_-]+$/);
  assert.match(cached[0].digest, /^[a-f0-9]{64}$/);
});

test("a cache failure after server acceptance reports the committed settings", async () => {
  const householdId = "32".repeat(16);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const value = { version: 1, revision: 2, name: "Willow", appearance: {
    version: 1, owner: "household", mode: "light", colorSource: "default", seed: "#984D38", manual: null, image: null,
  }, brand: { version: 1, iconSource: "letter", icon: null } };
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId, deviceId: "device" } });
  coordinator.request = async (path) => path === "/api/sync/status" ? { currentEpoch: 4 } : { revision: 3 };
  coordinator.keyStore = {
    getEpoch: async () => ({ householdKey: key }),
    cacheHouseholdSettings: async () => { throw new Error("storage closed"); },
  };
  await assert.rejects(() => coordinator.saveHouseholdSettings(value), (error) => {
    assert.equal(error.code, "household_settings_cache_partial");
    assert.deepEqual(error.savedValue, { ...value, revision: 3 });
    assert.match(error.message, /were saved.*offline copy/i);
    return true;
  });
});

test("a member listed twice must agree field by field", () => {
  const entry = { memberId: "aa".repeat(16), memberKind: "temporary", memberActive: true, memberStatus: "active", memberExpiresAt: 9_000 };
  // The same record with its fields in another order is one member.
  const reordered = { memberExpiresAt: 9_000, memberStatus: "active", memberActive: true, memberKind: "temporary", memberId: "aa".repeat(16) };
  assert.deepEqual(portableMembershipFromDirectory([entry, reordered]),
    [{ memberId: "aa".repeat(16), memberKind: "temporary", status: "active", expiresAt: 9_000 }]);
  for (const change of [{ memberStatus: "removed", memberActive: false }, { memberExpiresAt: 9_001 }])
    assert.throws(() => portableMembershipFromDirectory([entry, { ...entry, ...change }]), /conflicting membership/);
});

test("a household that moved to a home server stops sync for good; one that is moving only waits (#737)", async () => {
  const run = async (code) => {
    const states = [];
    const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { deviceId: "device" }, onState: (state) => states.push(state) });
    coordinator.runOnce = async () => { throw Object.assign(new Error(code), { code }); };
    try {
      await coordinator.syncNow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { states, terminal: coordinator.terminal };
    } finally {
      coordinator.stop();
    }
  };
  const moved = await run("household_moved");
  assert.equal(moved.terminal, true);
  assert.deepEqual({ state: moved.states.at(-1).state, lifecycleState: moved.states.at(-1).lifecycleState }, { state: "deleted", lifecycleState: "moved" });
  const moving = await run("household_moving");
  assert.equal(moving.terminal, false, "it tries again");
  assert.equal(moving.states.at(-1).state, "paused");
  assert.match(moving.states.at(-1).message, /moving to its home server/);
});

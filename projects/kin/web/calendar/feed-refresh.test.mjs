// The device side of synced calendars (#668): the sealed feed cache, the
// external-occurrence seam the views read, and the refresher's schedule
// (at unlock, every 30 minutes, after sync when the list is 5 minutes old),
// conditional fetches, errors, and removal everywhere.
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearExternalOccurrences, externalOccurrences, externalSources, externalWindow, onExternalOccurrences, removeExternalOccurrences,
  setExternalOccurrences,
} from "./external.js";
import { FEED_CACHE_STORE, FeedCache, memoryFeedBackend } from "./feed-cache.js";
import { CalendarFeedRefresher, LIST_INTERVAL_MS, REFRESH_INTERVAL_MS } from "./feed-refresh.js";

const id = (n) => n.toString(16).padStart(32, "0");

/** A stand-in for the local vault: sealing binds the context, as AES-GCM's
 * associated data does; a different root (`generation`) can't open. */
function fakeVault() {
  const vault = {
    root: 1, locked: false, sealed: [],
    async seal(value, context) {
      vault.sealed.push(context);
      return JSON.stringify({ root: vault.root, context, value });
    },
    async open(envelope, context) {
      if (vault.locked) throw Object.assign(new Error("locked"), { code: "locked" });
      const parsed = JSON.parse(envelope);
      if (parsed.root !== vault.root || JSON.stringify(parsed.context) !== JSON.stringify(context)) throw new Error("protected_store_corrupt");
      return parsed.value;
    },
  };
  return vault;
}

const feedEvents = (title) => [{
  flags: { cancelled: false }, master: null, original: null, exdates: [],
  event: { title, place: "", notes: "", sourceUid: `${title}@test`, allDay: false, zone: "Europe/London",
    start: { date: 20261102, minute: 540 }, end: { date: 20261102, minute: 570 }, repeat: { frequency: "weekly", interval: 1, weekdays: [0], weekStart: 0 } },
}];

test("the feed cache keeps feeds sealed, by subscription, and drops what no longer opens", async () => {
  const vault = fakeVault();
  const backend = memoryFeedBackend();
  const cache = new FeedCache(backend, vault);
  const value = { subscriptionId: id(1), fetchedAt: 5, etag: '"a"', source: "Google", audience: "me", name: "Work", events: feedEvents("Stand-up") };
  await cache.write(value);
  assert.deepEqual(vault.sealed, [{ store: FEED_CACHE_STORE, id: id(1) }]);
  const row = backend.rows.get(id(1));
  assert.deepEqual(Object.keys(row).sort(), ["sealed", "subscriptionId"], "only the ID is in the clear");
  assert.deepEqual(await cache.read(id(1)), value);
  assert.deepEqual(await cache.readAll(), [value]);
  // A row sealed for another subscription doesn't open as this one.
  backend.rows.set(id(2), { subscriptionId: id(2), sealed: row.sealed });
  assert.equal(await cache.read(id(2)), null);
  assert.equal(backend.rows.has(id(2)), false, "dropped");
  // Locked: refused, and kept.
  vault.locked = true;
  await assert.rejects(cache.read(id(1)), /locked/);
  assert.equal(backend.rows.has(id(1)), true);
  vault.locked = false;
  // A new local root (recovery key replacement): dropped, fetched again later.
  vault.root = 2;
  assert.deepEqual(await cache.readAll(), []);
  assert.equal(backend.rows.size, 0);
  await assert.rejects(cache.write({ subscriptionId: "nope" }), /invalid/);
});

test("external occurrences: set, read by range, listen, remove and clear", () => {
  clearExternalOccurrences();
  const seen = [];
  const stop = onExternalOccurrences(({ sourceId }) => seen.push(sourceId));
  const occurrence = (date, title) => ({ title, allDay: false, start: { date, minute: 540 }, end: { date, minute: 600 }, readOnly: false });
  setExternalOccurrences("a", [occurrence(20261103, "B"), occurrence(20261101, "A")], { label: "From Google" });
  setExternalOccurrences("b", [occurrence(20261102, "C"), { bad: true }], { label: "From Apple" });
  assert.deepEqual(externalOccurrences(20261101, 20261102).map((o) => o.title), ["A", "C"]);
  assert.equal(externalOccurrences(20261101, 20261130).every((o) => o.readOnly === true && Object.isFrozen(o)), true, "always read-only");
  assert.deepEqual(externalSources().map((s) => [s.sourceId, s.count, s.label]), [["a", 2, "From Google"], ["b", 1, "From Apple"]]);
  assert.deepEqual(externalOccurrences(20261130, 20261101), []);
  removeExternalOccurrences("a");
  assert.deepEqual(externalOccurrences(20261101, 20261130).map((o) => o.title), ["C"]);
  clearExternalOccurrences();
  assert.deepEqual(externalOccurrences(20261101, 20261130), []);
  assert.deepEqual(seen, ["a", "b", "a", "b"]);
  stop();
  setExternalOccurrences("c", []);
  assert.equal(seen.length, 4, "a stopped listener hears nothing");
  clearExternalOccurrences();
  assert.deepEqual(externalWindow(20261021), { from: 20260920, to: 20271022 });
  assert.throws(() => setExternalOccurrences("", []), TypeError);
});

/** A refresher over a fake service, clock and timers. */
function harness({ subscriptions = [{ id: id(1), source: "Google", audience: "me", mine: true, canRemove: true, status: "ok" }] } = {}) {
  const clock = { now: 1_000_000, today: 20261102 };
  const timers = [];
  const calls = [];
  const service = {
    subscriptions,
    failList: null,
    feeds: new Map(subscriptions.map((s) => [s.id, { etag: '"v1"', title: "Stand-up" }])),
    failFeed: new Map(),
  };
  const api = {
    async list() {
      calls.push(["list"]);
      if (service.failList) throw service.failList;
      return { subscriptions: service.subscriptions, canAdd: true, limits: { perMember: 10, perHousehold: 30 } };
    },
    async feed(subscriptionId, etag) {
      calls.push(["feed", subscriptionId, etag]);
      if (service.failFeed.has(subscriptionId)) throw service.failFeed.get(subscriptionId);
      const feed = service.feeds.get(subscriptionId);
      if (etag && etag === feed.etag) return { notModified: true, fetchedAt: clock.now };
      return { bytes: new TextEncoder().encode(feed.title), etag: feed.etag, fetchedAt: clock.now };
    },
    async add({ url, audience }) {
      calls.push(["add", url, audience]);
      const subscription = { id: id(9), source: "Apple", audience, mine: true, canRemove: true, status: "ok" };
      service.subscriptions = [...service.subscriptions, subscription];
      service.feeds.set(subscription.id, { etag: null, title: "Swimming" });
      return subscription;
    },
    async remove(subscriptionId) {
      calls.push(["remove", subscriptionId]);
      service.subscriptions = service.subscriptions.filter((s) => s.id !== subscriptionId);
    },
  };
  const vault = fakeVault();
  const backend = memoryFeedBackend();
  const views = [];
  const make = () => new CalendarFeedRefresher({
    api, cache: new FeedCache(backend, vault),
    parse: async (bytes) => {
      const title = new TextDecoder().decode(bytes);
      if (title === "garbage") throw new Error("KICS");
      return { name: `${title} calendar`, skipped: 0, truncated: false, events: feedEvents(title) };
    },
    today: () => clock.today, now: () => clock.now,
    onChange: (view) => views.push(view),
    setInterval: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearInterval: (handle) => { timers[handle - 1].cleared = true; },
  });
  return { clock, timers, calls, service, api, vault, backend, views, make };
}

const titles = () => externalOccurrences(20261101, 20261130).map((o) => `${o.title} ${o.start.date} ${o.label}`);

test("at unlock: fetches each calendar, keeps it sealed, and hands read-only occurrences to the views", async () => {
  clearExternalOccurrences();
  const h = harness();
  const refresher = h.make();
  await refresher.start();
  assert.deepEqual(h.calls, [["list"], ["feed", id(1), null]]);
  assert.deepEqual(titles(), ["Stand-up 20261102 From Google", "Stand-up 20261109 From Google", "Stand-up 20261116 From Google", "Stand-up 20261123 From Google", "Stand-up 20261130 From Google"]);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, REFRESH_INTERVAL_MS);
  const view = refresher.view();
  assert.equal(view.state, "ready");
  assert.equal(view.subscriptions[0].name, "Stand-up calendar");
  assert.equal(view.subscriptions[0].summary.next.title, "Stand-up");
  assert.equal(view.subscriptions[0].localFetchedAt, h.clock.now);
  assert.equal(h.backend.rows.size, 1);
  refresher.stop();
  assert.deepEqual(externalOccurrences(20261101, 20261130), [], "locking clears them from memory");
  assert.equal(h.timers[0].cleared, true);
  assert.equal(h.backend.rows.size, 1, "the sealed copy stays on the device");

  // The next unlock, offline: what the device kept shows at once.
  h.service.failList = Object.assign(new Error("offline"), { status: 0 });
  const offline = h.make();
  await offline.start();
  assert.equal(offline.view().state, "offline");
  assert.equal(titles().length, 5);
  assert.deepEqual(offline.view().subscriptions.map((s) => [s.id, s.source, s.name]), [[id(1), "Google", "Stand-up calendar"]]);
  offline.stop();
});

test("schedule: every 30 minutes, after sync only when the list is 5 minutes old, with the ETag", async () => {
  clearExternalOccurrences();
  const h = harness();
  const refresher = h.make();
  await refresher.start();
  h.calls.length = 0;
  // A sync pass right after: nothing.
  refresher.onSync();
  await refresher.refreshing;
  assert.deepEqual(h.calls, []);
  // Five minutes later: the list, but the feed isn't due.
  h.clock.now += LIST_INTERVAL_MS;
  refresher.onSync();
  await refresher.refreshing;
  assert.deepEqual(h.calls, [["list"]]);
  // The 30-minute timer: the feed, asked for with its ETag; unchanged.
  h.calls.length = 0;
  h.clock.now += REFRESH_INTERVAL_MS;
  h.timers[0].callback();
  await refresher.refreshing;
  assert.deepEqual(h.calls, [["list"], ["feed", id(1), '"v1"']]);
  assert.equal(refresher.view().subscriptions[0].localFetchedAt, h.clock.now);
  // Changed on the calendar's side: the new version replaces the old.
  h.service.feeds.set(id(1), { etag: '"v2"', title: "Retro" });
  h.clock.now += REFRESH_INTERVAL_MS;
  await refresher.refresh();
  assert.deepEqual(titles()[0], "Retro 20261102 From Google");
  // Calls while one runs coalesce into one more.
  h.calls.length = 0;
  await Promise.all([refresher.refresh({ force: true }), refresher.refresh({ force: true }), refresher.refresh({ force: true })]);
  await refresher.refreshing;
  assert.equal(h.calls.filter(([what]) => what === "list").length, 2);
  // A new day moves the window.
  h.clock.today = 20261201;
  refresher.onSync();
  assert.equal(externalOccurrences(20261201, 20261231).length > 0, true);
  refresher.stop();
});

test("errors keep the last good copy and say why; a broken feed doesn't replace it", async () => {
  clearExternalOccurrences();
  const h = harness();
  const refresher = h.make();
  await refresher.start();
  h.service.failFeed.set(id(1), Object.assign(new Error("The calendar's server says this link no longer exists."), { code: "calendar_link_not_found", status: 502 }));
  h.clock.now += REFRESH_INTERVAL_MS;
  await refresher.refresh();
  let view = refresher.view().subscriptions[0];
  assert.equal(view.deviceError.code, "calendar_link_not_found");
  assert.equal(titles().length, 5, "still showing");
  // Not asked again until 30 minutes after the failed try.
  h.calls.length = 0;
  h.clock.now += LIST_INTERVAL_MS;
  await refresher.refresh();
  assert.deepEqual(h.calls, [["list"]]);
  // A feed that doesn't parse.
  h.service.failFeed.clear();
  h.service.feeds.set(id(1), { etag: '"v3"', title: "garbage" });
  h.clock.now += REFRESH_INTERVAL_MS;
  await refresher.refresh();
  view = refresher.view().subscriptions[0];
  assert.equal(view.deviceError.code, "calendar_unreadable");
  assert.equal(titles()[0], "Stand-up 20261102 From Google");
  // Fixed: the error goes.
  h.service.feeds.set(id(1), { etag: '"v4"', title: "Planning" });
  await refresher.refresh({ force: true });
  assert.equal(refresher.view().subscriptions[0].deviceError, null);
  assert.equal(titles()[0], "Planning 20261102 From Google");
  // Signed out or removed: nothing to sync.
  h.service.failList = Object.assign(new Error("no"), { status: 401 });
  await refresher.refresh();
  assert.equal(refresher.view().state, "unavailable");
  refresher.stop();
});

test("adding fetches the new calendar; turning one off removes it here, and from other devices at their next list", async () => {
  clearExternalOccurrences();
  const h = harness();
  const mine = h.make();
  await mine.start();
  const added = await mine.add({ url: "webcal://p01-caldav.icloud.com/x", audience: "household" });
  assert.equal(added.id, id(9));
  assert.deepEqual(h.calls.slice(-2), [["add", "webcal://p01-caldav.icloud.com/x", "household"], ["feed", id(9), null]]);
  assert.equal(externalOccurrences(20261101, 20261130).some((o) => o.title === "Swimming" && o.label === "From Apple"), true);
  // Another device of the household (same service, its own cache).
  mine.stop();
  const other = harness();
  other.service.subscriptions = h.service.subscriptions;
  other.service.feeds = h.service.feeds;
  const theirs = other.make();
  await theirs.start();
  assert.equal(other.backend.rows.size, 2);
  // Turned off on the first device.
  const again = h.make();
  await again.start();
  await again.remove(id(9));
  assert.equal(h.backend.rows.has(id(9)), false);
  assert.equal(again.view().subscriptions.some((s) => s.id === id(9)), false);
  again.stop();
  // The other device's next list removes it there too.
  other.service.subscriptions = h.service.subscriptions;
  other.clock.now += LIST_INTERVAL_MS;
  theirs.onSync();
  await theirs.refreshing;
  assert.equal(other.backend.rows.has(id(9)), false);
  assert.equal(externalOccurrences(20261101, 20261130).some((o) => o.title === "Swimming"), false);
  theirs.stop();
});

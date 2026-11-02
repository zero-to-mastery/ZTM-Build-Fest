// Keeps this device's synced calendars current (#668, ADR 0022 §3).
//
// While Kin is unlocked: at unlock it shows what the device kept
// (feed-cache.js), then lists the calendars the service says this member
// sees and fetches each one whose copy is 30 minutes old or more; again
// every 30 minutes while Kin is open; and after a sync pass when the list
// is 5 minutes old or more. Each feed comes from the service's
// authenticated route (GET /api/calendar/subscriptions/:id/feed, with the
// ETag the device holds so an unchanged calendar costs nothing), is parsed
// on this device by Rust (`parseICalendar`), kept sealed in the feed cache,
// and expanded here (feed-expand.js) over the window around today
// (external.js externalWindow) for the views. A calendar the service no
// longer lists was turned off, or its owner left: it goes from this device
// too.
//
// A failed fetch keeps the last good copy showing, with when it was
// fetched and why it couldn't be updated; the service backs off meanwhile.
//
// Dependencies are passed in, so this runs in tests without a browser:
// `api` ({ list, feed, add, remove }), `parse(bytes)`, `cache` (FeedCache),
// `today()` (YYYYMMDD), `now()`, `publish` (external.js), timers.
import { expandFeed } from "./feed-expand.js";
import { externalCalendar, externalWindow } from "./external.js";

export const REFRESH_INTERVAL_MS = 30 * 60_000;
export const LIST_INTERVAL_MS = 5 * 60_000;
const UNREADABLE = Object.freeze({ code: "calendar_unreadable", message: "Kin couldn't read this calendar. It will try again later." });

export class CalendarFeedRefresher {
  constructor({
    api, parse, cache, today, now = () => Date.now(), publish = externalCalendar, onChange = () => {},
    setInterval: every = globalThis.setInterval.bind(globalThis), clearInterval: stopEvery = globalThis.clearInterval.bind(globalThis),
  }) {
    Object.assign(this, { api, parse, cache, today, now, publish, onChange, every, stopEvery });
    this.state = "idle";
    this.subscriptions = [];
    this.canAdd = false;
    this.limits = null;
    /** id → the cached value (feed-cache.js) */
    this.local = new Map();
    /** id → { code, message, at } of the last failed fetch */
    this.errors = new Map();
    /** id → when this device last tried */
    this.attempted = new Map();
    /** id → { count, next, truncated } of what is published */
    this.summaries = new Map();
    this.listedAt = -Infinity;
    this.windowDay = null;
    this.running = false;
    this.refreshing = null;
    this.again = null;
    this.timer = null;
  }

  /** At unlock: shows what the device kept, then refreshes. */
  async start() {
    this.running = true;
    this.state = "loading";
    try {
      for (const value of await this.cache.readAll()) this.local.set(value.subscriptionId, value);
    } catch { /* nothing kept, or locked: the refresh decides */ }
    if (!this.running) return;
    this.windowDay = this.today();
    for (const id of this.local.keys()) this.publishOne(id);
    this.changed();
    this.timer = this.every(() => { void this.refresh(); }, REFRESH_INTERVAL_MS);
    await this.refresh();
  }

  /** At lock: stops, and clears the decrypted occurrences from memory. */
  stop() {
    this.running = false;
    if (this.timer !== null) this.stopEvery(this.timer);
    this.timer = null;
    for (const id of this.local.keys()) this.publish.removeExternalOccurrences(id);
    this.local.clear();
    this.summaries.clear();
    this.errors.clear();
    this.subscriptions = [];
    this.state = "idle";
    this.cache.close?.();
  }

  /** After a sync pass: lists again when the list is 5 minutes old. */
  onSync() {
    if (!this.running) return;
    if (this.now() - this.listedAt >= LIST_INTERVAL_MS) void this.refresh();
    else this.republishIfDayChanged();
  }

  /** Lists, then fetches what is due (everything with `force`). One at a
   * time; a call meanwhile runs once more afterwards. */
  refresh({ force = false } = {}) {
    if (!this.running) return Promise.resolve();
    if (this.refreshing) {
      this.again = { force: force || Boolean(this.again?.force) };
      return this.refreshing;
    }
    this.refreshing = this.run(force).finally(() => {
      this.refreshing = null;
      const again = this.again;
      this.again = null;
      if (again && this.running) void this.refresh(again);
    });
    return this.refreshing;
  }

  async run(force) {
    let listed;
    try {
      listed = await this.api.list();
    } catch (error) {
      if (!this.running) return;
      // Not connected to a service, or not a member any more: nothing to
      // sync. Otherwise offline: keep showing what the device has.
      this.state = error?.status === 401 || error?.status === 403 ? "unavailable" : "offline";
      this.republishIfDayChanged();
      this.changed();
      return;
    }
    if (!this.running) return;
    this.listedAt = this.now();
    this.state = "ready";
    this.subscriptions = Array.isArray(listed?.subscriptions) ? listed.subscriptions : [];
    this.canAdd = listed?.canAdd === true;
    this.limits = listed?.limits ?? null;
    const listedIds = new Set(this.subscriptions.map((subscription) => subscription.id));
    for (const id of [...this.local.keys(), ...this.errors.keys()]) if (!listedIds.has(id)) await this.forget(id);
    this.changed();
    for (const subscription of this.subscriptions) {
      if (!this.running) return;
      const kept = this.local.get(subscription.id);
      const tried = this.attempted.get(subscription.id) ?? -Infinity;
      // Never fetched here, or the last fetch or try is 30 minutes old.
      const last = Math.max(kept?.receivedAt ?? -Infinity, tried);
      const due = force || last === -Infinity || this.now() - last >= REFRESH_INTERVAL_MS;
      if (due) await this.fetchOne(subscription);
    }
    this.republishIfDayChanged();
    this.changed();
  }

  async fetchOne(subscription) {
    const id = subscription.id;
    this.attempted.set(id, this.now());
    const kept = this.local.get(id);
    let result;
    try {
      result = await this.api.feed(id, kept?.etag ?? null);
    } catch (error) {
      if (!this.running) return;
      this.errors.set(id, { code: error?.code ?? "calendar_unreachable", message: error?.message || "Kin couldn't update this calendar.", at: this.now() });
      this.changed();
      return;
    }
    if (!this.running) return;
    let value;
    if (result.notModified && kept) value = { ...kept, fetchedAt: result.fetchedAt ?? this.now(), receivedAt: this.now() };
    else {
      let parsed;
      try { parsed = await this.parse(result.bytes); } catch {
        if (!this.running) return;
        this.errors.set(id, { ...UNREADABLE, at: this.now() });
        this.changed();
        return;
      }
      if (!this.running) return;
      value = {
        subscriptionId: id, fetchedAt: result.fetchedAt ?? this.now(), receivedAt: this.now(), etag: result.etag ?? null,
        source: subscription.source, audience: subscription.audience, name: parsed?.name ?? "",
        events: Array.isArray(parsed?.events) ? parsed.events : [], skipped: parsed?.skipped ?? 0, truncated: Boolean(parsed?.truncated),
      };
    }
    this.errors.delete(id);
    this.local.set(id, value);
    try { await this.cache.write(value); } catch { /* shown now; fetched again next unlock */ }
    if (!this.running) return;
    this.publishOne(id);
    this.changed();
  }

  /** Expands one calendar over the window around today and hands it to the
   * views. */
  publishOne(id) {
    const value = this.local.get(id);
    if (!value) return;
    const today = this.today();
    const window = externalWindow(today);
    const label = `From ${value.source || "another calendar"}`;
    const { occurrences, truncated } = expandFeed(value, window.from, window.to, { sourceId: id, label });
    this.publish.setExternalOccurrences(id, occurrences, { label, name: value.name, fetchedAt: value.fetchedAt, truncated, window });
    const next = occurrences.find((occurrence) => occurrence.end.date >= today) ?? null;
    this.summaries.set(id, { count: occurrences.length, truncated, next: next && { title: next.title, start: next.start, allDay: next.allDay, zone: next.zone } });
  }

  republishIfDayChanged() {
    const today = this.today();
    if (today === this.windowDay) return;
    this.windowDay = today;
    for (const id of this.local.keys()) this.publishOne(id);
  }

  /** A calendar that went: from the views, the summaries and the cache. */
  async forget(id) {
    this.local.delete(id);
    this.errors.delete(id);
    this.attempted.delete(id);
    this.summaries.delete(id);
    this.publish.removeExternalOccurrences(id);
    try { await this.cache.remove(id); } catch { /* the next list removes it again */ }
  }

  /** Adds a calendar (the service checks the link by fetching it), then
   * fetches it here. Resolves the service's view of it. */
  async add({ url, audience }) {
    const subscription = await this.api.add({ url, audience });
    if (this.running) {
      this.subscriptions = [...this.subscriptions.filter((entry) => entry.id !== subscription.id), subscription];
      this.changed();
      await this.fetchOne(subscription);
    }
    return subscription;
  }

  /** Turns a calendar off, for everyone in its audience. */
  async remove(id) {
    await this.api.remove(id);
    this.subscriptions = this.subscriptions.filter((entry) => entry.id !== id);
    await this.forget(id);
    this.changed();
  }

  /** What the settings page shows. Offline before the first list, the
   * calendars this device kept stand in for the service's list. */
  view() {
    const listed = this.state === "ready" || this.subscriptions.length
      ? this.subscriptions
      : [...this.local.values()].map((value) => ({ id: value.subscriptionId, source: value.source, audience: value.audience, mine: null, canRemove: false, status: "ok" }));
    return {
      state: this.state,
      canAdd: this.canAdd,
      limits: this.limits,
      subscriptions: listed.map((subscription) => {
        const kept = this.local.get(subscription.id);
        return {
          ...subscription,
          name: kept?.name ?? "",
          localFetchedAt: kept?.fetchedAt ?? null,
          summary: this.summaries.get(subscription.id) ?? null,
          deviceError: this.errors.get(subscription.id) ?? null,
        };
      }),
    };
  }

  changed() {
    try { this.onChange(this.view()); } catch { /* the page redraws next time */ }
  }
}

// Outside calendars on this device (#668, ADR 0022 §3): connects the
// settings section (<kin-calendar-subscriptions>) and the refresher
// (calendar/feed-refresh.js) to the service's routes, the engine's iCalendar
// parser and the local vault, for the unlocked session.
//
// Started at unlock for a household that syncs (session.js), told about
// each sync pass (sync.js), stopped on lock, which clears the decrypted
// occurrences from memory (calendar/external.js). State stays on the
// element (`this.app`); app/context.js explains the controllers.
import { clearExternalOccurrences } from "../../calendar/external.js";
import { FeedCache } from "../../calendar/feed-cache.js";
import { CalendarFeedRefresher } from "../../calendar/feed-refresh.js";

const ROUTE = "/api/calendar/subscriptions";

async function failure(response) {
  const value = await response.json().catch(() => ({}));
  return Object.assign(new Error(value.message || "Kin couldn't reach your household's calendars."), { code: value.error, status: response.status });
}

export class CalendarSyncController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.refresher = null;
    this.householdId = null;
    this.starting = null;
  }

  /** The service's routes, refusing results from a session that ended. */
  api(session) {
    const guard = () => this.ctx.session.assertCurrentSession(session);
    const json = async (path, options = {}) => {
      const response = await fetch(path, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
      guard();
      if (!response.ok) throw await failure(response);
      const value = await response.json();
      guard();
      return value;
    };
    return {
      list: () => json(ROUTE),
      add: async ({ url, audience }) => (await json(ROUTE, { method: "POST", body: JSON.stringify({ url, audience }) })).subscription,
      remove: (id) => json(`${ROUTE}/${id}`, { method: "DELETE" }),
      feed: async (id, etag) => {
        const response = await fetch(`${ROUTE}/${id}/feed`, { cache: "no-store", headers: etag ? { "If-None-Match": etag } : {} });
        guard();
        const fetchedAt = Number(response.headers.get("X-Kin-Calendar-Fetched-At")) || Date.now();
        if (response.status === 304) return { notModified: true, fetchedAt };
        if (!response.ok) throw await failure(response);
        const bytes = new Uint8Array(await response.arrayBuffer());
        guard();
        return { bytes, etag: response.headers.get("ETag"), fetchedAt };
      },
    };
  }

  view() {
    if (this.refresher) return this.refresher.view();
    return { state: this.householdId ? "loading" : "local", canAdd: false, subscriptions: [] };
  }

  render() {
    this.app.calendarSubscriptions?.update(this.view());
  }

  /** At unlock: `syncIdentity` is the household's sync binding, or null for
   * a household that doesn't sync (nothing to fetch then). */
  start(syncIdentity, session = this.ctx.session.captureSession()) {
    this.stop();
    this.householdId = syncIdentity?.householdId ?? null;
    if (this.app.calendarSubscriptions) this.app.calendarSubscriptions.controller = this;
    this.render();
    if (!this.householdId || !session.vault || !session.store) return Promise.resolve();
    const starting = (async () => {
      const cache = await FeedCache.open(this.householdId, { vault: session.vault });
      if (!this.ctx.session.isCurrentSession(session) || this.starting !== starting) { cache.close(); return; }
      this.refresher = new CalendarFeedRefresher({
        api: this.api(session),
        parse: (bytes) => session.store.parseICalendar(bytes),
        cache,
        today: () => this.ctx.navigation.currentCivilDate(),
        onChange: () => this.render(),
      });
      await this.refresher.start();
    })().catch(() => this.render());
    this.starting = starting;
    return starting;
  }

  /** After a sync pass. */
  onSync() {
    this.refresher?.onSync();
  }

  /** Lists and fetches everything now (the regression and a manual retry). */
  refresh() {
    return this.refresher?.refresh({ force: true }) ?? Promise.resolve();
  }

  async add(url, audience) {
    if (!this.refresher) throw new Error("Connect this household to a Kin server to sync calendars.");
    return this.refresher.add({ url, audience });
  }

  async remove(id) {
    if (!this.refresher) throw new Error("Kin can't reach your household's calendars right now.");
    return this.refresher.remove(id);
  }

  /** On lock: everything decrypted leaves memory. */
  stop() {
    this.starting = null;
    this.refresher?.stop();
    this.refresher = null;
    this.householdId = null;
    clearExternalOccurrences();
  }
}

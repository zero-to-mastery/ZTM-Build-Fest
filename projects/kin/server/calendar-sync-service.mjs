// Outside calendars a member syncs (#667, ADR 0022 §3): Google, Apple,
// Outlook or any calendar with a private iCal link.
//
// Who: any Adult may add a calendar, for "Just me" or "Everyone in the
// household". Limited and Temporary members can't add one (a child's or a
// sitter's device shouldn't make the service fetch outside links), but they
// see the household's shared ones. The member who added a calendar, or a
// household admin, removes it.
//
// What the service keeps (durable-store/calendar-subscriptions.mjs): the
// link, owner, audience, last fetch's status and error code, and the ETag.
// Never the calendar's contents: a downloaded feed is held in memory for at
// most 30 minutes (FEED_CACHE_MS), bounded in total (MAX_FEED_CACHE_BYTES),
// and never written to the database or logged.
//
// What devices do: each device in the audience asks for the feed
// (GET /api/calendar/subscriptions/:id/feed) about every 30 minutes while
// Kin is open, parses it itself and keeps the occurrences in its own
// encrypted storage (web/calendar/). The feed travels over the same TLS
// connection as everything else; it is not end-to-end encrypted, because the
// service had to read it to fetch it. The service fetches only when a
// device asks and its copy is older than 30 minutes, so a calendar nobody
// looks at isn't downloaded.
//
// Limits: 10 calendars per member and 30 per household; 20 additions per
// member an hour (each one fetches); fetching is bounded and guarded by
// calendar-fetcher.mjs. After a failed fetch the service waits before trying
// again: 5 minutes, doubling to at most 6 hours, and says why meanwhile.
//
// Purged with the owner when they leave or are removed, and with the
// household when it is deleted.
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DeviceWindow } from "./chat-limits.mjs";
import { CalendarFetcher, FeedFetchError, feedErrorMessage } from "./calendar-fetcher.mjs";
import { CALENDAR_SUBSCRIPTIONS_SQL, calendarSubscriptionMethods } from "./durable-store/calendar-subscriptions.mjs";
import { addMethods } from "./mixins.mjs";
import { PairingError } from "./pairing-service.mjs";
import { canManageTrust, canParticipate, isHouseholdAdmin } from "./pairing-service/shared.mjs";
import { FEED_AUDIENCES, FeedLinkError, feedSourceName, normalizeFeedUrl } from "../web/calendar/feed-link.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const CALENDAR_SYNC_LIMITS = Object.freeze({ perMember: 10, perHousehold: 30, addsPerMemberHour: 20 });
/** How long a downloaded feed is kept in memory, and so how often the
 * service downloads a calendar at most. */
export const FEED_CACHE_MS = 30 * MINUTE_MS;
export const MAX_FEED_CACHE_BYTES = 64 * 1024 * 1024;
export const BACKOFF_FIRST_MS = 5 * MINUTE_MS;
export const BACKOFF_MAX_MS = 6 * HOUR_MS;

/** The wait after `failures` failed fetches in a row. */
export function backoffDelay(failures) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)));
}

class MemoryCalendarStore {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(CALENDAR_SUBSCRIPTIONS_SQL);
    this.depth = 0;
  }

  assertAvailable() {}

  transaction(operation) {
    const savepoint = `kin_calendar_${this.depth}`;
    this.db.exec(this.depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = operation();
      this.db.exec(this.depth === 1 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(this.depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.depth -= 1;
    }
  }
}
addMethods(MemoryCalendarStore, calendarSubscriptionMethods);

const refused = (code, message, status = 400) => new PairingError(code, message, status);
const notFound = () => refused("calendar_subscription_not_found", "That calendar isn't synced in your household any more.", 404);

export class CalendarSyncService {
  /** `store` is the DurableStore or null (in memory); `fetcher` a
   * CalendarFetcher (tests pass one with their own DNS and certificate). */
  constructor({ store = null, fetcher = null, now = () => Date.now() } = {}) {
    this.storage = store ?? new MemoryCalendarStore();
    this.fetcher = fetcher ?? new CalendarFetcher();
    this.now = now;
    this.adds = new DeviceWindow({ limit: CALENDAR_SYNC_LIMITS.addsPerMemberHour, windowMs: HOUR_MS, now: () => this.now() });
    /** id → { householdId, body (Buffer or null after a 304), etag, at } */
    this.cache = new Map();
    this.cacheBytes = 0;
    /** id → the fetch in flight, so devices asking together share one. */
    this.fetching = new Map();
    this.timer = null;
  }

  transaction(operation) {
    return this.storage.transaction ? this.storage.transaction(operation) : operation();
  }

  /** A row as a member sees it. The link itself is never sent back: the
   * owner has it, and other members don't need it. */
  view(row, auth) {
    return {
      id: row.id,
      mine: row.ownerMemberId === auth.member.id,
      ownerMemberId: row.ownerMemberId,
      audience: row.audience,
      source: feedSourceName(row.url),
      host: new URL(row.url).hostname,
      status: row.status,
      error: row.status === "error" ? row.error : null,
      message: row.status === "error" ? feedErrorMessage(row.error) : null,
      fetchedAt: row.fetchedAt,
      attemptedAt: row.attemptedAt,
      retryAt: row.status === "error" ? row.retryAt : null,
      createdAt: row.createdAt,
      canRemove: row.ownerMemberId === auth.member.id || isHouseholdAdmin(auth.member, this.now()),
    };
  }

  /** Whether `auth`'s member is in `row`'s audience. */
  visible(row, auth) {
    return Boolean(row) && row.householdId === auth.household.id &&
      (row.audience === "household" || row.ownerMemberId === auth.member.id);
  }

  assertParticipant(auth) {
    if (!canParticipate(auth.member, this.now()))
      throw refused("membership_inactive", "Your membership in this household has ended.", 403);
  }

  /** The calendars this member sees, and whether they may add one. */
  list(auth) {
    this.assertParticipant(auth);
    const rows = this.storage.householdCalendarSubscriptions(auth.household.id).filter((row) => this.visible(row, auth));
    return {
      subscriptions: rows.map((row) => this.view(row, auth)),
      canAdd: canManageTrust(auth.member, this.now()),
      limits: { perMember: CALENDAR_SYNC_LIMITS.perMember, perHousehold: CALENDAR_SYNC_LIMITS.perHousehold },
    };
  }

  checkLimits(auth) {
    const counts = this.storage.countCalendarSubscriptions(auth.household.id, auth.member.id);
    if (counts.member >= CALENDAR_SYNC_LIMITS.perMember)
      throw refused("calendar_subscription_limit", `You can sync up to ${CALENDAR_SYNC_LIMITS.perMember} calendars. Remove one to add another.`, 409);
    if (counts.household >= CALENDAR_SYNC_LIMITS.perHousehold)
      throw refused("calendar_subscription_limit", `A household can sync up to ${CALENDAR_SYNC_LIMITS.perHousehold} calendars. Remove one to add another.`, 409);
  }

  /**
   * Adds a calendar ({ url, audience }) after one successful download, so a
   * link that doesn't work is refused at once rather than saved broken.
   * Resolves the new subscription's view.
   */
  async add(auth, body) {
    this.assertParticipant(auth);
    if (!canManageTrust(auth.member, this.now()))
      throw refused("calendar_adult_required", "Only adults can sync an outside calendar.", 403);
    if (!body || typeof body !== "object" || !FEED_AUDIENCES.includes(body.audience))
      throw refused("calendar_subscription_invalid", "Choose who sees this calendar: just you or everyone in the household.");
    let url;
    try { url = normalizeFeedUrl(body.url); } catch (error) {
      if (error instanceof FeedLinkError) throw refused(error.code, error.message);
      throw error;
    }
    const existing = this.storage.householdCalendarSubscriptions(auth.household.id)
      .find((row) => row.ownerMemberId === auth.member.id && row.url === url);
    if (existing) throw refused("calendar_subscription_exists", "You already sync this calendar.", 409);
    this.checkLimits(auth);
    if (!this.adds.allows(auth.member.id))
      throw refused("calendar_rate_limited", "You've added several calendars recently. Try again in a while.", 429);
    this.adds.spend(auth.member.id);
    let result;
    try { result = await this.fetcher.fetch(url); } catch (error) {
      if (error instanceof FeedFetchError) throw refused(error.code, error.message, 422);
      throw error;
    }
    const now = this.now();
    const row = {
      id: randomBytes(16).toString("hex"), householdId: auth.household.id, ownerMemberId: auth.member.id,
      audience: body.audience, url, createdAt: now, status: "ok", error: null, fetchedAt: now, attemptedAt: now,
      failures: 0, retryAt: null, etag: result.etag ?? null,
    };
    this.transaction(() => {
      // Checked again: another addition may have finished meanwhile.
      if (this.storage.householdCalendarSubscriptions(auth.household.id).some((other) => other.ownerMemberId === auth.member.id && other.url === url))
        throw refused("calendar_subscription_exists", "You already sync this calendar.", 409);
      this.checkLimits(auth);
      this.storage.insertCalendarSubscription(row);
    });
    this.remember(row, result.body, result.etag ?? null);
    return this.view(row, auth);
  }

  /** Turns a calendar off for everyone: its owner or a household admin. */
  remove(auth, id) {
    this.assertParticipant(auth);
    const row = this.storage.calendarSubscription(id);
    if (!this.visible(row, auth)) throw notFound();
    if (row.ownerMemberId !== auth.member.id && !isHouseholdAdmin(auth.member, this.now()))
      throw refused("calendar_owner_required", "Only the person who added this calendar, or a household admin, can turn it off.", 403);
    this.transaction(() => this.storage.deleteCalendarSubscription(id));
    this.forget(id);
    return { id, removed: true };
  }

  /**
   * The feed for a device in the audience: { body, etag, fetchedAt } or
   * { notModified: true, etag, fetchedAt } when the device's `ifNoneMatch`
   * is still current. Downloads only when the copy in memory is older than
   * 30 minutes and the backoff allows.
   */
  async feed(auth, id, { ifNoneMatch = null } = {}) {
    this.assertParticipant(auth);
    let row = this.storage.calendarSubscription(id);
    if (!this.visible(row, auth)) throw notFound();
    this.sweep();
    const fresh = this.cache.get(id);
    if (fresh) {
      if (ifNoneMatch && fresh.etag && ifNoneMatch === fresh.etag) return { notModified: true, etag: fresh.etag, fetchedAt: fresh.at };
      if (fresh.body) return { body: fresh.body, etag: fresh.etag, fetchedAt: fresh.at };
    }
    if (row.status === "error" && row.retryAt !== null && row.retryAt > this.now())
      throw refused(row.error ?? "calendar_unreachable", feedErrorMessage(row.error), 503);
    let pending = this.fetching.get(id);
    if (!pending) {
      // Ask the calendar's server for changes only when the device holds
      // what the stored ETag names.
      const etag = ifNoneMatch && row.etag && ifNoneMatch === row.etag ? row.etag : null;
      pending = this.download(row, etag).finally(() => this.fetching.delete(id));
      this.fetching.set(id, pending);
    }
    const result = await pending;
    row = this.storage.calendarSubscription(id);
    if (!this.visible(row, auth)) throw notFound();
    if (result.error) throw refused(result.error.code, result.error.message, 502);
    if (result.notModified) {
      if (ifNoneMatch && ifNoneMatch === result.etag) return { notModified: true, etag: result.etag, fetchedAt: result.at };
      // Another device's conditional fetch: this one needs the whole feed.
      return this.feed(auth, id, { ifNoneMatch });
    }
    return { body: result.body, etag: result.etag, fetchedAt: result.at };
  }

  /** One download for `row`, recorded; resolves { body, etag, at },
   * { notModified, etag, at } or { error }. */
  async download(row, etag) {
    const at = this.now();
    try {
      const result = await this.fetcher.fetch(row.url, { etag });
      const now = this.now();
      const tag = result.notModified ? etag : result.etag ?? null;
      if (this.storage.calendarSubscription(row.id)) {
        this.transaction(() => this.storage.updateCalendarSubscription(row.id, {
          status: "ok", error: null, fetchedAt: now, attemptedAt: at, failures: 0, retryAt: null, etag: tag,
        }));
        this.remember(row, result.notModified ? null : result.body, tag);
      }
      return result.notModified ? { notModified: true, etag: tag, at: now } : { body: result.body, etag: tag, at: now };
    } catch (error) {
      const failure = error instanceof FeedFetchError ? error : new FeedFetchError("calendar_unreachable");
      const current = this.storage.calendarSubscription(row.id);
      if (current) {
        const failures = current.failures + 1;
        this.transaction(() => this.storage.updateCalendarSubscription(row.id, {
          status: "error", error: failure.code, attemptedAt: at, failures, retryAt: this.now() + backoffDelay(failures),
          fetchedAt: current.fetchedAt, etag: current.etag,
        }));
      }
      return { error: failure };
    }
  }

  /** Keeps a downloaded feed in memory for FEED_CACHE_MS. */
  remember(row, body, etag) {
    this.forget(row.id);
    const entry = { householdId: row.householdId, body, etag, at: this.now() };
    this.cache.set(row.id, entry);
    this.cacheBytes += body?.length ?? 0;
    // Oldest first, until the total fits.
    for (const [id, other] of this.cache) {
      if (this.cacheBytes <= MAX_FEED_CACHE_BYTES || other === entry) break;
      this.forget(id);
    }
  }

  forget(id) {
    const entry = this.cache.get(id);
    if (!entry) return;
    this.cacheBytes -= entry.body?.length ?? 0;
    this.cache.delete(id);
  }

  /** Drops feeds held longer than FEED_CACHE_MS. */
  sweep() {
    const cutoff = this.now() - FEED_CACHE_MS;
    for (const [id, entry] of this.cache) if (entry.at <= cutoff) this.forget(id);
  }

  /** A removed member's calendars go with them, for everyone (in the
   * removal's transaction). */
  forgetMember(memberId) {
    for (const id of this.storage.purgeMemberCalendarSubscriptions(memberId)) this.forget(id);
  }

  /** A deleted household's calendars. The durable store also purges them in
   * purgeHouseholdData; this covers the in-memory store and the feeds. */
  forgetHousehold(householdId) {
    this.storage.purgeHouseholdCalendarSubscriptions(householdId);
    for (const [id, entry] of this.cache) if (entry.householdId === householdId) this.forget(id);
  }

  /** Sweeps the memory cache every 5 minutes; the timer doesn't keep the
   * process alive. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), 5 * MINUTE_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.cache.clear();
    this.cacheBytes = 0;
  }
}

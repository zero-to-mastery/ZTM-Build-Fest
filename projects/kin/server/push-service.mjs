// Push notifications (#85): per-device subscriptions and content-free
// "something new" pushes to other members after a sync batch commits.
//
// The service only learns what the relay already shows: that a household
// accepted an encrypted event, and from which member. The payload is fixed
// ({"v":1,"kind":"new"}): no content, event type, author or count. Nothing
// about delivery or clicks is recorded.
import { PairingError, canParticipate, chatAccess, isHouseholdAdmin } from "./pairing-service.mjs";
import { createHash } from "node:crypto";
import { allowedPushEndpoint, b64url, fromB64url, generateVapidKeys, PUSH_TOPIC, rawPublicKey, sendPush } from "./web-push.mjs";

export const PUSH_PAYLOAD = JSON.stringify({ v: 1, kind: "new" });
export const PUSH_COALESCE_MS = 2 * 60 * 1000;
/** Mutes the service offers, computed on the service's clock. */
export const PUSH_MUTES = Object.freeze({ hour: 60 * 60 * 1000, night: 8 * 60 * 60 * 1000, indefinite: null });
export const PUSH_CONCURRENCY = 4;
const RETRY_DELAYS_MS = [5_000, 30_000];
const MAX_RETRY_AFTER_MS = 60_000;
// The push service says this subscription will never work: forget it, so the
// device shows notifications as off instead of silently getting nothing.
const GONE_STATUSES = new Set([400, 404, 410, 413]);
// These usually mean the push service rejected the server's own VAPID
// signature (a wrong subject or restored keys), not the subscription:
// deleting would turn every device off at once. Logged for the operator.
const REJECTED_STATUSES = new Set([401, 403]);

/** A short fingerprint of an endpoint, so a device can tell whether the
 * service still holds its current subscription without reading it back. */
export const endpointTag = (endpoint) => createHash("sha256").update(endpoint).digest("base64url").slice(0, 16);

const invalid = (message) => new PairingError("push_subscription_invalid", message, 400);

/** Storage when the service has no durable store (tests, in-memory mode). */
class MemoryPushStore {
  constructor() { this.rows = new Map(); this.keys = null; }
  vapidKeys(generate) { return (this.keys ??= generate()); }
  getPushSubscription(deviceId) { return this.rows.get(deviceId) ?? null; }
  householdPushSubscriptions(householdId) { return [...this.rows.values()].filter((row) => row.householdId === householdId); }
  putPushSubscription(value) { this.rows.set(value.deviceId, { ...value, mutedUntil: value.mutedUntil ?? null, mutedIndefinitely: Boolean(value.mutedIndefinitely) }); }
  setPushMute(deviceId, mutedUntil, indefinitely = false) {
    const row = this.rows.get(deviceId);
    if (row) { row.mutedUntil = indefinitely ? null : mutedUntil; row.mutedIndefinitely = indefinitely; }
    return Boolean(row);
  }
  deletePushSubscriptions(deviceIds) { return deviceIds.filter((id) => this.rows.delete(id)).length; }
  deleteGonePushSubscription(deviceId, endpoint) { return this.rows.get(deviceId)?.endpoint === endpoint && this.rows.delete(deviceId); }
}

export class PushService {
  constructor({ pairingService, store = null, now = () => Date.now(), subject = process.env.KIN_PUSH_SUBJECT ?? null,
    send = sendPush, setTimer = setTimeout, clearTimer = clearTimeout, log = (event) => console.log(JSON.stringify(event)) }) {
    this.pairingService = pairingService;
    this.storage = store ?? new MemoryPushStore();
    this.now = now;
    this.subject = subject;
    this.send = send;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    // Coalescing: when each device was last sent to, and its trailing timer.
    this.lastSentAt = new Map();
    this.trailing = new Map();
    this.deviceHousehold = new Map();
    this.queue = [];
    this.inFlight = 0;
  }

  /** Push needs a VAPID subject the push services accept: a mailto: address
   * or an https: URL. A development server on http:// has neither unless
   * KIN_PUSH_SUBJECT names one, and then push is unavailable. */
  get available() {
    return typeof this.subject === "string" && /^(mailto:[^@\s]+@[^@\s]+\.[^@\s]+|https:\/\/[^\s/]+)/i.test(this.subject) && !/localhost/i.test(this.subject);
  }

  assertAvailable() {
    if (!this.available)
      throw new PairingError("push_unavailable", "Notifications aren't set up on this Kin server. Its operator needs to serve Kin over https or set KIN_PUSH_SUBJECT.", 503);
  }

  get vapidKeys() {
    return (this.keys ??= this.storage.vapidKeys(generateVapidKeys));
  }

  publicKey() {
    this.assertAvailable();
    return b64url(rawPublicKey(this.vapidKeys.publicJwk));
  }

  /** This device's subscription state, without key material. */
  status(auth) {
    const row = this.storage.getPushSubscription(auth.device.id);
    const mutedUntil = row?.mutedUntil && row.mutedUntil > this.now() ? row.mutedUntil : null;
    return {
      available: this.available,
      subscribed: Boolean(row),
      mutedUntil,
      mutedIndefinitely: Boolean(row?.mutedIndefinitely),
      endpointHost: row ? new URL(row.endpoint).hostname : null,
      endpointTag: row ? endpointTag(row.endpoint) : null,
    };
  }

  muted(row) {
    return Boolean(row.mutedIndefinitely || (row.mutedUntil && row.mutedUntil > this.now()));
  }

  subscribe(auth, value) {
    this.assertAvailable();
    const endpoint = allowedPushEndpoint(value?.endpoint);
    if (!endpoint) throw invalid("Kin can send notifications only through a supported browser push service.");
    const p256dh = typeof value?.keys?.p256dh === "string" ? fromB64url(value.keys.p256dh) : null;
    const authSecret = typeof value?.keys?.auth === "string" ? fromB64url(value.keys.auth) : null;
    if (p256dh?.length !== 65 || p256dh[0] !== 4 || authSecret?.length !== 16)
      throw invalid("That notification subscription has invalid keys.");
    const existing = this.storage.getPushSubscription(auth.device.id);
    this.storage.putPushSubscription({
      deviceId: auth.device.id, householdId: auth.household.id, memberId: auth.member.id,
      endpoint: endpoint.href, p256dh, auth: authSecret, mutedUntil: existing?.mutedUntil ?? null,
      mutedIndefinitely: existing?.mutedIndefinitely ?? false, createdAt: this.now(),
    });
    return this.status(auth);
  }

  unsubscribe(auth) {
    this.storage.deletePushSubscriptions([auth.device.id]);
    this.forget([auth.device.id]);
    return this.status(auth);
  }

  /** `choice` is "hour", "night", "indefinite", or null to unmute. The
   * service computes the end on its own clock, so a device's clock can't make
   * a mute fail or end early. */
  mute(auth, choice) {
    if (choice !== null && !Object.hasOwn(PUSH_MUTES, choice))
      throw invalid("Mute notifications for 1 hour, 8 hours, or until you turn them back on.");
    const duration = choice === null ? null : PUSH_MUTES[choice];
    const done = choice === null
      ? this.storage.setPushMute(auth.device.id, null, false)
      : duration === null
        ? this.storage.setPushMute(auth.device.id, null, true)
        : this.storage.setPushMute(auth.device.id, this.now() + duration, false);
    if (!done) throw new PairingError("push_not_subscribed", "Turn notifications on for this device first.", 409);
    return this.status(auth);
  }

  /** Drops subscriptions of devices that lost access (revocation, removal,
   * expiry). Called from the sync service's access-change hook, inside the
   * same transaction as the change when there is one. */
  removeUntrusted(householdId, excludedDeviceIds = []) {
    const gone = this.storage.householdPushSubscriptions(householdId)
      .filter((row) => excludedDeviceIds.includes(row.deviceId) || !this.trusted(row))
      .map((row) => row.deviceId);
    // Coalescing state of devices whose rows are already purged.
    for (const [deviceId, owner] of this.deviceHousehold) if (owner === householdId && !gone.includes(deviceId) && !this.storage.getPushSubscription(deviceId)) gone.push(deviceId);
    this.storage.deletePushSubscriptions(gone);
    this.forget(gone);
    return gone.length;
  }

  /** Signing out of a browser stops its notifications (a shared computer). */
  signedOut(deviceId) {
    this.storage.deletePushSubscriptions([deviceId]);
    this.forget([deviceId]);
  }

  forget(deviceIds) {
    for (const id of deviceIds) {
      this.lastSentAt.delete(id);
      this.deviceHousehold.delete(id);
      const timer = this.trailing.get(id);
      if (timer) this.clearTimer(timer);
      this.trailing.delete(id);
    }
  }

  trusted(row) {
    const device = this.pairingService.devices.get(row.deviceId);
    const member = device && this.pairingService.members.get(device.memberId);
    const household = this.pairingService.households.get(row.householdId);
    return Boolean(device && !device.revokedAt && device.householdId === row.householdId &&
      member && member.id === row.memberId && canParticipate(member, this.now()) &&
      household?.lifecycleState === "active");
  }

  /** A sync batch from `authorMemberId` committed new events. Returns at
   * once; sending happens in the background and never affects sync. */
  eventsAccepted(householdId, authorMemberId, { chat = false } = {}) {
    const household = this.pairingService.households.get(householdId);
    if (household?.lifecycleState !== "active" || !this.available) return;
    for (const row of this.storage.householdPushSubscriptions(householdId)) {
      if (row.memberId === authorMemberId || !this.trusted(row) || this.muted(row)) continue;
      // A member the chat policy (#123) shuts out isn't told chat is active.
      if (chat && chatAccess(this.pairingService.members.get(row.memberId), household, this.now()) === "none") continue;
      this.deviceHousehold.set(row.deviceId, householdId);
      this.schedule(row.deviceId);
    }
  }

  /**
   * A home server's certificate needs an admin (ADR 0025 §5, #718): it runs
   * out within 14 days, or a certificate it didn't make appeared in the
   * public logs. The same content-free push as any other, to every
   * household admin's unmuted devices on this server; the control panel
   * says what it is about. Returns at once.
   */
  adminsAlerted() {
    if (!this.available) return;
    for (const household of this.pairingService.households.values()) {
      if (household.lifecycleState !== "active") continue;
      for (const row of this.storage.householdPushSubscriptions(household.id)) {
        if (!this.trusted(row) || this.muted(row)) continue;
        if (!isHouseholdAdmin(this.pairingService.members.get(row.memberId), this.now())) continue;
        this.deviceHousehold.set(row.deviceId, household.id);
        this.schedule(row.deviceId);
      }
    }
  }

  /** At most one push per device per window; a change inside the window is
   * sent once when it ends, so the last change is never lost. */
  schedule(deviceId) {
    const last = this.lastSentAt.get(deviceId);
    const wait = last === undefined ? 0 : last + PUSH_COALESCE_MS - this.now();
    if (wait <= 0) { this.enqueue(deviceId); return; }
    if (this.trailing.has(deviceId)) return;
    const timer = this.setTimer(() => { this.trailing.delete(deviceId); this.enqueue(deviceId); }, wait);
    timer?.unref?.();
    this.trailing.set(deviceId, timer);
  }

  enqueue(deviceId) {
    this.lastSentAt.set(deviceId, this.now());
    this.queue.push({ deviceId, attempt: 0 });
    this.drain();
  }

  drain() {
    while (this.inFlight < PUSH_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.inFlight += 1;
      this.deliver(job).catch(() => {}).finally(() => { this.inFlight -= 1; this.drain(); });
    }
  }

  async deliver({ deviceId, attempt }) {
    // Re-read at send time: muted, unsubscribed or revoked since scheduling.
    const row = this.storage.getPushSubscription(deviceId);
    if (!row || !this.trusted(row) || this.muted(row)) return;
    let result;
    try {
      result = await this.send(row, { vapidKeys: this.vapidKeys, subject: this.subject, payload: PUSH_PAYLOAD, topic: PUSH_TOPIC, now: this.now() });
    } catch (error) {
      // A refused endpoint or invalid keys will never work; a network failure
      // might. Node's permission model may one day deny the network: say so.
      if (error?.code === "ERR_ACCESS_DENIED") this.log({ event: "push_network_denied" });
      result = { status: error?.message === "push_endpoint_not_allowed" || error instanceof TypeError || error instanceof RangeError ? 400 : 0 };
    }
    if (GONE_STATUSES.has(result.status)) {
      this.storage.deleteGonePushSubscription(deviceId, row.endpoint);
      this.forget([deviceId]);
      this.log({ event: "push_subscription_removed", status: result.status });
    } else if (REJECTED_STATUSES.has(result.status)) {
      this.log({ event: "push_rejected_by_service", status: result.status, host: new URL(row.endpoint).hostname });
    } else if ((result.status === 429 || result.status >= 500 || result.status === 0) && attempt < RETRY_DELAYS_MS.length) {
      // Bounded backoff, then the push is dropped: no unbounded queue. A
      // Retry-After (seconds) is honoured up to a minute.
      const hinted = Number(result.retryAfter) * 1000;
      const delay = Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted, MAX_RETRY_AFTER_MS) : RETRY_DELAYS_MS[attempt];
      const timer = this.setTimer(() => { this.queue.push({ deviceId, attempt: attempt + 1 }); this.drain(); }, delay);
      timer?.unref?.();
    }
  }
}

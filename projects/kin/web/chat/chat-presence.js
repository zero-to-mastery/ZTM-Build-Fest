// Read receipts and typing indicators (#120, #121, #122).
//
// Two kinds of small, sealed messages that are not chat events:
//
// Receipt slot (#121). Each member has ONE slot on the service, replaced
// compare-and-set, never appended to the chat log, so storage stays constant
// however long the chat grows. It is an event envelope (web/sync/crypto.js):
// AES-256-GCM under the household key and signed by the writing device, so the
// service sees ciphertext only, and the other members can tell which device
// wrote it. Its sequence is the slot revision it replaces. The plaintext is
// JSON, format 1:
//
//   { "v": 1, "kind": "receipt",
//     "cursor": { "postedAt": ms, "messageId": 32 hex } | null,
//     "readAt": ms, "receipts": bool, "typing": bool, "settingsAt": ms }
//
// The cursor is "read up to this message": it only moves forward, two devices
// of one member converge on the later one, and a message counts as read by a
// member when it is at or before their cursor in (postedAt, messageId) order.
// `receipts` and `typing` are the member's two settings. They ride in the same
// slot so every device of that member sees them; the other members can see
// them too, which they would anyway (a member who sends no receipts has none
// to show). The settings that were written last win (`settingsAt`).
// With receipts off the cursor is null: the member's progress is cleared, not
// merely hidden.
//
// Typing frame (#122). Ephemeral: sent over the live channel only, sealed the
// same way (kind "typing", `on` true or false), relayed by the service to the
// household's other chat-allowed devices and never stored by it or by a
// device. A receiver shows it for TYPING_EXPIRE_MS unless refreshed.
//
// Online frame (#128). Also ephemeral and sealed the same way (kind "online",
// `on` true for a heartbeat, false for "away"; `hello` true on the first
// heartbeat after unlocking, showing or reconnecting, which asks the others to
// answer once so a newcomer sees who is here without waiting). A device sends
// one every ONLINE_BEAT_MS while Kin is unlocked and visible; a member is
// online while any of their devices sent one in the last ONLINE_EXPIRE_MS.
// Nothing about it is stored: not by the service, not by a device. The member's
// `online` setting rides in the receipt slot with the other two.
import { decryptWithDeviceHistory, encryptEvent } from "../sync/crypto.js";

export const SLOT_VERSION = 1;
export const RECEIPT_WRITE_MS = 2_000;
export const RECEIPT_REFRESH_MS = 15_000;
export const TYPING_SEND_MS = 3_000;
export const TYPING_EXPIRE_MS = 6_000;
export const ONLINE_BEAT_MS = 30_000;
export const ONLINE_EXPIRE_MS = 70_000;
/** Answers to "hello" frames are sent at most this often. */
export const ONLINE_REPLY_MS = 5_000;
/** A typing frame sealed longer ago than this (or further ahead) is dropped. */
export const TYPING_FRESH_MS = 15_000;
/** A cursor dated further ahead than this is not believed: one message with a
 * wrong clock must not mark everything after it as read. */
export const CLOCK_SKEW_MS = 5 * 60_000;
/** The service refuses a slot over this (server/durable-store/shared.mjs). */
export const MAX_SLOT_BYTES = 4_096;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MESSAGE_ID = /^[a-f0-9]{32}$/;

export class ChatPresenceError extends Error {
  constructor(message, code = "chat_presence_invalid") {
    super(message);
    this.name = "ChatPresenceError";
    this.code = code;
  }
}

/* ---------- Cursors: pure ---------- */

export function isCursor(value) {
  return Boolean(value) && typeof value === "object" && Number.isSafeInteger(value.postedAt) && value.postedAt >= 0 && MESSAGE_ID.test(value.messageId);
}

/** The cursor that means "read up to and including this message". */
export function cursorOf(message) {
  return { postedAt: message.postedAt, messageId: message.messageId };
}

/** Negative, zero or positive: a before, equal to or after b. A missing
 * cursor is before every message. */
export function compareCursors(a, b) {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  if (a.postedAt !== b.postedAt) return a.postedAt < b.postedAt ? -1 : 1;
  return a.messageId === b.messageId ? 0 : a.messageId < b.messageId ? -1 : 1;
}

/** The later of two cursors: how two devices of one member converge. Cursors
 * only move forward, so applying it in any order gives the same result. */
export function mergeCursors(a, b) {
  return compareCursors(a, b) >= 0 ? (a ?? null) : b;
}

/** Whether a member whose cursor is `cursor` has read `message`. A deleted
 * message still has a place in the order, so it counts toward the cursor. */
export function hasRead(cursor, message) {
  return Boolean(cursor) && compareCursors(cursorOf(message), cursor) <= 0;
}

/**
 * Who has read `message`: the members other than its author whose cursor is at
 * or past it, earliest first. `slots` is a Map of memberId → { cursor, readAt }.
 * Computed on demand for a message shown, never stored per message.
 */
export function readersOf(message, slots) {
  const readers = [];
  for (const [memberId, slot] of slots)
    if (memberId !== message.authorId && hasRead(slot.cursor, message)) readers.push({ memberId, readAt: slot.readAt });
  return readers.sort((a, b) => a.readAt - b.readAt || (a.memberId < b.memberId ? -1 : 1));
}

/** "Seen by Sam, Alex", or "Seen by everyone" when all of `audience` did. */
export function seenText(readerLabels, everyone) {
  if (!readerLabels.length) return "";
  return everyone ? "Seen by everyone" : `Seen by ${readerLabels.join(", ")}`;
}

/** "Sam is typing…", "Sam and Alex are typing…", "Sam, Alex and Jo are typing…". */
export function typingText(labels) {
  if (!labels.length) return "";
  if (labels.length === 1) return `${labels[0]} is typing…`;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]} are typing…`;
  if (labels.length === 3) return `${labels[0]}, ${labels[1]} and ${labels[2]} are typing…`;
  return "Several people are typing…";
}

/* ---------- Sealing ---------- */

const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function seal({ body, householdId, deviceId, sequence, keyEpoch, householdKey, signingKey, now }) {
  const plaintext = encoder.encode(JSON.stringify(body));
  try {
    return await encryptEvent({
      eventId: randomId(), householdId, deviceId, deviceSequence: sequence, logicalTime: String(Math.max(0, Math.trunc(now))),
      keyEpoch, plaintext, householdKey, signingKey,
    });
  } finally {
    plaintext.fill(0);
  }
}

async function open({ envelope, device, householdKey, householdId, kind }) {
  if (!envelope || typeof envelope !== "object" || envelope.householdId !== householdId || envelope.deviceId !== device?.deviceId)
    throw new ChatPresenceError("A chat update came from the wrong place.");
  if (device.revokedAt || envelope.keyEpoch < (device.historyFromEpoch ?? 1))
    throw new ChatPresenceError("A chat update came from a device that can't send one.");
  const plain = await decryptWithDeviceHistory({ device, envelope, householdKey });
  try {
    const value = JSON.parse(decoder.decode(plain));
    if (!value || typeof value !== "object" || value.v !== SLOT_VERSION || value.kind !== kind) throw new Error("shape");
    return value;
  } catch {
    throw new ChatPresenceError("A chat update couldn't be read.");
  } finally {
    plain.fill(0);
  }
}

/* ---------- Typing: who is typing now ---------- */

/** Tracks who is typing for a few seconds at a time. Nothing is kept past that. */
export class TypingTracker {
  constructor({ now = () => Date.now(), expireMs = TYPING_EXPIRE_MS } = {}) {
    this.now = now;
    this.expireMs = expireMs;
    this.until = new Map();
  }

  set(memberId, on) {
    if (on) this.until.set(memberId, this.now() + this.expireMs);
    else this.until.delete(memberId);
  }

  /** Members still typing; drops the ones whose time ran out. */
  active() {
    const now = this.now();
    for (const [memberId, until] of this.until) if (until <= now) this.until.delete(memberId);
    return [...this.until.keys()].sort();
  }

  /** Milliseconds until the next indicator expires, or null. */
  nextExpiry() {
    if (!this.until.size) return null;
    return Math.max(1, Math.min(...this.until.values()) - this.now());
  }

  clear() {
    this.until.clear();
  }
}

/** Tracks which devices are online: a member is online while any of their
 * devices sent a heartbeat recently. Nothing is kept past that. */
export class OnlineTracker {
  constructor({ now = () => Date.now(), expireMs = ONLINE_EXPIRE_MS } = {}) {
    this.now = now;
    this.expireMs = expireMs;
    /** deviceId -> { memberId, until } */
    this.devices = new Map();
  }

  set(deviceId, memberId, on) {
    if (on) this.devices.set(deviceId, { memberId, until: this.now() + this.expireMs });
    else this.devices.delete(deviceId);
  }

  /** Members with a device still online, sorted; drops the ones that ran out. */
  active() {
    const now = this.now();
    const members = new Set();
    for (const [deviceId, entry] of this.devices) {
      if (entry.until <= now) this.devices.delete(deviceId);
      else members.add(entry.memberId);
    }
    return [...members].sort();
  }

  nextExpiry() {
    if (!this.devices.size) return null;
    return Math.max(1, Math.min(...[...this.devices.values()].map((entry) => entry.until)) - this.now());
  }

  clear() {
    this.devices.clear();
  }
}

/* ---------- The room's presence ---------- */

/**
 * One device's presence: its own cursor and settings, everyone's slots, and
 * who is typing. The chat room supplies the household key, signing key,
 * device directory and requests; the coordinator supplies the live channel.
 *
 * `env` : { identity, request(path, options), epochKey(epoch), sendingEpoch(),
 *           signingKey(), devices() -> verified directory, sendLive(bytes) -> bool,
 *           store: { presence(), savePresence(value) }, now, setTimer, clearTimer,
 *           onChange() }
 */
export class ChatPresence {
  constructor(env) {
    this.env = env;
    this.now = env.now ?? (() => Date.now());
    this.setTimer = env.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = env.clearTimer ?? ((timer) => clearTimeout(timer));
    this.settings = { receipts: true, typing: true, online: true, settingsAt: 0 };
    this.cursor = null;
    this.readAt = 0;
    this.revision = 0;
    this.dirty = false;
    // Bumped by every change that needs writing, so a write that was sealed
    // before a change doesn't mark that change as written.
    this.version = 0;
    // The member's own slot exists but this device can't open it, and this
    // device has no settings of its own: until they are known, send nothing.
    this.unverified = false;
    this.resealed = false;
    this.slots = new Map();
    this.typers = new TypingTracker({ now: this.now });
    this.watermarks = new Map();
    this.lastTypingSent = 0;
    this.typingOn = false;
    this.typingSequence = 0;
    this.typingChain = Promise.resolve();
    // Online now (#128).
    this.onlineTracker = new OnlineTracker({ now: this.now });
    this.onlineWatermarks = new Map();
    this.active = false;
    this.onlineSent = false;
    this.onlineSequence = 0;
    this.onlineIntent = 0;
    this.onlineChain = Promise.resolve();
    this.beatTimer = null;
    /** deviceId -> when its hello was last answered */
    this.lastReplies = new Map();
    this.writeTimer = null;
    this.expiryTimer = null;
    this.lastWrite = 0;
    this.lastRefresh = 0;
    this.hinted = false;
    this.writing = null;
    this.refreshing = null;
    this.closed = false;
  }

  /** Restores this device's cursor, settings and slot revision. */
  async load() {
    const saved = (await this.env.store.presence()) ?? {};
    if (typeof saved.receipts === "boolean") this.settings.receipts = saved.receipts;
    if (typeof saved.typing === "boolean") this.settings.typing = saved.typing;
    if (typeof saved.online === "boolean") this.settings.online = saved.online;
    if (Number.isSafeInteger(saved.settingsAt)) this.settings.settingsAt = saved.settingsAt;
    if (isCursor(saved.cursor) && this.settings.receipts) this.cursor = saved.cursor;
    if (Number.isSafeInteger(saved.readAt)) this.readAt = saved.readAt;
    if (Number.isSafeInteger(saved.revision) && saved.revision >= 0) this.revision = saved.revision;
    this.dirty = saved.dirty === true;
    if (this.dirty) this.version += 1;
  }

  /** Something needs writing to the slot. */
  touch() {
    this.dirty = true;
    this.version += 1;
  }

  async persist() {
    try {
      await this.env.store.savePresence({
        receipts: this.settings.receipts, typing: this.settings.typing, online: this.settings.online, settingsAt: this.settings.settingsAt,
        cursor: this.cursor, readAt: this.readAt, revision: this.revision, dirty: this.dirty,
      });
    } catch { /* kept in memory; the next change saves it */ }
  }

  /** The admin's policy (#123): receipts and typing are posting-adjacent, so
   * a member who can't post sends neither. */
  get mayPost() { return this.env.canPost ? this.env.canPost() : true; }
  get sendsReceipts() { return this.settings.receipts && !this.unverified && this.mayPost; }
  get sendsTyping() { return this.settings.typing && !this.unverified && this.mayPost; }
  /** Online status (#128) needs chat access, not posting: a read-only member
   * can be seen online and see others. */
  get hasAccess() { return this.env.hasAccess ? this.env.hasAccess() : true; }
  get sendsOnline() { return this.settings.online && !this.unverified && this.hasAccess; }
  /** Reciprocity: someone who shows no status sees no one else's. */
  get showsOnline() { return this.sendsOnline; }

  /** The access level changed: stop any typing at once, and go away or come
   * back as chat access is lost or given. */
  accessChanged() {
    if (!this.mayPost) this.stopTyping();
    if (!this.hasAccess) {
      this.stopBeating();
      this.onlineTracker.clear();
      this.env.onChange?.();
    } else if (this.active) this.beat({ hello: true });
  }

  /** Reciprocity: someone who sends no receipts sees no one else's. */
  get showsReceipts() { return this.sendsReceipts; }

  /* --- read cursor --- */

  /** A message was on screen in a visible, focused window: the cursor moves up
   * to it if that is later than where it was. Writes are throttled. */
  markRead(message) {
    if (this.closed || !this.sendsReceipts || !message) return false;
    const cursor = cursorOf(message);
    if (!isCursor(cursor) || compareCursors(cursor, this.cursor) <= 0 || cursor.postedAt > this.now() + CLOCK_SKEW_MS) return false;
    this.cursor = cursor;
    this.readAt = this.now();
    this.touch();
    void this.persist();
    this.scheduleWrite();
    this.env.onChange?.();
    return true;
  }

  /** Who has read `message`, from the slots held: empty when this member
   * sends no receipts, or for a message's author alone. */
  readers(message) {
    if (!this.showsReceipts || !message) return [];
    return readersOf(message, this.slots);
  }

  scheduleWrite() {
    if (this.closed || this.writeTimer !== null) return;
    const wait = Math.max(0, this.lastWrite + RECEIPT_WRITE_MS - this.now());
    this.writeTimer = this.setTimer(() => {
      this.writeTimer = null;
      void this.flush().catch(() => {});
    }, wait);
  }

  /** The slot's plaintext for this member now. */
  body() {
    return {
      v: SLOT_VERSION, kind: "receipt", cursor: this.settings.receipts ? this.cursor : null, readAt: this.readAt,
      receipts: this.settings.receipts, typing: this.settings.typing, online: this.settings.online, settingsAt: this.settings.settingsAt,
    };
  }

  /** Writes the slot if anything changed, compare-and-set on its revision;
   * another device having written meanwhile is merged and tried once more. */
  async flush({ retried = false } = {}) {
    // A write in flight was sealed before any change made since; wait for it,
    // then write again if something is still waiting.
    while (this.writing) await this.writing.catch(() => {});
    // Unverified: this device doesn't know the member's settings, so whatever
    // it holds would overwrite them with defaults. Nothing is written.
    if (this.closed || !this.dirty || this.unverified || !this.mayPost) return;
    this.writing = this.write({ retried }).finally(() => { this.writing = null; });
    return this.writing;
  }

  async write({ retried }) {
    const { identity } = this.env;
    const me = this.env.devices().find((device) => device.deviceId === identity.deviceId);
    if (!me) return;
    const epoch = await this.env.sendingEpoch();
    const householdKey = await this.env.epochKey(epoch);
    const version = this.version;
    // Re-checked here: a refresh during the awaits above may have found the
    // member's settings unknown (and a 409 retry comes back through here).
    if (this.unverified || this.closed) return;
    const record = await seal({
      body: this.body(), householdId: identity.householdId, deviceId: identity.deviceId, sequence: this.revision + 1,
      keyEpoch: epoch, householdKey, signingKey: this.env.signingKey(), now: this.now(),
    });
    if (this.unverified || this.closed) return;
    try {
      const result = await this.env.request("/api/chat/receipts", { method: "PUT", body: JSON.stringify({ expectedRevision: this.revision, record }) });
      this.revision = result.revision;
      if (this.version === version) this.dirty = false;
      this.lastWrite = this.now();
      await this.persist();
    } catch (error) {
      if (error?.code === "chat_receipts_stale" && !retried) {
        await this.refresh();
        return this.write({ retried: true });
      }
      if (error?.code === "chat_receipts_rate_limited") this.lastWrite = this.now() + RECEIPT_WRITE_MS * 4;
      throw error;
    }
  }

  /** Reads everyone's slots; merges this member's own (settings that were
   * written last win; the cursor is the later of the two). */
  refresh() {
    // One read at a time: a hint and the chat pass arriving together share it.
    if (!this.refreshing) this.refreshing = this.readSlots().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async readSlots() {
    if (this.closed) return false;
    this.lastRefresh = this.now();
    this.hinted = false;
    const wasUnverified = this.unverified;
    const { identity } = this.env;
    const response = await this.env.request("/api/chat/receipts");
    if (!Array.isArray(response?.slots)) throw new ChatPresenceError("Chat received invalid read receipts.");
    const devices = this.env.devices();
    const next = new Map();
    let changed = false;
    let ownUnreadable = false;
    for (const row of response.slots) {
      if (!row || typeof row.memberId !== "string" || !Number.isSafeInteger(row.revision) || row.revision < 1) continue;
      const own = row.memberId === identity.memberId;
      const device = devices.find((entry) => entry.deviceId === row.record?.deviceId);
      // A slot signed by a device that isn't that member's is not theirs.
      if (!device || device.memberId !== row.memberId) {
        if (own) { this.revision = Math.max(this.revision, row.revision); ownUnreadable = true; }
        continue;
      }
      let value;
      let keyMissing = false;
      try {
        const householdKey = await this.env.epochKey(row.record.keyEpoch).catch((error) => { keyMissing = true; throw error; });
        value = await open({ envelope: row.record, device, householdKey, householdId: identity.householdId, kind: "receipt" });
        if (row.record.deviceSequence !== row.revision) { if (own) { this.revision = Math.max(this.revision, row.revision); ownUnreadable = true; } continue; }
      } catch (error) {
        if (error?.code === "chat_locked") throw error;
        if (own) {
          // Sealed under a key this device never had. The revision is still
          // known (so writes work), the settings are not: fail closed unless
          // this device has its own, and re-seal the slot under a key it has.
          this.revision = Math.max(this.revision, row.revision);
          ownUnreadable = true;
          if (this.settings.settingsAt !== 0 && !this.resealed) { this.resealed = true; this.touch(); }
        } else if (keyMissing) {
          // A key this device doesn't hold right now: keep what was known
          // rather than drop a reader. A slot that fails its signature or
          // shape shows nothing.
          const before = this.slots.get(row.memberId);
          if (before) next.set(row.memberId, before);
        }
        continue;
      }
      const cursor = isCursor(value.cursor) && value.cursor.postedAt <= this.now() + CLOCK_SKEW_MS ? value.cursor : null;
      const slot = {
        revision: row.revision, cursor: value.receipts === false ? null : cursor,
        readAt: Number.isSafeInteger(value.readAt) ? value.readAt : 0,
        receipts: value.receipts !== false, typing: value.typing !== false, online: value.online !== false,
        settingsAt: Number.isSafeInteger(value.settingsAt) ? value.settingsAt : 0,
      };
      if (row.memberId === identity.memberId) {
        changed = this.mergeOwn(slot) || changed;
      } else {
        const before = this.slots.get(row.memberId);
        // Never trust an older slot than one already seen.
        if (before && before.revision > slot.revision) { next.set(row.memberId, before); continue; }
        if (!before || compareCursors(before.cursor, slot.cursor) !== 0 || before.readAt !== slot.readAt) changed = true;
        next.set(row.memberId, slot);
      }
    }
    if (next.size !== this.slots.size) changed = true;
    // Judged on each read: unverified only while the own slot is there and
    // can't be read, and this device has no settings of its own.
    if (!ownUnreadable || this.settings.settingsAt !== 0) this.unverified = false;
    else this.unverified = true;
    this.slots = next;
    // The member's settings just became known: now this device may say it is here.
    if (wasUnverified && !this.unverified && this.active) this.beat({ hello: true });
    if (changed) this.env.onChange?.();
    if (this.dirty) this.scheduleWrite();
    return changed;
  }

  /** Merges the member's own slot, as written by one of their devices. */
  mergeOwn(slot) {
    let changed = false;
    this.revision = Math.max(this.revision, slot.revision);
    this.unverified = false;
    // Equal times on two devices: the more private choice wins, so they agree.
    const tie = slot.settingsAt === this.settings.settingsAt
      && (slot.receipts !== this.settings.receipts || slot.typing !== this.settings.typing || slot.online !== this.settings.online)
      && (!slot.receipts || !slot.typing || !slot.online);
    if (slot.settingsAt > this.settings.settingsAt || tie) {
      const wasOnline = this.settings.online;
      this.settings = {
        receipts: tie ? slot.receipts && this.settings.receipts : slot.receipts,
        typing: tie ? slot.typing && this.settings.typing : slot.typing,
        online: tie ? slot.online && this.settings.online : slot.online,
        settingsAt: slot.settingsAt,
      };
      if (wasOnline !== this.settings.online) this.onlineSettingChanged();
      // The slot's progress replaces this device's: a device that was away
      // while receipts went off and on must not publish what was cleared.
      this.cursor = this.settings.receipts ? slot.cursor : null;
      this.readAt = this.settings.receipts ? slot.readAt : 0;
      if (tie) this.touch();
      changed = true;
    }
    if (this.settings.receipts) {
      const merged = mergeCursors(this.cursor, slot.cursor);
      if (compareCursors(merged, this.cursor) !== 0) {
        this.cursor = merged;
        this.readAt = Math.max(this.readAt, slot.readAt);
        changed = true;
      }
      // This device is ahead of (or differs from) the stored slot.
      if (compareCursors(this.cursor, slot.cursor) !== 0) this.touch();
    }
    if (slot.settingsAt < this.settings.settingsAt || (slot.settingsAt === this.settings.settingsAt
      && (slot.receipts !== this.settings.receipts || slot.typing !== this.settings.typing || slot.online !== this.settings.online))) this.touch();
    if (changed) void this.persist();
    return changed;
  }

  /** The chat pass: refresh now and then, write what is waiting. */
  async sync() {
    if (this.closed) return;
    if (this.refreshing) await this.refreshing;
    else if (this.hinted || this.now() - this.lastRefresh >= RECEIPT_REFRESH_MS) await this.refresh();
    if (this.dirty && this.writeTimer === null) await this.flush();
  }

  /** The service says a slot changed (live channel): refresh soon. */
  hint() {
    if (this.closed) return;
    this.hinted = true;
    void this.sync().catch(() => {});
  }

  /* --- settings --- */

  /** Turns sending receipts and typing on or off, on all this member's
   * devices. Off clears the stored cursor; typing off stops the indicator now. */
  async setSettings({ receipts = this.settings.receipts, typing = this.settings.typing, online = this.settings.online }) {
    const now = this.now();
    const wasReceipts = this.settings.receipts;
    const wasOnline = this.settings.online;
    this.settings = { receipts: Boolean(receipts), typing: Boolean(typing), online: Boolean(online), settingsAt: Math.max(now, this.settings.settingsAt + 1) };
    if (wasOnline !== this.settings.online) this.onlineSettingChanged();
    if (!this.settings.receipts) { this.cursor = null; this.readAt = 0; }
    else if (!wasReceipts) this.readAt = now;
    if (!this.settings.typing) this.stopTyping();
    this.unverified = false;
    this.touch();
    await this.persist();
    this.env.onChange?.();
    try { await this.flush(); } catch { this.scheduleWrite(); }
  }

  /* --- typing --- */

  /** The composer has new input: tell the others, at most every 3 seconds. */
  typed() {
    if (this.closed || !this.sendsTyping) return;
    if (this.typingOn && this.now() - this.lastTypingSent < TYPING_SEND_MS) return;
    void this.sendTyping(true);
  }

  /** The composer was sent, cleared, left, or the window hid or locked. */
  stopTyping() {
    if (!this.typingOn) return;
    void this.sendTyping(false);
  }

  sendTyping(on) {
    this.typingOn = on;
    this.lastTypingSent = this.now();
    const run = this.typingChain.then(async () => {
      const { identity } = this.env;
      const epoch = await this.env.sendingEpoch();
      const householdKey = await this.env.epochKey(epoch);
      // Strictly increasing across sessions, so a receiver can drop a replay.
      this.typingSequence = Math.max(this.now(), this.typingSequence + 1);
      const envelope = await seal({
        body: { v: SLOT_VERSION, kind: "typing", on }, householdId: identity.householdId, deviceId: identity.deviceId,
        sequence: this.typingSequence, keyEpoch: epoch, householdKey, signingKey: this.env.signingKey(), now: this.now(),
      });
      const sent = this.env.sendLive(encoder.encode(JSON.stringify(envelope)));
      // Not connected: nothing was sent, so nothing needs a "stopped".
      if (!sent) this.typingOn = false;
    });
    this.typingChain = run.catch(() => {});
    return run.catch(() => { this.typingOn = false; });
  }

  /** A typing frame relayed by the service. Unreadable, unsigned, replayed or
   * own frames are ignored; the rest show for TYPING_EXPIRE_MS. */
  async receiveTyping(bytes) {
    if (this.closed) return false;
    let envelope;
    try {
      envelope = JSON.parse(decoder.decode(bytes));
    } catch {
      return false;
    }
    const { identity } = this.env;
    const device = this.env.devices().find((entry) => entry.deviceId === envelope?.deviceId);
    if (!device || device.memberId === identity.memberId) return false;
    if ((this.watermarks.get(device.deviceId) ?? 0) >= envelope.deviceSequence) return false;
    // A frame is only as old as its seal: a replay of an old one shows nothing.
    const sealedAt = Number(envelope.logicalTime);
    if (!Number.isFinite(sealedAt) || Math.abs(this.now() - sealedAt) > TYPING_FRESH_MS) return false;
    let value;
    try {
      value = await open({ envelope, device, householdKey: await this.env.epochKey(envelope.keyEpoch), householdId: identity.householdId, kind: "typing" });
    } catch {
      return false;
    }
    if (this.closed || typeof value.on !== "boolean") return false;
    if ((this.watermarks.get(device.deviceId) ?? 0) >= envelope.deviceSequence) return false;
    this.watermarks.set(device.deviceId, envelope.deviceSequence);
    this.typers.set(device.memberId, value.on);
    this.armExpiry();
    this.env.onChange?.();
    return true;
  }

  /* --- online now (#128) --- */

  /** Kin is unlocked and visible on this device (true), or locked, hidden or
   * closing (false). Heartbeats run only while true. */
  setActive(active) {
    active = Boolean(active) && !this.closed;
    if (active === this.active) return;
    this.active = active;
    if (active) this.beat({ hello: true });
    else this.stopBeating();
  }

  /** The live channel came (back) up: say so at once. */
  reconnected() {
    if (this.active) this.beat({ hello: true });
  }

  /** The setting changed (here or from another device). */
  onlineSettingChanged() {
    if (!this.settings.online) {
      this.stopBeating();
      this.onlineTracker.clear();
      this.env.onChange?.();
    } else if (this.active) this.beat({ hello: true });
  }

  /** One heartbeat now, and the next after ONLINE_BEAT_MS. */
  beat({ hello = false } = {}) {
    this.clearTimer(this.beatTimer);
    this.beatTimer = null;
    if (this.closed || !this.active || !this.sendsOnline) return;
    void this.sendOnline(true, hello);
    this.beatTimer = this.setTimer(() => {
      this.beatTimer = null;
      this.beat();
    }, ONLINE_BEAT_MS);
  }

  /** "Away": no more heartbeats, and one frame saying so if one was sent. */
  stopBeating() {
    this.clearTimer(this.beatTimer);
    this.beatTimer = null;
    if (this.onlineSent) void this.sendOnline(false, false);
  }

  sendOnline(on, hello) {
    this.onlineSent = on;
    // A failed send only clears the flag if no later frame has been queued.
    const intent = ++this.onlineIntent;
    const run = this.onlineChain.then(async () => {
      const { identity } = this.env;
      const epoch = await this.env.sendingEpoch();
      const householdKey = await this.env.epochKey(epoch);
      this.onlineSequence = Math.max(this.now(), this.onlineSequence + 1);
      const envelope = await seal({
        body: { v: SLOT_VERSION, kind: "online", on, ...(hello ? { hello: true } : {}) }, householdId: identity.householdId, deviceId: identity.deviceId,
        sequence: this.onlineSequence, keyEpoch: epoch, householdKey, signingKey: this.env.signingKey(), now: this.now(),
      });
      const sent = this.env.sendLive(encoder.encode(JSON.stringify(envelope)), "presence");
      // Not connected: nothing was sent, so nothing needs an "away".
      if (!sent && on && this.onlineIntent === intent) this.onlineSent = false;
    });
    this.onlineChain = run.catch(() => {});
    return run.catch(() => { if (on && this.onlineIntent === intent) this.onlineSent = false; });
  }

  /** An online frame relayed by the service. Ignored while this member shows
   * no status of their own (reciprocity), and when unreadable, unsigned,
   * replayed, stale or from this member. */
  async receiveOnline(bytes) {
    if (this.closed || !this.showsOnline) return false;
    let envelope;
    try {
      envelope = JSON.parse(decoder.decode(bytes));
    } catch {
      return false;
    }
    const { identity } = this.env;
    const device = this.env.devices().find((entry) => entry.deviceId === envelope?.deviceId);
    if (!device || device.memberId === identity.memberId) return false;
    if ((this.onlineWatermarks.get(device.deviceId) ?? 0) >= envelope.deviceSequence) return false;
    const sealedAt = Number(envelope.logicalTime);
    if (!Number.isFinite(sealedAt) || Math.abs(this.now() - sealedAt) > TYPING_FRESH_MS) return false;
    let value;
    try {
      value = await open({ envelope, device, householdKey: await this.env.epochKey(envelope.keyEpoch), householdId: identity.householdId, kind: "online" });
    } catch {
      return false;
    }
    if (this.closed || !this.showsOnline || typeof value.on !== "boolean") return false;
    // Frames can finish opening out of order: an older one must not undo a newer.
    if ((this.onlineWatermarks.get(device.deviceId) ?? 0) >= envelope.deviceSequence) return false;
    this.onlineWatermarks.set(device.deviceId, envelope.deviceSequence);
    this.onlineTracker.set(device.deviceId, device.memberId, value.on);
    // A newcomer asked who is here: answer once in a while.
    if (value.on && value.hello === true && this.active && this.now() - (this.lastReplies.get(device.deviceId) ?? -Infinity) >= ONLINE_REPLY_MS) {
      this.lastReplies.set(device.deviceId, this.now());
      if (this.sendsOnline) void this.sendOnline(true, false);
    }
    this.armExpiry();
    this.env.onChange?.();
    return true;
  }

  /** Members online now, other than this one; empty while this member shows
   * no status. */
  online() {
    if (!this.showsOnline) return [];
    return this.onlineTracker.active().filter((memberId) => memberId !== this.env.identity.memberId);
  }

  armExpiry() {
    this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    const waits = [this.typers.nextExpiry(), this.onlineTracker.nextExpiry()].filter((wait) => wait !== null);
    const wait = waits.length ? Math.min(...waits) : null;
    if (wait === null || this.closed) return;
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      this.typers.active();
      this.onlineTracker.active();
      this.armExpiry();
      this.env.onChange?.();
    }, wait);
  }

  /** Members typing now, other than this one. */
  typing() {
    return this.typers.active().filter((memberId) => memberId !== this.env.identity.memberId);
  }

  /** The live channel went down: nobody's "stopped" will arrive, so their
   * indicators run out on their own within the expiry time. */

  close() {
    if (this.closed) return;
    // Best effort: sealing is asynchronous and the room drops its keys right
    // after, so this may not go out. Receivers expire the indicator anyway.
    if (this.typingOn) void this.sendTyping(false);
    if (this.onlineSent) void this.sendOnline(false, false);
    this.closed = true;
    this.active = false;
    this.clearTimer(this.writeTimer);
    this.clearTimer(this.expiryTimer);
    this.clearTimer(this.beatTimer);
    this.writeTimer = this.expiryTimer = this.beatTimer = null;
    this.typers.clear();
    this.onlineTracker.clear();
    this.onlineWatermarks.clear();
    this.lastReplies.clear();
    this.slots = new Map();
    this.watermarks.clear();
    this.cursor = null;
  }
}

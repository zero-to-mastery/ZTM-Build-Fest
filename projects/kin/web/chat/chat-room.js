// The household chat room on this device (#111): sending, the chat relay
// stream, and the decrypted chat log the engine pages through.
//
// - The chat log (chat-log-store.js) keeps every chat event as the signed,
//   encrypted envelope it travels in. Opening the room decrypts it into
//   memory (chat-records.js); locking drops that copy.
// - Sending seals the message content into a blob (#110), has the engine
//   make and check the chat event against the chat log (#109), encrypts and
//   signs it under the household's current key epoch, and stores it with an
//   outbox entry. It shows at once as waiting to send.
// - sync() runs after each full household sync pass (sync-coordinator.js):
//   it uploads each pending event's blob, pushes the events to the chat
//   relay, retires the blobs an edit or deletion replaced, then pulls new
//   chat events, authenticates each against its author's device key,
//   checks its canonical identity, and stores it.
//
// Until the chat key exists (#123), chat events are encrypted under the
// household key epoch, like household events. The relay keeps them in their
// own stream (server/chat-relay-service.mjs).
import { decryptStoredEvent, decryptWithDeviceHistory, encryptEvent } from "../sync/crypto.js";
import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../sync/envelope-wire.js";
import { idToHex } from "../wasm/kin-engine.js";
import { projectionContext } from "../browser-time.js";
import { ChatBlobClient } from "./chat-blob-client.js";
import { refHex } from "./chat-blob-crypto.js";
import {
  ATTACHMENT_PART_BYTES, ChatAttachmentError, MAX_ATTACHMENT_BYTES, attachmentProblem, decodeManifest,
  VOICE_TYPES, encodeManifest, manifestRefs, preparePhoto as browserPreparePhoto, safeAttachmentName, safeAttachmentType, sniffPhotoType, voiceProblem,
} from "./chat-attachments.js";
import { CHAT_EVENT_KINDS, chatNotes } from "./chat-archive.js";
import { ChatBlobStore } from "./chat-blob-store.js";
import { ChatBlobs } from "./chat-blobs.js";
import { ChatLogError, ChatLogStore } from "./chat-log-store.js";
import { ChatRecords } from "./chat-records.js";
import { encodePoll, parsePoll, pollProblem } from "./chat-polls.js";
import { memberLabels } from "../components/household/member-labels.js";
import { MAX_HIDDEN_MESSAGES, openHiddenState, sealHiddenRecord } from "./chat-hidden.js";
import { ChatPresence, CLOCK_SKEW_MS, compareCursors, cursorOf, isCursor, mergeCursors } from "./chat-presence.js";
import { ChatKeys, cursorSequence } from "./chat-keys.js";



/** Most events one push sends (the relay's batch bound). */
export const MAX_CHAT_PUSH = 20;
/** Most events one pull asks for (the relay's chat page bound). */
export const MAX_CHAT_PULL = 200;
/** Pull pages and push batches per sync pass; the coordinator continues
 * when there are more. */
const MAX_CHAT_PULL_PAGES = 5;
// Two push batches are at most 42 requests (20 blob uploads and a POST
// each), so a long outbox can't take much of the coordinator's shared
// request budget in one pass.
const MAX_CHAT_PUSH_BATCHES = 2;
/** Records read, decrypted and decoded together while opening the log. */
const LOAD_BATCH = 500;
/** Retire refusals that retrying can't fix: the blob stays on the service
 * and the event is sent anyway. */
const FINAL_RETIRE_REFUSALS = new Set(["chat_blob_retire_forbidden", "chat_blob_invalid", "chat_read_only", "chat_unavailable"]);
/** Authentication failures that skip an event at once: what the event
 * itself says can never pass (not a chat event, an identity that doesn't
 * match, a revoked or not-yet-granted device). A signature that doesn't
 * verify is skipped only when it fails again on a later pass, with a freshly
 * read directory (the device may have changed its key in between). Anything
 * else (an unknown device, a missing key epoch, a storage error) pauses chat
 * for a retry. */
const FINAL_REFUSALS = new Set(["chat_event_refused"]);
// A chat key epoch the household hasn't reached may only be newer than this
// pass's look at the service, so it gets a second look like a signature.
const SECOND_LOOK_REFUSALS = new Set(["event_signature_invalid", "chat_key_future", "chat_key_lost"]);
const CHAT_KINDS = CHAT_EVENT_KINDS;
const REF = /^[a-f0-9]{64}$/;
/** Most messages pinned at once (#131); the engine enforces it too. */
export const MAX_PINS = 10;

/** Throws the cancelled error once `signal` has been aborted. */
function cancelCheck(signal) {
  if (signal?.aborted) throw new ChatRoomError("Sending was cancelled.", "chat_attachment_cancelled");
}

export class ChatRoomError extends Error {
  constructor(message, code = "chat_unavailable") {
    super(message);
    this.name = "ChatRoomError";
    this.code = code;
  }
}

const randomIdHex = () => [...crypto.getRandomValues(new Uint8Array(16))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The newest messages the unread count looks through (#133). */
export const UNREAD_SCAN = 100;

/** How long a device keeps chat content it downloaded, and how often it
 * looks for older content to drop (#125). */
export const CHAT_CACHE_DAYS = 90;
const CACHE_TRIM_EVERY_MS = 6 * 60 * 60 * 1000;

/** Most rounds of opening older texts a single search runs (256 messages each). */
const MAX_SEARCH_ROUNDS = 40;

/** Members whose removals count: the household admins (ADR 0008), by the
 * service's own record (`householdAdmin` in the device directory), the same
 * rule it uses to let them delete others' content. A household has at most
 * four Adults, well within the engine's 16. */
export function chatAdmins(devices, now = Date.now()) {
  return [...new Set(devices
    .filter((device) => device.householdAdmin === true && device.memberActive !== false &&
      (device.memberExpiresAt === undefined || device.memberExpiresAt > now))
    .map((device) => device.memberId))].sort().slice(0, 16);
}

/** Members who can read chat under the admin's policy (#130), by the
 * service's own word (`chatAccess` in the device directory): the only ones
 * a message may mention by name. An older service says nothing, and every
 * active member then counts. At most 64, the engine's bound. */
export function chatReaders(devices) {
  return [...new Set(devices
    .filter((device) => device.memberActive !== false && (device.chatAccess ?? "read") !== "none")
    .map((device) => device.memberId))].sort().slice(0, 64);
}

/** What of the device directory decides member labels (each member's kind
 * and whether they're active): when it changes, the room asks the service
 * for the household's member list again. */
export function chatMembershipSignature(devices) {
  const members = new Map();
  for (const device of devices)
    members.set(device.memberId, `${device.memberKind ?? "adult"}:${device.memberActive !== false}`);
  return [...members].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map((entry) => entry.join("=")).join(",");
}

/** The `mentions` part of a post or edit command: `{ everyone, members }`
 * when there is anything to mention, else nothing (#130). */
function mentionsOf(mentions) {
  if (!mentions || (!mentions.everyone && !mentions.members?.length)) return {};
  return { mentions: { everyone: mentions.everyone === true, members: [...new Set(mentions.members ?? [])].sort() } };
}

/** Most characters one message holds (the engine's rule, chat.rs). */
export const MAX_CHAT_TEXT_CHARS = 4_000;

/** Why `text` can't be sent, or null: the engine's text rule (rust/src/chat.rs
 * check_text), checked here so a message never goes out that every device
 * would then refuse to show. */
export function chatTextProblem(text) {
  if (typeof text !== "string" || !text.isWellFormed()) return "That message can't be sent.";
  if (!text.trim()) return "Write a message first.";
  let characters = 0;
  for (const character of text) {
    characters += 1;
    if (/\p{Cc}/u.test(character) && character !== "\n" && character !== "\t") return "That message has characters Kin can't send.";
  }
  if (characters > MAX_CHAT_TEXT_CHARS) return `That's too long for one message. Keep it to ${MAX_CHAT_TEXT_CHARS.toLocaleString("en-US")} characters.`;
  return null;
}


/** The chat room for a browser page, with its blob store and client, or
 * null where there is no IndexedDB (Node tests of the coordinator). */
export async function openBrowserChatRoom({ blobFetch, ...options }) {
  if (typeof globalThis.indexedDB === "undefined" || typeof globalThis.IDBKeyRange === "undefined") return null;
  const blobStore = await ChatBlobStore.open(options.identity.householdId);
  try {
    // Blob requests go through the coordinator's guard (`blobFetch`): unlocked
    // only, stopped with it, within its request budget.
    const client = new ChatBlobClient(blobFetch ? { fetch: blobFetch } : {});
    const room = await ChatRoom.open({ ...options, blobs: new ChatBlobs({ store: blobStore, client }) });
    room.onClose = () => blobStore.close();
    return room;
  } catch (error) {
    blobStore.close();
    throw error;
  }
}

export class ChatRoom {
  /**
   * Opens the household's chat room on this device and decrypts its log.
   * `request(path, options)` is the coordinator's authenticated request;
   * `blobs` a ChatBlobs (#110). `locks` serializes sending across tabs.
   */
  static async open({ identity, keyStore, deviceKeys, engine, request, blobs, indexedDB, keyRange, locks = globalThis.navigator?.locks, now = () => Date.now(), onLocalChange = () => {}, preparePhoto = browserPreparePhoto }) {
    const store = await ChatLogStore.open(identity.householdId, { indexedDB, keyRange });
    const room = new ChatRoom({ identity, keyStore, deviceKeys, engine, request, blobs, store, locks, now, onLocalChange, preparePhoto });
    try {
      await room.loadState();
      await room.presence.load();
      await room.refresh();
    } catch (error) {
      room.close();
      throw error;
    }
    return room;
  }

  constructor({ identity, keyStore, deviceKeys, engine, request, blobs, store, locks, now, onLocalChange, preparePhoto }) {
    this.identity = identity;
    this.keyStore = keyStore;
    this.deviceKeys = deviceKeys;
    this.engine = engine;
    this.request = request;
    this.blobs = blobs;
    this.store = store;
    this.locks = locks;
    this.now = now;
    this.onLocalChange = onLocalChange;
    this.preparePhoto = preparePhoto;
    // Attachment manifests this device has opened, by manifest reference.
    this.manifests = new Map();
    this.records = new ChatRecords();
    // eventId -> record index, for resealing pending events.
    this.indexById = new Map();
    this.loadedOrder = 0;
    this.maxLogicalTime = 0n;
    this.epochKeys = new Map();
    // The dedicated chat key (#123) and, per loaded event, the chat key epoch
    // it was sealed under (0: from before the household had one).
    this.chatKeys = new ChatKeys({ identity, keyStore, request: (path, options) => this.request(path, options), now: () => this.now() });
    this.chatEpochById = new Map();
    this.currentEpoch = null;
    this.admins = [];
    /** Members who can read chat (#130): who can be mentioned. */
    this.readers = [];
    this.pending = new Set();
    // Messages with an event still waiting to send, for "Waiting to send".
    this.pendingMessages = new Set();
    this.retiredThrough = 0;
    this.retiredApplied = new Set();
    /** Events read from an export that can no longer be opened (#136). */
    this.unreadableImports = 0;
    this.refused = [];
    this.hidden = new Set();
    this.hiddenError = null;
    this.hiddenWaiting = false;
    /** This member's private read position (#133), or null. */
    this.readPosition = null;
    // Events whose signature failed once: eventId -> the pass it failed in.
    this.suspects = new Map();
    this.pass = 0;
    this.retireRefusal = null;
    // refresh() calls run one at a time (see refresh()).
    this.refreshQueue = Promise.resolve();
    this.listeners = new Set();
    // Read receipts and typing (#120): their own listeners, so a typing
    // indicator updating doesn't redraw the messages.
    this.presenceListeners = new Set();
    this.directory = [];
    this.liveSender = null;
    this.presence = new ChatPresence({
      identity,
      request: (path, options) => this.request(path, options),
      epochKey: (epoch) => this.epochKey(epoch),
      sendingEpoch: () => this.sendingEpoch(),
      signingKey: () => this.signingKey(),
      devices: () => this.directory,
      canPost: () => this.access === "write",
      hasAccess: () => this.access !== "none",
      sendLive: (bytes, kind = "typing") => Boolean(this.liveSender?.(bytes, kind)),
      store,
      now: () => this.now(),
      onChange: () => this.notifyPresence(),
    });
    // Visible and unlocked is what "online" means (#128).
    this.onVisibility = () => this.updateActivity();
    this.onPageHide = () => this.presence.setActive(false);
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", this.onVisibility);
      globalThis.addEventListener?.("pagehide", this.onPageHide);
      globalThis.addEventListener?.("pageshow", this.onVisibility);
    }
    // What the admin's chat policy lets this member do (#123): "write"
    // (read and post), "read" or "none". The service says so on every pass.
    this.access = "write";
    this.syncError = null;
    this.onClose = null;
    this.closed = false;
  }

  /** Records how the last chat pass went (null when it succeeded), for the
   * view to show; the coordinator calls it after each pass. */
  reportSync(error) {
    const changed = (this.syncError?.message ?? null) !== (error?.message ?? null);
    this.syncError = error;
    if (changed) this.notify();
  }

  /** Calls `listener()` whenever the chat log or its pending set changes.
   * Returns a function that stops it. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* a view's failure isn't the room's */ }
    }
  }

  /** Calls `listener()` when who has read what, or who is typing, changes. */
  subscribePresence(listener) {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  notifyPresence() {
    for (const listener of this.presenceListeners) {
      try { listener(); } catch { /* a view's failure isn't the room's */ }
    }
  }

  /** The coordinator's live channel, for typing frames: `send(bytes)` returns
   * whether the frame went out. Null when the channel is down. */
  setLiveSender(send) {
    this.liveSender = send;
    this.updateActivity();
  }

  /** Online now (#128): this device counts as online while Kin is unlocked
   * (this room is open) and the page is visible. */
  updateActivity() {
    const visible = typeof document !== "undefined" && document.visibilityState === "visible";
    this.presence.setActive(!this.closed && visible);
  }

  /** The live channel came up: tell the others straight away. */
  liveUp() {
    this.presence.reconnected();
  }

  /** An online frame relayed by the service (live channel). */
  receivePresence(bytes) {
    return this.presence.receiveOnline(bytes).catch(() => false);
  }

  /** A typing frame relayed by the service (live channel). */
  receiveTyping(bytes) {
    return this.presence.receiveTyping(bytes).catch(() => false);
  }

  /** The service says a read-receipt slot changed (live channel). */
  receiptsChanged() {
    this.presence.hint();
  }

  /** Posting, editing and deleting need "write" access (#123). */
  assertCanPost() {
    if (this.access !== "write")
      throw new ChatRoomError("Your household has set chat to read-only for you.", "chat_read_only");
  }

  assertOpen() {
    if (this.closed) throw new ChatRoomError("Unlock Kin to use chat.", "chat_locked");
    this.keyStore.vault?.assertUnlocked?.();
  }

  async epochKey(keyEpoch) {
    if (this.epochKeys.has(keyEpoch)) return this.epochKeys.get(keyEpoch);
    const epoch = await this.keyStore.getEpoch(this.identity.householdId, keyEpoch);
    if (!epoch) throw new ChatRoomError(`This device is missing key epoch ${keyEpoch}; chat is paused.`, "chat_key_missing");
    this.epochKeys.set(keyEpoch, epoch.householdKey);
    return epoch.householdKey;
  }

  /** The household's current key epoch: the last sync's, else the newest
   * this device holds (an offline message before the first sync). */
  async sendingEpoch() {
    if (this.currentEpoch !== null) return this.currentEpoch;
    const epochs = await this.keyStore.listEpochs(this.identity.householdId);
    if (!epochs.length) throw new ChatRoomError("Chat is unavailable until household sync is set up.", "chat_sync_unavailable");
    return Math.max(...epochs.map((epoch) => epoch.keyEpoch));
  }

  /** Reads events stored since the last read (by this tab or another) into
   * memory, and the outbox. Calls run one after another: two overlapping
   * reads would both append the same rows. */
  refresh() {
    const run = this.refreshQueue.then(() => this.refreshOnce());
    this.refreshQueue = run.catch(() => {});
    return run;
  }

  async refreshOnce() {
    this.assertOpen();
    let changed = false;
    while (true) {
      const rows = await this.store.eventsFrom(this.loadedOrder + 1, LOAD_BATCH);
      if (!rows.length) break;
      rows.forEach((row, index) => {
        if (row.order !== this.loadedOrder + 1 + index)
          throw new ChatLogError("This device's chat log is out of order.", "chat_log_damaged");
      });
      const keys = new Map();
      for (const row of rows)
        if (!row.imported && !keys.has(row.envelope.keyEpoch)) keys.set(row.envelope.keyEpoch, await this.epochKey(row.envelope.keyEpoch));
      const settled = await Promise.allSettled(rows.map(async (row) => {
        // Read from an export (#136): sealed by this device's vault, with no
        // envelope or chat key.
        if (row.imported) {
          this.chatEpochById.set(row.eventId, 0);
          try {
            return await this.keyStore.vault.open(row.imported, { store: "chat-import", id: row.eventId });
          } catch (error) {
            // Sealed under a root this device no longer has (the recovery key
            // was replaced): skipped, not a wall. Restoring the same export
            // again seals it afresh.
            if (error?.code === "locked") throw error;
            this.unreadableImports += 1;
            return null;
          }
        }
        const outer = await decryptStoredEvent({ envelope: row.envelope, householdKey: keys.get(row.envelope.keyEpoch) });
        const opened = await this.chatKeys.open(outer, row.eventId);
        this.chatEpochById.set(row.eventId, opened.keyEpoch);
        return opened.plaintext;
      }));
      const encoded = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
      try {
        const failed = settled.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
        this.assertOpen();
        const readable = rows.filter((_, index) => encoded[index]);
        const kept = encoded.filter(Boolean);
        const metadata = this.engine.eventMetadataBatch(kept);
        readable.forEach((row, index) => {
          this.indexById.set(row.eventId, this.records.length);
          this.records.append(kept[index]);
          const logicalTime = BigInt(metadata[index].logicalTime);
          if (logicalTime > this.maxLogicalTime) this.maxLogicalTime = logicalTime;
        });
      } finally {
        for (const bytes of encoded) bytes?.fill(0);
      }
      this.loadedOrder += rows.length;
      changed = true;
      if (rows.length < LOAD_BATCH) break;
    }
    const outbox = await this.store.outbox();
    const pending = new Set(outbox.map((row) => row.eventId));
    if (pending.size !== this.pending.size || [...pending].some((id) => !this.pending.has(id))) changed = true;
    this.pending = pending;
    this.pendingMessages = new Set(outbox.map((row) => row.messageId).filter(Boolean));
    if (changed) this.notify();
    return changed;
  }

  /** Loads what the log remembers beyond its events: the last known admins,
   * how far replaced blobs were deleted, and the refused relay events. */
  async loadState() {
    const state = await this.store.state();
    this.admins = state.admins ?? [];
    this.members = state.members ?? [];
    this.readers = state.readers ?? [];
    this.membersSignature = state.membersSignature ?? null;
    this.labels = memberLabels(this.members, this.identity.memberId);
    this.retiredThrough = state.retiredThrough ?? 0;
    this.refused = state.refused ?? [];
    this.hidden = new Set(state.hidden ?? []);
    this.readPosition = state.read ?? null;
    if (["write", "read", "none"].includes(state.access)) this.access = state.access;
  }

  /** Whether this member hid `messageId` for themselves ("delete for me"). */
  isHidden(messageId) {
    return this.hidden.has(messageId);
  }

  /** Deletes a message for this member only, on all their devices (#119):
   * nobody else sees any change. */
  async hide(message) {
    this.assertOpen();
    if (this.hidden.size >= MAX_HIDDEN_MESSAGES && !this.hidden.has(message.messageId))
      throw new ChatRoomError("You've deleted too many messages for yourself to keep track of more.", "chat_hidden_full");
    const ids = await this.store.addHidden([message.messageId]);
    this.hidden = new Set(ids);
    this.notify();
    try { this.onLocalChange(); } catch { /* sync starts on its own schedule */ }
  }

  /**
   * Brings this member's hidden messages in line with their sealed record
   * on the service: reads it (only when it changed, or when something here
   * must be written), adds what was hidden here, and writes it back when it
   * changed or when the member's devices did (so each current device can
   * read it). A record not sealed to this device's current key is left to
   * another of the member's devices that can read it; when none of them can
   * (all added or rekeyed since) or its writer is no longer trusted, this
   * device writes it afresh from what the member's devices hold.
   */
  async syncHidden(devices, { retried = false } = {}) {
    const memberId = this.identity.memberId, householdId = this.identity.householdId;
    const mine = devices.filter((device) => device.memberId === memberId && !device.revokedAt && device.publicKeys);
    const me = mine.find((device) => device.deviceId === this.identity.deviceId);
    if (!me) return;
    const sealFor = mine.map((device) => `${device.deviceId}:${device.fingerprint ?? ""}`).sort();
    const state = await this.store.state();
    const known = state.hiddenRevision ?? 0;
    const current = await this.request(`/api/chat/hidden?since=${known}`);
    const { revision } = current;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ChatRoomError("Chat received an invalid record.", "chat_hidden_invalid");
    // An older record than this device saw (a restored backup, or a service
    // withholding a write): never trusted to drop anything, since this
    // device writes back what it holds on top of it.
    const rolledBack = revision < known;
    const sameDevices = (state.hiddenSealedFor ?? []).join() === sealFor.join();
    if (current.unchanged && !state.hiddenDirty && sameDevices && !rolledBack) {
      this.hiddenWaiting = false;
      return;
    }
    const { record } = current.unchanged ? await this.request("/api/chat/hidden") : current;
    let remote = [], remoteRead = null;
    let rewrite = false;
    if (record) {
      try {
        ({ ids: remote, read: remoteRead } = await openHiddenState({
          record, householdId, memberId, revision, deviceId: me.deviceId, deviceFingerprint: me.fingerprint ?? "",
          agreementPrivateKey: this.deviceKeys?.keys?.agreementPrivateKey, senders: mine,
        }));
      } catch (error) {
        if (error?.code === "chat_hidden_untrusted_sender") {
          rewrite = true;
        } else if (error?.code === "chat_hidden_not_for_me") {
          const readable = new Set(record.recipients.map((entry) => `${entry.deviceId}:${entry.fingerprint ?? ""}`));
          if (sealFor.some((key) => readable.has(key))) {
            // Another current device of the member can read it: it will
            // write it again, sealed to this one too.
            this.hiddenWaiting = true;
            return;
          }
          rewrite = true;
        } else throw error;
      }
      const sealedFor = record.recipients.map((entry) => `${entry.deviceId}:${entry.fingerprint ?? ""}`).sort();
      if (sealedFor.join() !== sealFor.join()) rewrite = true;
    }
    this.hiddenWaiting = false;
    if (rolledBack) rewrite = true;
    const remoteSet = new Set(remote);
    const merged = [...new Set([...remote, ...(state.hidden ?? [])])];
    if (merged.length > MAX_HIDDEN_MESSAGES)
      throw new ChatRoomError("You've deleted too many messages for yourself to keep track of them all.", "chat_hidden_full");
    // The read position only moves forward, so the later of the two stands.
    // A position from the future (a wrong clock) would hide everything and
    // could never move back: it is ignored.
    if (remoteRead && remoteRead.postedAt > this.now() + CLOCK_SKEW_MS) remoteRead = null;
    const read = mergeCursors(remoteRead, state.read ?? null);
    const changed = merged.length !== remote.length || merged.some((id) => !remoteSet.has(id)) || compareCursors(read, remoteRead) > 0;
    let stored = revision;
    if (changed || rewrite) {
      const sealed = await sealHiddenRecord({
        ids: merged, read, householdId, memberId, revision: revision + 1, senderDeviceId: me.deviceId,
        signingKey: this.signingKey(),
        recipients: mine.map((device) => ({ deviceId: device.deviceId, fingerprint: device.fingerprint ?? "", publicKeys: device.publicKeys })),
      });
      try {
        stored = (await this.request("/api/chat/hidden", { method: "PUT", body: JSON.stringify({ expectedRevision: revision, record: sealed }) })).revision;
      } catch (error) {
        if (error?.code !== "chat_hidden_stale") throw error;
        // Another of the member's devices wrote meanwhile: read and merge
        // once more now; past that, the next pass does.
        if (!retried) return this.syncHidden(devices, { retried: true });
        const settled = await this.store.settleHidden({ ids: remote, revision, dirty: true, read: remoteRead });
        this.setHidden(settled.ids);
        this.setReadPosition(settled.read);
        return;
      }
    }
    const settled = await this.store.settleHidden({ ids: merged, revision: stored, sealedFor: sealFor, read });
    this.setHidden(settled.ids);
    this.setReadPosition(settled.read);
  }

  /**
   * Who can be mentioned (#130): the other active members who can read chat,
   * as { id, label } in label order. Mentioning someone is only offered, and
   * the engine only accepts it, for these.
   */
  mentionable() {
    const me = this.identity.memberId;
    return this.members
      .filter((member) => member.active !== false && member.id !== me && this.readers.includes(member.id))
      .map((member) => ({ id: member.id, label: this.authorLabel(member.id) }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
  }

  /**
   * The mentions of `message` that still mean something (#130): named
   * members who can still read chat and are active (anyone else shows as
   * plain text), and everyone. A message from someone else that mentions
   * this member, or everyone, also says so in `me`.
   */
  mentionsOf(message) {
    const found = message?.mentions;
    if (!found || (!found.everyone && !found.members?.length)) return { everyone: false, members: [], me: false };
    const members = found.members.filter((id) => this.readers.includes(id) && this.members.some((member) => member.id === id && member.active !== false));
    const me = message.authorId !== this.identity.memberId && (found.everyone || found.members.includes(this.identity.memberId));
    return { everyone: found.everyone, members, me };
  }

  /**
   * Moves this member's private read position forward to `message` (#133):
   * what the unread count and the "New messages" divider are measured from.
   * It is kept apart from read receipts (it works with them off and nobody
   * else sees it) and is written, sealed, to the member's own devices with
   * the next pass. Resolves true when the position moved.
   */
  async markReadPosition(message) {
    this.assertOpen();
    if (!message || this.access === "none") return false;
    const cursor = cursorOf(message);
    if (!isCursor(cursor) || compareCursors(cursor, this.readPosition) <= 0 || cursor.postedAt > this.now() + CLOCK_SKEW_MS) return false;
    this.setReadPosition(await this.store.markReadPosition(cursor));
    try { this.onLocalChange(); } catch { /* sync starts on its own schedule */ }
    return true;
  }

  setReadPosition(position) {
    if (compareCursors(position, this.readPosition) === 0) return;
    this.readPosition = position;
    this.notify();
  }

  /**
   * What this member hasn't read (#133): the messages from others, not
   * deleted or hidden, after the private read position. Counts the newest
   * `UNREAD_SCAN` messages only, so `capped` says "at least this many".
   * `first` is the oldest unread message in that range, where the divider
   * goes; null when there is none, or when no position is known yet (then
   * everything would be "new", which says nothing).
   */
  unread() {
    if (this.closed || this.access === "none") return { count: 0, mentions: 0, capped: false, first: null };
    const me = this.identity.memberId;
    const { messages, start } = this.page({ limit: UNREAD_SCAN });
    // Judged message by message against the position, not by where they
    // sit in the log: an offline message sorts earlier than it was posted.
    const horizon = this.now() + CLOCK_SKEW_MS;
    const after = (message) => compareCursors(cursorOf(message), this.readPosition) > 0;
    let count = 0, first = null, mentions = 0;
    for (const message of messages) {
      // A message dated in the future (its sender's clock is wrong) can't be
      // read past, so it isn't counted until its time comes.
      if (!after(message) || message.postedAt > horizon || message.authorId === me || this.hidden.has(message.messageId) || !(message.status === "live" || message.status === "edited")) continue;
      count += 1;
      if (this.mentionsOf(message).me) mentions += 1;
      first ??= message;
    }
    return { count, mentions, capped: start > 0 && messages.length > 0 && after(messages[0]), first: this.readPosition ? first : null };
  }

  setHidden(ids) {
    const before = this.hidden;
    this.hidden = new Set(ids);
    if (before.size !== this.hidden.size || [...this.hidden].some((id) => !before.has(id))) this.notify();
  }

  /** How the view names a message's author: "You", or the member's kind and
   * number ("Adult 2") exactly as Household access lists them
   * (member-labels.js); a member no longer listed is a "Former member". */
  authorLabel(memberId) {
    if (memberId === this.identity.memberId) return "You";
    return this.labels.get(memberId) ?? (this.members.some((member) => member.id === memberId) ? "Former member" : "Household member");
  }

  /** Whether this member may remove others' messages. */
  get isAdmin() {
    return this.admins.includes(this.identity.memberId);
  }

  /** What a reply quotes: the original's text, opened like a message's when
   * the engine doesn't hold it yet (#129). Takes page entries, returns the
   * same Map as loadTexts keyed by the original's ID. */
  async loadQuoteTexts(messages) {
    const originals = new Map();
    for (const { replyTo } of messages)
      if (replyTo?.contentKind === "text" && replyTo.blobRef && replyTo.text === null && !originals.has(replyTo.messageId))
        originals.set(replyTo.messageId, { messageId: replyTo.messageId, contentKind: "text", blobRef: replyTo.blobRef, blobKey: replyTo.blobKey, text: null });
    return this.loadTexts([...originals.values()]);
  }

  /**
   * Opens the text of each page message the engine doesn't hold yet (from
   * this device's blob store, else the service) and hands it to the engine,
   * which checks it. Resolves with a Map of messageId to { text },
   * { deleted: true }, { pending: true } (not uploaded yet) or
   * { failed: true } (couldn't be opened).
   */
  async loadTexts(messages) {
    this.assertOpen();
    const wanted = messages.filter((message) => message.contentKind === "text" && message.blobRef && message.text === null);
    const results = new Map();
    const kept = [];
    for (let start = 0; start < wanted.length; start += 8) {
      const chunk = wanted.slice(start, start + 8);
      const opened = await Promise.all(chunk.map((message) =>
        this.blobs.openText({ ref: message.blobRef, key: message.blobKey }).catch(() => ({ failed: true }))));
      chunk.forEach((message, index) => {
        results.set(message.messageId, opened[index]);
        if (typeof opened[index].text === "string") kept.push({ message, text: opened[index].text });
      });
    }
    this.assertOpen();
    for (let start = 0; start < kept.length; start += 500) {
      const chunk = kept.slice(start, start + 500);
      const accepted = this.engine.putChatTexts(chunk.map(({ message, text }) => ({ blobRef: message.blobRef, text })));
      // A text the engine refuses (control characters, too long) isn't shown.
      chunk.forEach(({ message }, index) => { if (!accepted[index]) results.set(message.messageId, { failed: true }); });
    }
    return results;
  }

  /** Whether this device's event `eventId` is still waiting to send. */
  isPending(eventId) {
    return this.pending.has(eventId);
  }

  syncIdentity() {
    return { householdId: this.identity.householdId, bindings: [] };
  }

  /**
   * What an export of this chat holds (#136): the canonical events (the same
   * records the room reads), the blobs this device still has for messages
   * that still exist, and the exporting member's own deleted-for-me list.
   * Content of messages deleted for everyone is never included: a blob this
   * device already deleted is gone, and one it has not yet deleted is left out
   * here. Nothing is copied: `records` is the room's own buffer.
   */
  async chatExportPlan() {
    this.assertOpen();
    if (this.access === "none") throw new ChatRoomError("Chat isn't available to you.", "chat_no_access");
    await this.refresh();
    // The events and the deletions they hold are read together, synchronously:
    // a snapshot, so events synced while the export is made are not in it.
    const view = this.records.view();
    const { retired } = this.page({ limit: 1, includeText: false, includeRetired: true });
    const gone = new Set(retired);
    const inventory = await this.blobs.store.inventory();
    // A deleted attachment's parts go with its manifest.
    for (const blob of inventory) if (gone.has(blob.ref)) for (const part of blob.parts ?? []) gone.add(part);
    const blobs = inventory.filter((blob) => !gone.has(blob.ref));
    const state = await this.store.state();
    return {
      view,
      events: view.length,
      blobs,
      blobBytes: blobs.reduce((total, blob) => total + blob.size, 0),
      notes: chatNotes({ memberId: this.identity.memberId, hidden: state.hidden ?? [] }),
      loadBlob: (blob) => this.blobs.store.get(blob.ref),
    };
  }

  /** A page of the chat room (wasm/kin-engine.js chatPage). */
  page(options = {}) {
    this.assertOpen();
    const { asOf, civilDate } = projectionContext(this.now());
    return this.engine.chatPage(this.records.view(), { includeReactions: true, includePolls: true, ...options, admins: this.admins }, asOf, civilDate, this.syncIdentity());
  }

  /**
   * Searches the chat (#124) in the engine, over the decrypted texts it
   * holds; nothing about the query leaves this device or is kept. Texts the
   * engine doesn't hold yet (older messages) are opened from this device's
   * store or the service in rounds, searching again after each, and
   * `onUpdate({ total, results, searching, incomplete })` runs after every
   * round. Resolves with the last update. `stopped()` ends it early.
   * Options: query, from, to (ms), authors (member IDs), attachmentsOnly, limit.
   */
  async search(options = {}, onUpdate = () => {}, stopped = () => false) {
    // Chat the member may not open can't be searched, whatever this device still holds.
    if (this.access === "none") throw new ChatRoomError("Chat isn't available to you.", "chat_no_access");
    const { query = "", from = 0, to = 0, authors = [], attachmentsOnly = false, mentioning = null, limit = 50 } = options;
    // Messages whose text couldn't be opened: left out of later rounds so
    // they don't crowd out older ones the engine lists next.
    const unopened = new Set();
    let update = { total: 0, results: [], searching: false, incomplete: false };
    for (let round = 0; round < MAX_SEARCH_ROUNDS; round += 1) {
      this.assertOpen();
      const { asOf, civilDate } = projectionContext(this.now());
      const found = this.engine.chatSearch(this.records.view(), {
        query, from, to, authors, attachmentsOnly, ...(mentioning ? { mentioning } : {}), limit, admins: this.admins, excluded: [...unopened, ...this.hidden].slice(0, MAX_HIDDEN_MESSAGES),
      }, asOf, civilDate, this.syncIdentity());
      const wanted = found.missing;
      const more = wanted.length > 0 && !stopped();
      update = { total: found.total, results: found.results, searching: more, incomplete: unopened.size > 0 || (!more && found.unsearched > 0) };
      onUpdate(update);
      if (!more) return update;
      const opened = await this.loadTexts(wanted.map((message) => ({ ...message, contentKind: "text", text: null })));
      for (const message of wanted) if (typeof opened.get(message.messageId)?.text !== "string") unopened.add(message.messageId);
      if (stopped()) return { ...update, searching: false };
    }
    update = { ...update, searching: false, incomplete: true };
    onUpdate(update);
    return update;
  }

  /** Sends a text message. Resolves with { messageId, eventId } once it is
   * stored on this device; it reaches the relay on the next sync. */
  async send(text, { replyTo = null, mentions = null } = {}) {
    this.assertCanPost();
    const messageId = randomIdHex();
    const sealed = await this.sealText(text);
    const eventId = await this.author({ type: "post-chat-message", messageId, blobRef: sealed.ref, blobKey: sealed.key, ...(replyTo ? { replyTo } : {}), ...mentionsOf(mentions) }, { blobRef: sealed.ref });
    return { messageId, eventId };
  }

  /**
   * Sends photos and files (#114) with an optional caption. Each file is
   * sealed in parts as it is read (so a large file never sits in memory
   * whole), then the manifest that names them. Resolves with
   * { messageId, eventId } like send().
   */
  async sendAttachments({ text = "", files, replyTo = null, mentions = null, voice = null, signal = null, onProgress = () => {} }) {
    this.assertOpen();
    this.assertCanPost();
    const problem = attachmentProblem(files);
    if (problem) throw new ChatRoomError(problem, "chat_attachment_invalid");
    // A voice message is one audio file with its length and waveform (#134).
    if (voice) {
      const voiceIssue = files.length !== 1 ? "A voice message is one recording." : !VOICE_TYPES.has(files[0].type) ? "This recording's format can't be sent." : voiceProblem(voice);
      if (voiceIssue) throw new ChatRoomError(voiceIssue, "chat_attachment_invalid");
    }
    if (text !== "" && chatTextProblem(text)) throw new ChatRoomError(chatTextProblem(text), "chat_text_invalid");
    const messageId = randomIdHex();
    const prepared = [];
    const kept = [];
    let manifest;
    // A broken progress callback must not break sending.
    const progress = (value) => { try { onProgress(value); } catch { /* progress is only for show */ } };
    try {
      for (const [index, file] of files.entries()) {
        const sealed = await this.sealFile(file, { signal, onBytes: (done, total) => progress({ index, done, total }) });
        if (voice) sealed.voice = { durationMs: voice.durationMs, peaks: [...voice.peaks] };
        prepared.push(sealed);
        // Kept first, so a failure from here on retires this file's parts too.
        kept.push(...manifestRefs({ files: [sealed] }));
        progress({ index, done: sealed.size, total: sealed.size });
      }
      this.assertOpen();
      cancelCheck(signal);
      const bytes = encodeManifest({ text, files: prepared });
      try {
        manifest = await this.blobs.sealBytes(bytes, { parts: kept });
      } finally {
        bytes.fill(0);
      }
      // The last point at which sending can still be stopped.
      cancelCheck(signal);
    } catch (error) {
      // Nothing was sent: this device's kept parts, and the manifest, go too.
      await this.blobs.retire(manifest ? [manifest.ref, ...kept] : kept).catch(() => {});
      manifest?.key.fill(0);
      throw error;
    }
    const hex = refHex(manifest.key);
    manifest.key.fill(0);
    const eventId = await this.author({ type: "post-chat-message", messageId, blobRef: manifest.ref, blobKey: hex, contentKind: "attachment", ...(replyTo ? { replyTo } : {}), ...mentionsOf(mentions) },
      { blobRef: manifest.ref });
    return { messageId, eventId };
  }

  /**
   * Sends a voice message (#134): a recording of at most five minutes with
   * its length and waveform peaks, sealed as an attachment of one audio file.
   * `recording` is the audio Blob (webm, mp4 or ogg).
   */
  async sendVoice({ recording, durationMs, peaks, replyTo = null, mentions = null }) {
    const type = String(recording?.type ?? "").split(";")[0].trim().toLowerCase();
    const extension = type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : "webm";
    if (!(recording instanceof Blob) || !VOICE_TYPES.has(type)) throw new ChatRoomError("This recording's format can't be sent.", "chat_attachment_invalid");
    const file = new File([recording], `Voice message.${extension}`, { type });
    return this.sendAttachments({ text: "", files: [file], replyTo, mentions, voice: { durationMs, peaks: [...peaks] } });
  }

  /** One file as its manifest entry: photos are drawn again first, then the
   * bytes are sealed in parts of ATTACHMENT_PART_BYTES. */
  async sealFile(file, { signal = null, onBytes = () => {} } = {}) {
    cancelCheck(signal);
    let source = file;
    let thumbnail = null;
    // Photos are recognized by their bytes, not their claimed type, so a
    // photo labelled as something else still loses its metadata.
    const photoType = await sniffPhotoType(file);
    if (photoType) {
      const photo = await this.preparePhoto(new File([file], safeAttachmentName(file.name), { type: photoType }));
      source = photo.blob;
      thumbnail = photo.thumbnail;
    }
    if (source.size < 1) throw new ChatAttachmentError(`${safeAttachmentName(file.name)} is empty. Choose a file that has content.`);
    if (source.size > MAX_ATTACHMENT_BYTES)
      throw new ChatAttachmentError(`${safeAttachmentName(file.name)} is too large to send${source !== file ? " even with its details removed" : ""}. Files can be 25 MB or smaller.`);
    const parts = await this.sealParts(source, { signal, onBytes });
    let thumb = null;
    if (thumbnail) {
      try {
        thumb = (await this.sealParts(thumbnail, { signal }))[0];
      } catch (error) {
        await this.blobs.retire(parts.map((part) => part.ref)).catch(() => {});
        throw error;
      }
    }
    return { name: safeAttachmentName(file.name), type: safeAttachmentType(source.type || file.type), size: source.size, thumbnail: thumb, parts };
  }

  /** Seals a blob's bytes part by part; each part is kept until sent. */
  async sealParts(source, { signal = null, onBytes = () => {} } = {}) {
    const parts = [];
    try {
      for (let offset = 0; offset < source.size; offset += ATTACHMENT_PART_BYTES) {
        this.assertOpen();
        cancelCheck(signal);
        const bytes = new Uint8Array(await source.slice(offset, offset + ATTACHMENT_PART_BYTES).arrayBuffer());
        try {
          const sealed = await this.blobs.sealBytes(bytes);
          parts.push({ ref: sealed.ref, key: refHex(sealed.key), size: bytes.length });
          sealed.key.fill(0);
        } finally {
          bytes.fill(0);
        }
        onBytes(Math.min(offset + ATTACHMENT_PART_BYTES, source.size), source.size);
      }
    } catch (error) {
      // Stopped part-way (cancelled, locked or failed): the parts already
      // sealed for this file are not part of any message, so they go.
      await this.blobs.retire(parts.map((part) => part.ref)).catch(() => {});
      throw error;
    }
    return parts;
  }

  /**
   * An attachment message's caption and file list (names, types, sizes),
   * opened once per device and remembered until the room closes. Throws
   * with code chat_attachment_deleted or chat_attachment_pending when its
   * manifest isn't available.
   */
  async openAttachment(message) {
    const manifest = await this.manifestOf(message);
    return {
      text: manifest.text,
      files: manifest.files.map((file) => ({ name: file.name, type: file.type, size: file.size, photo: Boolean(file.thumbnail), voice: file.voice ?? null })),
    };
  }

  async manifestOf(message) {
    this.assertOpen();
    if (message.contentKind !== "attachment" || !message.blobRef) throw new ChatAttachmentError("This message has no attachments.");
    // Deleted here (or on the service) since it was opened: no longer shown.
    if (await this.blobs.store.isRetired(message.blobRef)) {
      this.manifests.delete(message.blobRef);
      throw new ChatRoomError("This message was deleted.", "chat_attachment_deleted");
    }
    const cached = this.manifests.get(message.blobRef);
    if (cached) return cached;
    const opened = await this.blobs.openBytes({ ref: message.blobRef, key: message.blobKey });
    if (opened.deleted) throw new ChatRoomError("This message was deleted.", "chat_attachment_deleted");
    if (opened.pending) throw new ChatRoomError("This message is still arriving.", "chat_attachment_pending");
    let manifest;
    try {
      manifest = decodeManifest(opened.bytes);
    } finally {
      opened.bytes.fill(0);
    }
    // Its parts are now known: kept with the manifest, so deleting it can
    // delete them here too.
    await this.blobs.store.keepParts(message.blobRef, manifestRefs(manifest));
    this.manifests.set(message.blobRef, manifest);
    return manifest;
  }

  /** One file's bytes, as a Blob, fetched and checked part by part. */
  async attachmentFile(message, index) {
    const file = (await this.manifestOf(message)).files[index];
    if (!file) throw new ChatAttachmentError("This attachment couldn't be opened.");
    const chunks = await this.partBytes(file.parts, file.size);
    try {
      return new Blob(chunks, { type: file.type });
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  }

  /** A photo's thumbnail as a Blob, or null for a file without one. */
  async attachmentThumbnail(message, index) {
    const file = (await this.manifestOf(message)).files[index];
    if (!file?.thumbnail) return null;
    const [bytes] = await this.partBytes([file.thumbnail], file.thumbnail.size);
    try {
      return new Blob([bytes], { type: "image/jpeg" });
    } finally {
      bytes.fill(0);
    }
  }

  async partBytes(parts, size) {
    const chunks = [];
    let total = 0;
    for (const part of parts) {
      this.assertOpen();
      const opened = await this.blobs.openBytes({ ref: part.ref, key: bytesOfHex(part.key) });
      if (opened.deleted) throw new ChatRoomError("This attachment was deleted.", "chat_attachment_deleted");
      if (opened.pending) throw new ChatRoomError("This attachment is still arriving.", "chat_attachment_pending");
      if (opened.bytes.length !== part.size) throw new ChatAttachmentError("This attachment couldn't be opened.");
      total += opened.bytes.length;
      chunks.push(opened.bytes);
    }
    if (total !== size) throw new ChatAttachmentError("This attachment couldn't be opened.");
    return chunks;
  }

  /** The blobs an attachment message's removal must also delete (its
   * parts): from this device's kept copy, else its manifest. Deleted or still
   * arriving content has none to name. */
  async attachmentParts(message) {
    if (message.contentKind !== "attachment" || !message.blobRef) return [];
    const known = (await this.blobs.store.partsOf([message.blobRef])).get(message.blobRef);
    if (known) return known;
    try {
      return manifestRefs(await this.manifestOf(message));
    } catch (error) {
      // Gone, still arriving, or not a manifest this device can read: no
      // parts it can name. A connection failure still stops the deletion, so
      // the parts aren't left behind on the service.
      if (error.code === "chat_attachment_deleted" || error.code === "chat_attachment_pending" || error.code === "chat_attachment_invalid") return [];
      throw error;
    }
  }

  /**
   * Asks a quick poll (#135): a question and 2 to 10 options, one answer or
   * several. The question and options are sealed like message text. Resolves
   * with { messageId, eventId }.
   */
  async sendPoll({ question, options, multiple = false }) {
    this.assertCanPost();
    const problem = pollProblem({ question, options });
    if (problem) throw new ChatRoomError(problem, "chat_poll_invalid");
    const messageId = randomIdHex();
    const sealed = await this.sealText(encodePoll({ question, options }));
    const eventId = await this.author({
      type: "post-chat-message", messageId, blobRef: sealed.ref, blobKey: sealed.key,
      contentKind: "poll", poll: { options: options.length, multiple: multiple === true },
    }, { blobRef: sealed.ref });
    return { messageId, eventId };
  }

  /** Opens a poll message's question and options. Resolves with
   * { question, options }; rejects with a ChatRoomError whose code is
   * chat_poll_deleted, chat_poll_pending or chat_poll_invalid. */
  async openPoll(message) {
    this.assertOpen();
    if (message.contentKind !== "poll" || !message.blobRef || !message.poll)
      throw new ChatRoomError("This message isn't a poll.", "chat_poll_invalid");
    const opened = await this.blobs.openText({ ref: message.blobRef, key: message.blobKey });
    this.assertOpen();
    if (opened.deleted) throw new ChatRoomError("This poll was deleted.", "chat_poll_deleted");
    if (opened.pending) throw new ChatRoomError("This poll is still arriving.", "chat_poll_pending");
    const poll = typeof opened.text === "string" ? parsePoll(opened.text, message.poll.options) : null;
    if (!poll) throw new ChatRoomError("This poll couldn't be opened.", "chat_poll_invalid");
    return poll;
  }

  /** Votes in a poll: `choice` is the option numbers chosen (none clears the
   * vote). A later vote replaces an earlier one; the engine refuses it once
   * the poll is closed. */
  async vote(message, choice) {
    this.assertCanPost();
    return this.author({ type: "vote-chat-poll", messageId: message.messageId, choice }, { track: false });
  }

  /** Closes the member's own poll; no vote counts after. */
  async closePoll(message) {
    this.assertCanPost();
    return this.author({ type: "close-chat-poll", messageId: message.messageId }, { track: false });
  }

  /** Seals text into a kept blob; the key goes into the event as hex. */
  async sealText(text) {
    this.assertOpen();
    const problem = chatTextProblem(text);
    if (problem) throw new ChatRoomError(problem, "chat_text_invalid");
    const { ref, key } = await this.blobs.seal(text);
    const hex = refHex(key);
    key.fill(0);
    return { ref, key: hex };
  }

  /** Replaces a message's text. `message` is the page entry being edited. */
  async edit(message, text, { mentions = null } = {}) {
    this.assertCanPost();
    // Attachments are deleted, not edited (the engine refuses the edit too).
    if (message.contentKind !== "text") throw new ChatRoomError("Attachments can't be edited.", "chat_attachment_invalid");
    const sealed = await this.sealText(text);
    return this.author({ type: "edit-chat-message", messageId: message.messageId, blobRef: sealed.ref, blobKey: sealed.key, ...mentionsOf(mentions) },
      { blobRef: sealed.ref, retireRef: message.blobRef });
  }

  /** Deletes a message for everyone: the author's own, or as an admin. */
  async remove(message, { byAdmin = false } = {}) {
    this.assertCanPost();
    const retireParts = await this.attachmentParts(message);
    return this.author({ type: "delete-chat-message", messageId: message.messageId, byAdmin },
      { retireRef: message.blobRef, retireParts });
  }

  /** Turns this member's emoji reaction to `message` on or off (#127). The
   * engine refuses a reaction that changes nothing. */
  async react(message, emoji, on) {
    this.assertCanPost();
    return this.author({ type: "react-chat-message", messageId: message.messageId, emoji, on }, { track: false });
  }

  /**
   * Pins `message` or unpins it (#131); anyone who can post may. Up to
   * `MAX_PINS` messages are pinned at once: the engine refuses an 11th, and
   * this says so plainly first.
   */
  async pin(message, on) {
    this.assertCanPost();
    if (on && this.page({ limit: 1, includeText: false, includePins: true }).pins.length >= MAX_PINS)
      throw new ChatRoomError(`You can pin up to ${MAX_PINS} messages. Unpin one first.`, "chat_pin_limit");
    return this.author({ type: "pin-chat-message", messageId: message.messageId, on }, { track: false });
  }

  /**
   * Sets where `message` stands on the "To talk about" list (#312, ADR
   * 0014): "open" (Talk later, Reopen), "resolved" or "cleared" (Remove from
   * list). Anyone who can post may, as with a pin. The engine refuses a
   * change that changes nothing and a topic past `MAX_CHAT_TOPICS`; read the
   * list with `page({ includeTopics: true }).topics`.
   */
  async setTopic(message, state) {
    this.assertCanPost();
    return this.author({ type: "set-chat-topic", messageId: message.messageId, state }, { track: false });
  }

  async author(command, { blobRef = null, retireRef = null, retireParts = [], track = true }) {
    this.assertOpen();
    if (retireRef !== null && !REF.test(retireRef)) retireRef = null;
    retireParts = retireParts.filter((ref) => REF.test(ref));
    const write = async () => {
      // Another tab may have stored events (or sent) since this one read.
      await this.refresh();
      const state = await this.store.state();
      const { asOf, civilDate } = projectionContext(this.now());
      const eventId = randomIdHex();
      const logicalTime = this.maxLogicalTime + 1n;
      const result = this.engine.executeChatCommand(command, {
        eventId,
        householdId: this.identity.householdId,
        actorId: this.identity.memberId,
        deviceId: this.identity.deviceId,
        timestamp: asOf,
        logicalTime,
      }, this.records.view(), asOf, civilDate, this.syncIdentity(), this.admins, this.readers);
      let envelope;
      try {
        const keyEpoch = await this.sendingEpoch();
        const sealed = await this.chatKeys.seal(result.encodedEvent, eventId);
        try {
          envelope = await encryptEvent({
            eventId,
            householdId: this.identity.householdId,
            deviceId: this.identity.deviceId,
            deviceSequence: state.deviceSequence + 1,
            logicalTime: logicalTime.toString(),
            keyEpoch,
            plaintext: sealed.bytes,
            householdKey: await this.epochKey(keyEpoch),
            signingKey: this.signingKey(),
          });
        } finally {
          sealed.bytes.fill(0);
        }
      } finally {
        result.encodedEvent.fill(0);
      }
      this.assertOpen();
      // A reaction doesn't make its message "sending" (pendingMessages).
      await this.store.addLocal(envelope, { blobRef, retireRef, retireParts, messageId: track ? command.messageId : null });
      await this.refresh();
      return eventId;
    };
    const eventId = await this.exclusive(write);
    try { this.onLocalChange(); } catch { /* sync starts on its own schedule */ }
    return eventId;
  }

  signingKey() {
    const key = this.deviceKeys?.keys?.signingPrivateKey;
    if (!key) throw new ChatRoomError("Chat is unavailable until this device's keys are ready.", "chat_keys_unavailable");
    return key;
  }

  /**
   * One chat pass, after a full household pass: push this device's pending
   * events, then pull. `status` and `devices` are that pass's sync status
   * and verified device directory. Resolves with { hasMore } when the relay
   * has more chat to read than one pass takes.
   */
  async sync({ status, devices, deviceKeys }) {
    this.assertOpen();
    this.pass += 1;
    if (deviceKeys) this.deviceKeys = deviceKeys;
    this.currentEpoch = status.currentEpoch;
    this.directory = devices;
    const access = ["write", "read", "none"].includes(status.chat?.access) ? status.chat.access : "write";
    if (access !== this.access) {
      this.access = access;
      try { await this.store.saveAccess(access); } catch { /* the next pass says it again */ }
      this.presence.accessChanged();
      this.notify();
      this.notifyPresence();
    }
    // No access: nothing is fetched, sent or kept fresh until the admin
    // changes it back; what this device already decrypted stays.
    if (access === "none") return { hasMore: false };
    // The chat key (#123) comes before anything is read: events sealed under
    // it can't be opened without it. Trouble here (offline, a device not yet
    // ready) leaves chat on the keys already held.
    try {
      await this.chatKeys.sync({ status, devices, deviceKeys: this.deviceKeys });
    } catch (error) {
      if (error?.code === "chat_locked") throw error;
    }
    const admins = chatAdmins(devices, this.now());
    const adminsChanged = admins.join() !== this.admins.join();
    const readers = chatReaders(devices);
    const readersChanged = readers.join() !== this.readers.join();
    const signature = chatMembershipSignature(devices);
    let members = this.members, membersSignature = this.membersSignature;
    if (signature !== this.membersSignature) {
      // The household's member list, in the service's order, for labels.
      // Without it (offline, a service error) the labels wait for a later
      // pass.
      try {
        const household = await this.request("/api/household");
        members = (household.members ?? []).map(({ id, kind, active }) => ({ id, kind, active: active !== false }));
        membersSignature = signature;
      } catch (error) {
        // Labels are a nicety: keep the old ones and try again next pass,
        // rather than hold up sending and receiving.
        if (error?.code === "chat_locked") throw error;
      }
    }
    if (adminsChanged || readersChanged || membersSignature !== this.membersSignature) {
      await this.store.saveDirectory({ admins, members, membersSignature, readers });
      this.readers = readers;
      this.admins = admins;
      this.members = members;
      this.membersSignature = membersSignature;
      this.labels = memberLabels(members, this.identity.memberId);
      // Different admins can make an existing removal count, retiring its
      // blob: look at the retired list again this pass.
      if (adminsChanged) this.retiredThrough = 0;
      this.notify();
    }
    await this.refresh();
    let pushMore = false, pushError = null;
    if (!(status.rotationPending || this.chatKeys.pending || access !== "write")) {
      try {
        pushMore = await this.push();
      } catch (error) {
        // The service wants the chat key rotated, or this device's view of it
        // is behind: sending resumes on a later pass. A chat key this device
        // doesn't have yet must not hold up reading what it can.
        if (error?.code === "chat_key_stale" || error?.code === "chat_key_rotation_pending") pushMore = false;
        else if (["chat_key_missing", "chat_rate_limited", "chat_storage_full", "chat_limit"].includes(error?.code)) pushError = error;
        else throw error;
      }
    }
    const pullMore = await this.pull(status, devices);
    await this.retireReplaced();
    await this.trimCache().catch(() => {});
    // "Delete for me" is a nicety beside the chat itself: its trouble is
    // reported, and messages still flow.
    const hadError = this.hiddenError?.code ?? null, wasWaiting = this.hiddenWaiting;
    try {
      await this.syncHidden(devices);
      this.hiddenError = null;
    } catch (error) {
      if (error?.code === "chat_locked") throw error;
      this.hiddenError = error;
    }
    if ((this.hiddenError?.code ?? null) !== hadError || this.hiddenWaiting !== wasWaiting) this.notify();
    // Read receipts are a nicety too: their trouble never holds up messages.
    try {
      await this.presence.sync();
    } catch (error) {
      if (error?.code === "chat_locked") throw error;
    }
    if (pushError) throw pushError;
    return { hasMore: pushMore || pullMore };
  }

  /**
   * Drops this device's cached copies of chat content older than
   * CHAT_CACHE_DAYS (#125), at most every few hours. Messages stay; opening
   * an old one fetches its content again. Content waiting to be uploaded
   * (the outbox, with the parts of its attachment manifests) is never
   * dropped. Resolves with how many blobs were dropped.
   */
  async trimCache() {
    const now = this.now();
    if (this.trimmedAt && now - this.trimmedAt < CACHE_TRIM_EVERY_MS) return 0;
    const keep = new Set();
    for (const row of await this.store.outbox()) if (row.blobRef) keep.add(row.blobRef);
    for (const parts of (await this.blobs.store.partsOf([...keep])).values()) for (const part of parts) keep.add(part);
    const dropped = await this.blobs.store.evictOlderThan(now - CHAT_CACHE_DAYS * 24 * 60 * 60 * 1000, { keep });
    this.trimmedAt = now;
    return dropped;
  }

  /** The household's chat storage use, for an admin (#125): bytes and blobs
   * with their limits, and chat events. Totals only. */
  storageUsage() {
    this.assertOpen();
    return this.request("/api/chat/storage");
  }

  /** Sends pending events, at most MAX_CHAT_PUSH_BATCHES batches; resolves
   * true when more are left for the next pass. */
  async push() {
    const before = await this.store.state();
    if (!(await this.store.outbox()).length && !before.provisional) return false;
    // Renumbering and resealing change this device's sequence, so they run
    // under the lock sending holds, after asking the relay where it stands
    // for this device (inside the lock, so another tab can't push between).
    // That count settles a provisional sequence and tells events accepted
    // before a lost acknowledgement apart from events still to send.
    const accepted = await this.exclusive(async () => {
      const { deviceSequence: relaySequence } = await this.request("/api/chat/status");
      if (!Number.isSafeInteger(relaySequence) || relaySequence < 0)
        throw new ChatRoomError("Chat received an invalid relay position.", "chat_relay_invalid");
      const outbox = await this.store.outbox();
      const state = await this.store.state();
      if (state.provisional) {
        // Events made before this device first asked the relay: none of
        // them can be there, so they follow the relay's count.
        if (!outbox.length) await this.store.settleSequence(relaySequence);
        else await this.reseal(outbox, relaySequence + 1, { expectedDeviceSequence: state.deviceSequence, deviceSequence: relaySequence + outbox.length });
        return [];
      }
      const done = outbox.filter((row) => row.deviceSequence <= relaySequence);
      const waiting = outbox.slice(done.length);
      if (waiting.length && waiting[0].deviceSequence !== relaySequence + 1)
        throw new ChatRoomError("Chat on this device is out of step with the relay.", "chat_sequence_mismatch");
      // Anything sealed under an older key epoch than the current one is
      // sealed again (same sequence) before it leaves the device.
      const stale = [];
      for (const row of waiting)
        if ((await this.pendingEnvelope(row)).keyEpoch < this.currentEpoch ||
            (this.chatEpochById.get(row.eventId) ?? 0) < (await this.chatKeys.sendingEpoch())) stale.push(row);
      if (stale.length) await this.reseal(stale, null, { expectedDeviceSequence: state.deviceSequence, deviceSequence: state.deviceSequence });
      return done;
    });
    if (accepted.length) await this.finishSent(accepted);
    for (let batches = 0; batches < MAX_CHAT_PUSH_BATCHES; batches += 1) {
      const batch = (await this.store.outbox()).slice(0, MAX_CHAT_PUSH);
      if (!batch.length) break;
      const envelopes = [];
      for (const row of batch) {
        if (row.blobRef) await this.blobs.upload(row.blobRef);
        envelopes.push(await this.pendingEnvelope(row));
      }
      // Which chat key the batch is sealed under, for the service to check.
      const chatEpoch = Math.min(...batch.map((row) => this.chatEpochById.get(row.eventId) ?? 0));
      await this.request("/api/chat/events", {
        method: "POST",
        body: encodeEnvelopeBatch(envelopes),
        headers: { "Content-Type": ENVELOPE_CONTENT_TYPE, "X-Kin-Chat-Epoch": String(chatEpoch) },
      });
      await this.finishSent(batch);
    }
    await this.refresh();
    return (await this.store.outbox()).length > 0;
  }

  /** Runs `work` while no tab of this household is sending. */
  exclusive(work) {
    return this.locks?.request ? this.locks.request(`kin-chat-send:${this.identity.householdId}`, work) : work();
  }

  /** After the relay accepted events: asks the service to delete the blobs
   * they replaced, then drops them from the outbox. A deletion that failed
   * for now (offline, say) keeps the entry, so the next pass pushes it again
   * (harmless) and retries. One the service refuses outright (this member
   * may not delete that blob) is reported and the entry is dropped anyway:
   * retrying would block every later message. */
  async finishSent(rows) {
    const refs = rows.flatMap((row) => [row.retireRef, ...(row.retireParts ?? [])]).filter((ref) => ref);
    if (refs.length) {
      const { remoteError } = await this.blobs.retire(refs, { remote: refs });
      if (remoteError && !FINAL_RETIRE_REFUSALS.has(remoteError.code)) throw remoteError;
      if (remoteError) {
        this.retireRefusal = remoteError;
        this.notify();
      }
    }
    await this.store.markSent(rows.map((row) => row.deviceSequence));
  }

  /** The stored envelope of a pending event (another tab's included). */
  async pendingEnvelope(row) {
    const stored = await this.store.eventById(row.eventId);
    if (stored?.eventId !== row.eventId || stored.envelope.deviceSequence !== row.deviceSequence)
      throw new ChatLogError("This device's chat log is missing a pending message.", "chat_log_damaged");
    return stored.envelope;
  }

  /** Re-encrypts pending events, renumbered from `firstSequence` (or kept
   * when null), under the current key epoch. */
  async reseal(rows, firstSequence, { expectedDeviceSequence, deviceSequence }) {
    // Another tab's pending events need their plaintext in memory too.
    await this.refresh();
    const keyEpoch = await this.sendingEpoch();
    const householdKey = await this.epochKey(keyEpoch);
    const view = this.records.view();
    const entries = [];
    for (const [position, row] of rows.entries()) {
      const index = this.indexById.get(row.eventId);
      if (index === undefined) throw new ChatLogError("This device's chat log is missing a pending message.", "chat_log_damaged");
      const plaintext = view.record(index).slice();
      let envelope;
      try {
        const metadata = this.engine.eventMetadata(plaintext);
        const sealed = await this.chatKeys.seal(plaintext, row.eventId);
        try {
          envelope = await encryptEvent({
            eventId: row.eventId,
            householdId: this.identity.householdId,
            deviceId: this.identity.deviceId,
            deviceSequence: firstSequence === null ? row.deviceSequence : firstSequence + position,
            logicalTime: metadata.logicalTime.toString(),
            keyEpoch,
            plaintext: sealed.bytes,
            householdKey,
            signingKey: this.signingKey(),
          });
          this.chatEpochById.set(row.eventId, sealed.keyEpoch);
        } finally {
          if (sealed.bytes !== plaintext) sealed.bytes.fill(0);
        }
      } finally {
        plaintext.fill(0);
      }
      entries.push({ order: index + 1, previousSequence: row.deviceSequence, envelope, blobRef: row.blobRef ?? null, retireRef: row.retireRef ?? null, retireParts: row.retireParts ?? [], messageId: row.messageId ?? null });
    }
    await this.store.replacePending(entries, { expectedDeviceSequence, deviceSequence });
  }

  async pull(status, devices) {
    for (let pages = 0; pages < MAX_CHAT_PULL_PAGES; pages += 1) {
      const { cursor } = await this.store.state();
      const page = decodeEventPage(await this.request(
        `/api/chat/events?cursor=${encodeURIComponent(cursor)}&limit=${MAX_CHAT_PULL}`,
        { binary: true },
      ));
      const verified = [], refused = [];
      // A signature failing for the first time pauses the page, but the rest
      // of the page is still checked, so every such event gets its second
      // look on the next pass rather than one per pass.
      let pause = null;
      for (const { cursor: at, envelope } of page.events) {
        if (this.indexById.has(envelope.eventId)) {
          verified.push(envelope);
          continue;
        }
        try {
          await this.authenticate(envelope, status, devices, cursorSequence(at));
          verified.push(envelope);
        } catch (error) {
          // An event no retry can fix is skipped and remembered, so one bad
          // event can't stop the household's chat for good.
          if (this.closed) throw error;
          const secondLook = SECOND_LOOK_REFUSALS.has(error.code);
          const final = FINAL_REFUSALS.has(error.code) ||
            (secondLook && (this.suspects.get(envelope.eventId) ?? this.pass) < this.pass);
          if (!final && !secondLook) throw error;
          if (!final) {
            if (!this.suspects.has(envelope.eventId)) this.suspects.set(envelope.eventId, this.pass);
            pause ??= error;
            continue;
          }
          this.suspects.delete(envelope.eventId);
          refused.push({ eventId: envelope.eventId, deviceId: envelope.deviceId, cursor: at, code: error.code ?? "chat_event_refused" });
        }
      }
      if (pause) throw pause;
      this.assertOpen();
      await this.store.addReceived(verified, page.nextCursor, { refused });
      if (refused.length) {
        this.refused = [...this.refused, ...refused].slice(-100);
        this.notify();
      }
      await this.refresh();
      if (!page.hasMore) return false;
      if (page.nextCursor === cursor) return false;
    }
    return true;
  }

  /** Checks a relayed chat event as household sync checks its events: from
   * a trusted device of this household, signed by it, under a key epoch it
   * may use, and carrying the same identity inside as outside. */
  async authenticate(envelope, status, devices, sequence = null) {
    const refuse = (message) => { throw new ChatRoomError(message, "chat_event_refused"); };
    if (envelope.householdId !== this.identity.householdId) refuse("A chat message came from another household.");
    const signer = devices.find((device) => device.deviceId === envelope.deviceId);
    if (!signer?.publicKeys)
      throw new ChatRoomError("A chat message came from a device this one doesn't know yet.", "chat_device_unknown");
    if (signer.revokedAt && envelope.keyEpoch >= status.currentEpoch) refuse("A revoked device cannot send chat messages in the current key epoch.");
    if (envelope.keyEpoch < (signer.historyFromEpoch ?? 1)) refuse("A chat message came from before its device's history.");
    const outer = await decryptWithDeviceHistory({ device: signer, envelope, householdKey: await this.epochKey(envelope.keyEpoch) });
    let encodedEvent;
    try {
      encodedEvent = (await this.chatKeys.open(outer, envelope.eventId, { sequence })).plaintext;
    } catch (error) {
      outer.fill(0);
      throw error;
    }
    try {
      let metadata;
      try {
        metadata = this.engine.eventMetadata(encodedEvent);
      } catch {
        refuse("A chat message isn't a valid event.");
      }
      if (!CHAT_KINDS.has(metadata.kind) ||
          idToHex(metadata.eventId) !== envelope.eventId ||
          idToHex(metadata.householdId) !== this.identity.householdId ||
          idToHex(metadata.actorId) !== signer.memberId ||
          idToHex(metadata.deviceId) !== envelope.deviceId ||
          metadata.logicalTime.toString() !== envelope.logicalTime)
        refuse("A chat message did not match its encrypted envelope.");
    } finally {
      encodedEvent.fill(0);
    }
  }

  /** Deletes on this device the blobs the chat log says are gone (edited
   * or deleted messages), as every device does once it syncs. */
  async retireReplaced() {
    // Only new events can retire blobs, so this runs only when the log grew
    // since the last time (remembered across unlocks).
    const count = this.records.length;
    if (count <= this.retiredThrough) return;
    const { retired } = this.page({ limit: 1, includeText: false, includeRetired: true });
    // The list covers every blob ever replaced; only the ones not yet deleted
    // here are deleted (checked in memory, else once per unlock in storage).
    let fresh = retired.filter((ref) => !this.retiredApplied.has(ref));
    if (fresh.length) fresh = await this.blobs.store.unretired(fresh);
    if (fresh.length) await this.blobs.retire(fresh);
    for (const ref of retired) this.retiredApplied.add(ref);
    await this.store.saveRetiredThrough(count);
    this.retiredThrough = count;
    if (fresh.length) this.notify();
  }

  /** Drops the decrypted log (on lock or stop). */
  close() {
    if (this.closed) return;
    if (typeof document !== "undefined" && document.removeEventListener) {
      document.removeEventListener("visibilitychange", this.onVisibility);
      globalThis.removeEventListener?.("pagehide", this.onPageHide);
      globalThis.removeEventListener?.("pageshow", this.onVisibility);
    }
    this.presence.close();
    this.closed = true;
    this.records.clear();
    this.indexById.clear();
    this.epochKeys.clear();
    this.chatKeys.close();
    this.chatEpochById.clear();
    this.pending.clear();
    this.pendingMessages.clear();
    this.retiredApplied.clear();
    this.manifests.clear();
    this.hidden?.clear();
    this.listeners.clear();
    this.presenceListeners.clear();
    this.liveSender = null;
    this.deviceKeys = null;
    this.store.close();
    try { this.onClose?.(); } catch { /* already closed */ }
  }
}

/** Bytes from lowercase hex (64 characters for a key). */
function bytesOfHex(hex) {
  if (typeof hex !== "string" || !/^([a-f0-9]{2})+$/.test(hex)) throw new ChatAttachmentError("This attachment couldn't be opened.");
  return Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
}

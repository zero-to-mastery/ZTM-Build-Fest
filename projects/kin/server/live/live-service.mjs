// The live channel (#107): one WebSocket per trusted device at /api/live, so
// the service can tell a device "there is something new" at once instead of
// waiting for its next poll. It carries notices and, later, chat signals;
// encrypted household data still moves over the HTTP sync routes, which stay
// the fallback whenever the socket isn't there.
//
// Rules:
// - The upgrade is refused unless the Origin is exactly Kin's own origin
//   (cross-site WebSocket hijacking), the session cookie names an active
//   member on a trusted device, and the household isn't being deleted.
// - One socket per device: a new one replaces the old (close 4409).
// - Losing access closes the socket at once: a signed-out or expired session
//   with 4401, a revoked device, removed member or deleted household with
//   4403. Anything that changes access calls revalidate(); a timer fires when
//   the session or a Temporary membership expires; each ping re-checks too.
//   A storage failure closes with 1011, not as lost access.
// - Pings every 25 s; two unanswered pings close the socket. A client that
//   half-closes (TCP FIN without a close frame) is closed at once.
// - Backpressure: while the socket can't take more, messages queue (a
//   sync hint already waiting isn't queued twice); past 1 MiB queued, the
//   socket closes with 4429 and the client catches up over HTTP.
// - Each connection keeps its socket and timers in a DisposableStack, so
//   every way it ends releases the same resources exactly once. Sockets that
//   are still closing count against the connection limit.
import {
  acceptKey, CLOSE, closePayload, encodeFrame, encodeMessage, FrameParser, isClientKey, MAX_MESSAGE_BYTES, OPCODE, parseMessage,
} from "./websocket.mjs";
import { PairingError, canParticipate, chatAccess } from "../pairing-service/shared.mjs";
import { CATEGORIES, EphemeralError, MAX_EPHEMERAL_PAYLOAD, SCOPE, decodeRequest, encodeDelivery } from "./ephemeral.mjs";

export const LIVE_PATH = "/api/live";
export const PING_INTERVAL_MS = 25_000;
export const MAX_MISSED_PONGS = 2;
export const MAX_QUEUED_BYTES = 1024 * 1024;
export const MAX_CONNECTIONS = 4096;
/** How long a closing socket may take to finish its closing handshake. */
const CLOSE_GRACE_MS = 5_000;
/** The same at shutdown, so stopping the service never waits on a peer. */
const SHUTDOWN_GRACE_MS = 250;
/** setTimeout's longest delay; longer expiries are re-armed in steps. */
const MAX_TIMER_MS = 2_147_483_647;

/** Kin record types on the live channel (server → client unless noted). */
export const LIVE_TYPE = Object.freeze({
  /** Sent once when the socket opens. Empty payload. */
  HELLO: 0x01,
  /** New household events were accepted: pull from the HTTP sync routes.
   * Empty payload; it says nothing about what changed or who changed it. */
  SYNC_HINT: 0x02,
  /** Typing (#122), both ways. A client sends one sealed frame (a signed
   * household-key envelope, JSON); the service relays it unchanged to the
   * household's other connected, chat-allowed devices and keeps nothing. */
  TYPING: 0x03,
  /** A member's read-receipt slot changed (#121): fetch /api/chat/receipts.
   * Empty payload; like a sync hint it says nothing about what changed. */
  RECEIPTS: 0x04,
  /** Online now (#128), both ways. A client sends a sealed heartbeat frame
   * (the same kind of signed household-key envelope as typing) every 30
   * seconds while Kin is unlocked and visible, and an "away" frame when it
   * stops; the service relays it unchanged to the household's other
   * connected, chat-allowed devices. It is never stored, counted or logged. */
  PRESENCE: 0x05,
  /** An ephemeral message (#257), both ways: one versioned envelope (see
   * ephemeral.mjs) relayed to open sockets only, by member or trusted
   * device, with the sender stamped by the service. Never stored, replayed,
   * exported or pushed. Production accepts no category yet. */
  EPHEMERAL: 0x06,
});

/** A typing frame is one small envelope; anything larger isn't one. */
export const MAX_TYPING_BYTES = 2048;
/** Frames a connection may send in a burst, and how fast that refills. A
 * client sends one every 3 seconds, plus one when it stops. */
export const TYPING_BURST = 4;
export const TYPING_REFILL_MS = 1_000;
/** Presence frames (#128) are rarer: one per 30 seconds, a few on connect. */
export const PRESENCE_BURST = 6;
export const PRESENCE_REFILL_MS = 2_000;
/** Frames dropped in a row before the connection is closed as abusive. */
export const MAX_TYPING_DROPS = 60;

const ACCESS_CODES = new Map([
  ["authentication_required", CLOSE.SESSION_ENDED],
  ["device_not_trusted", CLOSE.ACCESS_LOST],
  ["membership_removed", CLOSE.ACCESS_LOST],
  ["household_deletion_pending", CLOSE.ACCESS_LOST],
  ["household_deleted", CLOSE.ACCESS_LOST],
]);

const STATUS_TEXT = new Map([
  [400, "Bad Request"], [401, "Unauthorized"], [403, "Forbidden"], [404, "Not Found"],
  [426, "Upgrade Required"], [503, "Service Unavailable"],
]);

function refuse(socket, status, headers = "") {
  if (socket.destroyed) return;
  const response = `HTTP/1.1 ${status} ${STATUS_TEXT.get(status)}\r\nConnection: close\r\n${headers}Content-Length: 0\r\n\r\n`;
  // Let the refusal reach the client before the socket goes.
  socket.end(response, () => socket.destroy());
  setTimeout(() => socket.destroy(), 1_000).unref?.();
}

function headerList(value) {
  return String(value ?? "").toLowerCase().split(",").map((part) => part.trim());
}

/** A category table is checked once, so a bad entry stops the service
 * starting instead of quietly disabling a limit later. */
function checkedCategories(table) {
  for (const [id, category] of table) {
    const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    if (!whole(id, 0, 255) || !whole(category?.maxPayload, 1, MAX_EPHEMERAL_PAYLOAD) || !whole(category.burst, 1, 1_000) ||
        !whole(category.refillMs, 1, 3_600_000) || !Array.isArray(category.scopes) || !category.scopes.length ||
        !category.scopes.every((scope) => Object.values(SCOPE).includes(scope)) || !["chat", "write"].includes(category.access))
      throw new RangeError(`Invalid ephemeral category ${id}.`);
  }
  return table;
}

class LiveConnection {
  constructor(live, socket, { sessionToken, deviceId, householdId, memberId, deadline }) {
    this.live = live;
    this.socket = socket;
    this.sessionToken = sessionToken;
    this.deviceId = deviceId;
    this.householdId = householdId;
    this.memberId = memberId;
    this.parser = new FrameParser({ maxMessage: live.maxMessage });
    this.queue = [];
    this.queuedBytes = 0;
    this.queuedHint = false;
    this.blocked = false;
    this.missedPongs = 0;
    this.typingTokens = TYPING_BURST;
    this.typingRefilledAt = 0;
    this.typingDrops = 0;
    this.presenceTokens = PRESENCE_BURST;
    this.presenceRefilledAt = 0;
    this.presenceDrops = 0;
    /** category id → { tokens, refilledAt, drops }, for the ephemeral path. */
    this.ephemeralBuckets = new Map();
    this.queuedReceipts = false;
    this.closing = false;
    this.disposed = false;
    this.resources = new DisposableStack();
    const onData = (chunk) => this.receive(chunk);
    const onDrain = () => this.flush();
    const onEnd = () => this.dispose();
    // A half-close (FIN without a close frame) means the peer is gone.
    const onHalfClose = () => (this.closing ? this.dispose() : this.close(CLOSE.GOING_AWAY, "", { grace: 0 }));
    socket.on("data", onData);
    socket.on("drain", onDrain);
    socket.on("end", onHalfClose);
    socket.on("close", onEnd);
    socket.on("error", onEnd);
    socket.setNoDelay?.(true);
    this.resources.defer(() => {
      socket.off("data", onData);
      socket.off("drain", onDrain);
      socket.off("end", onHalfClose);
      socket.destroy();
    });
    const ping = setInterval(() => this.tick(), live.pingInterval);
    ping.unref?.();
    this.resources.defer(() => clearInterval(ping));
    this.armExpiry(deadline);
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.live.forget(this, { socket: true });
    if (this.live.closingByDevice.get(this.deviceId) === this) this.live.closingByDevice.delete(this.deviceId);
    this.resources.dispose();
  }

  /** Re-checks access when the session or a Temporary membership expires. */
  armExpiry(deadline) {
    if (!Number.isFinite(deadline)) return;
    const wait = Math.max(0, deadline - this.live.service.now());
    const timer = setTimeout(() => {
      if (wait > MAX_TIMER_MS) return this.armExpiry(deadline);
      this.live.stillAllowed(this);
    }, Math.min(wait, MAX_TIMER_MS) + 1);
    timer.unref?.();
    this.resources.defer(() => clearTimeout(timer));
  }

  /** Every ping interval: give up on a silent peer, re-check the session. */
  tick() {
    if (this.closing) return;
    if (this.missedPongs >= this.live.maxMissedPongs) return this.close(CLOSE.GOING_AWAY, "No pong");
    if (!this.live.stillAllowed(this)) return;
    this.missedPongs += 1;
    this.write(encodeFrame(OPCODE.PING));
  }

  receive(chunk) {
    if (this.disposed) return;
    for (const event of this.parser.feed(chunk)) {
      if (event.type === "error") return this.close(event.code, event.reason);
      if (event.type === "close") {
        // Echo the peer's close and finish.
        const code = event.code === 1005 ? CLOSE.NORMAL : event.code;
        this.close(code, "", { echo: true });
        return;
      }
      if (this.closing) continue;
      if (event.type === "ping") this.write(encodeFrame(OPCODE.PONG, event.data));
      else if (event.type === "pong") this.missedPongs = 0;
      else if (event.type === "message") {
        const record = parseMessage(event.data);
        if (!record) return this.close(CLOSE.INVALID_DATA, "Malformed message");
        const handler = this.live.handlers.get(record.type);
        if (!handler) return this.close(CLOSE.UNSUPPORTED_DATA, "Unknown message type");
        try {
          handler(this, record);
        } catch {
          return this.close(CLOSE.SERVER_ERROR, "");
        }
      }
    }
  }

  /** Sends one Kin record. */
  send(type, payload, flags) {
    if (this.closing || this.disposed) return false;
    // An empty sync hint already waiting says all a second one would.
    if (type === LIVE_TYPE.SYNC_HINT && this.blocked) {
      if (this.queuedHint) return true;
      this.queuedHint = true;
    }
    if (type === LIVE_TYPE.RECEIPTS && this.blocked) {
      if (this.queuedReceipts) return true;
      this.queuedReceipts = true;
    }
    return this.write(encodeFrame(OPCODE.BINARY, encodeMessage(type, payload, flags)));
  }

  /** Sends a record that is only worth sending now: dropped, not queued,
   * while the socket can't take more (typing is gone in six seconds anyway). */
  sendEphemeral(type, payload) {
    if (this.closing || this.disposed || this.blocked) return false;
    return this.write(encodeFrame(OPCODE.BINARY, encodeMessage(type, payload)));
  }

  write(frame) {
    if (this.disposed) return false;
    if (this.blocked) {
      this.queue.push(frame);
      this.queuedBytes += frame.length;
      if (this.queuedBytes > this.live.maxQueued) {
        // The client isn't reading; it can catch up over HTTP.
        this.close(CLOSE.SLOW_CONSUMER, "Too slow", { grace: 1_000 });
        return false;
      }
      return true;
    }
    this.blocked = !this.socket.write(frame);
    return true;
  }

  flush() {
    this.blocked = false;
    while (this.queue.length && !this.blocked) {
      const frame = this.queue.shift();
      this.queuedBytes -= frame.length;
      this.blocked = !this.socket.write(frame);
    }
    if (!this.blocked) {
      this.queuedHint = false;
      this.queuedReceipts = false;
    }
  }

  /** Starts the closing handshake; the socket ends once the close frame is
   * written, and at the latest after `grace`. Anything still queued is
   * dropped; the close frame goes out past it. */
  close(code, reason = "", { echo = false, grace = CLOSE_GRACE_MS } = {}) {
    if (this.closing || this.disposed) {
      if (echo) this.dispose();
      return;
    }
    this.closing = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.blocked = false;
    this.live.forget(this);
    // A device holds at most one closing socket: an earlier one still
    // waiting out its grace goes now, so a device reconnecting in a loop
    // can't pile up sockets against the limit.
    const earlier = this.live.closingByDevice.get(this.deviceId);
    this.live.closingByDevice.set(this.deviceId, this);
    earlier?.dispose();
    if (!this.socket.writableEnded && !this.socket.destroyed) {
      this.socket.write(encodeFrame(OPCODE.CLOSE, closePayload(code, reason)));
      this.socket.end();
    }
    if (echo || grace === 0) {
      if (grace === 0) setImmediate(() => this.dispose());
      else this.dispose();
      return;
    }
    const timer = setTimeout(() => this.dispose(), grace);
    timer.unref?.();
    this.resources.defer(() => clearTimeout(timer));
  }
}

export class LiveService {
  constructor({
    service, origin, readSession, store = null,
    pingInterval = PING_INTERVAL_MS, maxMissedPongs = MAX_MISSED_PONGS, maxQueued = MAX_QUEUED_BYTES,
    maxMessage = MAX_MESSAGE_BYTES, maxConnections = MAX_CONNECTIONS, ephemeralCategories = CATEGORIES,
  }) {
    this.service = service;
    // Compared as a browser sends it: scheme, host and port only.
    this.origin = new URL(origin).origin;
    this.readSession = readSession;
    this.store = store;
    this.pingInterval = pingInterval;
    this.maxMissedPongs = maxMissedPongs;
    this.maxQueued = maxQueued;
    this.maxMessage = maxMessage;
    this.maxConnections = maxConnections;
    this.ephemeralCategories = checkedCategories(ephemeralCategories);
    /** deviceId → connection */
    this.connections = new Map();
    /** householdId → Set of connections */
    this.households = new Map();
    /** Every socket still held, open or closing (the connection limit). */
    this.sockets = new Set();
    /** deviceId → its connection still closing, if any (at most one). */
    this.closingByDevice = new Map();
    /** Kin record type → handler(connection, record), for client messages. */
    this.handlers = new Map();
    this.handlers.set(LIVE_TYPE.TYPING, (connection, record) => this.relayTyping(connection, record));
    this.handlers.set(LIVE_TYPE.PRESENCE, (connection, record) => this.relayPresence(connection, record));
    this.handlers.set(LIVE_TYPE.EPHEMERAL, (connection, record) => this.relayEphemeral(connection, record));
  }

  /** What the connection's member may do in chat now (#123): "write",
   * "read" or "none". Read comes from the admin's policy, live. */
  chatLevel(connection) {
    return chatAccess(this.service.members.get(connection.memberId), this.service.households.get(connection.householdId), this.service.now());
  }

  /** Whether the connection's member may see chat signals (typing, receipts). */
  chatAllowed(connection) {
    return this.chatLevel(connection) !== "none";
  }

  /**
   * Relays one typing frame (#122) to the household's other connected,
   * chat-allowed devices, unchanged and unstored. The service can't read it;
   * it checks only that it is small, names the sender's own household and
   * device, and isn't coming faster than a person types. Frames over the
   * rate are dropped; a connection that keeps sending them is closed.
   */
  relayTyping(connection, record) {
    const payload = record.payload;
    if (payload.length < 1 || payload.length > MAX_TYPING_BYTES) return connection.close(CLOSE.TOO_BIG, "Bad typing frame");
    const now = this.service.now();
    const elapsed = Math.max(0, now - connection.typingRefilledAt);
    connection.typingTokens = Math.min(TYPING_BURST, connection.typingTokens + Math.floor(elapsed / TYPING_REFILL_MS));
    if (elapsed >= TYPING_REFILL_MS) connection.typingRefilledAt = now;
    if (connection.typingTokens < 1) {
      connection.typingDrops += 1;
      if (connection.typingDrops > MAX_TYPING_DROPS) connection.close(CLOSE.POLICY, "Too many typing frames");
      return;
    }
    connection.typingTokens -= 1;
    connection.typingDrops = 0;
    let frame;
    try {
      frame = JSON.parse(payload.toString("utf8"));
    } catch {
      return connection.close(CLOSE.INVALID_DATA, "Bad typing frame");
    }
    if (!frame || typeof frame !== "object" || frame.householdId !== connection.householdId || frame.deviceId !== connection.deviceId)
      return connection.close(CLOSE.POLICY, "Bad typing frame");
    // Typing is posting-adjacent: only a member who can post sends it.
    if (this.chatLevel(connection) !== "write") return;
    for (const other of this.households.get(connection.householdId) ?? [])
      if (other !== connection && this.chatAllowed(other)) other.sendEphemeral(LIVE_TYPE.TYPING, payload);
  }

  /**
   * Relays one presence frame (#128) like a typing frame: to the household's
   * other connected, chat-allowed devices, unchanged. Nothing about it is
   * stored, counted per member or logged; a member with no chat access
   * neither sends nor receives it (a read-only member may: presence is not
   * posting).
   */
  relayPresence(connection, record) {
    const payload = record.payload;
    if (payload.length < 1 || payload.length > MAX_TYPING_BYTES) return connection.close(CLOSE.TOO_BIG, "Bad presence frame");
    const now = this.service.now();
    const elapsed = Math.max(0, now - connection.presenceRefilledAt);
    connection.presenceTokens = Math.min(PRESENCE_BURST, connection.presenceTokens + Math.floor(elapsed / PRESENCE_REFILL_MS));
    if (elapsed >= PRESENCE_REFILL_MS) connection.presenceRefilledAt = now;
    if (connection.presenceTokens < 1) {
      connection.presenceDrops += 1;
      if (connection.presenceDrops > MAX_TYPING_DROPS) connection.close(CLOSE.POLICY, "Too many presence frames");
      return;
    }
    connection.presenceTokens -= 1;
    connection.presenceDrops = 0;
    let frame;
    try {
      frame = JSON.parse(payload.toString("utf8"));
    } catch {
      return connection.close(CLOSE.INVALID_DATA, "Bad presence frame");
    }
    if (!frame || typeof frame !== "object" || frame.householdId !== connection.householdId || frame.deviceId !== connection.deviceId)
      return connection.close(CLOSE.POLICY, "Bad presence frame");
    if (!this.chatAllowed(connection)) return;
    for (const other of this.households.get(connection.householdId) ?? [])
      if (other !== connection && this.chatAllowed(other)) other.sendEphemeral(LIVE_TYPE.PRESENCE, payload);
  }

  /**
   * Relays one ephemeral message (#257, #258). The envelope is checked
   * before anything else: a malformed one, an unknown version or category, a
   * scope the category doesn't allow or an oversized payload closes the
   * socket (fail closed, like an unknown record type). After that nothing a
   * sender gets wrong is visible to it: a message that is over the rate, or
   * whose sender or receivers may not take part, or that names a member or
   * device that is offline, revoked or in another household, is dropped without
   * a word, so the sender learns nothing about who is connected.
   *
   * Receivers are chosen from the live sockets and re-checked now, on the
   * server: the device still trusted, its member active and allowed. The
   * sender is stamped from its own session, never read from the message.
   * Nothing is stored, queued (a receiver that can't take it right now misses
   * it), counted per member or logged.
   */
  relayEphemeral(connection, record) {
    let request;
    try {
      request = decodeRequest(record.payload, this.ephemeralCategories);
    } catch (error) {
      if (!(error instanceof EphemeralError)) throw error;
      const code = error.reason === "too_big" ? CLOSE.TOO_BIG : error.reason === "malformed" ? CLOSE.INVALID_DATA : CLOSE.UNSUPPORTED_DATA;
      return connection.close(code, "Bad ephemeral message");
    }
    const { category, categoryId } = request;
    const now = this.service.now();
    let bucket = connection.ephemeralBuckets.get(categoryId);
    if (!bucket) connection.ephemeralBuckets.set(categoryId, (bucket = { tokens: category.burst, refilledAt: now, drops: 0 }));
    // Whole tokens earned since the last refill; the part of an interval
    // not yet earned carries over instead of being thrown away.
    const earned = Math.floor(Math.max(0, now - bucket.refilledAt) / category.refillMs);
    if (earned > 0) {
      bucket.tokens = Math.min(category.burst, bucket.tokens + earned);
      bucket.refilledAt = bucket.tokens >= category.burst ? now : bucket.refilledAt + earned * category.refillMs;
    }
    if (bucket.tokens < 1) {
      bucket.drops += 1;
      if (bucket.drops > MAX_TYPING_DROPS) connection.close(CLOSE.POLICY, "Too many messages");
      return;
    }
    bucket.tokens -= 1;
    bucket.drops = 0;
    // The sender must still be trusted, and allowed to take part, right now.
    if (!this.stillAllowed(connection) || !this.ephemeralAllowed(connection, category)) return;
    let delivery;
    for (const other of this.ephemeralReceivers(connection, request)) {
      if (!this.ephemeralAllowed(other, category) || this.lostAccess(other)) continue;
      delivery ??= encodeDelivery({
        categoryId, scope: request.scope, correlation: request.correlation,
        senderMemberId: connection.memberId, senderDeviceId: connection.deviceId, payload: request.payload,
      });
      other.sendEphemeral(LIVE_TYPE.EPHEMERAL, delivery);
    }
  }

  /** Whether the connection's member may take part in a category now. */
  ephemeralAllowed(connection, category) {
    if (connection.closing || connection.disposed) return false;
    return category.access === "write" ? this.chatLevel(connection) === "write" : this.chatAllowed(connection);
  }

  /** The open sockets a request addresses, in the sender's household only. */
  ephemeralReceivers(connection, { scope, targetId }) {
    const household = this.households.get(connection.householdId);
    if (!household) return [];
    if (scope === SCOPE.DEVICE) {
      const other = this.connections.get(targetId);
      return other && other !== connection && household.has(other) ? [other] : [];
    }
    return [...household].filter((other) => other !== connection && (scope === SCOPE.HOUSEHOLD || other.memberId === targetId));
  }

  /** node:http's "upgrade" event. */
  handleUpgrade(request, socket, head) {
    socket.on("error", () => socket.destroy());
    let url;
    try {
      url = new URL(request.url, this.origin);
    } catch {
      return refuse(socket, 400);
    }
    if (url.pathname !== LIVE_PATH || request.method !== "GET") return refuse(socket, 404);
    const key = request.headers["sec-websocket-key"];
    if (!headerList(request.headers.upgrade).includes("websocket") ||
        !headerList(request.headers.connection).includes("upgrade") || !isClientKey(key))
      return refuse(socket, 400);
    if (request.headers["sec-websocket-version"] !== "13")
      return refuse(socket, 426, "Sec-WebSocket-Version: 13\r\n");
    // Cross-site WebSocket hijacking: the browser always sends Origin.
    if (request.headers.origin !== this.origin) return refuse(socket, 403);
    // Kin speaks no subprotocol; extensions are declined by not echoing them.
    if (request.headers["sec-websocket-protocol"] !== undefined) return refuse(socket, 400);
    let auth;
    const sessionToken = this.readSession(request);
    try {
      this.store?.assertAvailable();
      auth = this.service.authorize(sessionToken);
    } catch (error) {
      if (!(error instanceof PairingError)) return refuse(socket, 503);
      return refuse(socket, ACCESS_CODES.get(error.code) === CLOSE.SESSION_ENDED ? 401 : 403);
    }
    const replacing = this.connections.get(auth.device.id);
    if (!replacing && this.sockets.size >= this.maxConnections) return refuse(socket, 503);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    replacing?.close(CLOSE.REPLACED, "Replaced by a newer connection");
    const temporaryEnd = Number.isFinite(auth.member.expiresAt) ? auth.member.expiresAt : Infinity;
    const connection = new LiveConnection(this, socket, {
      sessionToken, deviceId: auth.device.id, householdId: auth.household.id, memberId: auth.member.id,
      deadline: Math.min(auth.session.expiresAt ?? Infinity, temporaryEnd),
    });
    this.sockets.add(connection);
    this.connections.set(connection.deviceId, connection);
    let group = this.households.get(connection.householdId);
    if (!group) this.households.set(connection.householdId, (group = new Set()));
    group.add(connection);
    connection.send(LIVE_TYPE.HELLO);
    if (head?.length) connection.receive(head);
  }

  /** Drops a connection from the maps; with `socket`, its socket is gone too. */
  forget(connection, { socket = false } = {}) {
    if (this.connections.get(connection.deviceId) === connection) this.connections.delete(connection.deviceId);
    const group = this.households.get(connection.householdId);
    group?.delete(connection);
    if (group?.size === 0) this.households.delete(connection.householdId);
    if (socket) this.sockets.delete(connection);
  }

  /** Whether the connection's session still grants access; closes it if not. */
  stillAllowed(connection) {
    if (connection.closing || connection.disposed) return false;
    try {
      const auth = this.service.authorize(connection.sessionToken);
      if (auth.device.id === connection.deviceId && auth.household.id === connection.householdId) return true;
      connection.close(CLOSE.ACCESS_LOST, "Access changed");
    } catch (error) {
      if (!(error instanceof PairingError)) connection.close(CLOSE.SERVER_ERROR, "");
      else connection.close(this.lostAccess(connection) ? CLOSE.ACCESS_LOST : ACCESS_CODES.get(error.code) ?? CLOSE.ACCESS_LOST, "Access changed");
    }
    return false;
  }

  /** Whether the device itself lost access (revoked, member removed,
   * household being deleted), as opposed to only its session ending.
   * Revoking a device also ends its sessions, so this is asked first. */
  lostAccess(connection) {
    const device = this.service.devices.get(connection.deviceId);
    const member = device && this.service.members.get(device.memberId);
    const household = member && this.service.households.get(member.householdId);
    return !device || Boolean(device.revokedAt) || !member?.active ||
      ["deletion_pending", "deleted"].includes(household?.lifecycleState);
  }

  /** Re-checks every connection of a household (or all), closing those that
   * lost access. Called whenever access may have changed. */
  revalidate(householdId) {
    const targets = householdId ? [...(this.households.get(householdId) ?? [])] : [...this.connections.values()];
    for (const connection of targets) this.stillAllowed(connection);
  }

  /** New events were accepted: tell the household's other devices. */
  eventsAccepted(householdId, authorDeviceId, { chat = false } = {}) {
    for (const connection of this.households.get(householdId) ?? [])
      if (connection.deviceId !== authorDeviceId && (!chat || this.chatAllowed(connection))) connection.send(LIVE_TYPE.SYNC_HINT);
  }

  /** New events in a member's private stream (#491): tell that member's
   * other devices only, so no one else's device learns when they happen. */
  memberEventsAccepted(householdId, memberId, authorDeviceId) {
    for (const connection of this.households.get(householdId) ?? [])
      if (connection.memberId === memberId && connection.deviceId !== authorDeviceId) connection.send(LIVE_TYPE.SYNC_HINT);
  }

  /** A member's read-receipt slot changed: tell the household's other
   * chat-allowed devices to fetch the slots. */
  receiptsChanged(householdId, authorDeviceId) {
    for (const connection of this.households.get(householdId) ?? [])
      if (connection.deviceId !== authorDeviceId && this.chatAllowed(connection)) connection.send(LIVE_TYPE.RECEIPTS);
  }

  /** Closes every socket (service shutdown), without waiting long. */
  closeAll(code = CLOSE.GOING_AWAY) {
    for (const connection of [...this.sockets]) {
      if (connection.closing) connection.dispose();
      else connection.close(code, "Service stopping", { grace: SHUTDOWN_GRACE_MS });
    }
  }
}

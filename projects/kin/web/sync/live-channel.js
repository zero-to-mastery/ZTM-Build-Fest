// The live channel (#108): one WebSocket per unlocked device to /api/live,
// so new household events reach this device at once instead of on the next
// poll ([SYNC](../../docs/SYNC.md#live-channel-v11-107)).
//
// The socket only says "something is new". Events still move over the HTTP
// sync routes, which stay the source of truth: a hint (or a reconnect) makes
// the coordinator sync now, and while the socket is down the coordinator
// polls as before. The only thing a client sends on the socket is a sealed typing
// frame (#122), when the chat asks; the browser answers the
// service's pings itself.
//
// One tab per device holds the socket: a Web Lock named for the device
// decides which, and another tab takes over when that one closes or locks.
// The holder's syncs reach the other tabs through IndexedDB and the peer
// channel, as any sync does. Without Web Locks every tab connects and the
// service keeps the newest (close 4409), which this backs off from.
//
// Reconnecting waits a jittered, doubling delay from 1 s to 30 s, and
// tries at once when the browser comes back online. Losing access (4401 a
// session that ended, 4403 a revoked device, removed member or household
// being deleted) stops reconnecting: the coordinator's next HTTP sync
// meets the same refusal and shows the signed-out or deleted state.

export const LIVE_TYPE = Object.freeze({ HELLO: 1, SYNC_HINT: 2, TYPING: 3, RECEIPTS: 4, PRESENCE: 5, EPHEMERAL: 6 });
export const LIVE_CLOSE = Object.freeze({
  SESSION_ENDED: 4401,
  ACCESS_LOST: 4403,
  REPLACED: 4409,
  SLOW_CONSUMER: 4429,
});
// A close code the WebSocket API lets a client send (1000 or 3000-4999):
// "this isn't a Kin live channel".
export const CLOSE_NOT_KIN = 4000;
export const MIN_RECONNECT_MS = 1_000;
export const MAX_RECONNECT_MS = 30_000;
const RECORD_HEADER = 8;
// The service's message bound (256 KiB); anything larger is not Kin's.
const MAX_RECORD = 256 * 1024;

/**
 * Reads one Kin record from a binary message: { type, flags, payload }, or
 * null for anything malformed. `[u8 type][u8 flags][u16 0][u32 length]`.
 */
export function parseLiveRecord(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < RECORD_HEADER || data.byteLength > MAX_RECORD) return null;
  const view = new DataView(data);
  const length = view.getUint32(4, true);
  if (view.getUint16(2, true) !== 0 || RECORD_HEADER + length !== data.byteLength) return null;
  return { type: view.getUint8(0), flags: view.getUint8(1), payload: new Uint8Array(data, RECORD_HEADER) };
}

/** The live channel's URL for this page: same origin, ws: or wss:. */
export function liveUrl(location = globalThis.location) {
  const url = new URL("/api/live", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export class LiveChannel {
  /**
   * @param options.url        the /api/live URL
   * @param options.lockName   the Web Lock that makes one tab the holder
   * @param options.onHint     the service accepted new events: sync now
   * @param options.onUp       the socket opened (HELLO): sync now, poll less
   * @param options.onDown     the socket closed and will reconnect: poll again
   * @param options.onEnd      access was lost ({ code }); no reconnecting
   * @param options.onTyping   a sealed typing frame relayed by the service (#122)
   * @param options.onPresence a sealed online frame relayed by the service (#128)
   * @param options.onReceipts a member's read-receipt slot changed (#121)
   */
  constructor({
    url,
    lockName,
    onHint = () => {},
    onUp = () => {},
    onDown = () => {},
    onEnd = () => {},
    onTyping = () => {},
    onPresence = () => {},
    onReceipts = () => {},
    WebSocket: Socket = globalThis.WebSocket,
    locks = globalThis.navigator?.locks ?? null,
    events = globalThis,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (timer) => clearTimeout(timer),
    random = Math.random,
  }) {
    Object.assign(this, { url, lockName, onHint, onUp, onDown, onEnd, onTyping, onPresence, onReceipts, Socket, locks, events, setTimer, clearTimer, random });
    this.socket = null;
    this.timer = null;
    this.attempts = 0;
    this.up = false;
    this.stopped = true;
    this.ended = false;
    this.releaseLock = null;
    this.lockAbort = null;
    this.online = () => {
      if (this.stopped || this.ended || this.socket) return;
      // Back online: the failures while offline say nothing about now.
      this.attempts = 0;
      this.clearTimer(this.timer);
      this.timer = null;
      this.connect();
    };
    // A socket can stay "open" across a silent network drop until TCP gives
    // up; going offline closes it, so polling resumes and coming back online
    // reconnects at once.
    this.offline = () => {
      if (this.stopped || !this.socket) return;
      this.drop(this.socket);
    };
  }

  /** Abandons `socket` as though it had closed, then reconnects later. */
  drop(socket) {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(CLOSE_NOT_KIN, ""); } catch { /* already closing */ }
    if (this.socket !== socket) return;
    this.socket = null;
    const wasUp = this.up;
    this.up = false;
    if (wasUp) this.onDown();
    this.retry();
  }

  /** Sends one record (typing, #122). False when the socket isn't up, or
   * isn't draining: typing is worth sending now or not at all. */
  send(type, payload) {
    const socket = this.socket;
    if (!this.up || !socket || socket.readyState !== 1 || (socket.bufferedAmount ?? 0) > 16 * 1024) return false;
    if (!(payload instanceof Uint8Array) || payload.length > 2048) return false;
    const record = new Uint8Array(RECORD_HEADER + payload.length);
    const view = new DataView(record.buffer);
    view.setUint8(0, type);
    view.setUint32(4, payload.length, true);
    record.set(payload, RECORD_HEADER);
    try {
      socket.send(record);
      return true;
    } catch {
      return false;
    }
  }

  /** Starts holding the socket (once this tab holds the lock). */
  start() {
    if (!this.stopped || !this.Socket || !this.url) return;
    this.stopped = false;
    this.ended = false;
    this.events.addEventListener?.("online", this.online);
    this.events.addEventListener?.("offline", this.offline);
    if (!this.locks || !this.lockName) {
      this.connect();
      return;
    }
    // The lock is held until stop() resolves this promise. A tab waiting
    // for it connects when the holder lets go; stop() withdraws the wait.
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    this.lockAbort = abort;
    this.locks.request(this.lockName, abort ? { signal: abort.signal } : {}, () => new Promise((release) => {
      if (this.stopped || this.lockAbort !== abort) return release();
      this.releaseLock = release;
      this.connect();
    })).catch(() => {});
  }

  /** Closes the socket for good: lock, sign-out or disposal. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.events.removeEventListener?.("online", this.online);
    this.events.removeEventListener?.("offline", this.offline);
    this.lockAbort?.abort();
    this.lockAbort = null;
    this.clearTimer(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    this.up = false;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(1000, ""); } catch { /* already closing */ }
    }
    this.releaseLock?.();
    this.releaseLock = null;
  }

  connect() {
    if (this.stopped || this.ended || this.socket) return;
    let socket;
    try {
      socket = new this.Socket(this.url);
    } catch {
      this.retry();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const record = parseLiveRecord(event.data);
      // The service only sends well-formed records; anything else means
      // this isn't a Kin live channel, so give it up and poll.
      if (!record) {
        this.drop(socket);
        return;
      }
      if (record.type === LIVE_TYPE.HELLO) {
        this.attempts = 0;
        if (!this.up) {
          this.up = true;
          this.onUp();
        }
      } else if (record.type === LIVE_TYPE.SYNC_HINT && this.up) {
        this.onHint();
      } else if (record.type === LIVE_TYPE.TYPING && this.up) {
        this.onTyping(record.payload.slice());
      } else if (record.type === LIVE_TYPE.PRESENCE && this.up) {
        this.onPresence(record.payload.slice());
      } else if (record.type === LIVE_TYPE.RECEIPTS && this.up) {
        this.onReceipts();
      }
      // Record types this client doesn't know are ignored.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasUp = this.up;
      this.up = false;
      if (event.code === LIVE_CLOSE.SESSION_ENDED || event.code === LIVE_CLOSE.ACCESS_LOST) {
        this.ended = true;
        // An ended channel holds nothing: the lock goes to whoever is next.
        this.stop();
        this.onEnd({ code: event.code });
        return;
      }
      if (wasUp) this.onDown();
      // Another socket for this device took over: wait the longest.
      if (event.code === LIVE_CLOSE.REPLACED) this.attempts = Math.max(this.attempts, 5);
      this.retry();
    };
    // Every error is followed by a close event, which decides what's next.
    socket.onerror = () => {};
  }

  /** Waits a jittered, doubling delay (1-2 s at first, at most 30 s),
   * then reconnects. */
  retry() {
    if (this.stopped || this.ended || this.timer !== null) return;
    const base = MIN_RECONNECT_MS * 2 ** Math.min(this.attempts, 5);
    this.attempts += 1;
    // Between the base and twice it, so devices that lost the service
    // together (a restart) don't all come back in the same instant.
    const delay = Math.min(MAX_RECONNECT_MS, Math.round(base * (1 + this.random())));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}

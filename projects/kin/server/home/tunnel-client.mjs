// The home server's side of the KTUN v1 tunnel (ADR 0025 §2, story #733).
//
//   phone ──TLS──▶ connection relay ══KTUN over TLS 1.3══▶ TunnelClient
//                                                             │ one Duplex per OPEN
//                                                             ▼
//                                              home TLS (home-server.mjs) ──▶ Kin HTTP
//
// A TunnelClient keeps one authenticated tunnel open to the configured
// relay: TLS 1.3 to the relay's own name with ALPN kin-tunnel/1, the
// preface, HELLO, then AUTH, an Ed25519 signature with the home key over
// "kin-tunnel-auth/1" 0 relayName 0 nonce exporter, where the exporter is
// 32 bytes of this TLS session's keying material (label
// EXPORTER-kin-tunnel-auth), so the signature is good for this connection
// only. Every OPEN becomes a TunnelStream (a Duplex) with KTUN credit flow
// control both ways; the caller ends TLS on it. The byte formats are the
// shared codec's (relay/ktun.mjs); nothing here re-encodes a frame.
//
// Resilience (#735): after a lost tunnel it waits a random time between 0
// and the current backoff (1 s doubling to 5 min, full jitter), and the
// backoff resets once a tunnel has stayed up 60 s. It reconnects at once on
// a network change (polled from os.networkInterfaces, since Node has no
// change event) and when the clock jumps by more than two ping intervals
// (the computer slept). A newer tunnel for the same key replaces an older
// one at the relay, so a reconnect never waits for a half-dead tunnel to
// time out. PING after `pingSeconds` of silence; dead after `idleSeconds`.
//
// Flow control: towards the relay, a stream sends only what both its window
// and the tunnel's allow, and its writable side calls back only when the
// bytes are on the tunnel socket (and that socket isn't over its buffer), so
// a slow phone back-pressures the home TLS socket and from there Kin's HTTP
// response. From the relay, credit is granted back only for bytes the TLS
// socket has read: a stream holds at most one window, plus the Readable's
// own small buffer.
//
// The client never logs an address or a byte of a stream.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import {
  ALPN, Code, ControlOp, DEFAULT_HELLO, EXPORTER_LABEL, EXPORTER_LENGTH, FLAG_ACK, FLAG_FIN, FrameReader, FrameType,
  KtunError, MAX_PAYLOAD, ReceiveWindow, SendWindow, authMessage, decodeControl, decodeGoaway, decodeHello,
  decodeNameList, decodeOpen, decodeReset, decodeWindow, encodeAuth, encodeControl, encodeControlBody, encodeData,
  encodeGoaway, encodePing, encodePreface, encodeReset, encodeWindow, rawEd25519PublicKey, signEd25519,
} from "../../relay/ktun.mjs";

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const BACKOFF_RESET_MS = 60_000;
/** TLS, the preface, HELLO, AUTH and READY must finish within this long. */
export const SIGN_IN_TIMEOUT_MS = 15_000;
export const CONTROL_TIMEOUT_MS = 30_000;
export const NETWORK_CHECK_MS = 5_000;
const TICK_MS = 1_000;

/** What `status().lastError.code` can be (no address, no detail). */
export const TUNNEL_ERRORS = Object.freeze([
  "relay-unreachable", "relay-certificate", "relay-tls", "sign-in-timeout", "auth-failed", "replaced", "limit",
  "suspended", "relay-overloaded", "relay-shutting-down", "protocol-error", "tunnel-dead", "connection-lost",
  "name-taken", "name-not-allowed", "name-limit", "name-unknown", "name-failed",
]);

/** GOAWAY codes the relay may send, as status error codes. */
const GOAWAY_ERRORS = {
  [Code.PROTOCOL_ERROR]: "protocol-error",
  [Code.AUTH_FAILED]: "auth-failed",
  [Code.REPLACED]: "replaced",
  [Code.LIMIT]: "limit",
  [Code.SUSPENDED]: "suspended",
  [Code.OVERLOADED]: "relay-overloaded",
  [Code.SHUTTING_DOWN]: "relay-shutting-down",
};
/** CONTROL answers about the name, as status error codes. */
const NAME_ERRORS = {
  [Code.NAME_TAKEN]: "name-taken",
  [Code.NAME_NOT_ALLOWED]: "name-not-allowed",
  [Code.LIMIT]: "name-limit",
  [Code.UNKNOWN_NAME]: "name-unknown",
  [Code.SUSPENDED]: "suspended",
};
/** CHECK answers (#719). PROTOCOL_ERROR is an older relay without CHECK. */
const CHECK_ANSWERS = {
  [Code.NONE]: "available",
  [Code.NAME_TAKEN]: "taken",
  [Code.NAME_NOT_ALLOWED]: "not-allowed",
  [Code.LIMIT]: "limit",
  [Code.UNKNOWN_NAME]: "not-proven",
  [Code.SUSPENDED]: "taken",
  [Code.PROTOCOL_ERROR]: "unknown",
};
/** Errors after which reconnecting soon can't help: wait the longest backoff.
 * "replaced" means another home server holds this key (a restored backup
 * running elsewhere); the two would otherwise take the tunnel from each other
 * every second. */
const SLOW_RETRY = new Set(["replaced", "suspended", "auth-failed"]);

const CERTIFICATE_ERRORS = /^(?:CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)|ERR_TLS_CERT_ALTNAME)/;
function connectErrorCode(error) {
  const code = String(error?.code ?? "");
  if (CERTIFICATE_ERRORS.test(code)) return "relay-certificate";
  if (code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS") || code === "EPROTO") return "relay-tls";
  return "relay-unreachable";
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** A string that changes when the computer's non-loopback addresses do. */
export function networkFingerprint(interfaces = networkInterfaces()) {
  const addresses = [];
  for (const [name, entries] of Object.entries(interfaces ?? {}))
    for (const entry of entries ?? []) if (!entry.internal) addresses.push(`${name} ${entry.address}`);
  return addresses.sort().join("\n");
}

// ------------------------------------------------------------------ streams

/**
 * One phone connection inside the tunnel. Readable: the phone's bytes (the
 * TLS records the relay forwards). Writable: the home server's bytes back.
 * `open` is { name, address, family } from the OPEN frame.
 */
export class TunnelStream extends Duplex {
  constructor(tunnel, id, open) {
    super({ allowHalfOpen: true });
    this.tunnel = tunnel;
    this.id = id;
    this.open = open;
    this.send = new SendWindow(tunnel.hello.streamWindow);
    this.recv = new ReceiveWindow(tunnel.hello.streamWindow);
    this.incoming = [];
    this.incomingBytes = 0;
    this.wantsData = false;
    this.finReceived = false;
    this.endPushed = false;
    this.outgoing = [];
    this.outgoingBytes = 0;
    this.finQueued = null;
    this.finSent = false;
    this.resetReceived = false;
  }

  /** Bytes sent to the relay that it hasn't granted back yet. */
  get unacknowledged() { return this.tunnel.hello.streamWindow - this.send.available; }

  _read() {
    this.wantsData = true;
    this.#deliver();
  }

  /** DATA from the relay. The payload is a view into a chunk the socket
   * handed over and never reuses, so it is kept without a copy. */
  receive(payload, fin) {
    if (this.finReceived) throw new KtunError("DATA after FIN");
    this.recv.receive(payload.length);
    if (payload.length) { this.incoming.push(payload); this.incomingBytes += payload.length; }
    if (fin) this.finReceived = true;
    this.#deliver();
  }

  #deliver() {
    let passed = 0;
    while (this.wantsData && this.incoming.length) {
      const bytes = this.incoming.shift();
      this.incomingBytes -= bytes.length;
      passed += bytes.length;
      this.wantsData = this.push(bytes);
    }
    if (this.finReceived && this.incoming.length === 0 && !this.endPushed) { this.endPushed = true; this.push(null); }
    if (passed) this.tunnel.passed(this, passed);
    this.tunnel.maybeFinished(this);
  }

  _write(chunk, _encoding, callback) {
    this.outgoing.push([chunk, callback]);
    this.outgoingBytes += chunk.length;
    this.tunnel.flush(this);
  }

  _final(callback) {
    this.finQueued = callback;
    this.tunnel.flush(this);
  }

  _destroy(error, callback) {
    this.tunnel.dropped(this);
    for (const [, pending] of this.outgoing.splice(0)) pending(error ?? new Error("tunnel stream closed"));
    this.outgoingBytes = 0;
    if (this.finQueued) { const done = this.finQueued; this.finQueued = null; done(error ?? new Error("tunnel stream closed")); }
    callback(error);
  }
}

// ------------------------------------------------------------------- tunnel

/** One TLS connection to the relay and its streams. The TunnelClient owns
 * reconnecting; a Tunnel lives from dial to close and never reopens. */
class Tunnel {
  constructor(client) {
    this.client = client;
    this.state = "connecting";
    this.reader = new FrameReader("relay");
    this.hello = { ...DEFAULT_HELLO };
    this.streams = new Map();
    this.lastStream = 0;
    this.blocked = new Set();
    this.drainWaiters = [];
    this.controls = new Map();
    this.nextRequest = 1;
    this.names = [];
    this.draining = false;
    this.closed = false;
    this.readyAt = null;
    this.lastReceived = client.now();
    this.lastPing = 0;
    this.error = null;
  }

  dial() {
    const { relay, connectHost, ca } = this.client.options;
    const socket = tlsConnect({
      host: connectHost ?? relay.host, port: relay.port, servername: relay.host, ALPNProtocols: [ALPN],
      minVersion: "TLSv1.3", ...(ca ? { ca } : {}),
    });
    this.socket = socket;
    this.signInTimer = setTimeout(() => this.fail("sign-in-timeout"), this.client.options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS);
    this.signInTimer.unref?.();
    socket.on("error", (error) => { this.error ??= this.state === "connecting" ? connectErrorCode(error) : "connection-lost"; });
    socket.on("close", () => this.#closed());
    socket.on("drain", () => {
      for (const waiter of this.drainWaiters.splice(0)) waiter();
      for (const stream of [...this.blocked]) this.flush(stream);
    });
    socket.once("secureConnect", () => {
      if (socket.alpnProtocol !== ALPN || socket.getProtocol() !== "TLSv1.3") { this.fail("relay-tls"); return; }
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      this.state = "hello";
      this.lastReceived = this.client.now();
      socket.on("data", (chunk) => this.#onData(chunk));
      socket.write(encodePreface());
    });
  }

  write(bytes) { if (!this.closed && !this.socket.destroyed) this.socket.write(bytes); }

  /** Closes the tunnel for `code` (a status error code). A protocol error is
   * reported to the relay with GOAWAY 1 first (§2). */
  fail(code, goaway = code === "protocol-error" ? Code.PROTOCOL_ERROR : null) {
    if (this.closed) return;
    this.error ??= code;
    if (goaway !== null) this.write(encodeGoaway(this.lastStream, goaway));
    this.socket.end();
    this.socket.destroySoon?.();
    const timer = setTimeout(() => this.socket.destroy(), 2000);
    timer.unref?.();
    this.#closed();
  }

  /** Tells the relay this side is stopping, then closes. */
  goaway(code) {
    if (this.closed) return;
    // Before the preface there is no KTUN session to say goodbye in.
    if (this.state !== "connecting") this.write(encodeGoaway(this.lastStream, code));
    this.fail(null, null);
  }

  #closed() {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";
    clearTimeout(this.signInTimer);
    clearInterval(this.keepAlive);
    for (const stream of this.streams.values()) { stream.resetReceived = true; stream.destroy(new Error("tunnel closed")); }
    this.streams.clear();
    for (const { reject, timer } of this.controls.values()) { clearTimeout(timer); reject(Object.assign(new Error("the tunnel closed"), { code: "tunnel-lost" })); }
    this.controls.clear();
    for (const waiter of this.drainWaiters.splice(0)) waiter();
    if (!this.socket.destroyed) this.socket.destroy();
    this.client.tunnelClosed(this);
  }

  #onData(chunk) {
    if (this.closed) return;
    this.lastReceived = this.client.now();
    try {
      for (const frame of this.reader.push(chunk)) {
        if (this.closed) return;
        this.#frame(frame);
      }
    } catch (error) {
      if (!(error instanceof KtunError)) throw error;
      this.fail("protocol-error");
    }
  }

  #frame({ type, flags, stream, payload }) {
    if (this.state === "hello") {
      if (type === FrameType.HELLO && !this.hello.nonce) { this.#signIn(payload); return; }
      if (type === FrameType.READY && this.hello.nonce) { this.#ready(decodeNameList(payload)); return; }
      if (type === FrameType.GOAWAY) { this.#goaway(decodeGoaway(payload)); return; }
      if (type === FrameType.PING) { this.#ping(flags, payload); return; }
      throw new KtunError(`frame ${type} before READY`);
    }
    switch (type) {
      case FrameType.READY: this.#names(decodeNameList(payload)); break;
      case FrameType.OPEN: this.#open(stream, decodeOpen(payload)); break;
      case FrameType.DATA: this.#data(stream, flags, payload); break;
      case FrameType.WINDOW: this.#window(stream, decodeWindow(payload)); break;
      case FrameType.RESET: this.#reset(stream, decodeReset(payload)); break;
      case FrameType.PING: this.#ping(flags, payload); break;
      case FrameType.GOAWAY: this.#goaway(decodeGoaway(payload)); break;
      case FrameType.CONTROL: this.#controlAnswer(decodeControl(payload)); break;
      default: throw new KtunError(`unexpected frame ${type}`);
    }
  }

  #signIn(payload) {
    this.hello = decodeHello(payload);
    // Keep-alive is checked at a quarter of the ping interval (at most every
    // second), as the relay does. A coarser check could skip the whole window
    // between pingSeconds and idleSeconds (they may be one second apart) and
    // give up without ever having pinged.
    const pingMs = this.hello.pingSeconds * 1000;
    this.keepAlive = setInterval(() => this.tick(this.client.now()), Math.min(1000, pingMs / 4));
    this.keepAlive.unref?.();
    this.connSend = new SendWindow(this.hello.connectionWindow);
    this.connRecv = new ReceiveWindow(this.hello.connectionWindow);
    const exporter = this.socket.exportKeyingMaterial(EXPORTER_LENGTH, EXPORTER_LABEL);
    const { privateKey, relay, softwareVersion } = this.client.options;
    const signature = signEd25519(privateKey, authMessage(relay.host, this.hello.nonce, exporter));
    this.write(encodeAuth({ publicKey: this.client.publicKey, signature, softwareVersion }));
  }

  #ready(names) {
    clearTimeout(this.signInTimer);
    this.state = "ready";
    this.readyAt = this.client.now();
    this.names = names;
    this.client.tunnelReady(this);
  }

  #names(names) {
    this.names = names;
    this.client.namesChanged(this);
  }

  #ping(flags, payload) {
    if (!(flags & FLAG_ACK)) this.write(encodePing(payload, true));
  }

  #goaway({ code }) {
    if (code === Code.NONE) {
      // The relay is draining this tunnel (its stream numbers are running
      // out, §2): open a fresh one now; this one ends with its last stream.
      this.draining = true;
      this.client.tunnelDraining(this);
      if (this.streams.size === 0) this.fail(null, null);
      return;
    }
    this.fail(GOAWAY_ERRORS[code] ?? "protocol-error", null);
  }

  // ---------------------------------------------------------------- streams

  #open(id, open) {
    if (id !== this.lastStream + 1) throw new KtunError("OPEN out of order");
    this.lastStream = id;
    if (this.draining || this.streams.size >= this.hello.maxStreams) { this.write(encodeReset(id, Code.LIMIT)); return; }
    const stream = new TunnelStream(this, id, open);
    stream.on("error", () => {});
    this.streams.set(id, stream);
    this.client.streamOpened(stream);
  }

  #data(id, flags, payload) {
    this.connRecv.receive(payload.length);
    const stream = this.streams.get(id);
    if (!stream) {
      // A stream this side already dropped: its bytes still spent the
      // tunnel's credit, which goes straight back.
      if (id > this.lastStream) throw new KtunError("DATA on a stream never opened");
      if (payload.length) { this.connRecv.passed(payload.length); this.#grantTunnel(); }
      return;
    }
    stream.receive(payload, (flags & FLAG_FIN) !== 0);
  }

  /** The TLS socket has read `bytes` of `stream`'s data: credit goes back. */
  passed(stream, bytes) {
    stream.recv.passed(bytes);
    this.connRecv.passed(bytes);
    const increment = stream.recv.takeGrant();
    if (increment && !stream.finReceived && this.streams.has(stream.id)) this.write(encodeWindow(stream.id, increment));
    this.#grantTunnel();
  }

  #grantTunnel(force = false) {
    const increment = this.connRecv.takeGrant(force);
    if (increment) this.write(encodeWindow(0, increment));
  }

  #window(id, increment) {
    if (id === 0) {
      this.connSend.grant(increment);
      for (const stream of [...this.blocked]) this.flush(stream);
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) { if (id > this.lastStream) throw new KtunError("WINDOW for a stream never opened"); return; }
    stream.send.grant(increment);
    this.flush(stream);
  }

  #reset(id) {
    const stream = this.streams.get(id);
    if (!stream) { if (id > this.lastStream) throw new KtunError("RESET for a stream never opened"); return; }
    stream.resetReceived = true;
    stream.destroy();
  }

  /** Home → phone: as much of `stream`'s queue as both windows allow. Each
   * write's callback runs once its bytes are on the tunnel socket and the
   * socket isn't over its buffer. */
  flush(stream) {
    if (this.closed || stream.destroyed || !this.streams.has(stream.id)) return;
    while (stream.outgoing.length) {
      const entry = stream.outgoing[0];
      const [bytes, callback] = entry;
      const size = Math.min(bytes.length, MAX_PAYLOAD, stream.send.available, this.connSend.available);
      if (size === 0) { this.blocked.add(stream); return; }
      stream.send.spend(size);
      this.connSend.spend(size);
      this.write(encodeData(stream.id, bytes.subarray(0, size)));
      stream.outgoingBytes -= size;
      if (size < bytes.length) { entry[0] = bytes.subarray(size); continue; }
      stream.outgoing.shift();
      if (this.socket.writableNeedDrain) this.drainWaiters.push(() => callback());
      else callback();
    }
    this.blocked.delete(stream);
    if (stream.finQueued && !stream.finSent) {
      stream.finSent = true;
      this.write(encodeData(stream.id, Buffer.alloc(0), true));
      const done = stream.finQueued;
      stream.finQueued = null;
      done();
      this.maybeFinished(stream);
    }
  }

  /** A stream both sides have ended leaves without a RESET. */
  maybeFinished(stream) {
    if (stream.finSent && stream.finReceived && stream.endPushed && this.streams.get(stream.id) === stream) {
      this.streams.delete(stream.id);
      this.blocked.delete(stream);
      this.#afterStream();
    }
  }

  /** A stream destroyed on this side: the tunnel's credit for bytes nobody
   * will read goes back, and RESET unless this side already sent FIN. After
   * FIN the relay still has our last bytes to write to the phone, and a
   * RESET would make it drop them; it ends the stream itself when the phone
   * closes, and any DATA that arrives meanwhile only returns credit. */
  dropped(stream) {
    const held = stream.incomingBytes;
    stream.incoming = [];
    stream.incomingBytes = 0;
    if (this.streams.get(stream.id) === stream) {
      this.streams.delete(stream.id);
      this.blocked.delete(stream);
      if (!stream.resetReceived && !stream.finSent) this.write(encodeReset(stream.id, Code.NONE));
      if (held && !this.closed) { this.connRecv.passed(held); this.#grantTunnel(true); }
      this.#afterStream();
    }
  }

  #afterStream() {
    if (this.draining && this.streams.size === 0) this.fail(null, null);
  }

  // ---------------------------------------------------------------- control

  /** Sends a CONTROL request; resolves with { status, names }. */
  control(op, fields) {
    if (this.state !== "ready" || this.closed) return Promise.reject(Object.assign(new Error("the tunnel is not connected"), { code: "tunnel-not-ready" }));
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(requestId); reject(Object.assign(new Error("the relay didn't answer"), { code: "tunnel-timeout" })); }, CONTROL_TIMEOUT_MS);
      timer.unref?.();
      this.controls.set(requestId, { op, resolve, reject, timer });
      this.write(encodeControl({ requestId, op, body: encodeControlBody(op, fields) }));
    });
  }

  #controlAnswer({ requestId, op, status, body }) {
    const pending = this.controls.get(requestId);
    if (!pending || pending.op !== op) throw new KtunError("a CONTROL answer for no request");
    this.controls.delete(requestId);
    clearTimeout(pending.timer);
    const names = status === Code.NONE ? decodeNameList(body) : null;
    if (names) this.#names(names);
    pending.resolve({ status, names });
  }

  /** Keep-alive (§2): PING after pingSeconds of silence; dead after
   * idleSeconds. Runs from the tunnel's own timer once HELLO has set them. */
  tick(now) {
    if (this.closed || !this.keepAlive) return;
    const silent = now - this.lastReceived;
    if (silent >= this.hello.idleSeconds * 1000) { this.fail("tunnel-dead"); return; }
    const pingMs = this.hello.pingSeconds * 1000;
    if (silent >= pingMs && now - this.lastPing >= pingMs) {
      this.lastPing = now;
      this.write(encodePing(randomBytes(8)));
    }
  }
}

// ------------------------------------------------------------------- client

export class TunnelClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {{ host: string, port: number }} options.relay  the relay's own name and port
   * @param {string|null} options.name      this home server's name; null signs in only
   *   (the setup page's availability check, #719: nothing is claimed)
   * @param {boolean} options.freeName      true: CLAIM it; false: ADD_DOMAIN (own domain)
   * @param {import("node:crypto").KeyObject} options.privateKey  the home key (Ed25519)
   * @param {number} [options.softwareVersion]
   * @param {string} [options.connectHost]  dial this address instead of resolving relay.host (tests)
   * @param {string|Buffer} [options.ca]    trust this CA for the relay instead of the system's (tests, private relays)
   * @param {{ minMs?: number, maxMs?: number, resetMs?: number }} [options.backoff]
   * @param {() => number} [options.now]
   * @param {() => number} [options.random]
   * @param {() => object} [options.interfaces]  os.networkInterfaces stand-in
   * @param {number} [options.networkCheckMs]
   * @param {number} [options.signInTimeoutMs]
   * @param {(event: object) => void} [options.log]
   *
   * Events: "stream" (TunnelStream), "status" (status()), "routed" (names).
   */
  constructor(options) {
    super();
    this.options = { softwareVersion: 0, ...options };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.backoffMin = options.backoff?.minMs ?? BACKOFF_MIN_MS;
    this.backoffMax = options.backoff?.maxMs ?? BACKOFF_MAX_MS;
    this.backoffReset = options.backoff?.resetMs ?? BACKOFF_RESET_MS;
    this.publicKey = rawEd25519PublicKey(options.privateKey);
    this.backoff = this.backoffMin;
    this.current = null;
    this.pending = null;
    this.retryTimer = null;
    this.nextAttemptAt = null;
    this.running = false;
    this.lastError = null;
    this.since = this.now();
    this.nameWanted = true;
    this.nameError = null;
    this.routedWaiters = [];
    this.connects = 0;
  }

  /** Starts dialling and the keep-alive, sleep and network watches. */
  start() {
    if (this.running) return this;
    this.running = true;
    this.lastTick = this.now();
    this.ticker = setInterval(() => this.#tick(), TICK_MS);
    this.ticker.unref?.();
    const interfaces = this.options.interfaces ?? networkInterfaces;
    this.networkSeen = networkFingerprint(interfaces());
    this.networkTimer = setInterval(() => {
      const seen = networkFingerprint(interfaces());
      if (seen !== this.networkSeen) { this.networkSeen = seen; this.reconnectNow("network-change"); }
    }, this.options.networkCheckMs ?? NETWORK_CHECK_MS);
    this.networkTimer.unref?.();
    this.#dial();
    return this;
  }

  /** Closes the tunnel with GOAWAY 8 (shutting down) and stops reconnecting. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.ticker);
    clearInterval(this.networkTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextAttemptAt = null;
    const tunnels = [this.current, this.pending, ...(this.retired ?? [])].filter(Boolean);
    const closing = tunnels.map((tunnel) => new Promise((resolve) => {
      if (tunnel.socket.destroyed) { resolve(); return; }
      tunnel.socket.once("close", resolve);
    }));
    for (const tunnel of tunnels) tunnel.goaway(Code.SHUTTING_DOWN);
    for (const waiter of this.routedWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error("the tunnel stopped"), { code: "tunnel-stopped" }));
    }
    await Promise.race([Promise.all(closing), new Promise((resolve) => { const timer = setTimeout(resolve, 3000); timer.unref?.(); })]);
    this.#changed();
  }

  /** Dials a new tunnel now, without waiting for the backoff: the network
   * changed or the computer woke. An open tunnel keeps serving until the new
   * one is ready; the relay then replaces it. */
  reconnectNow(reason = "requested") {
    if (!this.running || this.pending) return;
    this.#log({ event: "home_tunnel_reconnect", reason });
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextAttemptAt = null;
    this.#dial();
  }

  #dial() {
    this.connects += 1;
    const tunnel = new Tunnel(this);
    this.pending = tunnel;
    this.#changed();
    tunnel.dial();
  }

  #schedule(error) {
    if (!this.running || this.retryTimer || this.pending) return;
    const ceiling = SLOW_RETRY.has(error) ? this.backoffMax : this.backoff;
    const delay = Math.floor(this.random() * ceiling);
    this.backoff = Math.min(this.backoff * 2, this.backoffMax);
    this.nextAttemptAt = this.now() + delay;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.nextAttemptAt = null; if (this.running) this.#dial(); }, delay);
    this.retryTimer.unref?.();
  }

  #tick() {
    const now = this.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    const pingMs = (this.current?.hello.pingSeconds ?? DEFAULT_HELLO.pingSeconds) * 1000;
    // Timers don't run while the computer sleeps; the clock does. A jump of
    // more than two ping intervals means every NAT entry is likely gone.
    if (gap > 2 * pingMs + TICK_MS) this.reconnectNow("wake");
  }

  // ------------------------------------------------------- tunnel callbacks

  tunnelReady(tunnel) {
    if (this.pending === tunnel) this.pending = null;
    const older = this.current;
    this.current = tunnel;
    // The relay replaces the older tunnel for this key with GOAWAY 3; keep it
    // only until then, so its streams can finish if the relay lets them.
    if (older && !older.closed) (this.retired ??= new Set()).add(older);
    this.lastError = null;
    this.since = this.now();
    this.nameError = null;
    this.#log({ event: "home_tunnel_connected", names: tunnel.names.length });
    this.#changed();
    this.namesChanged(tunnel);
    if (this.options.name && !this.#routed(tunnel)) this.#ensureName(tunnel);
  }

  namesChanged(tunnel) {
    if (tunnel !== this.current) return;
    if (this.#routed(tunnel)) {
      for (const waiter of this.routedWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(tunnel.names); }
      this.emit("routed", tunnel.names);
    }
    this.#changed();
  }

  tunnelDraining(tunnel) {
    if (tunnel === this.current) {
      this.current = null;
      (this.retired ??= new Set()).add(tunnel);
      this.backoff = this.backoffMin;
      this.reconnectNow("relay-draining");
    }
  }

  tunnelClosed(tunnel) {
    this.retired?.delete(tunnel);
    const wasCurrent = tunnel === this.current;
    const wasPending = tunnel === this.pending;
    if (!wasCurrent && !wasPending) return; // an older tunnel, replaced or drained
    if (wasCurrent) this.current = null;
    if (wasPending) this.pending = null;
    if (!this.running) { this.#changed(); return; }
    // A tunnel that stayed up long enough resets the backoff (§2).
    if (wasCurrent && tunnel.readyAt !== null && this.now() - tunnel.readyAt >= this.backoffReset) this.backoff = this.backoffMin;
    const code = tunnel.error ?? "connection-lost";
    if (wasCurrent || !this.current) {
      this.lastError = { code, at: iso(this.now()) };
      this.since = this.now();
      this.#log({ event: "home_tunnel_lost", code });
    }
    if (!this.current) this.#schedule(code);
    this.#changed();
  }

  streamOpened(stream) {
    if (!this.listenerCount("stream")) { stream.destroy(); return; }
    this.emit("stream", stream);
  }

  // --------------------------------------------------------------- the name

  #routed(tunnel) { return this.options.name !== null && this.options.name !== undefined && tunnel.names.includes(this.options.name); }

  /** CLAIM a free name, or ADD_DOMAIN an own domain, once per tunnel (§3). */
  async #ensureName(tunnel) {
    const { name, freeName } = this.options;
    try {
      const { status } = await tunnel.control(freeName ? ControlOp.CLAIM : ControlOp.ADD_DOMAIN, { name });
      if (status !== Code.NONE) {
        this.nameError = { code: NAME_ERRORS[status] ?? "name-failed", at: iso(this.now()) };
        this.#log({ event: "home_tunnel_name_refused", code: this.nameError.code });
        this.#changed();
      }
    } catch (error) {
      if (tunnel === this.current) { this.nameError = { code: error.code ?? "name-failed", at: iso(this.now()) }; this.#changed(); }
    }
  }

  /** Resolves with the routed names once the relay routes this server's
   * name to the current tunnel. */
  whenRouted(timeoutMs = 120_000) {
    if (this.current && this.#routed(this.current)) return Promise.resolve(this.current.names);
    if (!this.running) return Promise.reject(Object.assign(new Error("the tunnel is not running"), { code: "tunnel-stopped" }));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.routedWaiters.indexOf(waiter);
        if (index >= 0) this.routedWaiters.splice(index, 1);
        reject(Object.assign(new Error("the relay hasn't routed this server's name"), { code: "tunnel-not-ready" }));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.routedWaiters.push(waiter);
    });
  }

  /** CONTROL op 3 SET_CAA (§5): the relay's DNS names this ACME account in
   * the free name's CAA record. Must succeed before an order. An own domain
   * keeps CAA in the household's own DNS, so there is nothing to send. */
  async setCaa(accountUri, { timeoutMs } = {}) {
    if (!this.options.freeName) return;
    await this.whenRouted(timeoutMs);
    const { status } = await this.current.control(ControlOp.SET_CAA, { name: this.options.name, accountUri });
    if (status !== Code.NONE)
      throw Object.assign(new Error(`the relay refused the CAA record (code ${status})`), { code: `tunnel-caa-${NAME_ERRORS[status] ?? "refused"}` });
    this.#log({ event: "home_tunnel_caa_set" });
  }

  /**
   * CONTROL op 7 CHECK (#719): could this key have `name`? Resolves with
   * "available", "taken", "not-allowed", "limit" (this key already holds a
   * free name, or too many checks), "not-proven" (an own domain whose
   * `_kin-relay` TXT record the relay can't see naming this key yet) or
   * "unknown" (a relay that predates CHECK: the claim will tell). Waits up
   * to `timeoutMs` for a signed-in tunnel.
   */
  async check(name, { timeoutMs = 15_000 } = {}) {
    const deadline = this.now() + timeoutMs;
    while (!this.current || this.current.closed || this.current.state !== "ready") {
      if (!this.running) throw Object.assign(new Error("the tunnel is not running"), { code: "tunnel-stopped" });
      // The tunnel's own error (relay-unreachable, relay-certificate …)
      // says more than "not ready" when there is one.
      if (this.now() >= deadline) throw Object.assign(new Error("the relay didn't answer"), { code: this.lastError?.code ?? "tunnel-not-ready" });
      await new Promise((resolve) => { const timer = setTimeout(resolve, 50); timer.unref?.(); });
    }
    const { status } = await this.current.control(ControlOp.CHECK, { name });
    return CHECK_ANSWERS[status] ?? "unknown";
  }

  /** What the control panel (#718) shows. No address, no key, no secret. */
  status() {
    const tunnel = this.current;
    const connected = Boolean(tunnel && !tunnel.closed);
    let state = "stopped";
    if (this.running) state = connected ? "connected" : this.pending ? "connecting" : "waiting";
    return {
      state,
      connected,
      relay: `${this.options.relay.host}${this.options.relay.port === 443 ? "" : `:${this.options.relay.port}`}`,
      name: this.options.name,
      names: connected ? [...tunnel.names] : [],
      routed: connected && this.#routed(tunnel),
      nameError: this.nameError,
      lastError: this.lastError,
      since: iso(this.since),
      nextAttemptAt: iso(this.nextAttemptAt),
      streams: connected ? tunnel.streams.size : 0,
    };
  }

  #changed() { this.emit("status", this.status()); }
  #log(event) { this.options.log?.(event); }
}

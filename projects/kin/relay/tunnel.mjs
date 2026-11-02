// One home server's tunnel, on the relay's side (ADR 0025 §2, #730): the
// preface, HELLO, the signed AUTH bound to this TLS session, READY, and then
// one stream per phone connection with credit-based flow control and
// keep-alive. The relay (relay/relay.mjs) owns routing, limits and the
// registry; this file owns the bytes of one tunnel.
//
// Flow control (§2): every DATA payload spends credit in its stream's window
// and the tunnel's. Towards the home server, when a stream's credit runs out
// the phone's socket is paused, so TCP pushes back on the phone, and at most
// one socket read (≤ 64 KiB, under one window) waits here. From the home
// server, credit is granted back only once the phone's socket has taken the
// bytes (and the name's bandwidth allows), so a slow phone slows its own
// stream and nothing piles up in the relay.
import { randomBytes } from "node:crypto";
import {
  Code, ControlOp, EXPORTER_LABEL, EXPORTER_LENGTH, FLAG_ACK, FLAG_FIN, FrameReader, FrameType, KtunError, MAX_PAYLOAD,
  PREFACE_LENGTH, ReceiveWindow, SendWindow, STREAM_LIMIT, authMessage, decodeAuth, decodeControl, decodePreface,
  decodeReset, decodeWindow, encodeControl, encodeData, encodeGoaway, encodeHello, encodeNameList, encodeOpen,
  encodePing, encodeReady, encodeReset, encodeWindow, keyHash, verifyEd25519,
} from "./ktun.mjs";

/** The preface and AUTH must arrive within this long of the TLS handshake. */
export const SIGN_IN_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} TunnelHost   what the relay gives each tunnel
 * @property {string} relayName
 * @property {object} hello        HELLO parameters (ktun DEFAULT_HELLO shape)
 * @property {number} [streamLimit] the stream number after which the relay sends GOAWAY
 * @property {(tunnel: RelayTunnel) => boolean} allowSignIn
 * @property {(tunnel: RelayTunnel) => number} signedIn   Code.NONE, or the GOAWAY code to refuse with
 * @property {(tunnel: RelayTunnel, request: object) => Promise<number>} control
 * @property {(tunnel: RelayTunnel) => void} closed
 * @property {(code: string) => void} error
 * @property {(name: string, direction: "up"|"down", bytes: number) => number} bandwidth  ms to wait
 * @property {(name: string, field: string, bytes: number) => void} count
 */

export class RelayTunnel {
  /** @param {import("node:tls").TLSSocket} socket @param {TunnelHost} host */
  constructor(socket, host) {
    this.socket = socket;
    this.host = host;
    this.address = normalizeAddress(socket.remoteAddress);
    this.state = "preface";
    this.reader = new FrameReader("home");
    this.preface = Buffer.alloc(0);
    this.nonce = randomBytes(32);
    this.publicKey = null;
    this.keyHash = null;
    this.names = [];
    this.streams = new Map();
    this.nextStream = 1;
    this.draining = false;
    this.connSend = new SendWindow(host.hello.connectionWindow);
    this.connRecv = new ReceiveWindow(host.hello.connectionWindow);
    this.blocked = new Set();
    this.controlInFlight = 0;
    this.lastReceived = Date.now();
    this.lastPing = 0;
    this.closedAt = null;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", () => {});
    socket.on("close", () => this.#closed());
    this.signInTimer = setTimeout(() => this.#fail("sign-in-timeout", Code.AUTH_FAILED), SIGN_IN_TIMEOUT_MS);
    this.signInTimer.unref?.();
    const pingMs = host.hello.pingSeconds * 1000;
    this.keepAlive = setInterval(() => this.#tick(), Math.min(1000, pingMs / 4));
    this.keepAlive.unref?.();
  }

  get keyHex() { return this.keyHash?.toString("hex") ?? null; }
  get closed() { return this.closedAt !== null; }

  #write(bytes) { if (!this.closed && !this.socket.destroyed) this.socket.write(bytes); }

  /** Sends GOAWAY with `code` and closes the tunnel; its phones' sockets go
   * with it (streams on a lost tunnel are lost, §2). */
  goaway(code) {
    if (this.closed) return;
    this.#write(encodeGoaway(this.nextStream - 1, code));
    this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), 2000);
    timer.unref?.();
    this.#closed();
  }

  #fail(errorCode, goawayCode = Code.PROTOCOL_ERROR) {
    this.host.error(errorCode);
    this.goaway(goawayCode);
  }

  #closed() {
    if (this.closed) return;
    this.closedAt = Date.now();
    clearTimeout(this.signInTimer);
    clearInterval(this.keepAlive);
    for (const stream of this.streams.values()) { stream.reset = true; stream.socket.destroy(); }
    this.streams.clear();
    this.host.closed(this);
  }

  #tick() {
    if (this.closed) return;
    const now = Date.now();
    const silent = now - this.lastReceived;
    const { pingSeconds, idleSeconds } = this.host.hello;
    if (silent >= idleSeconds * 1000) { this.host.error("tunnel-dead"); this.socket.destroy(); this.#closed(); return; }
    if (this.state === "ready" && silent >= pingSeconds * 1000 && now - this.lastPing >= pingSeconds * 1000) {
      this.lastPing = now;
      this.#write(encodePing(randomBytes(8)));
    }
  }

  #onData(chunk) {
    if (this.closed) return;
    this.lastReceived = Date.now();
    try {
      if (this.state === "preface") {
        const needed = PREFACE_LENGTH - this.preface.length;
        this.preface = Buffer.concat([this.preface, chunk.subarray(0, needed)]);
        chunk = chunk.subarray(needed);
        if (this.preface.length < PREFACE_LENGTH) return;
        decodePreface(this.preface);
        if (this.socket.getProtocol?.() !== "TLSv1.3") throw new KtunError("the tunnel needs TLS 1.3");
        if (!this.host.allowSignIn(this)) { this.#fail("sign-in-limit", Code.LIMIT); return; }
        this.state = "hello";
        this.#write(encodeHello({ nonce: this.nonce, ...this.host.hello }));
        if (chunk.length === 0) return;
      }
      for (const frame of this.reader.push(chunk)) {
        if (this.closed) return;
        this.#frame(frame);
      }
    } catch (error) {
      if (!(error instanceof KtunError)) throw error;
      this.#fail("ktun-protocol", error.code);
    }
  }

  #frame(frame) {
    const { type, flags, stream, payload } = frame;
    if (this.state === "hello") {
      if (type === FrameType.AUTH) { this.#auth(payload); return; }
      if (type === FrameType.GOAWAY) { this.socket.end(); this.#closed(); return; }
      throw new KtunError(`${type} before AUTH`);
    }
    switch (type) {
      case FrameType.AUTH: throw new KtunError("a second AUTH");
      case FrameType.DATA: this.#data(stream, flags, payload); break;
      case FrameType.WINDOW: this.#window(stream, decodeWindow(payload)); break;
      case FrameType.RESET: this.#reset(stream, decodeReset(payload)); break;
      case FrameType.PING: if (!(flags & FLAG_ACK)) this.#write(encodePing(payload, true)); break;
      case FrameType.GOAWAY: this.#peerGoaway(); break;
      case FrameType.CONTROL: this.#control(decodeControl(payload)); break;
      default: throw new KtunError(`unexpected frame ${type}`);
    }
  }

  #auth(payload) {
    const { publicKey, signature } = decodeAuth(payload);
    let exporter;
    try { exporter = this.socket.exportKeyingMaterial(EXPORTER_LENGTH, EXPORTER_LABEL); }
    catch { this.#fail("auth-exporter", Code.AUTH_FAILED); return; }
    if (!verifyEd25519(publicKey, authMessage(this.host.relayName, this.nonce, exporter), signature)) {
      this.#fail("auth-failed", Code.AUTH_FAILED);
      return;
    }
    clearTimeout(this.signInTimer);
    this.publicKey = Buffer.from(publicKey);
    this.keyHash = keyHash(this.publicKey);
    this.state = "ready";
    // The relay replaces an older tunnel for this key, routes the key's
    // names here and sends READY, or refuses with a GOAWAY code.
    const refusal = this.host.signedIn(this);
    if (refusal !== Code.NONE) this.#fail(refusal === Code.SUSPENDED ? "tunnel-suspended" : "tunnel-refused", refusal);
  }

  /** Sends READY with the names now routed to this tunnel. The relay sends it
   * after sign-in and again whenever that set changes. */
  ready(names) {
    this.names = names;
    this.#write(encodeReady(names));
  }

  // ------------------------------------------------------------- control

  #control({ requestId, op, status, body }) {
    if (status !== 0) throw new KtunError("a CONTROL request carries a status");
    const answer = (code) => {
      if (this.closed) return;
      const okBody = code === Code.NONE ? encodeNameList(this.names) : Buffer.alloc(0);
      this.#write(encodeControl({ requestId, op, status: code, body: okBody }));
    };
    if (!Object.values(ControlOp).includes(op)) { answer(Code.PROTOCOL_ERROR); return; }
    if (this.controlInFlight >= (this.host.controlRequestsInFlight ?? 8)) { answer(Code.LIMIT); return; }
    this.controlInFlight += 1;
    Promise.resolve()
      .then(() => this.host.control(this, { op, body }))
      .catch((error) => (error instanceof KtunError ? error.code : (this.host.error("control-failure"), Code.OVERLOADED)))
      .then((code) => { this.controlInFlight -= 1; answer(code); });
  }

  // ------------------------------------------------------------- streams

  /** Whether a new phone connection may open a stream here. */
  get acceptsStreams() {
    return this.state === "ready" && !this.closed && !this.draining && this.streams.size < this.host.hello.maxStreams;
  }

  /**
   * Opens a stream for a phone connection whose ClientHello the relay has
   * read: OPEN with the name and the phone's address, then the hello bytes
   * exactly as received, then everything else both ways.
   */
  open(socket, name, address, hello) {
    const id = this.nextStream;
    this.nextStream += 1;
    const stream = {
      id, socket, name,
      send: new SendWindow(this.host.hello.streamWindow),
      recv: new ReceiveWindow(this.host.hello.streamWindow),
      queue: [], queued: 0, throttled: false,
      phoneEnded: false, finSent: false, finReceived: false, reset: false,
      down: [], unpassed: 0, waitDrain: false, waitUntil: 0, downTimer: null, ended: false,
    };
    this.streams.set(id, stream);
    this.#write(encodeOpen(id, { name, address }));
    socket.on("data", (chunk) => { stream.queue.push(chunk); stream.queued += chunk.length; this.#pump(stream); });
    socket.on("end", () => { stream.phoneEnded = true; this.#pump(stream); });
    socket.on("drain", () => { stream.waitDrain = false; this.#pass(stream); });
    socket.on("error", () => {});
    socket.on("close", () => this.#phoneClosed(stream));
    socket.setTimeout(this.host.phoneIdleMs ?? 15 * 60_000, () => { this.host.error("phone-idle"); socket.destroy(); });
    stream.queue.push(hello);
    stream.queued += hello.length;
    this.#pump(stream);
    // Near 2³¹ the relay stops opening streams here and the home server
    // reconnects on a fresh tunnel (§2).
    if (this.nextStream > (this.host.streamLimit ?? STREAM_LIMIT)) {
      this.draining = true;
      this.#write(encodeGoaway(id, Code.NONE));
      this.host.drained?.(this);
    }
    return stream;
  }

  /** Phone → home: sends what credit and bandwidth allow; pauses the phone
   * otherwise. */
  #pump(stream) {
    if (stream.reset || this.closed) return;
    while (stream.queued > 0 && !stream.throttled) {
      const head = stream.queue[0];
      const size = Math.min(head.length, MAX_PAYLOAD, stream.send.available, this.connSend.available);
      if (size === 0) { this.blocked.add(stream); break; }
      stream.send.spend(size);
      this.connSend.spend(size);
      this.#write(encodeData(stream.id, head.subarray(0, size)));
      this.host.count(stream.name, "bytesIn", size);
      if (size === head.length) stream.queue.shift(); else stream.queue[0] = head.subarray(size);
      stream.queued -= size;
      const wait = this.host.bandwidth(stream.name, "up", size);
      if (wait > 0) {
        stream.throttled = true;
        const timer = setTimeout(() => { stream.throttled = false; this.#pump(stream); }, wait);
        timer.unref?.();
      }
    }
    if (stream.queued > 0 || stream.throttled) stream.socket.pause();
    else {
      this.blocked.delete(stream);
      stream.socket.resume();
      if (stream.phoneEnded && !stream.finSent) {
        stream.finSent = true;
        this.#write(encodeData(stream.id, Buffer.alloc(0), true));
      }
    }
  }

  /** Home → phone. */
  #data(id, flags, payload) {
    this.connRecv.receive(payload.length);
    const stream = this.streams.get(id);
    if (!stream) {
      // A stream this side has already dropped: its bytes still spent the
      // tunnel's credit, which is given straight back.
      if (id >= this.nextStream) throw new KtunError("DATA on a stream never opened");
      this.connRecv.passed(payload.length);
      this.#grantTunnel();
      return;
    }
    if (stream.finReceived) throw new KtunError("DATA after FIN");
    stream.recv.receive(payload.length);
    if (payload.length) {
      this.host.count(stream.name, "bytesOut", payload.length);
      stream.down.push(payload);
    }
    if (flags & FLAG_FIN) stream.finReceived = true;
    this.#flushDown(stream);
  }

  /** Writes held bytes to the phone as the name's bandwidth allows. At most
   * one stream window is ever held: the home server can't send more until
   * the bytes are written and credit goes back. */
  #flushDown(stream) {
    if (stream.reset) return;
    while (stream.down.length > 0) {
      const now = Date.now();
      if (now < stream.waitUntil) {
        if (!stream.downTimer) {
          stream.downTimer = setTimeout(() => { stream.downTimer = null; this.#flushDown(stream); }, stream.waitUntil - now);
          stream.downTimer.unref?.();
        }
        return;
      }
      const bytes = stream.down.shift();
      const wait = this.host.bandwidth(stream.name, "down", bytes.length);
      if (wait > 0) stream.waitUntil = now + wait;
      stream.unpassed += bytes.length;
      if (!stream.socket.write(bytes)) stream.waitDrain = true;
    }
    if (stream.finReceived && !stream.ended) { stream.ended = true; stream.socket.end(); }
    this.#pass(stream);
  }

  /** Credit back to the home server once the phone's socket has taken the
   * bytes. */
  #pass(stream) {
    if (stream.reset || stream.waitDrain || stream.unpassed === 0) return;
    stream.recv.passed(stream.unpassed);
    this.connRecv.passed(stream.unpassed);
    stream.unpassed = 0;
    const increment = stream.recv.takeGrant();
    if (increment && !stream.finReceived) this.#write(encodeWindow(stream.id, increment));
    this.#grantTunnel();
  }

  #grantTunnel(force = false) {
    const increment = this.connRecv.takeGrant(force);
    if (increment) this.#write(encodeWindow(0, increment));
  }

  #window(id, increment) {
    if (id === 0) {
      this.connSend.grant(increment);
      for (const stream of [...this.blocked]) this.#pump(stream);
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) { if (id >= this.nextStream) throw new KtunError("WINDOW for a stream never opened"); return; }
    stream.send.grant(increment);
    this.#pump(stream);
  }

  #reset(id) {
    const stream = this.streams.get(id);
    if (!stream) { if (id >= this.nextStream) throw new KtunError("RESET for a stream never opened"); return; }
    stream.reset = true;
    stream.socket.destroy();
  }

  #phoneClosed(stream) {
    if (!this.streams.has(stream.id)) return;
    this.streams.delete(stream.id);
    this.blocked.delete(stream);
    this.host.streamClosed?.(this, stream);
    if (!stream.reset && !this.closed && !(stream.finSent && stream.finReceived)) this.#write(encodeReset(stream.id, Code.NONE));
    stream.reset = true;
    // Bytes the phone never took still spent tunnel credit: give it back.
    clearTimeout(stream.downTimer);
    const held = stream.unpassed + stream.down.reduce((sum, bytes) => sum + bytes.length, 0);
    stream.down = [];
    stream.unpassed = 0;
    if (held) { this.connRecv.passed(held); this.#grantTunnel(true); }
    if (this.draining && this.streams.size === 0) this.goaway(Code.NONE);
  }

  #peerGoaway() {
    this.draining = true;
    this.host.drained?.(this);
    if (this.streams.size === 0) { this.socket.end(); this.#closed(); }
  }
}

/** A socket's peer address as KTUN carries it: no IPv6 zone, and IPv4-mapped
 * IPv6 as plain IPv4. */
export function normalizeAddress(address) {
  const value = String(address ?? "").split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  return mapped ? mapped[1] : value;
}

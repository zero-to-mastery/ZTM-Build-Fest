// A small home server for the relay's tests: it dials the relay, signs in
// with KTUN, and hands each stream to a Node TLS server that ends TLS with
// the home server's own (self-signed) certificate. It is test support, not
// the real tunnel client (#733), but it speaks the same codec.
import { EventEmitter, once } from "node:events";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import { TLSSocket, connect, createSecureContext } from "node:tls";
import {
  ALPN, Code, EXPORTER_LABEL, EXPORTER_LENGTH, FLAG_ACK, FLAG_FIN, FrameReader, FrameType, MAX_PAYLOAD, ReceiveWindow,
  SendWindow, authMessage, decodeControl, decodeGoaway, decodeHello, decodeNameList, decodeOpen, decodeReset,
  decodeWindow, encodeAuth, encodeControl, encodeControlBody, encodeData, encodeGoaway, encodePing, encodePreface,
  encodeReset, encodeWindow, rawEd25519PublicKey, signEd25519,
} from "../ktun.mjs";

export class FakeHome extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.port            the relay's port 443 stand-in
   * @param {string} options.relayName
   * @param {Buffer} options.relayCert       trusted as the relay's CA
   * @param {{ key: Buffer, cert: Buffer }} options.homeTls
   * @param {import("node:crypto").KeyObject} [options.privateKey]  the home key
   * @param {boolean} [options.grantCredit]  false: never send WINDOW (a stuck home server)
   * @param {boolean} [options.answerPings]  false: never answer PING (a dead one)
   * @param {(signed: Buffer) => Buffer} [options.tamperSignature]
   */
  constructor(options) {
    super();
    this.options = { grantCredit: true, answerPings: true, ...options };
    this.privateKey = options.privateKey ?? generateKeyPairSync("ed25519").privateKey;
    this.publicKey = rawEd25519PublicKey(this.privateKey);
    this.reader = new FrameReader("relay");
    this.streams = new Map();
    this.requests = new Map();
    this.nextRequest = 1;
    this.frames = [];
    this.names = null;
    this.goaway = null;
    this.secureContext = createSecureContext(options.homeTls);
    this.serve = (socket) => {
      socket.on("error", () => {});
      socket.on("data", (data) => {
        // A tiny HTTP answer, so a client can prove it reached the home server.
        if (data.toString("latin1").startsWith("GET ")) socket.end(`HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nhome server\r\n`);
        else if (data.toString("latin1").startsWith("BIG ")) {
          const size = Number(data.toString("latin1").slice(4).trim());
          socket.end(Buffer.alloc(size, 0x6b));
        } else socket.write(data);
      });
    };
  }

  /** Connects and signs in; resolves with the READY names. */
  async connect() {
    const { port, relayName, relayCert } = this.options;
    this.socket = connect({ port, host: "127.0.0.1", servername: relayName, ca: relayCert, ALPNProtocols: [ALPN], minVersion: "TLSv1.3" });
    this.socket.on("error", (error) => this.emit("socket-error", error));
    await once(this.socket, "secureConnect");
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));
    this.socket.on("data", (chunk) => this.#onData(chunk));
    this.socket.write(encodePreface());
    const [names] = await once(this, "ready");
    return names;
  }

  #write(bytes) { if (!this.socket.destroyed) this.socket.write(bytes); }

  #onData(chunk) {
    for (const frame of this.reader.push(chunk)) {
      this.frames.push(frame.type);
      this.#frame(frame);
    }
  }

  #frame({ type, flags, stream, payload }) {
    switch (type) {
      case FrameType.HELLO: {
        this.hello = decodeHello(payload);
        this.connSend = new SendWindow(this.hello.connectionWindow);
        this.connRecv = new ReceiveWindow(this.hello.connectionWindow);
        const exporter = this.socket.exportKeyingMaterial(EXPORTER_LENGTH, EXPORTER_LABEL);
        let signature = signEd25519(this.privateKey, authMessage(this.options.relayName, this.hello.nonce, exporter));
        if (this.options.tamperSignature) signature = this.options.tamperSignature(signature);
        this.#write(encodeAuth({ publicKey: this.publicKey, signature, softwareVersion: 1 }));
        break;
      }
      case FrameType.READY:
        this.names = decodeNameList(payload);
        this.emit("ready", this.names);
        break;
      case FrameType.OPEN: this.#open(stream, decodeOpen(payload)); break;
      case FrameType.DATA: this.#data(stream, flags, payload); break;
      case FrameType.WINDOW: {
        const increment = decodeWindow(payload);
        if (stream === 0) this.connSend.grant(increment); else this.streams.get(stream)?.send.grant(increment);
        for (const entry of this.streams.values()) entry.flush();
        break;
      }
      case FrameType.RESET: { const entry = this.streams.get(stream); this.emit("reset", stream, decodeReset(payload)); entry?.duplex.destroy(); this.streams.delete(stream); break; }
      case FrameType.PING:
        this.emit("ping", flags);
        if (!(flags & FLAG_ACK) && this.options.answerPings) this.#write(encodePing(payload, true));
        break;
      case FrameType.GOAWAY: this.goaway = decodeGoaway(payload); this.emit("goaway", this.goaway); break;
      case FrameType.CONTROL: {
        const answer = decodeControl(payload);
        const resolve = this.requests.get(answer.requestId);
        this.requests.delete(answer.requestId);
        resolve?.({ status: answer.status, names: answer.status === Code.NONE ? decodeNameList(answer.body) : null });
        break;
      }
    }
  }

  #open(id, open) {
    const home = this;
    const entry = {
      id, open, send: new SendWindow(this.hello.streamWindow), recv: new ReceiveWindow(this.hello.streamWindow),
      pending: [], finished: false, finQueued: false,
      flush() {
        while (entry.pending.length) {
          const [bytes, callback] = entry.pending[0];
          const size = Math.min(bytes.length, MAX_PAYLOAD, entry.send.available, home.connSend.available);
          if (size === 0) return;
          entry.send.spend(size);
          home.connSend.spend(size);
          home.#write(encodeData(id, bytes.subarray(0, size)));
          if (size === bytes.length) { entry.pending.shift(); callback(); } else entry.pending[0][0] = bytes.subarray(size);
        }
        if (entry.finQueued && !entry.finished) {
          entry.finished = true;
          home.#write(encodeData(id, Buffer.alloc(0), true));
          if (entry.ended) home.streams.delete(id);
        }
      },
    };
    entry.duplex = new Duplex({
      read() {},
      write(chunk, _encoding, callback) { entry.pending.push([chunk, callback]); entry.flush(); },
      final(callback) { entry.finQueued = true; entry.flush(); callback(); },
      destroy(error, callback) {
        if (home.streams.has(id)) { home.streams.delete(id); home.#write(encodeReset(id, Code.NONE)); }
        callback(error);
      },
    });
    entry.duplex.on("error", () => {});
    this.streams.set(id, entry);
    this.emit("open", open);
    // The home server ends TLS itself, with its own certificate.
    const tls = new TLSSocket(entry.duplex, { isServer: true, secureContext: this.secureContext, ALPNProtocols: ["http/1.1"] });
    entry.tls = tls;
    tls.on("secure", () => this.serve(tls));
    tls.on("error", () => entry.duplex.destroy());
    tls.on("end", () => tls.end());
    tls.on("close", () => { if (!entry.duplex.destroyed) entry.duplex.end(); });
  }

  #data(id, flags, payload) {
    this.connRecv.receive(payload.length);
    const entry = this.streams.get(id);
    if (!entry) return;
    entry.recv.receive(payload.length);
    if (payload.length) entry.duplex.push(Buffer.from(payload));
    if (this.options.grantCredit) {
      entry.recv.passed(payload.length);
      this.connRecv.passed(payload.length);
      const increment = entry.recv.takeGrant();
      if (increment) this.#write(encodeWindow(id, increment));
      const tunnel = this.connRecv.takeGrant();
      if (tunnel) this.#write(encodeWindow(0, tunnel));
    }
    if (flags & FLAG_FIN) {
      entry.ended = true;
      entry.duplex.push(null);
      if (entry.finished) this.streams.delete(id);
    }
  }

  /** Sends a CONTROL request; resolves with { status, names }. */
  control(op, fields) {
    const requestId = this.nextRequest++;
    const answer = new Promise((resolve) => this.requests.set(requestId, resolve));
    this.#write(encodeControl({ requestId, op, body: encodeControlBody(op, fields) }));
    return answer;
  }

  /** Raw bytes into the tunnel, for protocol-error tests. */
  raw(bytes) { this.#write(bytes); }
  ping() { this.#write(encodePing(randomBytes(8))); }
  sendGoaway(code = Code.NONE) { this.#write(encodeGoaway(0, code)); }

  close() { this.socket?.destroy(); for (const entry of this.streams.values()) entry.tls?.destroy(); }
}

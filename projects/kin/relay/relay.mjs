// The Kin connection relay (ADR 0025 §1, §4, story #728): a pure SNI router.
//
//   phone ──TLS──▶ relay :443 ──KTUN tunnel──▶ home server (ends TLS)
//
// On port 443 it reads each connection's ClientHello for the server name
// only. A home server's name: the bytes, exactly as received and still
// encrypted, go into that home server's tunnel, and the rest is spliced
// both ways. The relay holds no certificate or key for any home server's
// name and never ends TLS for one. Its own name: the relay ends TLS with its
// own certificate; ALPN kin-tunnel/1 is a home server's tunnel, anything else
// gets a one-line status page. Port 80 only redirects to https://, and port
// 53 answers DNS for the zone (relay/dns.mjs).
//
// It keeps the registry and 30 days of hourly counters (relay/registry.mjs)
// and, in memory only, client addresses for rate limits (relay/limits.mjs).
// It logs nothing about connections: no access log, no address, no byte.
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { resolveTxt as systemResolveTxt } from "node:dns/promises";
import { createDnsServer, zoneConfig } from "./dns.mjs";
import {
  ALPN, Code, ControlOp, DEFAULT_HELLO, decodeControlBody, isHostName, keyHash, keyHashText, transferMessage, verifyEd25519,
} from "./ktun.mjs";
import { ClaimSketch, DAY, DEFAULT_LIMITS, HOUR, MINUTE, TokenBucket, WindowCounter, addressKey } from "./limits.mjs";
import { Registry } from "./registry.mjs";
import { HELLO_TIMEOUT_MS, MAX_HELLO_BYTES, UNRECOGNIZED_NAME_ALERT, readClientHello } from "./sni.mjs";
import { RelayTunnel, SIGN_IN_TIMEOUT_MS, normalizeAddress } from "./tunnel.mjs";

/**
 * Asks Certificate Transparency (crt.sh's JSON search by default) whether
 * any certificate names `name`. true or false, or null when it can't tell
 * (a name is then never freed on that day's evidence).
 */
export function ctLookup(baseUrl = "https://crt.sh/") {
  return async (name) => {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set("q", name);
      url.searchParams.set("output", "json");
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return null;
      const entries = await response.json();
      return Array.isArray(entries) && entries.some((entry) => String(entry?.name_value ?? "").toLowerCase().split("\n").includes(name));
    } catch { return null; }
  };
}

export class ConnectionRelay {
  /**
   * @param {object} options
   * @param {string} options.zone            e.g. home.kin.journeytocode.io
   * @param {string} options.relayName       the relay's own name, e.g. relay.kin.journeytocode.io
   * @param {{ key: Buffer|string, cert: Buffer|string }} options.tls  the relay's own certificate
   * @param {Registry} [options.registry]    else one is opened at `registryPath`
   * @param {string} [options.registryPath]
   * @param {string[]} [options.addresses]   the relay's published IPs, for DNS
   * @param {string[]} [options.nameServers]
   * @param {string} [options.hostmaster]
   * @param {string} [options.abuseContact]
   * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits]
   * @param {Partial<typeof DEFAULT_HELLO>} [options.hello]
   * @param {(name: string) => Promise<string[][]>} [options.resolveTxt]  injected in tests
   * @param {(name: string) => Promise<boolean|null>} [options.certificateSeen]
   * @param {number} [options.streamLimit]   testing: GOAWAY after this stream number
   * @param {string[]} [options.reserved]
   * @param {(line: string) => void} [options.log]  operator messages; never a client address
   */
  constructor(options) {
    const { zone, relayName, tls } = options;
    if (!isHostName(zone) || !isHostName(relayName)) throw new RangeError("zone and relayName must be lowercase host names");
    this.zone = zone;
    this.relayName = relayName;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.hello = { ...DEFAULT_HELLO, maxStreams: this.limits.connectionsPerName, ...options.hello };
    this.streamLimit = options.streamLimit;
    this.phoneIdleMs = this.limits.phoneIdleMs;
    this.controlRequestsInFlight = this.limits.controlRequestsInFlight;
    this.abuseContact = options.abuseContact ?? `abuse@${zone}`;
    this.log = options.log ?? (() => {});
    this.resolveTxt = options.resolveTxt ?? systemResolveTxt;
    this.certificateSeen = options.certificateSeen ?? ctLookup();
    this.ownsRegistry = !options.registry;
    this.registry = options.registry ?? new Registry({
      zone, path: options.registryPath ?? ":memory:", reserved: options.reserved ?? [], newNamesPerWeek: this.limits.newNamesPerWeek,
    });
    this.dnsConfig = zoneConfig({ zone, relayName, addresses: options.addresses ?? [], nameServers: options.nameServers, hostmaster: options.hostmaster });

    /** Online tunnels by key hash (hex), and routed names to their tunnel. */
    this.tunnels = new Map();
    this.routes = new Map();
    this.pendingHellos = 0;
    this.phoneConnections = 0;
    // In memory only (§4): client addresses, forgotten when each window ends.
    this.phoneRate = new WindowCounter({ limit: this.limits.connectionsPerClientPerMinute, windowMs: MINUTE });
    this.signInRate = new WindowCounter({ limit: this.limits.signInsPerSourcePerHour, windowMs: HOUR });
    this.claimsToday = new WindowCounter({ limit: this.limits.claimsPerSourcePerDay, windowMs: DAY });
    this.claims30 = new ClaimSketch({ limit: this.limits.claimsPerSourcePer30Days });
    // Keyed by the home key's hash, not an address.
    this.checkRate = new WindowCounter({ limit: this.limits.checksPerKeyPerMinute, windowMs: MINUTE });
    this.buckets = new Map();
    this.pendingCounts = new Map();
    this.pendingErrors = new Map();
    this.usage = new Map();
    this.sockets = new Set();

    this.ownTls = createTlsServer({
      key: tls.key, cert: tls.cert, ALPNProtocols: [ALPN, "http/1.1"], minVersion: "TLSv1.2", handshakeTimeout: SIGN_IN_TIMEOUT_MS,
    }, (socket) => this.#ownConnection(socket));
    this.ownTls.on("tlsClientError", (_error, socket) => { this.error("relay-tls"); socket.destroy(); });
    this.edge = createNetServer({ allowHalfOpen: true }, (socket) => this.#edgeConnection(socket));
    this.edge.on("error", () => this.error("edge-listener"));
    this.redirect = createHttpServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => this.#redirect(request, response));
  }

  /** Replaces the relay's own certificate (it renews), without a restart. */
  setCertificate({ key, cert }) { this.ownTls.setSecureContext({ key, cert }); }

  /** Starts listening. Port 0 picks a free port (tests); null skips a listener. */
  async listen({ host = "::", tlsPort = 443, httpPort = 80, dnsPort = 53 } = {}) {
    const listen = (server, port) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(server.address().port); });
    });
    try {
      this.ports = { tls: await listen(this.edge, tlsPort) };
      if (httpPort !== null) this.ports.http = await listen(this.redirect, httpPort);
      if (dnsPort !== null) {
        this.dns = await createDnsServer({
          host, port: dnsPort, config: this.dnsConfig, lookup: (name) => this.registry.dnsInfo(name), onError: (code) => this.error(code),
        });
        this.ports.dns = this.dns.udpPort;
      }
    } catch (error) {
      // A failed start closes whatever already listens, so nothing is left
      // open to keep the process alive (#469).
      const closing = [this.edge, this.redirect].filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve)));
      if (this.dns) closing.push(this.dns.close());
      this.dns = null;
      await Promise.all(closing);
      throw error;
    }
    this.minuteTimer = setInterval(() => this.minuteTick(), MINUTE);
    this.minuteTimer.unref?.();
    this.dayTimer = setInterval(() => { this.dailySweep().catch(() => this.error("sweep-failure")); }, DAY);
    this.dayTimer.unref?.();
    this.log(`Kin connection relay for ${this.zone} listening (TLS ${this.ports.tls}${this.ports.http ? `, HTTP ${this.ports.http}` : ""}${this.ports.dns ? `, DNS ${this.ports.dns}` : ""}).`);
    return this.ports;
  }

  /** Stops: every tunnel gets GOAWAY 8 (shutting down); counters are kept. */
  async close() {
    clearInterval(this.minuteTimer);
    clearInterval(this.dayTimer);
    // GOAWAY 8 must reach each home server before its socket goes: destroying
    // right after the write can drop it or turn the close into a reset (seen
    // on Windows, #733). A home server ends its side when it reads GOAWAY,
    // so wait for each tunnel to close, at most two seconds, then destroy
    // whatever is left.
    const tunnels = [...this.tunnels.values()];
    const goneAway = tunnels.map(({ socket }) => new Promise((resolve) => {
      if (socket.destroyed) { resolve(); return; }
      socket.once("close", resolve);
    }));
    for (const tunnel of tunnels) tunnel.goaway(Code.SHUTTING_DOWN);
    if (goneAway.length) {
      let timer;
      await Promise.race([Promise.all(goneAway), new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
    }
    for (const socket of this.sockets) socket.destroy();
    const closing = [new Promise((resolve) => this.edge.close(resolve))];
    if (this.ports?.http) { closing.push(new Promise((resolve) => this.redirect.close(resolve))); this.redirect.closeAllConnections?.(); }
    if (this.dns) closing.push(this.dns.close());
    await Promise.all(closing);
    this.flush();
    if (this.ownsRegistry) this.registry.close();
  }

  // --------------------------------------------------------------- port 443

  #edgeConnection(socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    if (this.pendingHellos >= this.limits.pendingHellos || this.phoneConnections >= this.limits.phoneConnections) {
      this.error("overloaded");
      socket.destroy();
      return;
    }
    this.pendingHellos += 1;
    let buffer = null;
    let length = 0;
    let decided = false;
    const decide = () => { decided = true; this.pendingHellos -= 1; clearTimeout(timer); socket.removeListener("data", onData); };
    const refuse = (code) => { decide(); this.error(code); socket.destroy(); };
    const timer = setTimeout(() => refuse("hello-timeout"), HELLO_TIMEOUT_MS);
    timer.unref?.();
    socket.once("close", () => { if (!decided) { decided = true; this.pendingHellos -= 1; clearTimeout(timer); } });
    const onData = (chunk) => {
      buffer ??= Buffer.allocUnsafe(MAX_HELLO_BYTES);
      if (length + chunk.length > MAX_HELLO_BYTES) { refuse("hello-too-large"); return; }
      chunk.copy(buffer, length);
      length += chunk.length;
      const result = readClientHello(buffer.subarray(0, length));
      if (result.state === "more") return;
      if (result.state === "refuse") { refuse(`hello-${result.reason}`); return; }
      decide();
      socket.pause();
      const hello = buffer.subarray(0, length);
      if (result.name === this.relayName) {
        // The relay's own name: its own TLS server reads the same bytes. The
        // raw socket stays in `sockets` so close() ends it: a client that
        // aborts this handshake (it doesn't trust the certificate, say) is
        // never noticed by the TLS server on a handed-over socket, so the
        // handshake time limit below and close() are what free it (#733).
        socket.unshift(hello);
        this.ownTls.emit("connection", socket);
        return;
      }
      this.#route(socket, result.name, hello);
    };
    socket.on("data", onData);
  }

  /** Hands a phone connection to the tunnel routing `name`, or refuses it. */
  #route(socket, name, hello) {
    const tunnel = this.routes.get(name);
    if (!tunnel) {
      this.error("unrouted");
      socket.end(UNRECOGNIZED_NAME_ALERT);
      socket.setTimeout(2000, () => socket.destroy());
      return;
    }
    const address = normalizeAddress(socket.remoteAddress);
    let clientKey;
    try { clientKey = `${addressKey(address)} ${name}`; } catch { socket.destroy(); return; }
    // Refused above a limit (§4); the home server's control panel shows why.
    let refusal = null;
    if (!this.phoneRate.hit(clientKey)) refusal = "limit-client-rate";
    else if (!tunnel.acceptsStreams) refusal = tunnel.draining ? "tunnel-draining" : "limit-name-connections";
    else if (this.#usage(name) >= this.limits.bytesPer30DaysPerName) refusal = "limit-name-bandwidth";
    if (refusal) { this.error(refusal); socket.destroy(); return; }
    this.phoneConnections += 1;
    socket.once("close", () => { this.phoneConnections -= 1; });
    this.count(name, "connections", 1);
    tunnel.open(socket, name, address, Buffer.from(hello));
  }

  // ------------------------------------------------------ the relay's own name

  #ownConnection(socket) {
    socket.on("error", () => {});
    if (socket.alpnProtocol === ALPN) {
      const tunnel = new RelayTunnel(socket, this);
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      return tunnel;
    }
    // Anything else on the relay's own name: one line, and closed (§2).
    socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nKin connection relay for ${this.zone}. Abuse reports: ${this.abuseContact}\n`);
    socket.setTimeout(5000, () => socket.destroy());
    return null;
  }

  #redirect(request, response) {
    const host = String(request.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    const path = typeof request.url === "string" && request.url.startsWith("/") && request.url.length <= 2048 ? request.url : "/";
    if (!isHostName(host)) { response.writeHead(400, { "content-type": "text/plain", connection: "close" }).end("Bad request\n"); return; }
    response.writeHead(301, { location: `https://${host}${path}`, "content-type": "text/plain", connection: "close" }).end("Moved\n");
  }

  // ----------------------------------------------------------- TunnelHost

  allowSignIn(tunnel) {
    try { return this.signInRate.hit(addressKey(tunnel.address)); } catch { return false; }
  }

  /** After a good AUTH: replaces an older tunnel for the key, routes its
   * names, and sends READY; or refuses a suspended key. */
  signedIn(tunnel) {
    const { suspended } = this.registry.signedIn(tunnel.keyHash);
    if (suspended) return Code.SUSPENDED;
    const older = this.tunnels.get(tunnel.keyHex);
    if (older && older !== tunnel) {
      this.#unroute(older);
      this.tunnels.delete(tunnel.keyHex);
      this.error("tunnel-replaced");
      older.goaway(Code.REPLACED);
    }
    this.tunnels.set(tunnel.keyHex, tunnel);
    this.#refresh(tunnel, true);
    return Code.NONE;
  }

  closed(tunnel) {
    if (tunnel.keyHex && this.tunnels.get(tunnel.keyHex) === tunnel) this.tunnels.delete(tunnel.keyHex);
    this.#unroute(tunnel);
  }

  drained(tunnel) { this.#unroute(tunnel); }

  #unroute(tunnel) {
    for (const [name, routed] of this.routes) if (routed === tunnel) this.routes.delete(name);
  }

  /** Routes the names the registry gives `tunnel`'s key to it, and sends
   * READY when they changed (or `always`). A name that moved here from
   * another tunnel (an own domain whose TXT now names this key) leaves it. */
  #refresh(tunnel, always = false) {
    if (tunnel.closed || tunnel.draining) return;
    const names = this.registry.routedNames(tunnel.keyHash);
    const before = tunnel.names.join("\n");
    const others = new Set();
    for (const [name, routed] of this.routes) if (routed === tunnel && !names.includes(name)) this.routes.delete(name);
    for (const name of names) {
      const current = this.routes.get(name);
      if (current && current !== tunnel) others.add(current);
      this.routes.set(name, tunnel);
    }
    if (always || names.join("\n") !== before) tunnel.ready(names);
    for (const other of others) this.#refresh(other);
  }

  /** CONTROL requests (§3). Returns the status code. */
  async control(tunnel, { op, body }) {
    const request = decodeControlBody(op, body);
    const { registry } = this;
    let code;
    switch (op) {
      case ControlOp.CLAIM: {
        let source;
        try { source = addressKey(tunnel.address); } catch { return Code.LIMIT; }
        let counted = false;
        code = registry.claim(tunnel.keyHash, request.name, () => {
          counted = this.claimsToday.allows(source) && this.claims30.allows(source);
          return counted;
        });
        if (code === Code.NONE && counted) { this.claimsToday.hit(source); this.claims30.add(source); }
        break;
      }
      case ControlOp.RELEASE:
        code = registry.release(tunnel.keyHash, request.name);
        break;
      case ControlOp.SET_CAA:
        code = registry.setCaa(tunnel.keyHash, request.name, request.accountUri);
        break;
      case ControlOp.ADD_DOMAIN: {
        if (!registry.domainAllowed(request.name, this.relayName)) return Code.NAME_NOT_ALLOWED;
        const proofs = await this.#txtProofs(request.name);
        if (!proofs.has(keyHashText(tunnel.publicKey))) return Code.NAME_NOT_ALLOWED;
        code = registry.addDomain(tunnel.keyHash, request.name, (other) => proofs.has(other.toString("base64url")));
        break;
      }
      case ControlOp.REMOVE_DOMAIN:
        code = registry.removeDomain(tunnel.keyHash, request.name);
        break;
      case ControlOp.CHECK: {
        // Answers what CLAIM or ADD_DOMAIN would, and changes nothing.
        if (!this.checkRate.hit(tunnel.keyHex)) return Code.LIMIT;
        if (registry.labelOf(request.name) !== null) return registry.check(tunnel.keyHash, request.name);
        if (!registry.domainAllowed(request.name, this.relayName)) return Code.NAME_NOT_ALLOWED;
        const proofs = await this.#txtProofs(request.name);
        const other = registry.keyOf(request.name);
        if (other && !other.equals(tunnel.keyHash) && proofs.has(other.toString("base64url"))) return Code.NAME_TAKEN;
        // UNKNOWN_NAME: the relay can't see this key in _kin-relay yet.
        return proofs.has(keyHashText(tunnel.publicKey)) ? Code.NONE : Code.UNKNOWN_NAME;
      }
      case ControlOp.TRANSFER: {
        if (!verifyEd25519(request.newKey, transferMessage(request.name, tunnel.publicKey, request.newKey), request.signature)) return Code.AUTH_FAILED;
        const newHash = keyHash(request.newKey);
        code = registry.transfer(tunnel.keyHash, request.name, newHash);
        if (code === Code.NONE) { const other = this.tunnels.get(newHash.toString("hex")); if (other) this.#refresh(other); }
        break;
      }
      default:
        return Code.PROTOCOL_ERROR;
    }
    if (code === Code.NONE) this.#refresh(tunnel);
    return code;
  }

  /** The key hashes `_kin-relay.<domain>` names (base64url SHA-256, §3). */
  async #txtProofs(domain) {
    try {
      const records = await this.resolveTxt(`_kin-relay.${domain}`);
      return new Set(records.map((chunks) => chunks.join("").trim()));
    } catch { return new Set(); }
  }

  bandwidth(name, direction, bytes) {
    const id = `${direction} ${name}`;
    let bucket = this.buckets.get(id);
    if (!bucket) {
      // Bursts of up to two seconds' worth.
      bucket = new TokenBucket({ bytesPerSecond: this.limits.bytesPerSecondPerName, burstBytes: this.limits.bytesPerSecondPerName * 2 });
      this.buckets.set(id, bucket);
    }
    return bucket.reserve(bytes);
  }

  /** Adds to a name's hourly counters (flushed to the registry each minute). */
  count(name, field, amount) {
    let entry = this.pendingCounts.get(name);
    if (!entry) { entry = { connections: 0, bytesIn: 0, bytesOut: 0 }; this.pendingCounts.set(name, entry); }
    entry[field] += amount;
  }

  /** Counts an error code (§4: an error code and a count, nothing else). */
  error(code) { this.pendingErrors.set(code, (this.pendingErrors.get(code) ?? 0) + 1); }

  #usage(name) {
    let cached = this.usage.get(name);
    if (cached === undefined) { cached = this.registry.usage(name); this.usage.set(name, cached); }
    const pending = this.pendingCounts.get(name);
    return cached + (pending ? pending.bytesIn + pending.bytesOut : 0);
  }

  /** Writes pending counters and error counts to the registry. */
  flush() {
    if (!this.registry.db.isOpen) return;
    for (const [name, entry] of this.pendingCounts) this.registry.count(name, entry);
    for (const [code, count] of this.pendingErrors) this.registry.error(code, count);
    this.pendingCounts.clear();
    this.pendingErrors.clear();
    this.usage.clear();
  }

  /** Every minute: counters to disk, expired addresses out of memory, and
   * suspensions (made with relay/admin.mjs) applied to online tunnels. */
  minuteTick() {
    this.flush();
    this.phoneRate.sweep();
    this.signInRate.sweep();
    this.claimsToday.sweep();
    this.checkRate.sweep();
    for (const [id, bucket] of this.buckets) if (bucket.tokens >= bucket.burstBytes) this.buckets.delete(id);
    for (const tunnel of [...this.tunnels.values()]) {
      if (this.registry.keySuspended(tunnel.keyHash)) { this.#unroute(tunnel); this.tunnels.delete(tunnel.keyHex); tunnel.goaway(Code.SUSPENDED); }
      else this.#refresh(tunnel);
    }
  }

  /**
   * Once a day: counters past 30 days are dropped; names claimed 7 or more
   * days ago that Certificate Transparency shows no certificate for are
   * freed (§3); own domains' TXT records are checked again (§3); online
   * keys' last-seen day is today.
   */
  async dailySweep() {
    this.flush();
    this.registry.prune();
    for (const name of this.registry.uncertifiedNames()) {
      const seen = await this.certificateSeen(name);
      if (seen === true) this.registry.markCertified(name);
      else if (seen === false) this.registry.freeUncertified(name);
    }
    for (const { domain, keyHash: hash } of this.registry.domains()) {
      const proofs = await this.#txtProofs(domain);
      if (proofs.has(hash.toString("base64url"))) this.registry.domainVerified(domain);
    }
    // A home server connected all day still "connected" today (§3: a name
    // stops routing only after 365 days without its key).
    for (const tunnel of this.tunnels.values()) this.registry.signedIn(tunnel.keyHash);
    this.minuteTick();
  }

  /** Counts for tests and the operator's status: never an address. */
  stats() {
    let streams = 0;
    for (const tunnel of this.tunnels.values()) streams += tunnel.streams.size;
    return {
      tunnels: this.tunnels.size, routes: [...this.routes.keys()].sort(), streams, pendingHellos: this.pendingHellos,
      phoneConnections: this.phoneConnections, addressesHeld: this.phoneRate.size + this.signInRate.size + this.claimsToday.size,
    };
  }
}

export const createRelay = (options) => new ConnectionRelay(options);

// The connection relay's authoritative DNS server for its zone (ADR 0025 §4,
// §5): UDP and TCP, no recursion, no EDNS, no DNSSEC. It answers
//
// - A/AAAA for routed names (and in-zone name servers and the relay's own
//   name, when they are in the zone): the relay's own addresses;
// - CAA per name from the registry, and `0 issue ";"` at the zone's top, so
//   names nobody has claimed can't get a certificate;
// - NS and SOA for the zone; never an HTTPS (type 65) record, so browsers
//   never send a real Encrypted Client Hello the relay couldn't route;
// - NXDOMAIN for names that aren't routed, REFUSED outside the zone.
//
// `answerQuery` is pure (bytes in, bytes out); `createDnsServer` binds it.
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { addressBytes, isHostName } from "./ktun.mjs";

export const Type = Object.freeze({ A: 1, NS: 2, SOA: 6, TXT: 16, AAAA: 28, HTTPS: 65, ANY: 255, CAA: 257 });
export const Rcode = Object.freeze({ NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 });
const CLASS_IN = 1;
const UDP_LIMIT = 512;
const TTL = 300;
const NEGATIVE_TTL = 60;
const NS_TTL = 3600;

/** Encodes a host name in DNS wire form (uncompressed). */
export function encodeName(name) {
  const parts = name === "" ? [] : name.split(".");
  const bytes = [];
  for (const label of parts) bytes.push(label.length, ...Buffer.from(label, "latin1"));
  bytes.push(0);
  return Buffer.from(bytes);
}

/**
 * Reads the single question of a query. Returns null for anything that
 * isn't one well-formed question (FORMERR). Compression pointers are not
 * accepted in a question.
 */
export function readQuestion(message) {
  if (message.length < 12 + 5) return null;
  let at = 12;
  const labels = [];
  let total = 0;
  for (;;) {
    if (at >= message.length) return null;
    const length = message[at];
    if (length === 0) { at += 1; break; }
    if (length > 63) return null;
    total += length + 1;
    if (total > 255 || at + 1 + length > message.length) return null;
    labels.push(message.toString("latin1", at + 1, at + 1 + length));
    at += 1 + length;
  }
  if (at + 4 > message.length) return null;
  return {
    name: labels.join(".").toLowerCase(),
    type: message.readUInt16BE(at),
    class: message.readUInt16BE(at + 2),
    end: at + 4,
  };
}

function record(owner, type, ttl, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(CLASS_IN, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([owner, head, data]);
}

function caa(flags, tag, value) {
  const tagBytes = Buffer.from(tag, "latin1");
  return Buffer.concat([Buffer.from([flags, tagBytes.length]), tagBytes, Buffer.from(value, "utf8")]);
}

/**
 * The zone's fixed data. `addresses` are the relay's published IPv4 and
 * IPv6 addresses; `nameServers` the zone's NS names; `hostmaster` the SOA
 * contact as a domain name (hostmaster.example.org).
 */
export function zoneConfig({ zone, relayName, addresses = [], nameServers, hostmaster, serial = Math.floor(Date.now() / 1000) >>> 0 }) {
  if (!isHostName(zone)) throw new RangeError("DNS zone must be a host name");
  const parsed = addresses.map((address) => addressBytes(address));
  return {
    zone,
    relayName,
    v4: parsed.filter((entry) => entry.family === 4).map((entry) => entry.bytes.subarray(0, 4)),
    v6: parsed.filter((entry) => entry.family === 6).map((entry) => entry.bytes),
    nameServers: nameServers?.length ? nameServers : [`ns1.${zone}`, `ns2.${zone}`],
    hostmaster: hostmaster ?? `hostmaster.${zone}`,
    serial,
  };
}

/**
 * Answers one query message. `lookup(name)` returns `{ routed,
 * caaAccountUri }` for a name directly under the zone (the registry's
 * dnsInfo). Returns the response bytes, or null to send nothing (a
 * response, or bytes too short to answer).
 */
export function answerQuery(message, config, lookup, { udp = true } = {}) {
  if (message.length < 12) return null;
  const flags = message.readUInt16BE(2);
  if (flags & 0x8000) return null;
  const opcode = (flags >> 11) & 0xf;
  const rd = flags & 0x0100;
  const header = (rcode, counts = [0, 0, 0], aa = true, tc = false, withQuestion = true) => {
    const bytes = Buffer.alloc(12);
    message.copy(bytes, 0, 0, 2);
    bytes.writeUInt16BE(0x8000 | (opcode << 11) | (aa ? 0x0400 : 0) | (tc ? 0x0200 : 0) | rd | rcode, 2);
    bytes.writeUInt16BE(withQuestion ? 1 : 0, 4);
    bytes.writeUInt16BE(counts[0], 6);
    bytes.writeUInt16BE(counts[1], 8);
    bytes.writeUInt16BE(counts[2], 10);
    return bytes;
  };
  if (opcode !== 0) return header(Rcode.NOTIMP, undefined, false, false, false);
  if (message.readUInt16BE(4) !== 1) return header(Rcode.FORMERR, undefined, false, false, false);
  const question = readQuestion(message);
  if (!question) return header(Rcode.FORMERR, undefined, false, false, false);
  const questionBytes = message.subarray(12, question.end);
  const { name, type } = question;
  const { zone } = config;
  const inZone = name === zone || name.endsWith(`.${zone}`);
  if (question.class !== CLASS_IN || !inZone) return Buffer.concat([header(Rcode.REFUSED, undefined, false), questionBytes]);

  // The question's name is at offset 12; the zone apex is a suffix of it.
  const QNAME = Buffer.from([0xc0, 12]);
  const apexOffset = 12 + (name === zone ? 0 : Buffer.byteLength(name) - Buffer.byteLength(zone));
  const APEX = Buffer.from([0xc0 | (apexOffset >> 8), apexOffset & 0xff]);
  const soa = () => {
    const tail = Buffer.alloc(20);
    tail.writeUInt32BE(config.serial, 0);
    tail.writeUInt32BE(3600, 4);
    tail.writeUInt32BE(600, 8);
    tail.writeUInt32BE(604_800, 12);
    tail.writeUInt32BE(NEGATIVE_TTL, 16);
    return record(APEX, Type.SOA, NS_TTL, Buffer.concat([encodeName(config.nameServers[0]), encodeName(config.hostmaster), tail]));
  };
  const addressRecords = () => type === Type.A ? config.v4.map((bytes) => record(QNAME, Type.A, TTL, bytes))
    : type === Type.AAAA ? config.v6.map((bytes) => record(QNAME, Type.AAAA, TTL, bytes)) : [];

  let answers = [];
  let rcode = Rcode.NOERROR;
  if (name === zone) {
    if (type === Type.SOA) answers = [soa()];
    else if (type === Type.NS) answers = config.nameServers.map((server) => record(QNAME, Type.NS, NS_TTL, encodeName(server)));
    else if (type === Type.CAA) answers = [record(QNAME, Type.CAA, TTL, caa(0, "issue", ";"))];
  } else if (config.nameServers.includes(name) || name === config.relayName) {
    answers = addressRecords();
  } else {
    const label = name.slice(0, -(zone.length + 1));
    const info = label.includes(".") ? { routed: false } : lookup(name);
    if (!info.routed) rcode = Rcode.NXDOMAIN;
    else if (type === Type.A || type === Type.AAAA) answers = addressRecords();
    else if (type === Type.CAA && info.caaAccountUri) answers = [
      record(QNAME, Type.CAA, TTL, caa(0, "issue", `letsencrypt.org; accounturi=${info.caaAccountUri}; validationmethods=tls-alpn-01`)),
      record(QNAME, Type.CAA, TTL, caa(0, "issuewild", ";")),
    ];
    // Everything else, HTTPS (65) included, has no record: NODATA.
  }
  const authority = answers.length === 0 ? [soa()] : [];
  let response = Buffer.concat([header(rcode, [answers.length, authority.length, 0]), questionBytes, ...answers, ...authority]);
  if (udp && response.length > UDP_LIMIT) response = Buffer.concat([header(rcode, [0, 0, 0], true, true), questionBytes]);
  return response;
}

/**
 * Serves the zone on UDP and TCP `port` at `host`. TCP connections are
 * length-prefixed (RFC 1035 §4.2.2), idle-closed after 10 seconds, and
 * limited in number. Nothing about a query is logged or kept.
 */
export async function createDnsServer(options) {
  // Port 0 (tests) lets the system pick a free UDP port, and TCP must then
  // listen on the same number, which may already be taken for TCP (on
  // Windows a loopback client socket holds its port, and that fails as
  // EADDRINUSE; a number in a range Windows keeps back from TCP fails as
  // EACCES, and such ranges run to hundreds of numbers): pick again (#469).
  // The system gives out numbers in order, so asking it again only steps
  // one number further into the same range; later picks are random.
  for (let attempt = 1; ; attempt += 1) {
    const port = options.port === 0 && attempt > 1 ? randomDynamicPort() : options.port;
    try { return await openDnsServer({ ...options, port }); }
    catch (error) { if (options.port !== 0 || !["EADDRINUSE", "EACCES"].includes(error.code) || attempt === 20) throw error; }
  }
}

// A number in the dynamic range (RFC 6335 §6).
export function randomDynamicPort() {
  return 49152 + Math.floor(Math.random() * 16384);
}

async function openDnsServer({ host, port, config, lookup, maxTcpConnections = 512, onError = () => {} }) {
  const udp = createSocket({ type: host?.includes(":") ? "udp6" : "udp4", reuseAddr: false });
  udp.on("message", (message, peer) => {
    let response = null;
    try { response = answerQuery(message, config, lookup, { udp: true }); } catch { onError("dns-failure"); }
    if (response) udp.send(response, peer.port, peer.address);
  });
  // A random pick may be taken for UDP too; a failed bind leaves no socket
  // open and is not a DNS error, since the caller picks again.
  await new Promise((resolve, reject) => {
    const failed = (error) => { udp.close(); reject(error); };
    udp.once("error", failed);
    udp.bind(port, host, () => { udp.off("error", failed); resolve(); });
  });
  udp.on("error", () => onError("dns-udp"));

  const open = new Set();
  const tcp = createServer((socket) => {
    if (open.size >= maxTcpConnections) { socket.destroy(); return; }
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("error", () => {});
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 2 + 65_535) { socket.destroy(); return; }
      while (pending.length >= 2) {
        const length = pending.readUInt16BE(0);
        if (pending.length < 2 + length) break;
        const message = pending.subarray(2, 2 + length);
        pending = pending.subarray(2 + length);
        let response = null;
        try { response = answerQuery(message, config, lookup, { udp: false }); } catch { onError("dns-failure"); }
        if (!response) { socket.destroy(); return; }
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(response.length, 0);
        socket.write(Buffer.concat([prefix, response]));
      }
    });
  });
  await new Promise((resolve, reject) => {
    // A failed start leaves no UDP socket open to keep the process alive.
    const failed = (error) => { udp.close(); reject(error); };
    tcp.once("error", failed);
    // A port net can't take at all (above 65535, which dgram cuts to 16
    // bits) throws here instead of emitting an error.
    try { tcp.listen(port === 0 ? udp.address().port : port, host, () => { tcp.off("error", failed); resolve(); }); } catch (error) { failed(error); }
  });
  return {
    udpPort: udp.address().port,
    tcpPort: tcp.address().port,
    close: () => Promise.all([
      new Promise((resolve) => udp.close(resolve)),
      new Promise((resolve) => { tcp.close(resolve); for (const socket of open) socket.destroy(); }),
    ]),
  };
}

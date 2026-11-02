// Does a domain publish an Encrypted Client Hello configuration? (ADR 0025
// §4, #719.) With ECH a browser hides the real name inside the ClientHello,
// so the connection relay, which routes by the visible name, couldn't route
// it. Some DNS providers add an `ech` parameter to HTTPS (type 65) records
// on their own, so the setup page checks an own domain before using it.
//
// Node's resolver has no HTTPS record type, so this sends one plain DNS
// query over UDP to the computer's first configured resolver and reads the
// answer's SvcParams (RFC 9460 §2.2): key 5 is `ech`. Only what is needed
// is parsed, every length is checked against the bytes that remain, and a
// truncated, failed or unreadable answer is "unknown" (null), never "no".
import { createSocket } from "node:dgram";
import { getServers } from "node:dns";
import { randomInt } from "node:crypto";
import { isIP } from "node:net";

const TYPE_HTTPS = 65;
const CLASS_IN = 1;
const KEY_ECH = 5;

/** A host name in DNS wire form, uncompressed. (relay/dns.mjs has the same
 * encoder, but only relay/ktun.mjs ships with the home server.) */
function encodeName(name) {
  const bytes = [];
  for (const label of name.split(".")) bytes.push(label.length, ...Buffer.from(label, "latin1"));
  bytes.push(0);
  return Buffer.from(bytes);
}

/** The query bytes for `name`'s HTTPS records, recursion desired. */
export function httpsQuery(name, id = randomInt(0x10000)) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE_HTTPS, 0);
  question.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, encodeName(name), question]);
}

/** The offset just past a (possibly compressed) name at `at`, or -1. */
function skipName(message, at) {
  for (let hops = 0; hops < 128; hops += 1) {
    if (at >= message.length) return -1;
    const length = message[at];
    if (length === 0) return at + 1;
    if ((length & 0xc0) === 0xc0) return at + 2 <= message.length ? at + 2 : -1;
    if (length > 63) return -1;
    at += 1 + length;
  }
  return -1;
}

/**
 * Reads a DNS answer to an HTTPS query. Returns { ech: boolean } when the
 * answer is complete (ech is true when any HTTPS record carries the `ech`
 * key), or null when it can't tell (truncated, an error code other than
 * NXDOMAIN, the wrong ID, or malformed).
 */
export function readHttpsAnswer(message, id) {
  if (!Buffer.isBuffer(message) || message.length < 12) return null;
  if (id !== undefined && message.readUInt16BE(0) !== id) return null;
  const flags = message.readUInt16BE(2);
  if (!(flags & 0x8000) || (flags & 0x0200)) return null; // not a response, or truncated
  const rcode = flags & 0x000f;
  if (rcode === 3) return { ech: false };
  if (rcode !== 0) return null;
  const questions = message.readUInt16BE(4);
  const answers = message.readUInt16BE(6);
  let at = 12;
  for (let index = 0; index < questions; index += 1) {
    at = skipName(message, at);
    if (at < 0 || at + 4 > message.length) return null;
    at += 4;
  }
  let ech = false;
  for (let index = 0; index < answers; index += 1) {
    at = skipName(message, at);
    if (at < 0 || at + 10 > message.length) return null;
    const type = message.readUInt16BE(at);
    const length = message.readUInt16BE(at + 8);
    at += 10;
    if (at + length > message.length) return null;
    if (type === TYPE_HTTPS) {
      const rdata = message.subarray(at, at + length);
      // priority:u16, then TargetName, never compressed (RFC 9460 §2.2).
      let offset = 2;
      for (;;) {
        if (offset >= rdata.length) return null;
        const label = rdata[offset];
        if (label === 0) { offset += 1; break; }
        if (label > 63) return null;
        offset += 1 + label;
      }
      while (offset < rdata.length) {
        if (offset + 4 > rdata.length) return null;
        const key = rdata.readUInt16BE(offset);
        const size = rdata.readUInt16BE(offset + 2);
        offset += 4 + size;
        if (offset > rdata.length) return null;
        if (key === KEY_ECH) ech = true;
      }
    }
    at += length;
  }
  return { ech };
}

/** "1.2.3.4", "1.2.3.4:53", "2001:db8::1" or "[2001:db8::1]:53" as
 * { address, port }, or null. */
export function parseServer(text) {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) return isIP(bracketed[1]) ? { address: bracketed[1], port: Number(bracketed[2] ?? 53) } : null;
  if (isIP(text)) return { address: text, port: 53 };
  const withPort = /^([\d.]+):(\d+)$/.exec(text);
  return withPort && isIP(withPort[1]) === 4 ? { address: withPort[1], port: Number(withPort[2]) } : null;
}

/**
 * Asks the computer's resolver whether `name` publishes ECH. Resolves with
 * true, false, or null when it couldn't find out within `timeoutMs`.
 */
export function publishesEch(name, { servers = getServers(), timeoutMs = 5_000 } = {}) {
  const server = servers.map(parseServer).find(Boolean);
  if (!server) return Promise.resolve(null);
  const id = randomInt(0x10000);
  return new Promise((resolve) => {
    const socket = createSocket(isIP(server.address) === 6 ? "udp6" : "udp4");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.on("error", () => finish(null));
    socket.on("message", (message, from) => {
      if (from.address !== server.address && !from.address.endsWith(server.address)) return;
      const answer = readHttpsAnswer(message, id);
      finish(answer ? answer.ech : null);
    });
    socket.send(httpsQuery(name, id), server.port, server.address, (error) => { if (error) finish(null); });
  });
}

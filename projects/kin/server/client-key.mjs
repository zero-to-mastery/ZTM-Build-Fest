// Which client a request comes from, for per-client limits (pairing-code
// guessing; bootstrap limits reuse it).
//
// Kin listens on loopback, so a hosted deployment sits behind a TLS proxy and
// every request arrives from the proxy's address. (A home server's tunnel
// connections are the exception: their address comes from the relay, see
// trustTunnelPeer below.) Without configuration that
// is all Kin can see, and every client shares one limit. An operator who runs
// a proxy that appends the real client address to X-Forwarded-For lists that
// proxy's address in KIN_TRUSTED_PROXIES. Only then is the header read, and
// only from those addresses.
import { isIP } from "node:net";

// Sockets that arrived through the home server's authenticated tunnel, and
// the phone address the relay gave for each. Only server/home/ adds to it,
// for TLS sockets it made itself from tunnel streams; a socket from the
// loopback listener is never in it, so direct connections keep the rules
// above.
const tunnelPeers = new WeakMap();

/** Marks `socket` as a tunnel stream whose client is `address` (from OPEN). */
export function trustTunnelPeer(socket, address) {
  tunnelPeers.set(socket, normalizeAddress(address));
}

/** The OPEN address of a tunnel socket, or null for any other socket. */
export function tunnelPeer(socket) {
  return tunnelPeers.get(socket) ?? null;
}

/** Parses KIN_TRUSTED_PROXIES: comma-separated IP addresses. Empty means off. */
export function parseTrustedProxies(value) {
  if (value === undefined || value === null || value === "") return new Set();
  const entries = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries)
    if (!isIP(normalizeAddress(entry)))
      throw Object.assign(
        new Error(`KIN_TRUSTED_PROXIES must list IP addresses; "${entry}" is not one.`),
        { code: "trusted_proxies_invalid" },
      );
  return new Set(entries.map(normalizeAddress));
}

/** IPv4-mapped IPv6 ("::ffff:203.0.113.5") compares equal to its IPv4 form. */
export function normalizeAddress(address) {
  const value = String(address ?? "").trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return (mapped ? mapped[1] : value).toLowerCase();
}

/**
 * The rate-limit key for `request`. With no trusted proxies, or when the
 * connection is not from one, it is the socket's address and any
 * X-Forwarded-For header is ignored. From a trusted proxy it is the
 * right-most forwarded hop that is not itself a trusted proxy: hops to its
 * left were written by the client and can be spoofed. A malformed hop falls
 * back to the proxy's own address, which never loosens the limit.
 */
export function clientKey(request, trustedProxies) {
  // A connection through the home server's tunnel (ADR 0025 §2, #736): the
  // relay reported the phone's address in the stream's OPEN frame, outside
  // the HTTP request where a phone can't forge it. That address is the key,
  // per IPv4 address or IPv6 /64, and X-Forwarded-For is ignored: no proxy
  // sits between the relay and the home server.
  const tunneled = tunnelPeers.get(request.socket);
  if (tunneled !== undefined) return isIP(tunneled) ? limitKey(tunneled) : "unknown";
  const peer = normalizeAddress(request.socket?.remoteAddress) || "unknown";
  if (!trustedProxies?.size || !trustedProxies.has(peer)) return peer;
  const header = request.headers?.["x-forwarded-for"];
  if (typeof header !== "string" || header.length > 4096) return peer;
  const hops = header.split(",").map(normalizeAddress);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index];
    // A zone ID ("fe80::1%eth0") is never a client address over the
    // network, and isIP accepts any text after "%": treat it as malformed.
    if (hop.includes("%") || !isIP(hop)) return peer;
    if (!trustedProxies.has(hop)) return limitKey(hop);
  }
  return peer;
}

/**
 * One limit per IPv4 address, and one per IPv6 /64: a single IPv6 network
 * holds billions of addresses, so per-address limits would let one network
 * pose as many clients. Expects a valid, normalized IP.
 */
export function limitKey(address) {
  if (isIP(address) !== 6) return address;
  const [head, tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // An embedded IPv4 tail occupies two groups; it never reaches the /64 prefix.
  const width = (groups) => groups.reduce((sum, group) => sum + (group.includes(".") ? 2 : 1), 0);
  const groups = address.includes("::")
    ? [...left, ...Array(8 - width(left) - width(right)).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}

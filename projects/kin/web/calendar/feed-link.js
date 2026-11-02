// Calendar subscription links (#665, ADR 0022 §3): what a member may paste,
// and the name a synced calendar is shown under. Shared by the service
// (server/calendar-sync-service.mjs, which decides) and the device (which
// checks early, so a typo is caught before anything is sent).
//
// A link is accepted when, after trimming:
// - it is `https://`, or `webcal://` / `webcals://`, which calendar apps use
//   for the same thing and which become `https://`;
// - it names a host, not an address in the link itself that is private,
//   loopback or otherwise not public (the service checks every address the
//   host resolves to again, on every fetch and every redirect);
// - it has no user name or password, and no port but 443;
// - it is at most 2,048 characters.
// A `#fragment` is dropped: it never reaches the calendar's server anyway.

export const MAX_FEED_URL_LENGTH = 2048;
export const FEED_AUDIENCES = Object.freeze(["me", "household"]);
/** Shown before a member turns sync on (ADR 0022 §3), word for word. */
export const FEED_WARNING = "Your Kin server will download this calendar about every 30 minutes and can read it while it does.";

export class FeedLinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeedLinkError";
    this.code = code;
  }
}

const MESSAGES = Object.freeze({
  calendar_link_invalid: "That doesn't look like a calendar link. Copy the private iCal (.ics) link from your calendar's settings.",
  calendar_link_not_https: "Kin can only sync calendar links that start with https:// or webcal://.",
  calendar_link_credentials: "That link has a user name or password in it. Use the calendar's private link instead.",
  calendar_link_port: "Kin can only sync calendars served on the standard secure port.",
  calendar_link_too_long: "That link is too long.",
  calendar_link_address: "That link points to a private or local address, which Kin won't fetch.",
});

const fail = (code) => new FeedLinkError(code, MESSAGES[code]);

/** The link as Kin stores and fetches it: an `https:` URL string. Throws a
 * FeedLinkError (with `code`) when the link can't be synced. */
export function normalizeFeedUrl(text) {
  if (typeof text !== "string") throw fail("calendar_link_invalid");
  let value = text.trim();
  if (!value) throw fail("calendar_link_invalid");
  if (value.length > MAX_FEED_URL_LENGTH) throw fail("calendar_link_too_long");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme === "webcal" || scheme === "webcals") value = `https:${value.slice(scheme.length + 1)}`;
  else if (scheme !== "https") throw fail(scheme ? "calendar_link_not_https" : "calendar_link_invalid");
  let url;
  try { url = new URL(value); } catch { throw fail("calendar_link_invalid"); }
  if (url.protocol !== "https:" || !url.hostname) throw fail("calendar_link_invalid");
  if (url.username || url.password) throw fail("calendar_link_credentials");
  if (url.port && url.port !== "443") throw fail("calendar_link_port");
  if (literalAddress(url.hostname) && !isPublicAddress(literalAddress(url.hostname))) throw fail("calendar_link_address");
  if (isLocalName(url.hostname)) throw fail("calendar_link_address");
  url.hash = "";
  const result = url.href;
  if (result.length > MAX_FEED_URL_LENGTH) throw fail("calendar_link_too_long");
  return result;
}

/** Host names that only ever mean this machine or the local network. */
export function isLocalName(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host.endsWith(".internal") || host.endsWith(".home.arpa") || !host.includes(".") && !literalAddress(host);
}

/** The address a URL hostname spells out, or null for a name. */
export function literalAddress(hostname) {
  const host = String(hostname);
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return parseIPv4(host) ? host : null;
}

// ---------------------------------------------------------------------------
// Which addresses are public. Written out here (no dependency, and the same
// answer in the browser and the service): every address a calendar host
// resolves to must be ordinary public unicast.

function parseIPv4(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

/** An IPv6 address as a BigInt, or null. Accepts an embedded IPv4 tail and
 * drops a zone (`%eth0`). */
function parseIPv6(text) {
  let value = String(text).toLowerCase();
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(value) || !value.includes(":")) return null;
  const lastColon = value.lastIndexOf(":");
  const last = value.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (v4 === null) return null;
    value = `${value.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups = head;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array(fill).fill("0"), ...rest];
  }
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [parseIPv4(base), bits]);

const inV4 = (value, base, bits) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));

const V6_BLOCKED = [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
].map(([base, bits]) => [parseIPv6(base), bits]);

const inV6 = (value, base, bits) => (value >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));

/** Whether `address` (IPv4 or IPv6 text) is public unicast: not private,
 * loopback, link-local, multicast, documentation, benchmarking, carrier NAT,
 * 6to4 or Teredo, or otherwise reserved. An IPv6 form of an IPv4 address
 * (mapped or NAT64) is judged by that IPv4 address. Anything unparseable is
 * not public. */
export function isPublicAddress(address) {
  const v4 = parseIPv4(address);
  if (v4 !== null) return !V4_BLOCKED.some(([base, bits]) => inV4(v4, base, bits));
  const v6 = parseIPv6(address);
  if (v6 === null) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and the well-known NAT64 prefix carry an
  // IPv4 address: judge that one.
  if (inV6(v6, parseIPv6("::ffff:0:0"), 96) || inV6(v6, parseIPv6("64:ff9b::"), 96)) {
    const embedded = Number(v6 & 0xffffffffn);
    return isPublicAddress([embedded >>> 24, (embedded >>> 16) & 255, (embedded >>> 8) & 255, embedded & 255].join("."));
  }
  // Global unicast is 2000::/3; everything else is reserved.
  if (!inV6(v6, parseIPv6("2000::"), 3)) return false;
  return !V6_BLOCKED.some(([base, bits]) => inV6(v6, base, bits));
}

// ---------------------------------------------------------------------------
// The name a synced calendar shows under: "From Google".

const SOURCES = Object.freeze([
  [/(^|\.)google\.com$/, "Google"],
  [/(^|\.)icloud\.com$/, "Apple"],
  [/(^|\.)(outlook\.office365\.com|outlook\.office\.com|outlook\.live\.com|outlook\.com|live\.com|hotmail\.com)$/, "Outlook"],
]);

/** "Google", "Apple" or "Outlook" for their calendar hosts, else the host. */
export function feedSourceName(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return "Calendar"; }
  for (const [pattern, name] of SOURCES) if (pattern.test(host)) return name;
  return host.replace(/^www\./, "");
}

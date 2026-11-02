// The one rule for a web address that must reach the public web (ADR 0153, #213): the browser and
// hosted-function half of `openblog_core::citations::public_url_problem`, which the publication
// boundary, the citation review and a suggestion's link all use. Both read
// tests/fixtures/public-urls.json and must agree on every address and its reason.
//
// Only a plain `http` or `https` address without credentials, naming a public host (not
// `localhost`, a single-label or private-suffix name, or a loopback, private, link-local,
// site-local, benchmarking, multicast, reserved or NAT64 address, in any way an IPv4 address can be
// written or embedded in an IPv6 one) and carrying no query or fragment parameter named like a
// secret. Nothing is fetched: the address is only read.

const PRIVATE_SUFFIXES = [
  ".localhost",
  ".localhost.localdomain",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".intranet",
  ".corp",
  ".test",
  ".home",
  ".localdomain",
];

const SECRET_WORDS = new Set([
  "token", "secret", "password", "passwd", "pass", "pwd", "sig", "signature", "credential", "credentials",
  "auth", "authorization", "session", "jwt", "bearer",
]);
// `key` is secret alone or when one of these says what it opens.
const KEY_OWNERS = new Set([
  "api", "access", "secret", "private", "auth", "license", "licence", "client", "app", "subscription", "signing", "encryption", "master",
]);
const COMPOUNDS = new Set([
  "apikey", "xapikey", "appkey", "accesskey", "awsaccesskeyid", "secretkey", "privatekey", "authkey", "licensekey", "clientkey",
  "signingkey", "accesstoken", "authtoken", "idtoken", "refreshtoken", "sessiontoken", "sessionid", "bearertoken", "xamzsignature",
  "xamzcredential", "xamzsecuritytoken", "clientsecret", "apisecret", "apitoken",
]);

const WHITE_SPACE = "\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const TRIM = new RegExp(`^[${WHITE_SPACE}]+|[${WHITE_SPACE}]+$`, "gu");

const isAsciiAlphanumeric = (character) => /^[A-Za-z0-9]$/.test(character);
const isAsciiUpper = (character) => /^[A-Z]$/.test(character);
const isAsciiLower = (character) => /^[a-z]$/.test(character);
const isAsciiDigit = (character) => /^[0-9]$/.test(character);

/** The lower-cased words of a parameter name, split at anything that is not a letter or digit and at camelCase boundaries. */
function parameterWords(name) {
  const chars = Array.from(String(name));
  const words = [];
  let word = "";
  chars.forEach((character, index) => {
    if (!isAsciiAlphanumeric(character)) {
      if (word) words.push(word);
      word = "";
      return;
    }
    const previous = chars[index - 1];
    const next = chars[index + 1];
    const boundary = isAsciiUpper(character) && word !== "" && (isAsciiLower(previous) || isAsciiDigit(previous) || (next !== undefined && isAsciiLower(next) && isAsciiUpper(previous)));
    if (boundary) {
      words.push(word);
      word = "";
    }
    word += character.toLowerCase();
  });
  if (word) words.push(word);
  return words;
}

/** Whether a query or fragment parameter is named like a secret, matched by whole word. */
function secretParameter(name) {
  const words = parameterWords(name);
  const joined = words.join("");
  if (joined === "key" || COMPOUNDS.has(joined)) return true;
  return words.some((word, index) => SECRET_WORDS.has(word) || COMPOUNDS.has(word) || (word === "key" && index > 0 && KEY_OWNERS.has(words[index - 1])));
}

function privateIpv4(octets) {
  const [a, b] = octets;
  return (
    a === 127 || // loopback
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local
    (octets.every((octet) => octet === 0)) || // unspecified
    octets.every((octet) => octet === 255) || // broadcast
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** The eight 16-bit groups of an IPv6 address as a URL writes it (without brackets), or null. */
function ipv6Segments(text) {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return all.map((group) => Number.parseInt(group, 16));
}

const bytesOf = (high, low) => [high >> 8, high & 0xff, low >> 8, low & 0xff];

function privateIpv6(segments) {
  const [first] = segments;
  const embedded = (high, low) => privateIpv4(bytesOf(high, low));
  const zeros = (count) => segments.slice(0, count).every((segment) => segment === 0);
  const loopback = zeros(7) && segments[7] === 1;
  const unspecified = zeros(8);
  const mapped = zeros(5) && segments[5] === 0xffff && privateIpv4(bytesOf(segments[6], segments[7]));
  return (
    loopback ||
    unspecified ||
    mapped ||
    // The deprecated IPv4-compatible form `::a.b.c.d` embeds one too.
    (zeros(6) && embedded(segments[6], segments[7])) ||
    // 6to4, 2002::/16, carries its IPv4 address in the next 32 bits.
    (first === 0x2002 && embedded(segments[1], segments[2])) ||
    // Multicast, ff00::/8.
    (first & 0xff00) === 0xff00 ||
    // The NAT64 prefix 64:ff9b::/96 embeds any IPv4 address.
    (first === 0x64 && segments[1] === 0xff9b && segments.slice(2, 6).every((segment) => segment === 0)) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    // Deprecated site-local addresses, fec0::/10.
    (first & 0xffc0) === 0xfec0
  );
}

/**
 * Why a web address may not be reached as public, or `null` when it may: the messages are
 * `public_url_problem`'s, word for word.
 */
export function publicUrlProblem(value) {
  let url;
  try {
    url = new URL(String(value).replace(TRIM, ""));
  } catch {
    return "it is not a web address";
  }
  if (!["http:", "https:"].includes(url.protocol)) return "only http and https addresses are published";
  if (url.username !== "" || url.password !== "") return "it carries a user name or password";
  const host = url.hostname;
  let privateHost;
  if (host === "") {
    privateHost = true;
  } else if (host.startsWith("[")) {
    const segments = ipv6Segments(host.slice(1, -1));
    privateHost = segments === null ? true : privateIpv6(segments);
  } else if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host)) {
    privateHost = privateIpv4(host.split(".").map(Number));
  } else {
    const domain = host.replace(/\.+$/, "").toLowerCase();
    privateHost = !domain.includes(".") || domain === "localhost.localdomain" || PRIVATE_SUFFIXES.some((suffix) => domain.endsWith(suffix));
  }
  if (privateHost) return "it names a private or local network address readers cannot reach";
  // The query, and a fragment written as `name=value` pairs, as the single-page apps that read a
  // token from the fragment write it. A fragment with no `=` is a heading anchor, not a pair.
  for (const [name] of url.searchParams) if (secretParameter(name)) return "it carries a query parameter named like a key, token or signature";
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (fragment.includes("=")) {
    for (const [name] of new URLSearchParams(fragment)) if (secretParameter(name)) return "it carries a fragment parameter named like a key, token or signature";
  }
  return null;
}

// Sign-in links (#98). A computer signing in with a phone shows a QR code for
// `/link#r=<request>&s=<secret>&f=<fingerprint>&c=<nonce>`. Everything rides
// in the fragment, which browsers never send to a server. The phone reads the
// link with Kin's own scanner and sends the request ID, the secret and the
// fingerprint to the service in request bodies. The nonce never leaves the
// two devices: it travels only through the camera.
//
// The 6-digit code and its tag. The phone picks the code at random and
// shows it. It also sends the service a tag: an HMAC over the request, its
// own device ID and key fingerprint, and the computer's fingerprint, keyed by
// a hash of the nonce and the code (linkTag). The service checks the code the
// computer types (three tries) and only then hands over which device
// approved, its fingerprint and the tag. The computer recomputes the tag from
// the nonce and the code the person typed, and pins that phone's key only if
// it matches.
// - Someone holding only the QR code has the nonce but not the code, and gets
//   nothing back without the right code: three tries in a million.
// - The service has the code but not the nonce, so it can't make a tag for a
//   device of its own.
// - Only the service and a QR holder working together could; comparing
//   fingerprints by eye is the only defence against that (THREAT-MODEL).
//
// The secret and nonce are base64url and case-sensitive, so these helpers read
// the link as given and never through the router, which lower-cases
// fragments.

export const LINK_PATH = "/link";
/** The 6-digit code the phone shows and the computer types. */
export const LINK_CODE_LENGTH = 6;

const REQUEST_ID = /^[a-f0-9]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_LINK = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** A fresh nonce for one request: 16 random bytes. */
export function linkNonce(random = globalThis.crypto) {
  return base64url(random.getRandomValues(new Uint8Array(16)));
}

/** The sign-in link for a request on `origin`. The fingerprint (64 hex) is
 * carried as base64url to keep the QR code small. */
export function signInLink(origin, { requestId, secret, fingerprint, nonce }) {
  const bytes = Uint8Array.from(fingerprint.match(/../g), (pair) => parseInt(pair, 16));
  return `${origin}${LINK_PATH}#r=${requestId}&s=${secret}&f=${base64url(bytes)}&c=${nonce}`;
}

/** The request in a scanned sign-in link, or null unless the link is exactly
 * one on `origin` with a well-formed request ID, secret, fingerprint and
 * nonce, and nothing else. The fingerprint comes back as 64 hex. */
export function signInRequest(link, origin) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (typeof origin !== "string" || url.origin !== origin || url.pathname !== LINK_PATH) return null;
  if (url.search || url.username || url.password) return null;
  const fields = new Map();
  for (const part of url.hash.replace(/^#/, "").split("&")) {
    const at = part.indexOf("=");
    if (at < 1) return null;
    const name = part.slice(0, at);
    if (fields.has(name)) return null;
    fields.set(name, part.slice(at + 1));
  }
  if (fields.size !== 4) return null;
  const requestId = fields.get("r") ?? "";
  const secret = fields.get("s") ?? "";
  const packed = fields.get("f") ?? "";
  const nonce = fields.get("c") ?? "";
  if (!REQUEST_ID.test(requestId) || !SECRET.test(secret) || !FINGERPRINT_LINK.test(packed) || !NONCE.test(nonce))
    return null;
  const bytes = fromBase64url(packed);
  if (bytes.length !== 32) return null;
  const fingerprint = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { requestId, secret, fingerprint, nonce };
}

/** A random 6-digit code, without bias (values past the last whole million
 * are drawn again). */
export function newLinkCode(random = globalThis.crypto) {
  const limit = 4_294_000_000; // 4294 × 10^6, the largest multiple below 2^32
  const value = new Uint32Array(1);
  do random.getRandomValues(value); while (value[0] >= limit);
  return String(value[0] % 1_000_000).padStart(LINK_CODE_LENGTH, "0");
}

/** The tag binding the approving device to the code and the QR code's nonce:
 * HMAC-SHA-256 keyed by SHA-256(label | nonce | code), over the request ID,
 * the approving device's ID and fingerprint, and the computer's fingerprint,
 * as base64url. */
export async function linkTag({ nonce, code, requestId, approverDeviceId, approverFingerprint, computerFingerprint }) {
  if (!NONCE.test(nonce ?? "") || !/^[0-9]{6}$/.test(code ?? "") || !REQUEST_ID.test(requestId ?? "") ||
      !REQUEST_ID.test(approverDeviceId ?? "") || !FINGERPRINT.test(approverFingerprint ?? "") || !FINGERPRINT.test(computerFingerprint ?? ""))
    throw new Error("Kin could not check the sign-in.");
  const encoder = new TextEncoder();
  const subtle = globalThis.crypto.subtle;
  const keyBytes = await subtle.digest("SHA-256", encoder.encode(`kin-link-key-v1|${nonce}|${code}`));
  const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const tag = await subtle.sign("HMAC", key, encoder.encode(`kin-link-tag-v1|${requestId}|${approverDeviceId}|${approverFingerprint}|${computerFingerprint}`));
  return base64url(new Uint8Array(tag));
}

/** Whether `tag` is the tag for these values (compared in full). */
export async function linkTagMatches(tag, values) {
  let expected;
  try {
    expected = await linkTag(values);
  } catch {
    return false;
  }
  if (typeof tag !== "string" || tag.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < tag.length; index += 1) difference |= tag.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

let openedLink = false;

/** A sign-in link opened in a browser, say by a phone's camera app, rather
 * than read by Kin's scanner: drop it from the address (and so from the
 * page's history entry) before any route is resolved, and remember that it
 * happened so People & devices can say where to scan it (kin-app.js). */
export function takeSignInLink(where = globalThis.location, past = globalThis.history) {
  if (!where || where.pathname !== LINK_PATH) return false;
  past?.replaceState(null, "", "/");
  openedLink = true;
  return true;
}

/** Whether a sign-in link was opened, once. */
export function consumeOpenedSignInLink() {
  const opened = openedLink;
  openedLink = false;
  return opened;
}

/** The digits of a typed code: spaces and dashes dropped, at most six. */
export function cleanLinkCode(raw) {
  return String(raw ?? "").replace(/[\s-]/g, "").slice(0, LINK_CODE_LENGTH);
}

/** Whether `code` is a whole 6-digit code. */
export function isLinkCode(code) {
  return /^[0-9]{6}$/.test(code);
}

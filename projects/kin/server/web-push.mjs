// Web Push without dependencies (#85, #86): VAPID (RFC 8292) authentication
// and aes128gcm payload encryption (RFC 8291, RFC 8188), on node:crypto and
// node:https. Kin's payload is fixed and content-free; this module would
// encrypt anything, but the notifier only ever sends {"v":1,"kind":"new"}.
import { createCipheriv, createDecipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
export const fromB64url = (text) => Buffer.from(String(text), "base64url");

/** Push services Kin will contact. Endpoints anywhere else are refused, so a
 * subscription can't make the service send requests into other networks. */
export const PUSH_SERVICE_HOSTS = Object.freeze([
  "fcm.googleapis.com",
  "*.push.services.mozilla.com",
  "*.push.apple.com",
  "*.notify.windows.com",
]);

/** The endpoint as a URL if Kin may send to it, otherwise null: https on
 * port 443, a DNS name on the allowlist, no credentials. */
export function allowedPushEndpoint(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase();
  if (!host || isIP(host.replace(/^\[|\]$/g, "")) || String(value).length > 2048) return null;
  const allowed = PUSH_SERVICE_HOSTS.some((pattern) => pattern.startsWith("*.")
    ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
    : host === pattern);
  return allowed ? url : null;
}

// ---- VAPID (RFC 8292) -------------------------------------------------------

/** A new VAPID key pair as JWKs (P-256). */
export function generateVapidKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateJwk: privateKey.export({ format: "jwk" }), publicJwk: publicKey.export({ format: "jwk" }) };
}

/** The uncompressed public point (65 bytes) of a P-256 JWK. */
export function rawPublicKey(publicJwk) {
  return Buffer.concat([Buffer.from([4]), fromB64url(publicJwk.x), fromB64url(publicJwk.y)]);
}

/** The Authorization header value for an endpoint: an ES256 JWT for the
 * endpoint's origin, valid for at most 12 hours, and the public key. */
export function vapidAuthorization(endpoint, { privateJwk, publicJwk }, { subject, now = Date.now(), lifetimeSeconds = 12 * 60 * 60 } = {}) {
  const audience = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + Math.min(lifetimeSeconds, 12 * 60 * 60), sub: subject }));
  const input = `${header}.${claims}`;
  // ieee-p1363 gives the raw 64-byte r||s JWS needs (no DER conversion).
  const signature = sign("sha256", Buffer.from(input), { key: createPrivateKey({ key: privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64url(signature)}, k=${b64url(rawPublicKey(publicJwk))}`;
}

// ---- Payload encryption (RFC 8291) ------------------------------------------

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const RECORD_SIZE = 4096;

function deriveKeys({ sharedSecret, authSecret, uaPublic, asPublic, salt }) {
  // RFC 8291 §3.4: IKM from the ECDH secret and the auth secret, then the
  // RFC 8188 content-encryption key and nonce from the salt.
  const prkKey = hmac(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "latin1")).subarray(0, 12);
  return { cek, nonce };
}

/** Encrypts `plaintext` for a subscription's p256dh and auth keys as one
 * aes128gcm record. `ephemeralPrivateKey` and `salt` are for test vectors
 * only; normally both are fresh and random. */
export function encryptPushPayload(plaintext, { p256dh, auth }, { ephemeralPrivateKey, salt = randomBytes(16) } = {}) {
  const uaPublic = Buffer.isBuffer(p256dh) ? p256dh : fromB64url(p256dh);
  const authSecret = Buffer.isBuffer(auth) ? auth : fromB64url(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16 || salt.length !== 16)
    throw new TypeError("Invalid push subscription keys.");
  const ecdh = createECDH("prime256v1");
  if (ephemeralPrivateKey) ecdh.setPrivateKey(ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const { cek, nonce } = deriveKeys({ sharedSecret: ecdh.computeSecret(uaPublic), authSecret, uaPublic, asPublic, salt });
  const data = Buffer.from(plaintext);
  if (data.length + 1 + 16 > RECORD_SIZE) throw new RangeError("Push payload too large.");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // A single, last record: the content, then the 0x02 delimiter (no padding).
  const body = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** Decrypts one aes128gcm push message with the receiver's keys (tests and
 * the RFC vector). */
export function decryptPushPayload(message, { privateKey, auth }) {
  const salt = message.subarray(0, 16);
  const idLength = message[20];
  const asPublic = message.subarray(21, 21 + idLength);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  const { cek, nonce } = deriveKeys({ sharedSecret: ecdh.computeSecret(asPublic), authSecret: auth, uaPublic: ecdh.getPublicKey(), asPublic, salt });
  const body = message.subarray(21 + idLength);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const padded = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  const end = padded.lastIndexOf(2);
  if (end < 0 || padded.subarray(end + 1).some((byte) => byte !== 0)) throw new Error("Invalid padding.");
  return padded.subarray(0, end);
}

// ---- Sending -----------------------------------------------------------------

/** The Topic header: a push service replaces an undelivered notification
 * with the same topic for the same subscription instead of queueing both.
 * Topics only apply within one subscription, so one fixed value does that;
 * anything derived from the household would let a push service link the
 * household's members' devices. */
export const PUSH_TOPIC = "kin-new";

/** Sends one encrypted push. Resolves { status }; never rejects for HTTP
 * statuses, rejects on network failure or timeout. `transport` replaces
 * node:https in tests. */
export function sendPush(subscription, { vapidKeys, subject, payload, topic, ttlSeconds = 12 * 60 * 60, timeoutMs = 10_000, transport = httpsRequest, now = Date.now() }) {
  const url = allowedPushEndpoint(subscription.endpoint);
  if (!url) return Promise.reject(new Error("push_endpoint_not_allowed"));
  const body = encryptPushPayload(payload, subscription);
  return new Promise((resolve, reject) => {
    const request = transport(url, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(url.href, vapidKeys, { subject, now }),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        TTL: String(ttlSeconds),
        Urgency: "normal",
        ...(topic ? { Topic: topic } : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode, retryAfter: response.headers?.["retry-after"] ?? null }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("push_timeout")));
    request.on("error", reject);
    request.end(body);
  });
}


// Envelope encryption for provider credentials of optional social publishing (epic #353,
// ADR 0295). Server-only: this module runs in the hosted function, never in a browser or a build.
//
// Each credential bundle (access token, refresh token) is encrypted with its own random 256-bit
// data key (AES-256-GCM). That data key is wrapped (AES-256-GCM) by a key-encryption key held only
// in OPENBLOG_SOCIAL_TOKEN_KEYS, which is not in the database. A database dump, a backup or a
// service_role leak therefore yields only ciphertext. Both layers are bound by their additional
// authenticated data to the site, the account and the key id, so a ciphertext copied to another
// row, account or site fails to open.
//
// Only Web Crypto is used, so the module runs unchanged in Node and Deno. Errors never carry a key,
// a token or a ciphertext.

export const ENVELOPE_VERSION = 1;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SocialTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SocialTokenError";
    this.code = code;
  }
}

const toBase64 = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new SocialTokenError("invalid-envelope", "The stored credential is not readable.");
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
};

// OPENBLOG_SOCIAL_TOKEN_KEYS: "id:base64,id:base64". Each key is 32 random bytes; the first one
// encrypts new credentials, the rest only open older ones (rotation). Throws without echoing input.
export function parseKeyring(value) {
  const entries = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!entries.length) throw new SocialTokenError("invalid-keyring", "No token encryption key is configured.");
  const keys = new Map();
  for (const entry of entries) {
    const split = entry.indexOf(":");
    const id = split < 0 ? "" : entry.slice(0, split);
    let bytes;
    try {
      bytes = fromBase64(entry.slice(split + 1));
    } catch {
      bytes = null;
    }
    if (!KEY_ID.test(id) || keys.has(id) || !bytes || bytes.length !== KEY_BYTES) {
      throw new SocialTokenError("invalid-keyring", "A token encryption key is not valid: use id:base64 of 32 bytes, each id once.");
    }
    keys.set(id, bytes);
  }
  const keyring = { activeId: [...keys.keys()][0], has: (id) => keys.has(id) };
  Object.defineProperty(keyring, "bytes", { value: (id) => keys.get(id), enumerable: false });
  Object.defineProperty(keyring, "toJSON", { value: () => ({ activeId: keyring.activeId, ids: [...keys.keys()] }), enumerable: false });
  return Object.freeze(keyring);
}

const importKey = (bytes, usages) => crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);

const aad = (layer, { siteId, accountId }, keyId) => encoder.encode(`openblog-social:v${ENVELOPE_VERSION}:${layer}:${siteId}:${accountId}:${keyId}`);

const seal = async (key, plaintext, additionalData) => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plaintext);
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(sealed)) };
};

const open = async (key, { iv, data }, additionalData) => {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData }, key, fromBase64(data)));
  } catch (error) {
    if (error instanceof SocialTokenError) throw error;
    throw new SocialTokenError("decrypt-failed", "The stored credential could not be decrypted.");
  }
};

const context = ({ siteId, accountId }) => {
  if (typeof siteId !== "string" || typeof accountId !== "string" || !siteId || !accountId) {
    throw new SocialTokenError("invalid-context", "A credential belongs to one site and one account.");
  }
  return { siteId, accountId };
};

const wrapDataKey = async (keyring, keyId, ctx, dataKeyBytes) => {
  const kek = await importKey(keyring.bytes(keyId), ["encrypt"]);
  return seal(kek, dataKeyBytes, aad("wrap", ctx, keyId));
};

// Encrypts a bundle of secrets (an object of strings and numbers) into a storable envelope.
export async function sealCredential(keyring, scope, secrets) {
  const ctx = context(scope);
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) throw new SocialTokenError("invalid-secret", "Nothing to encrypt.");
  const keyId = keyring.activeId;
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const dataKey = await importKey(dataKeyBytes, ["encrypt"]);
  const body = await seal(dataKey, encoder.encode(JSON.stringify(secrets)), aad("data", ctx, keyId));
  const wrapped = await wrapDataKey(keyring, keyId, ctx, dataKeyBytes);
  dataKeyBytes.fill(0);
  return { keyId, envelope: { v: ENVELOPE_VERSION, wrap: wrapped, body } };
}

const unwrap = async (keyring, scope, keyId, envelope) => {
  const ctx = context(scope);
  if (!envelope || envelope.v !== ENVELOPE_VERSION || !envelope.wrap || !envelope.body) {
    throw new SocialTokenError("invalid-envelope", "The stored credential is not readable.");
  }
  if (!keyring.has(keyId)) throw new SocialTokenError("unknown-key", "The key that encrypted this credential is no longer configured.");
  const kek = await importKey(keyring.bytes(keyId), ["decrypt"]);
  return { ctx, dataKeyBytes: await open(kek, envelope.wrap, aad("wrap", ctx, keyId)) };
};

// Decrypts an envelope; any change to the ciphertext, the site, the account or the key id fails.
export async function openCredential(keyring, scope, keyId, envelope) {
  const { ctx, dataKeyBytes } = await unwrap(keyring, scope, keyId, envelope);
  const dataKey = await importKey(dataKeyBytes, ["decrypt"]);
  dataKeyBytes.fill(0);
  const plain = await open(dataKey, envelope.body, aad("data", ctx, keyId));
  try {
    return JSON.parse(decoder.decode(plain));
  } catch {
    throw new SocialTokenError("invalid-envelope", "The stored credential is not readable.");
  }
}

// Key rotation: re-wraps the data key under the active key without decrypting the tokens.
export async function rewrapCredential(keyring, scope, keyId, envelope) {
  const { ctx, dataKeyBytes } = await unwrap(keyring, scope, keyId, envelope);
  // The data layer is bound to the key id it was sealed under, so it is re-sealed with the same
  // data key under the new id rather than left pointing at a retired one.
  const oldDataKey = await importKey(dataKeyBytes, ["decrypt"]);
  const plain = await open(oldDataKey, envelope.body, aad("data", ctx, keyId));
  const newId = keyring.activeId;
  const newDataKey = await importKey(dataKeyBytes, ["encrypt"]);
  const body = await seal(newDataKey, plain, aad("data", ctx, newId));
  const wrap = await wrapDataKey(keyring, newId, ctx, dataKeyBytes);
  dataKeyBytes.fill(0);
  plain.fill(0);
  return { keyId: newId, envelope: { v: ENVELOPE_VERSION, wrap, body } };
}

// Removes every given secret from a string, for the rare message that must mention a failure.
export function redact(value, secrets = []) {
  let out = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|id_token|code|token)(["']?\s*[:=]\s*["']?)[^\s"'&,}]{3,}/gi, "$1$2[redacted]");
}

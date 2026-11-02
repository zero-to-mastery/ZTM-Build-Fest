// A member's account key vault (ADR 0018, #564/#565): the formats and the
// cryptography only. Nothing here talks to the network or to IndexedDB, and
// nothing creates a vault on its own; the first-run and sign-in stories call
// these functions. Every primitive is Web Crypto (AES-256-GCM, HKDF-SHA-256,
// PBKDF2-SHA-256, ECDSA P-256); nothing is hand-written.
//
// Key hierarchy:
//
//   vault key VK (32 random bytes, generated once per member)
//     |-- HKDF-SHA-256(VK, fresh 32-byte salt, "kin/vault/v1") -> AES-256-GCM
//     |     key for one vault version's contents (epoch keys, certification
//     |     key, member-key epochs for private storage, ADR 0019)
//     '-- wrapped by each way the member can open it (a wrapper), under a
//         32-byte key-encryption key (KEK):
//           password          passwordKey (below)
//           passkey           HKDF(PRF output, "kin/vault-passkey/v1")
//           password-passkey  HKDF(PRF output || passwordKey, "kin/vault-2f/v1")
//           backup-code       HKDF(code bytes, "kin/vault-backup/v1")
//
//   password -> PBKDF2-SHA-256(NFC UTF-8 password, 16-byte member salt,
//               600,000 iterations, 256 bits) = stretched
//     |-- HKDF(stretched, salt, "kin/auth/v1")           = authKey (sent at sign-in)
//     '-- HKDF(stretched, salt, "kin/vault-password/v1") = passwordKey (never sent)
//
// One PBKDF2 run split by HKDF, rather than two PBKDF2 runs with
// domain-separated salts: an attacker guessing the password pays the full
// 600,000 iterations per guess either way, but two runs would double the
// honest device's cost (seconds on a phone) for no extra security. HKDF is a
// PRF keyed by the stretched value, so authKey reveals nothing about
// passwordKey; the service, which sees authKey, can't open a vault with it.
//
// Binary formats (all integers big-endian):
//
//   vault contents, format 1 (plaintext, only ever inside the sealed vault)
//     u8  format (1)          u8  flags (0)
//     u16 epoch count N, then N entries sorted by (family, epoch), unique:
//         u8 family (1 household, 2 chat)  u8 0  u16 epoch (1..128)  32-byte key
//     u16 L, then L bytes: the certification key (ECDSA P-256 PKCS8), L = 0 if none
//     u16 M, then M bytes: the private-storage key (reserved, epic #480), M = 0 or 32
//         (read as member-key epoch 1 with revokedThrough 0)
//
//   vault contents, format 2 (ADR 0019, #487): format 1 with the reserved
//   slot replaced by a list of member-key epochs
//     u8  format (2)          u8  flags (0)
//     u16 epoch count N and N entries, as format 1
//     u16 L and the certification key, as format 1
//     u16 member-key count K (1..128), then K entries sorted by epoch, unique:
//         u16 epoch (1..128)  u16 0  u64 revokedThrough  32-byte member key
//     `revokedThrough` is the latest revocation time (service milliseconds)
//     of the member's own devices that the epoch was made after: a device
//     that sees a newer revocation of one of the member's devices starts the
//     next epoch (web/private/member-key.js). Contents with no member key
//     are still written as format 1, byte for byte as before, so a vault
//     only becomes format 2 once its member has a member key.
//
//   sealed vault, format 1 (what the service stores; unchanged by contents
//   format 2, which an older release refuses as "written by a newer Kin")
//     "KVLT"  u8 format (1)  32-byte HKDF salt  12-byte AES-GCM nonce
//     ciphertext with its 16-byte tag
//     AAD: JSON ["kin/vault/v1", "1", householdId, memberId, "<vault version>"]
//
//   wrapped vault key, format 1 (61 bytes)
//     u8 format (1)  12-byte nonce  48 bytes (VK ciphertext and tag)
//     AAD: JSON ["kin/vault-wrapper/v1", "1", householdId, memberId,
//                "<type>", "<wrapperId>", "<wrapper version>"]
//
// AAD and HKDF info use a JSON array of strings, which is length-unambiguous
// (the same encoding as local-vault.js); IDs are never concatenated raw.

/** The newest vault contents format (2 since ADR 0019); format 1 is still
 * read, and written while a vault holds no member key. */
export const VAULT_FORMAT = 2;
/** The sealed container around the contents ("KVLT" header byte and AAD). */
export const SEALED_VAULT_FORMAT = 1;
export const WRAPPER_FORMAT = 1;
export const PASSWORD_ITERATIONS = 600_000;
export const PASSWORD_SALT_BYTES = 16;
export const WRAPPER_TYPES = Object.freeze(["password", "passkey", "password-passkey", "backup-code"]);
export const EPOCH_FAMILY = Object.freeze({ household: 1, chat: 2 });
export const MAX_VAULT_EPOCH = 128;
/** Most member-key epochs, and the largest epoch number (ADR 0019). */
export const MAX_MEMBER_KEY_EPOCH = 128;
/** Largest sealed vault: 256 epoch entries (two families of 128), a PKCS8
 * key and 128 member-key epochs fit with room to spare. The service
 * enforces the same bound (server/account-vault-service.mjs). */
export const MAX_SEALED_VAULT_BYTES = 64 * 1024;
export const WRAPPED_KEY_BYTES = 61;

const MAGIC = [0x4b, 0x56, 0x4c, 0x54]; // "KVLT"
const SEALED_HEADER_BYTES = 4 + 1 + 32 + 12;
const MAX_ENTRIES = 2 * MAX_VAULT_EPOCH;
const MAX_CERTIFICATION_KEY_BYTES = 512;
const MEMBER_KEY_ENTRY_BYTES = 44;
const encoder = new TextEncoder();
const ID = /^[a-f0-9]{32}$/;

export class AccountVaultError extends Error {
  constructor(message, code = "vault_invalid", cause) {
    super(message, { cause });
    this.name = "AccountVaultError";
    this.code = code;
  }
}

/** A new random 256-bit vault key. The caller zeroes it when done. */
export function generateVaultKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * A new random 256-bit member key (ADR 0019): the AES-256-GCM key a
 * member's private envelopes are sealed under, for one epoch. It lives only
 * in the member's vault and, while unlocked, on their devices. The caller
 * zeroes it once it is sealed into the vault.
 */
export function generateMemberKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A new random per-member password salt (16 bytes). */
export function newPasswordSalt() {
  return crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
}

/** A new random wrapper ID (32 lowercase hex characters). */
export function newWrapperId() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * A new member certification key (ADR 0018 section 3): an ECDSA P-256 key
 * pair whose private half lives only inside the vault, as PKCS8. Certifying
 * it (a trusted device's signature, pinned by the household) is a later
 * story; this only makes the key so the vault has a slot for it.
 */
export async function generateCertificationKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pkcs8, publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } };
}

/** Imports a vault's certification key for signing (non-extractable). */
export function importCertificationKey(pkcs8) {
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// ---- Vault contents ------------------------------------------------------

/**
 * Encodes vault contents. `epochs` is a list of
 * `{ family: "household" | "chat", epoch, key: Uint8Array(32) }`;
 * `memberKeys` a list of `{ epoch, key: Uint8Array(32), revokedThrough }`
 * (ADR 0019). Both are sorted here, and a repeated epoch is refused. Without
 * member keys the result is format 1, exactly as before; with them, format 2.
 */
export function encodeVaultContents({ epochs = [], certificationKey = null, memberKeys = [] } = {}) {
  const entries = normalizeEpochs(epochs);
  const certification = optionalBytes(certificationKey, MAX_CERTIFICATION_KEY_BYTES, "certification key");
  const members = normalizeMemberKeys(memberKeys);
  const bytes = new Uint8Array(4 + entries.length * 36 + 2 + certification.length + 2 + members.length * MEMBER_KEY_ENTRY_BYTES);
  const view = new DataView(bytes.buffer);
  bytes[0] = members.length ? VAULT_FORMAT : 1;
  bytes[1] = 0;
  view.setUint16(2, entries.length);
  let offset = 4;
  for (const entry of entries) {
    bytes[offset] = EPOCH_FAMILY[entry.family];
    bytes[offset + 1] = 0;
    view.setUint16(offset + 2, entry.epoch);
    bytes.set(entry.key, offset + 4);
    offset += 36;
  }
  view.setUint16(offset, certification.length);
  bytes.set(certification, offset + 2);
  offset += 2 + certification.length;
  // Format 1 ends with an empty private-storage slot (M = 0); format 2 with
  // the member-key list.
  view.setUint16(offset, members.length);
  offset += 2;
  for (const entry of members) {
    view.setUint16(offset, entry.epoch);
    view.setUint16(offset + 2, 0);
    view.setBigUint64(offset + 4, BigInt(entry.revokedThrough));
    bytes.set(entry.key, offset + 12);
    offset += MEMBER_KEY_ENTRY_BYTES;
  }
  return bytes;
}

/** Decodes and validates vault contents (format 1 or 2). Keys are fresh
 * copies. Returns `{ epochs, certificationKey, memberKeys }`; a format 1
 * private-storage key reads as member-key epoch 1. */
export function decodeVaultContents(bytes) {
  const fail = () => new AccountVaultError("The vault contents are invalid.", "vault_corrupt");
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = bytes[0];
  if (format !== 1 && format !== VAULT_FORMAT)
    throw new AccountVaultError("This vault was written by a newer version of Kin.", "vault_unsupported");
  if (bytes[1] !== 0) throw fail();
  const count = view.getUint16(2);
  if (count > MAX_ENTRIES || bytes.length < 4 + count * 36 + 4) throw fail();
  const epochs = [];
  let offset = 4;
  let previous = -1;
  for (let index = 0; index < count; index += 1) {
    const familyCode = bytes[offset];
    const family = familyCode === 1 ? "household" : familyCode === 2 ? "chat" : null;
    const epoch = view.getUint16(offset + 2);
    const order = familyCode * 1024 + epoch;
    if (!family || bytes[offset + 1] !== 0 || epoch < 1 || epoch > MAX_VAULT_EPOCH || order <= previous) throw fail();
    previous = order;
    epochs.push({ family, epoch, key: bytes.slice(offset + 4, offset + 36) });
    offset += 36;
  }
  const certificationLength = view.getUint16(offset);
  offset += 2;
  if (certificationLength > MAX_CERTIFICATION_KEY_BYTES || offset + certificationLength + 2 > bytes.length) throw fail();
  const certificationKey = certificationLength ? bytes.slice(offset, offset + certificationLength) : null;
  offset += certificationLength;
  const tail = view.getUint16(offset);
  offset += 2;
  const memberKeys = [];
  if (format === 1) {
    if ((tail !== 0 && tail !== 32) || offset + tail !== bytes.length) throw fail();
    if (tail) memberKeys.push({ epoch: 1, key: bytes.slice(offset, offset + 32), revokedThrough: 0 });
    return { epochs, certificationKey, memberKeys };
  }
  if (tail < 1 || tail > MAX_MEMBER_KEY_EPOCH || offset + tail * MEMBER_KEY_ENTRY_BYTES !== bytes.length) throw fail();
  let previousEpoch = 0;
  for (let index = 0; index < tail; index += 1) {
    const epoch = view.getUint16(offset);
    const revokedThrough = view.getBigUint64(offset + 4);
    if (epoch <= previousEpoch || epoch > MAX_MEMBER_KEY_EPOCH || view.getUint16(offset + 2) !== 0 ||
        revokedThrough > BigInt(Number.MAX_SAFE_INTEGER)) throw fail();
    previousEpoch = epoch;
    memberKeys.push({ epoch, key: bytes.slice(offset + 12, offset + 44), revokedThrough: Number(revokedThrough) });
    offset += MEMBER_KEY_ENTRY_BYTES;
  }
  return { epochs, certificationKey, memberKeys };
}

/**
 * Merges two vault contents: the union of their household and chat epoch
 * keys by (family, epoch), and of their member-key epochs by epoch. The same
 * epoch with different key bytes is a conflict nobody can resolve safely, so
 * it is refused rather than silently picking one: `vault_epoch_conflict`,
 * or `vault_member_key_conflict` when two devices started the same
 * member-key epoch (the second adopts the first's, web/private/member-key.js).
 * The certification key is kept from whichever side has it; different values
 * on both sides are refused the same way.
 * Returns `{ contents, changed }`, where `changed` says whether the result
 * differs from `base` (so an unchanged vault isn't re-uploaded).
 */
export function mergeVaultContents(base, incoming) {
  const merged = new Map();
  for (const entry of normalizeEpochs(base.epochs ?? [])) merged.set(`${entry.family}:${entry.epoch}`, entry);
  let changed = false;
  for (const entry of normalizeEpochs(incoming.epochs ?? [])) {
    const key = `${entry.family}:${entry.epoch}`;
    const existing = merged.get(key);
    if (!existing) { merged.set(key, entry); changed = true; continue; }
    if (!equalBytes(existing.key, entry.key))
      throw new AccountVaultError(`Two different keys exist for ${entry.family} epoch ${entry.epoch}.`, "vault_epoch_conflict");
  }
  const members = new Map();
  for (const entry of normalizeMemberKeys(base.memberKeys ?? [])) members.set(entry.epoch, entry);
  for (const entry of normalizeMemberKeys(incoming.memberKeys ?? [])) {
    const existing = members.get(entry.epoch);
    if (!existing) { members.set(entry.epoch, entry); changed = true; continue; }
    if (!equalBytes(existing.key, entry.key) || existing.revokedThrough !== entry.revokedThrough)
      throw new AccountVaultError(`Two different member keys exist for epoch ${entry.epoch}.`, "vault_member_key_conflict");
  }
  const pick = (left, right, name) => {
    if (!left) { if (right) changed = true; return right ?? null; }
    if (right && !equalBytes(left, right))
      throw new AccountVaultError(`The vault holds a different ${name}.`, "vault_key_conflict");
    return left;
  };
  const certificationKey = pick(base.certificationKey ?? null, incoming.certificationKey ?? null, "certification key");
  return {
    contents: { epochs: normalizeEpochs([...merged.values()]), certificationKey, memberKeys: normalizeMemberKeys([...members.values()]) },
    changed,
  };
}

/** Overwrites every key in decoded contents with zeros. */
export function wipeVaultContents(contents) {
  for (const entry of contents?.epochs ?? []) entry.key?.fill(0);
  contents?.certificationKey?.fill(0);
  for (const entry of contents?.memberKeys ?? []) entry.key?.fill(0);
}

// ---- Sealing the vault ---------------------------------------------------

/**
 * Encrypts vault contents for one vault version. `version` is the version
 * this ciphertext will be stored as (the service's version after the
 * compare-and-set), and is authenticated, so the service can't relabel an
 * old vault as a newer one, or move a vault to another member or household.
 */
export async function sealVault(vaultKey, contents, { householdId, memberId, version }) {
  requireVaultKey(vaultKey);
  const aad = vaultAad({ householdId, memberId, version });
  const plaintext = encodeVaultContents(contents);
  try {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await contentKey(vaultKey, salt);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext));
    const sealed = new Uint8Array(SEALED_HEADER_BYTES + ciphertext.length);
    sealed.set(MAGIC, 0);
    sealed[4] = SEALED_VAULT_FORMAT;
    sealed.set(salt, 5);
    sealed.set(nonce, 37);
    sealed.set(ciphertext, SEALED_HEADER_BYTES);
    if (sealed.length > MAX_SEALED_VAULT_BYTES) throw new AccountVaultError("The vault is larger than Kin supports.", "vault_too_large");
    return sealed;
  } finally {
    plaintext.fill(0);
  }
}

/** Decrypts a sealed vault stored as `version`; throws `vault_unlock_failed`
 * for a wrong key, a changed byte or a different household, member or version. */
export async function openVault(vaultKey, sealed, { householdId, memberId, version }) {
  requireVaultKey(vaultKey);
  const aad = vaultAad({ householdId, memberId, version });
  if (!(sealed instanceof Uint8Array) || sealed.length < SEALED_HEADER_BYTES + 16 + 8 ||
      sealed.length > MAX_SEALED_VAULT_BYTES || MAGIC.some((value, index) => sealed[index] !== value))
    throw new AccountVaultError("The vault is invalid.", "vault_corrupt");
  if (sealed[4] !== SEALED_VAULT_FORMAT) throw new AccountVaultError("This vault was written by a newer version of Kin.", "vault_unsupported");
  let plaintext;
  try {
    const key = await contentKey(vaultKey, sealed.subarray(5, 37));
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.subarray(37, 49), additionalData: aad, tagLength: 128 }, key, sealed.subarray(SEALED_HEADER_BYTES)));
  } catch (error) {
    throw new AccountVaultError("Kin could not open this vault.", "vault_unlock_failed", error);
  }
  try {
    return decodeVaultContents(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

// ---- Key-encryption keys -------------------------------------------------

/**
 * Stretches a password once with PBKDF2 and splits it with HKDF into
 * `authKey` (sent to the service at sign-in, which stores only its Argon2id
 * hash) and `passwordKey` (the password wrapper's KEK; never leaves the
 * device). Both are 32-byte Uint8Arrays the caller zeroes when done.
 * `iterations` is accepted from a stored wrapper's parameters but never
 * below 600,000: a service that offered fewer would get an authKey cheaper
 * to guess the password from.
 */
export async function derivePasswordKeys(password, salt, { iterations = PASSWORD_ITERATIONS } = {}) {
  if (typeof password !== "string" || password.length === 0 || password.length > 1024)
    throw new AccountVaultError("Enter your password.", "password_invalid");
  if (!(salt instanceof Uint8Array) || salt.length !== PASSWORD_SALT_BYTES)
    throw new AccountVaultError("The password parameters are invalid.", "password_params_invalid");
  if (!Number.isSafeInteger(iterations) || iterations < PASSWORD_ITERATIONS || iterations > 10_000_000)
    throw new AccountVaultError("The password parameters are invalid.", "password_params_invalid");
  const passwordBytes = encoder.encode(password.normalize("NFC"));
  let stretched;
  try {
    const material = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
    stretched = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256));
    const [authKey, passwordKey] = await Promise.all([
      hkdfBytes(stretched, salt, "kin/auth/v1"),
      hkdfBytes(stretched, salt, "kin/vault-password/v1"),
    ]);
    return { authKey, passwordKey };
  } finally {
    passwordBytes.fill(0);
    stretched?.fill(0);
  }
}

/** The passkey wrapper's KEK from a WebAuthn PRF output (32 bytes). */
export function passkeyKek(prfOutput) {
  requireSecret(prfOutput, "passkey output");
  return hkdfBytes(prfOutput, new Uint8Array(), "kin/vault-passkey/v1");
}

/** The password-and-passkey wrapper's KEK: neither secret alone derives it. */
export async function combinedKek(prfOutput, passwordKey) {
  requireSecret(prfOutput, "passkey output");
  requireSecret(passwordKey, "password key");
  const input = new Uint8Array(64);
  input.set(prfOutput, 0);
  input.set(passwordKey, 32);
  try {
    return await hkdfBytes(input, new Uint8Array(), "kin/vault-2f/v1");
  } finally {
    input.fill(0);
  }
}

/** The backup-code wrapper's KEK from the code's 32 random bytes. */
export function backupCodeKek(codeBytes) {
  requireSecret(codeBytes, "backup code");
  return hkdfBytes(codeBytes, new Uint8Array(), "kin/vault-backup/v1");
}

/**
 * What a backup-code sign-in sends to the service (#572): HKDF of the code's
 * bytes under its own purpose, so it is never the wrapper's KEK. The service
 * keeps only SHA-256 of it (`backupCodeVerifier`): the code is 256 random
 * bits, so a plain hash is already beyond guessing and no stretching is needed.
 */
export function backupCodeAuthKey(codeBytes) {
  requireSecret(codeBytes, "backup code");
  return hkdfBytes(codeBytes, new Uint8Array(), "kin/backup-auth/v1");
}

/** The service's check value for a backup code: base64url SHA-256 of its authKey. */
export async function backupCodeVerifier(authKey) {
  requireSecret(authKey, "backup code key");
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", authKey)));
}

/**
 * The secret that opens one export's root wrapper for a member with a
 * backup code (#572, PORTABILITY): HKDF of the vault key, bound to the
 * exporting device's vault ID. The export carries the backup-code wrapper
 * of VK, so the code opens VK, VK derives this, and this opens the export.
 * Never stored; derived when exporting and when restoring.
 */
export function exportUnlockSecret(vaultKey, vaultId) {
  requireVaultKey(vaultKey);
  if (!/^[a-f0-9]{32}$/.test(vaultId ?? "")) throw new AccountVaultError("The export context is invalid.");
  return hkdfBytes(vaultKey, new Uint8Array(), JSON.stringify(["kin/export-backup-code/v1", vaultId]));
}

// ---- Wrappers ------------------------------------------------------------

/**
 * Wraps VK under a 32-byte KEK for one wrapper. The wrapper's type, ID and
 * version, and the member and household, are authenticated: a wrapper can't
 * be moved to another member or passed off as another kind of wrapper.
 */
export async function wrapVaultKey(vaultKey, kek, context) {
  requireVaultKey(vaultKey);
  const aad = wrapperAad(context);
  const key = await kekKey(kek, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, vaultKey));
  const wrapped = new Uint8Array(WRAPPED_KEY_BYTES);
  wrapped[0] = WRAPPER_FORMAT;
  wrapped.set(nonce, 1);
  wrapped.set(ciphertext, 13);
  return wrapped;
}

/** Recovers VK from a wrapper; throws `vault_unlock_failed` otherwise. */
export async function unwrapVaultKey(wrapped, kek, context) {
  const aad = wrapperAad(context);
  if (!(wrapped instanceof Uint8Array) || wrapped.length !== WRAPPED_KEY_BYTES)
    throw new AccountVaultError("The vault wrapper is invalid.", "vault_corrupt");
  if (wrapped[0] !== WRAPPER_FORMAT)
    throw new AccountVaultError("This vault wrapper was written by a newer version of Kin.", "vault_unsupported");
  try {
    const key = await kekKey(kek, ["decrypt"]);
    const vaultKey = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: wrapped.subarray(1, 13), additionalData: aad, tagLength: 128 }, key, wrapped.subarray(13)));
    if (vaultKey.length !== 32) throw new Error("vault key length");
    return vaultKey;
  } catch (error) {
    throw new AccountVaultError("Kin could not open this vault.", "vault_unlock_failed", error);
  }
}

// ---- Helpers -------------------------------------------------------------

function vaultAad({ householdId, memberId, version }) {
  if (!ID.test(householdId ?? "") || !ID.test(memberId ?? "") || !Number.isSafeInteger(version) || version < 1)
    throw new AccountVaultError("The vault context is invalid.");
  return fields(["kin/vault/v1", String(SEALED_VAULT_FORMAT), householdId, memberId, String(version)]);
}

function wrapperAad({ householdId, memberId, type, wrapperId, version } = {}) {
  if (!ID.test(householdId ?? "") || !ID.test(memberId ?? "") || !WRAPPER_TYPES.includes(type) ||
      !ID.test(wrapperId ?? "") || !Number.isSafeInteger(version) || version < 1)
    throw new AccountVaultError("The vault wrapper context is invalid.");
  return fields(["kin/vault-wrapper/v1", String(WRAPPER_FORMAT), householdId, memberId, type, wrapperId, String(version)]);
}

function fields(values) {
  return encoder.encode(JSON.stringify(values));
}

async function contentKey(vaultKey, salt) {
  const material = await crypto.subtle.importKey("raw", vaultKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("kin/vault/v1") },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function hkdfBytes(secret, salt, purpose) {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(purpose) }, material, 256));
}

function kekKey(kek, usages) {
  requireSecret(kek, "key-encryption key");
  return crypto.subtle.importKey("raw", kek, { name: "AES-GCM" }, false, usages);
}

function requireVaultKey(vaultKey) {
  if (!(vaultKey instanceof Uint8Array) || vaultKey.length !== 32)
    throw new AccountVaultError("The vault key is invalid.");
}

function requireSecret(value, name) {
  if (!(value instanceof Uint8Array) || value.length !== 32)
    throw new AccountVaultError(`The ${name} is invalid.`);
}

function optionalBytes(value, maximum, name) {
  if (value === null || value === undefined) return new Uint8Array();
  if (!(value instanceof Uint8Array) || value.length > maximum)
    throw new AccountVaultError(`The ${name} is invalid.`);
  return value;
}

function normalizeEpochs(epochs) {
  if (!Array.isArray(epochs) || epochs.length > MAX_ENTRIES) throw new AccountVaultError("The vault holds too many keys.");
  const sorted = epochs.map((entry) => {
    if (!Object.hasOwn(EPOCH_FAMILY, entry?.family) || !Number.isSafeInteger(entry.epoch) ||
        entry.epoch < 1 || entry.epoch > MAX_VAULT_EPOCH || !(entry.key instanceof Uint8Array) || entry.key.length !== 32)
      throw new AccountVaultError("A vault epoch key is invalid.");
    return entry;
  }).sort((left, right) => EPOCH_FAMILY[left.family] - EPOCH_FAMILY[right.family] || left.epoch - right.epoch);
  for (let index = 1; index < sorted.length; index += 1)
    if (sorted[index].family === sorted[index - 1].family && sorted[index].epoch === sorted[index - 1].epoch)
      throw new AccountVaultError("A vault epoch key is repeated.");
  return sorted;
}

function normalizeMemberKeys(memberKeys) {
  if (!Array.isArray(memberKeys) || memberKeys.length > MAX_MEMBER_KEY_EPOCH) throw new AccountVaultError("The vault holds too many member keys.");
  const sorted = memberKeys.map((entry) => {
    const revokedThrough = entry?.revokedThrough ?? 0;
    if (!Number.isSafeInteger(entry?.epoch) || entry.epoch < 1 || entry.epoch > MAX_MEMBER_KEY_EPOCH ||
        !(entry.key instanceof Uint8Array) || entry.key.length !== 32 ||
        !Number.isSafeInteger(revokedThrough) || revokedThrough < 0)
      throw new AccountVaultError("A member key is invalid.");
    return { epoch: entry.epoch, key: entry.key, revokedThrough };
  }).sort((left, right) => left.epoch - right.epoch);
  for (let index = 1; index < sorted.length; index += 1)
    if (sorted[index].epoch === sorted[index - 1].epoch) throw new AccountVaultError("A member key epoch is repeated.");
  return sorted;
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

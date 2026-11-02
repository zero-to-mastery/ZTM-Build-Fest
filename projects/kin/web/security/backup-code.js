// The account backup code (ADR 0018 section 6, #571/#572): one per member,
// 256 random bits, shown to the person as text they can print or write down.
// No network, no storage: the security panel and the sign-in screens call
// these, and account-vault.js derives the keys.
//
// Format: the 32 code bytes and a 3-byte check (the first three bytes of
// SHA-256 over "kin/backup-code-check/v1" and the code bytes) are 35 bytes,
// exactly 56 characters of Crockford base32 (5 bits each, most significant
// first), shown as 8 groups of 7:
//
//   7KX2M9Q-ZB4T0HR-...  (8 groups)
//
// Crockford's alphabet leaves out I, L, O and U, so the code reads aloud
// without ambiguity; when typing, I and L are read as 1 and O as 0, case
// doesn't matter, and spaces and dashes are ignored. The check catches a
// mistyped character with probability 1 - 2^-24; it is not a secret and adds
// nothing to the code's strength. It is computed with Web Crypto's SHA-256,
// so nothing here is hand-written cryptography (base32 is only a spelling).
import { VaultError } from "./local-vault.js";

export const BACKUP_CODE_BYTES = 32;
export const BACKUP_CODE_GROUPS = 8;
export const BACKUP_CODE_GROUP_LENGTH = 7;
const CHECK_BYTES = 3;
const LENGTH = BACKUP_CODE_GROUPS * BACKUP_CODE_GROUP_LENGTH;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const encoder = new TextEncoder();

/** A new random backup code: `{ bytes, text }`. The caller zeroes `bytes`. */
export async function generateBackupCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(BACKUP_CODE_BYTES));
  return { bytes, text: await formatBackupCode(bytes) };
}

/** "XXXXXXX-XXXXXXX-…" (8 groups of 7) for 32 code bytes. */
export async function formatBackupCode(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== BACKUP_CODE_BYTES) throw new VaultError("The backup code is invalid.");
  const framed = new Uint8Array(BACKUP_CODE_BYTES + CHECK_BYTES);
  framed.set(bytes);
  framed.set(await check(bytes), BACKUP_CODE_BYTES);
  try {
    const characters = base32(framed);
    const groups = [];
    for (let index = 0; index < LENGTH; index += BACKUP_CODE_GROUP_LENGTH) groups.push(characters.slice(index, index + BACKUP_CODE_GROUP_LENGTH));
    return groups.join("-");
  } finally {
    framed.fill(0);
  }
}

/** The typed code with spaces, dashes and look-alikes folded, or null when it isn't 56 code characters. */
export function normalizeBackupCode(value) {
  if (typeof value !== "string" || value.length > 200) return null;
  const folded = value.toUpperCase().replace(/[\s-]+/g, "").replaceAll("O", "0").replaceAll("I", "1").replaceAll("L", "1");
  return folded.length === LENGTH && [...folded].every((character) => ALPHABET.includes(character)) ? folded : null;
}

/** Whether a typed value has the backup code's shape (not whether it is right). */
export function looksLikeBackupCode(value) {
  return normalizeBackupCode(value) !== null;
}

/**
 * The 32 code bytes of a typed backup code. Refuses (VaultError, code
 * "backup_code_invalid") a value of the wrong length or alphabet, and one
 * whose check doesn't match, which almost always means a typo.
 */
export async function parseBackupCode(value) {
  const normalized = normalizeBackupCode(value);
  if (!normalized) throw new VaultError("Enter the whole backup code: 8 groups of 7 letters and numbers.", "backup_code_invalid");
  const framed = unbase32(normalized);
  try {
    if (!framed) throw new VaultError("Enter the whole backup code: 8 groups of 7 letters and numbers.", "backup_code_invalid");
    const bytes = framed.slice(0, BACKUP_CODE_BYTES);
    const expected = await check(bytes);
    let difference = 0;
    for (let index = 0; index < CHECK_BYTES; index += 1) difference |= expected[index] ^ framed[BACKUP_CODE_BYTES + index];
    if (difference) {
      bytes.fill(0);
      throw new VaultError("That backup code has a typo. Check each group against your copy.", "backup_code_invalid");
    }
    return bytes;
  } finally {
    framed?.fill(0);
  }
}

async function check(bytes) {
  const prefix = encoder.encode("kin/backup-code-check/v1");
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", input)).slice(0, CHECK_BYTES);
  } finally {
    input.fill(0);
  }
}

// 35 bytes are exactly 280 bits, 56 characters: no padding either way.
function base32(bytes) {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(buffer >> bits) & 31];
    }
  }
  return output;
}

function unbase32(characters) {
  const bytes = new Uint8Array(BACKUP_CODE_BYTES + CHECK_BYTES);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of characters) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) return null;
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return offset === bytes.length && bits === 0 ? bytes : null;
}

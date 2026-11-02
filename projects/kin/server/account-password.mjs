// The password verifier for password sign-in (ADR 0018 section 2; the
// sign-in itself is #557). The browser derives `authKey` from the password
// (PBKDF2-SHA-256, 600,000 iterations, then HKDF "kin/auth/v1"; see
// web/security/account-vault.js) and sends only that. The service keeps
// Argon2id(authKey) from Node's built-in crypto.argon2, never authKey itself,
// so a stolen database has to repeat both the PBKDF2 and the Argon2id work
// for every password guess.
//
// Parameters: Argon2id v1.3, 19 MiB of memory, 2 passes, parallelism 1, a
// 16-byte random salt and a 32-byte tag: OWASP's (2023) first recommended
// Argon2id configuration. The verifier is stored as a PHC string
// ("$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>", unpadded standard
// base64), so the parameters can rise later without a schema change: a
// stored verifier is checked with its own parameters, within the bounds
// below.
import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

export const ARGON2ID_PARAMETERS = Object.freeze({ memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 });
const SALT_BYTES = 16;
const AUTH_KEY_BYTES = 32;
// A stored verifier is refused outside these, so a damaged or hostile row
// can't make one check take minutes or gigabytes.
const LIMITS = { memory: [8_192, 262_144], passes: [1, 10], parallelism: [1, 4] };
const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d)\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

export class AccountPasswordError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccountPasswordError";
    this.code = "account_password_invalid";
  }
}

/** Hashes a 32-byte authKey into a PHC-format Argon2id verifier string. */
export async function hashAuthKey(authKey, { parameters = ARGON2ID_PARAMETERS, salt = randomBytes(SALT_BYTES) } = {}) {
  requireAuthKey(authKey);
  checkParameters(parameters);
  const tag = await run(authKey, salt, parameters);
  return `$argon2id$v=19$m=${parameters.memory},t=${parameters.passes},p=${parameters.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** Whether `authKey` matches `verifier`, compared in constant time. A
 * malformed verifier is an error, not a mismatch. */
export async function verifyAuthKey(authKey, verifier) {
  requireAuthKey(authKey);
  const match = PHC.exec(typeof verifier === "string" ? verifier : "");
  if (!match) throw new AccountPasswordError("The stored password verifier is invalid.");
  const parameters = { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]), tagLength: 32 };
  checkParameters(parameters);
  const salt = Buffer.from(match[4], "base64");
  const expected = Buffer.from(match[5], "base64");
  const actual = await run(authKey, salt, parameters);
  return timingSafeEqual(actual, expected);
}

function run(authKey, salt, { memory, passes, parallelism, tagLength }) {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: authKey, nonce: salt, memory, passes, parallelism, tagLength }, (error, tag) => {
      if (error) reject(error); else resolve(tag);
    });
  });
}

function checkParameters(parameters) {
  for (const [name, [low, high]] of Object.entries(LIMITS))
    if (!Number.isSafeInteger(parameters[name]) || parameters[name] < low || parameters[name] > high)
      throw new AccountPasswordError("The password verifier parameters are out of range.");
  if (parameters.memory < 8 * parameters.parallelism || parameters.tagLength !== 32)
    throw new AccountPasswordError("The password verifier parameters are out of range.");
}

function requireAuthKey(authKey) {
  if (!(authKey instanceof Uint8Array) || authKey.length !== AUTH_KEY_BYTES)
    throw new AccountPasswordError("The password key is invalid.");
}

function b64(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/=+$/u, "");
}

// PairingService, username and password sign-in (ADR 0018, #558).
//
// A member who signs up with a password has a username (unique among active
// members, normalized by web/security/account-credentials.js) and a password
// record: the PBKDF2 salt and iterations their devices use, and the
// Argon2id verifier of `authKey` (server/account-password.mjs). The browser
// sends only authKey, never the password; authKey can't open the member's
// vault or local data (passwordKey, derived beside it, never leaves the
// device).
//
// What a password does here:
// - creates a household or joins one in place of a passkey (bootstrap and a
//   new-member claim; adding a device to an existing member still uses a
//   passkey);
// - activates an approved claim;
// - signs in a trusted device (its kin_device cookie) for a session;
// - confirms an admin-only action freshly, for a member with no passkey.
//
// Every check is rate-limited per member, device and client address, runs
// Argon2id even when nothing matches (so timing doesn't say whether a
// username exists), compares in constant time and answers with one generic
// message.
import { hashAuthKey, verifyAuthKey } from "../account-password.mjs";
import { normalizeUsername, usernameProblem } from "../../web/security/account-credentials.js";
import { canParticipate, hash, PairingError } from "./shared.mjs";

/** Failed password checks allowed per member, device or address in a window. */
export const PASSWORD_ATTEMPTS = 10;
export const PASSWORD_WINDOW_MS = 15 * 60_000;
/** Username availability checks per client address in a window. */
export const USERNAME_CHECKS = 30;
export const PASSWORD_ITERATIONS_MIN = 600_000;
const PASSWORD_ITERATIONS_MAX = 10_000_000;
const MAX_LIMIT_KEYS = 4096;

export const SIGN_IN_FAILED = "That username and password didn't match. Check them and try again.";

const signInFailed = () => new PairingError("sign_in_failed", SIGN_IN_FAILED, 401);
const passwordFailed = () => new PairingError("password_incorrect", "That password didn't match. Check it and try again.", 401);
const tooMany = () => new PairingError("password_rate_limited", "Too many tries. Wait a few minutes and try again.", 429);

/** A bounded sliding-window counter: `allows(key)` and `spend(key)`. */
class AttemptWindow {
  constructor(limit, windowMs, now) {
    Object.assign(this, { limit, windowMs, now, entries: new Map() });
  }
  recent(key) {
    const cutoff = this.now() - this.windowMs;
    const times = (this.entries.get(key) ?? []).filter((time) => time > cutoff);
    if (times.length) this.entries.set(key, times); else this.entries.delete(key);
    return times;
  }
  allows(key) { return this.recent(key).length < this.limit; }
  spend(key) {
    const times = this.recent(key);
    if (!this.entries.has(key) && this.entries.size >= MAX_LIMIT_KEYS) this.entries.delete(this.entries.keys().next().value);
    times.push(this.now());
    this.entries.set(key, times);
  }
}

// A verifier nothing matches, checked when there is no real one, so a
// mismatch costs the same Argon2id work either way.
let decoyVerifier = null;
const decoy = async () => (decoyVerifier ??= await hashAuthKey(new Uint8Array(32).fill(0xa5)));

/** A 32-byte authKey from canonical base64url, or null. */
export function decodeAuthKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value ? new Uint8Array(bytes) : null;
}

export const passwordMethods = {
  passwordLimits() {
    this.passwordAttempts ??= new AttemptWindow(PASSWORD_ATTEMPTS, PASSWORD_WINDOW_MS, this.now);
    this.usernameChecks ??= new AttemptWindow(USERNAME_CHECKS, PASSWORD_WINDOW_MS, this.now);
    return this.passwordAttempts;
  },

  /** The active member (or a claim waiting for approval) holding `username`. */
  usernameHolder(username) {
    for (const member of this.members.values())
      if (member.username === username && member.active && canParticipate(member, this.now())) return member;
    // A claim waiting for approval holds its username until it ends.
    for (const pairing of this.pairings.values())
      if (pairing.claimant?.password?.username === username && this.state(pairing) === "Claimed") return pairing;
    return null;
  },

  assertUsernameAvailable(username) {
    if (this.usernameHolder(username))
      throw new PairingError("username_taken", "That username is taken. Try another.", 409);
  },

  /**
   * Whether a username can be chosen, for the sign-up form. Answers the
   * question every sign-up page answers; rate-limited per client address so
   * it can't be used to list accounts quickly.
   */
  usernameAvailable(username, rateKey = "unknown") {
    this.passwordLimits();
    if (!this.usernameChecks.allows(`address:${rateKey}`)) throw tooMany();
    this.usernameChecks.spend(`address:${rateKey}`);
    const normalized = normalizeUsername(username);
    if (!normalized) throw new PairingError("username_invalid", usernameProblem(username), 400);
    return { username: normalized, available: !this.usernameHolder(normalized) };
  },

  /**
   * Checks a sign-up's username and password parameters and hashes authKey:
   * `{ username, authKey, salt, iterations }` from the request body, with
   * authKey and salt as base64url. Returns the password record to keep.
   * Async (Argon2id); callers re-check availability after it.
   */
  async preparePassword(body) {
    const username = normalizeUsername(body?.username);
    if (!username) throw new PairingError("username_invalid", usernameProblem(body?.username), 400);
    const authKey = decodeAuthKey(body?.authKey);
    const salt = typeof body?.salt === "string" && /^[A-Za-z0-9_-]{22}$/.test(body.salt) ? Buffer.from(body.salt, "base64url") : null;
    const iterations = body?.iterations;
    if (!authKey || salt?.length !== 16 || salt.toString("base64url") !== body.salt ||
        !Number.isSafeInteger(iterations) || iterations < PASSWORD_ITERATIONS_MIN || iterations > PASSWORD_ITERATIONS_MAX)
      throw new PairingError("password_invalid", "Kin could not read that password. Try again.", 400);
    this.assertUsernameAvailable(username);
    try {
      return { username, salt: new Uint8Array(salt), iterations, verifier: await hashAuthKey(authKey), updatedAt: this.now() };
    } finally {
      authKey.fill(0);
    }
  },

  /** The public parameters a member's device needs to derive authKey again
   * (for a fresh confirmation), or null for a member without a password. */
  passwordParameters(member) {
    if (!member?.password) return null;
    return { username: member.username, salt: Buffer.from(member.password.salt).toString("base64url"), iterations: member.password.iterations };
  },

  /**
   * Checks `authKey` against `member`'s verifier (or a decoy when there is
   * none), charging the limits for `keys` only on failure. Every key is
   * checked before the work, so a refused address doesn't learn anything
   * from a correct password. Resolves true or false.
   */
  async checkPassword(member, authKeyText, keys) {
    const limits = this.passwordLimits();
    if (keys.some((key) => !limits.allows(key))) throw tooMany();
    const authKey = decodeAuthKey(authKeyText) ?? new Uint8Array(32);
    let matched = false;
    try {
      matched = await verifyAuthKey(authKey, member?.password?.verifier ?? await decoy());
    } finally {
      authKey.fill(0);
    }
    const valid = matched && Boolean(member?.password) && decodeAuthKey(authKeyText) !== null;
    if (!valid) for (const key of keys) limits.spend(key);
    return valid;
  },

  /**
   * Signs in this trusted device (its kin_device cookie) with the member's
   * username and authKey: a new session, as a passkey login gives. The
   * username must be the device's member's. One generic error for a wrong
   * username, a wrong password and a member without a password.
   */
  async signInWithPassword({ deviceToken, username, authKey, rateKey = "unknown" }) {
    const { device, member } = this.trustedDevice(deviceToken);
    const keys = [`member:${member.id}`, `device:${device.id}`, `address:${rateKey}`];
    const normalized = normalizeUsername(username);
    const passwordMatched = await this.checkPassword(member, authKey, keys);
    // State may have changed during the check: the device is checked again.
    const current = this.trustedDevice(deviceToken);
    if (!passwordMatched || !normalized || normalized !== member.username || current.member !== member) {
      if (passwordMatched) for (const key of keys) this.passwordLimits().spend(key);
      this.audit("password_sign_in_failed", { householdId: member.householdId, deviceId: device.id });
      throw signInFailed();
    }
    const result = {
      ...this.issueSession(member.id, device.id),
      deviceToken: this.issueDeviceToken(device),
      householdId: member.householdId,
      memberId: member.id,
      deviceId: device.id,
    };
    this.persistHousehold(member.householdId);
    return result;
  },

  /** Confirms an admin-only action for a member with no passkey: a fresh
   * password re-entry (THREAT-MODEL: weaker than a passkey). */
  async verifyFreshPassword(member, authKey, rateKey = "unknown") {
    if (!(await this.checkPassword(member, authKey, [`member:${member.id}`, `address:${rateKey}`]))) {
      this.audit("password_confirmation_failed", { householdId: member.householdId, memberId: member.id });
      throw passwordFailed();
    }
  },

  /** Whether a member confirms sensitive actions with a password: they have
   * one and no passkey yet. Members with a passkey always use it. */
  confirmsWithPassword(member) {
    return Boolean(member?.password) && (member.credentials?.size ?? 0) === 0;
  },

  /** Whether a member can confirm sensitive actions at all (a passkey, or a
   * password until one is added). Used where Kin keeps a usable admin. */
  canConfirmFreshly(member) {
    return (member?.credentials?.size ?? 0) > 0 || Boolean(member?.password);
  },

  /** The approved claim's password (#558) for activation with authKey. */
  async activateClaimWithPassword(claimToken, authKey, rateKey = "unknown") {
    this.prunePairingCapabilities();
    const pairing = this.pairings.get(this.claimTokens.get(hash(String(claimToken ?? ""))));
    if (!pairing || this.state(pairing) !== "Confirmed")
      throw new PairingError("claim_not_confirmed", "Approval is still required.", 409);
    const member = this.members.get(pairing.confirmedMemberId);
    if (!pairing.claimant.password || !member?.password)
      throw new PairingError("passkey_required", "Use the passkey you joined with to finish.", 409);
    if (!(await this.checkPassword(member, authKey, [`member:${member.id}`, `address:${rateKey}`])))
      throw passwordFailed();
    return this.activateClaim(claimToken);
  },
};

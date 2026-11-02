// One-time codes for the control panel on this computer (ADR 0025 §10–§11,
// #719). A program on the same computer can reach the loopback listener, so
// the panel there asks for a code that only someone who can see Kin's own
// window or log has: the setup code on first run, and later an access code
// or a confirmation code the panel asks Kin to print.
//
// A code is 10 characters from an alphabet without look-alikes (no 0/O,
// 1/I/L, U/V), 29 in all, shown as two groups of five. It is valid for one purpose
// (`access` signs a browser in; `confirm` confirms one change; `move` lets
// another server send a household here, #739), expires,
// is used once, and is destroyed after `maxAttempts` wrong tries, so a
// guessing program gets a handful of guesses per printed code: with 29^10
// (about 4 × 10^14) codes, five guesses succeed about once in 10^14. Only the SHA-256 of a code is
// kept, in memory; asking for a new code replaces the old one and is
// limited to one every `issueIntervalMs`. With `reissueAfterUse` (the
// confirmation code, which only a signed-in session can ask for), a code
// that was used correctly doesn't make the next one wait, so one change can
// follow another (#721: back up, then restore); a code that ran out or was
// locked by wrong tries keeps the wait, so guessing gets no faster.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";
export const CODE_LENGTH = 10;
export const SETUP_CODE_TTL_MS = 60 * 60_000;
export const CONFIRM_CODE_TTL_MS = 10 * 60_000;
/** A move code (ADR 0026 §1.1) is typed on another server: an hour. */
export const MOVE_CODE_TTL_MS = 60 * 60_000;
export const MAX_ATTEMPTS = 5;
export const ISSUE_INTERVAL_MS = 30_000;

const digest = (code) => createHash("sha256").update(code, "utf8").digest();

/** Upper-cases `input` and drops spaces and hyphens: "abcde-fghjk" and
 * "ABCDE FGHJK" are the same code. Returns null for anything else. */
export function normalizeCode(input) {
  if (typeof input !== "string" || input.length > 40) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const character of code) if (!CODE_ALPHABET.includes(character)) return null;
  return code;
}

/** "ABCDEFGHJK" as "ABCDE-FGHJK". */
export const displayCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

export function generateCode(random = randomInt) {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return code;
}

/**
 * One purpose's current code. `verify(input)` answers "ok" (and the code is
 * gone), "wrong", "expired", "locked" (too many wrong tries; it is gone),
 * "none" (no code issued, or already used) or "malformed" (not a code at
 * all: it doesn't count as a try, so a typo in length isn't punished).
 */
export class OneTimeCode {
  #hash = null;
  #expiresAt = 0;
  #attempts = 0;
  #issuedAt = null;
  #used = false;

  constructor({ purpose, ttlMs, maxAttempts = MAX_ATTEMPTS, issueIntervalMs = ISSUE_INTERVAL_MS, reissueAfterUse = false, now = Date.now, random = randomInt }) {
    Object.assign(this, { purpose, ttlMs, maxAttempts, issueIntervalMs, reissueAfterUse, now, random });
  }

  /** Whether a new code may be issued now; else when (ms since epoch). */
  nextIssueAt(now = this.now()) {
    return this.#issuedAt === null || (this.reissueAfterUse && this.#used) ? now : this.#issuedAt + this.issueIntervalMs;
  }

  /** Issues a new code (replacing any), or returns null inside the issue
   * interval unless `force`. Resolves to { code, expiresAt }. The clock is
   * read once: two looks a millisecond apart would refuse a first code. */
  issue({ force = false, code = null } = {}) {
    const now = this.now();
    if (!force && now < this.nextIssueAt(now)) return null;
    const value = code === null ? generateCode(this.random) : normalizeCode(code);
    if (value === null) throw new TypeError("not a valid code");
    this.#hash = digest(value);
    this.#issuedAt = now;
    this.#expiresAt = this.#issuedAt + this.ttlMs;
    this.#attempts = 0;
    this.#used = false;
    return { code: value, expiresAt: this.#expiresAt };
  }

  get active() { return this.#hash !== null && this.now() < this.#expiresAt; }
  get expiresAt() { return this.#hash === null ? null : this.#expiresAt; }
  get attemptsLeft() { return this.#hash === null ? 0 : this.maxAttempts - this.#attempts; }

  revoke() { this.#hash = null; this.#attempts = 0; }

  verify(input) {
    const code = normalizeCode(input);
    if (code === null) return "malformed";
    if (this.#hash === null) return "none";
    if (this.now() >= this.#expiresAt) { this.revoke(); return "expired"; }
    if (timingSafeEqual(digest(code), this.#hash)) { this.revoke(); this.#used = true; return "ok"; }
    this.#attempts += 1;
    if (this.#attempts >= this.maxAttempts) { this.revoke(); return "locked"; }
    return "wrong";
  }
}

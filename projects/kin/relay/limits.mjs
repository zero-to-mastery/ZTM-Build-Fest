// The connection relay's limits (ADR 0025 §3, §4, #732), held in memory
// only. Client addresses are kept here, for rate limits, and nowhere else:
// never written to disk, never logged, and forgotten when their window ends
// (24 hours at most). The 30-day claim limit is the one exception to "per
// address": it is counted in a sketch of keyed hashes that can't give an
// address back (ClaimSketch below).
import { createHmac, randomBytes } from "node:crypto";
import { addressBytes } from "./ktun.mjs";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Relay defaults (§4 table; §3 claims). The operator can change each. */
export const DEFAULT_LIMITS = Object.freeze({
  connectionsPerName: 256,
  connectionsPerClientPerMinute: 60,
  phoneIdleMs: 15 * MINUTE,
  bytesPerSecondPerName: 20_000_000 / 8,
  bytesPer30DaysPerName: 50 * 1000 ** 3,
  signInsPerSourcePerHour: 30,
  claimsPerSourcePerDay: 3,
  claimsPerSourcePer30Days: 10,
  newNamesPerWeek: 20,
  pendingHellos: 4096,
  phoneConnections: 65_536,
  controlRequestsInFlight: 8,
  // CHECK (#719): a setup page checking names as someone types.
  checksPerKeyPerMinute: 30,
});

/**
 * The rate-limit key for an address: the IPv4 address, or the IPv6 /64
 * (one network holds billions of IPv6 addresses), as Kin's own
 * server/client-key.mjs does. IPv4-mapped IPv6 counts as IPv4.
 */
export function addressKey(address) {
  const { family, bytes } = addressBytes(String(address ?? ""));
  return family === 4 ? bytes.subarray(0, 4).join(".") : `${bytes.subarray(0, 8).toString("hex")}/64`;
}

/**
 * Counts events per key in fixed windows. `hit(key)` counts one and says
 * whether the key is still within its limit. An entry is dropped as soon as
 * its window has ended (`sweep`), so nothing outlives `windowMs`, which is
 * at most a day.
 */
export class WindowCounter {
  #entries = new Map();
  constructor({ limit, windowMs, now = Date.now }) {
    if (windowMs > DAY) throw new RangeError("a relay rate-limit window is at most 24 hours");
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }
  hit(key, count = 1) {
    const now = this.now();
    let entry = this.#entries.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      entry = { start: now, count: 0 };
      this.#entries.set(key, entry);
    }
    entry.count += count;
    return entry.count <= this.limit;
  }
  /** Whether one more would be allowed, without counting it. */
  allows(key) {
    const entry = this.#entries.get(key);
    return !entry || this.now() - entry.start >= this.windowMs || entry.count < this.limit;
  }
  sweep() {
    const now = this.now();
    for (const [key, entry] of this.#entries) if (now - entry.start >= this.windowMs) this.#entries.delete(key);
  }
  get size() { return this.#entries.size; }
  /** The keys held now (for tests that check nothing is kept too long). */
  keys() { return [...this.#entries.keys()]; }
}

/**
 * Claims per source over 30 days, without keeping a source for 30 days.
 * A count-min sketch: each claim adds 1 to `depth` cells chosen by an HMAC
 * of the address key under a random secret made at start and never stored,
 * in the current day's row. A source's count is the smallest of its cells
 * summed over the last 30 days. Cells are shared by many addresses, so the
 * sketch can only over-count (a false refusal when claims are very many),
 * and it holds no address or identifier that could be given back. A
 * restart forgets it, as it forgets every in-memory limit.
 */
export class ClaimSketch {
  #secret = randomBytes(32);
  #days = new Map();
  constructor({ limit, days = 30, width = 4096, depth = 3, now = Date.now }) {
    Object.assign(this, { limit, days, width, depth, now });
  }
  #cells(key) {
    const digest = createHmac("sha256", this.#secret).update(key).digest();
    return Array.from({ length: this.depth }, (_, row) => row * this.width + (digest.readUInt32LE(row * 4) % this.width));
  }
  count(key) {
    const today = Math.floor(this.now() / DAY);
    const cells = this.#cells(key);
    let smallest = Infinity;
    for (const cell of cells) {
      let sum = 0;
      for (const [day, row] of this.#days) if (day > today - this.days) sum += row[cell];
      smallest = Math.min(smallest, sum);
    }
    return smallest;
  }
  allows(key) { return this.count(key) < this.limit; }
  add(key) {
    const today = Math.floor(this.now() / DAY);
    let row = this.#days.get(today);
    if (!row) { row = new Uint16Array(this.width * this.depth); this.#days.set(today, row); }
    for (const cell of this.#cells(key)) if (row[cell] < 0xffff) row[cell] += 1;
    for (const day of this.#days.keys()) if (day <= today - this.days) this.#days.delete(day);
  }
}

/**
 * A token bucket for one name's bandwidth in one direction. `reserve(n)`
 * takes n bytes (going into debt if need be) and returns how many
 * milliseconds to wait before passing more, so the sustained rate stays at
 * `bytesPerSecond` with bursts up to `burstBytes`.
 */
export class TokenBucket {
  constructor({ bytesPerSecond, burstBytes = bytesPerSecond, now = Date.now }) {
    Object.assign(this, { bytesPerSecond, burstBytes, now });
    this.tokens = burstBytes;
    this.at = now();
  }
  reserve(bytes) {
    const now = this.now();
    this.tokens = Math.min(this.burstBytes, this.tokens + ((now - this.at) * this.bytesPerSecond) / 1000);
    this.at = now;
    this.tokens -= bytes;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens * 1000) / this.bytesPerSecond);
  }
}

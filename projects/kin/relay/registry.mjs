// The connection relay's name registry (ADR 0025 §3, §4, #731), one SQLite
// file through node:sqlite, as Kin's own service keeps its data.
//
// What it keeps is exactly the ADR's list (§4 "What the relay logs"):
//
// - names: each free name, the SHA-256 of its home public key, the day it
//   was claimed, the last day (not time) its key connected, its CAA account
//   URI, whether it is suspended, and the day a certificate for it was first
//   seen in Certificate Transparency (public already; it decides the one case
//   where a name may be claimed again, §3);
// - domains: each own domain, the key hash it belongs to, the day it was
//   added and the last day its TXT record was checked good;
// - retired: names released by their key, kept forever as the name and the
//   key hash only, so they are never given out again;
// - counters: per name and hour, phone connections and bytes each way,
//   kept 30 days;
// - errors: an error code and a count;
// - waitlist: key hashes waiting for a free name while the weekly cap
//   applies, with the day they asked.
//
// No address, no connection time and no byte of any stream is ever written.
import { DatabaseSync } from "node:sqlite";
import { Code, isHostName } from "./ktun.mjs";
import { DAY, HOUR } from "./limits.mjs";

/** Names no one may claim (§3); the operator adds more. */
export const RESERVED_NAMES = Object.freeze([
  "www", "relay", "ns", "ns1", "ns2", "ns3", "ns4", "mail", "smtp", "imap", "pop", "mx", "admin", "administrator",
  "api", "kin", "home", "help", "support", "status", "login", "account", "accounts", "secure", "acme", "test",
  "example", "abuse", "postmaster", "hostmaster", "webmaster", "root", "localhost", "autoconfig", "autodiscover",
  "dns", "ftp", "security", "noc", "info",
]);

/** Days a claimed name may go without a certificate before it is freed. */
export const CERTIFICATE_GRACE_DAYS = 7;
/** Days without its key connecting before a name stops routing. */
export const DORMANT_DAYS = 365;
export const COUNTER_DAYS = 30;
export const DOMAINS_PER_KEY = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS names (
  name TEXT PRIMARY KEY,
  key_hash BLOB NOT NULL UNIQUE,
  claimed_day INTEGER NOT NULL,
  last_seen_day INTEGER NOT NULL,
  caa_account_uri TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  certified_day INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  key_hash BLOB NOT NULL,
  added_day INTEGER NOT NULL,
  verified_day INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS domains_key ON domains(key_hash);
CREATE TABLE IF NOT EXISTS retired (
  name TEXT PRIMARY KEY,
  key_hash BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS counters (
  name TEXT NOT NULL,
  hour INTEGER NOT NULL,
  connections INTEGER NOT NULL DEFAULT 0,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, hour)
) STRICT;
CREATE TABLE IF NOT EXISTS errors (
  code TEXT PRIMARY KEY,
  count INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS waitlist (
  key_hash BLOB PRIMARY KEY,
  day INTEGER NOT NULL,
  seq INTEGER NOT NULL
) STRICT;
`;

/** The registry's file format version (PRAGMA user_version). */
export const REGISTRY_VERSION = 1;

/**
 * Whether `label` may be a free name (§3): 3 to 40 characters of lowercase
 * letters, digits and hyphens, not starting or ending with a hyphen, no
 * hyphen in both the third and fourth places (reserved for "xn--"), and not
 * reserved.
 */
export function freeLabelAllowed(label, reserved = RESERVED_NAMES) {
  return typeof label === "string"
    && /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(label)
    && !(label[2] === "-" && label[3] === "-")
    && !reserved.includes(label);
}

export class Registry {
  /**
   * @param {object} options
   * @param {string} options.zone       the relay's zone, e.g. home.kin.journeytocode.io
   * @param {string} [options.path]     the SQLite file (":memory:" for tests)
   * @param {string[]} [options.reserved] names the operator adds to the reserved list
   * @param {number} [options.newNamesPerWeek] the weekly cap while the PSL entry isn't in use; 0 for none
   * @param {() => number} [options.now]
   */
  constructor({ zone, path = ":memory:", reserved = [], newNamesPerWeek = 20, now = Date.now }) {
    if (!isHostName(zone)) throw new RangeError("the relay zone must be a lowercase host name");
    this.zone = zone;
    this.reserved = [...RESERVED_NAMES, ...reserved.map((name) => name.toLowerCase())];
    this.newNamesPerWeek = newNamesPerWeek;
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    // Close before refusing, so the file isn't left open (Windows can't
    // delete or replace an open file).
    if (version > REGISTRY_VERSION) this.db.close();
    if (version > REGISTRY_VERSION) throw new Error(`the relay registry is version ${version}; this relay reads up to ${REGISTRY_VERSION}`);
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${REGISTRY_VERSION}`);
    const q = (sql) => this.db.prepare(sql);
    this.sql = {
      nameRow: q("SELECT * FROM names WHERE name = ?"),
      nameOfKey: q("SELECT * FROM names WHERE key_hash = ?"),
      retired: q("SELECT 1 FROM retired WHERE name = ?"),
      insertName: q("INSERT INTO names (name, key_hash, claimed_day, last_seen_day) VALUES (?, ?, ?, ?)"),
      deleteName: q("DELETE FROM names WHERE name = ?"),
      retire: q("INSERT OR IGNORE INTO retired (name, key_hash) VALUES (?, ?)"),
      seen: q("UPDATE names SET last_seen_day = ? WHERE key_hash = ?"),
      setCaa: q("UPDATE names SET caa_account_uri = ? WHERE name = ?"),
      suspend: q("UPDATE names SET suspended = ? WHERE name = ?"),
      certified: q("UPDATE names SET certified_day = ? WHERE name = ? AND certified_day IS NULL"),
      rebind: q("UPDATE names SET key_hash = ?, caa_account_uri = NULL WHERE name = ?"),
      uncertified: q("SELECT name FROM names WHERE certified_day IS NULL AND claimed_day <= ?"),
      claimedSince: q("SELECT COUNT(*) AS count FROM names WHERE claimed_day > ?"),
      domainRow: q("SELECT * FROM domains WHERE domain = ?"),
      domainsOfKey: q("SELECT * FROM domains WHERE key_hash = ? ORDER BY domain"),
      allDomains: q("SELECT * FROM domains ORDER BY domain"),
      upsertDomain: q("INSERT INTO domains (domain, key_hash, added_day, verified_day) VALUES (?, ?, ?, ?) ON CONFLICT(domain) DO UPDATE SET key_hash = excluded.key_hash, added_day = excluded.added_day, verified_day = excluded.verified_day"),
      verifiedDomain: q("UPDATE domains SET verified_day = ? WHERE domain = ?"),
      deleteDomain: q("DELETE FROM domains WHERE domain = ?"),
      count: q(`INSERT INTO counters (name, hour, connections, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name, hour) DO UPDATE SET connections = connections + excluded.connections,
        bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out`),
      usage: q("SELECT COALESCE(SUM(bytes_in + bytes_out), 0) AS bytes FROM counters WHERE name = ? AND hour > ?"),
      pruneCounters: q("DELETE FROM counters WHERE hour <= ?"),
      error: q("INSERT INTO errors (code, count) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET count = count + excluded.count"),
      errors: q("SELECT code, count FROM errors ORDER BY code"),
      waiting: q("SELECT key_hash FROM waitlist ORDER BY seq"),
      wait: q("INSERT OR IGNORE INTO waitlist (key_hash, day, seq) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM waitlist))"),
      unwait: q("DELETE FROM waitlist WHERE key_hash = ?"),
      pruneWaitlist: q("DELETE FROM waitlist WHERE day <= ?"),
    };
  }

  close() { if (this.db.isOpen) this.db.close(); }

  get today() { return Math.floor(this.now() / DAY); }

  /** The label of a full name in the zone, or null. */
  labelOf(name) {
    const suffix = `.${this.zone}`;
    if (typeof name !== "string" || !name.endsWith(suffix)) return null;
    const label = name.slice(0, -suffix.length);
    return label.includes(".") ? null : label;
  }

  /** A free name is routed while bound, not suspended and not dormant (§3). */
  #routable(row) {
    return row && !row.suspended && row.last_seen_day > this.today - DORMANT_DAYS;
  }

  /** Records a sign-in by `keyHash`: its free name's last-seen day is today.
   * Returns { suspended } (a suspended name refuses the tunnel, §3). */
  signedIn(keyHash) {
    this.sql.seen.run(this.today, keyHash);
    const row = this.sql.nameOfKey.get(keyHash);
    return { suspended: Boolean(row?.suspended) };
  }

  /** The names routed to `keyHash`'s tunnel: its free name and its own
   * domains whose TXT record checked good within the last two days. */
  routedNames(keyHash) {
    const names = [];
    const row = this.sql.nameOfKey.get(keyHash);
    if (this.#routable(row)) names.push(row.name);
    for (const domain of this.sql.domainsOfKey.all(keyHash))
      if (domain.verified_day >= this.today - 1) names.push(domain.domain);
    return names;
  }

  /** What the DNS server answers for a name in the zone (§4). */
  dnsInfo(name) {
    const row = this.sql.nameRow.get(name);
    return this.#routable(row) ? { routed: true, caaAccountUri: row.caa_account_uri ?? null } : { routed: false, caaAccountUri: null };
  }

  /** The key hash a name is bound to (any state), or null. */
  keyOf(name) {
    const row = this.sql.nameRow.get(name) ?? this.sql.domainRow.get(name);
    return row ? Buffer.from(row.key_hash) : null;
  }

  isSuspended(name) { return Boolean(this.sql.nameRow.get(name)?.suspended); }
  /** Whether `keyHash`'s free name is suspended (read only). */
  keySuspended(keyHash) { return Boolean(this.sql.nameOfKey.get(keyHash)?.suspended); }

  /**
   * CLAIM (§3). Returns a KTUN code: NONE when `name` is now (or already
   * was) bound to `keyHash`; NAME_NOT_ALLOWED for a name outside the rules
   * or reserved; NAME_TAKEN for a name bound to another key or retired;
   * LIMIT when the key already holds a free name or the weekly cap is
   * reached (the key then waits its turn). Per-source limits are the
   * caller's (they need the address, which the registry never sees):
   * `sourceAllows()` is asked only when the claim would bind a new name.
   */
  claim(keyHash, name, sourceAllows = () => true) {
    const label = this.labelOf(name);
    if (label === null || !freeLabelAllowed(label, this.reserved)) return Code.NAME_NOT_ALLOWED;
    const existing = this.sql.nameRow.get(name);
    if (existing) return Buffer.from(existing.key_hash).equals(keyHash) ? Code.NONE : Code.NAME_TAKEN;
    if (this.sql.retired.get(name)) return Code.NAME_TAKEN;
    if (this.sql.nameOfKey.get(keyHash) || !sourceAllows()) return Code.LIMIT;
    if (this.newNamesPerWeek > 0) {
      const room = this.newNamesPerWeek - this.sql.claimedSince.get(this.today - 7).count;
      this.sql.pruneWaitlist.run(this.today - 30);
      const queue = this.sql.waiting.all().map((row) => Buffer.from(row.key_hash));
      const position = queue.findIndex((hash) => hash.equals(keyHash));
      if (room <= 0 || (position < 0 ? queue.length >= room : position >= room)) {
        this.sql.wait.run(keyHash, this.today);
        return Code.LIMIT;
      }
    }
    this.sql.insertName.run(name, keyHash, this.today, this.today);
    this.sql.unwait.run(keyHash);
    return Code.NONE;
  }

  /**
   * CHECK (#719): what CLAIM would answer for `name` from `keyHash`, without
   * binding it, counting it or joining the weekly waiting list. NONE means
   * free (or already this key's); LIMIT means this key already holds a
   * different free name. The weekly cap and per-source limits are only
   * known at the claim itself.
   */
  check(keyHash, name) {
    const label = this.labelOf(name);
    if (label === null || !freeLabelAllowed(label, this.reserved)) return Code.NAME_NOT_ALLOWED;
    const existing = this.sql.nameRow.get(name);
    if (existing) return Buffer.from(existing.key_hash).equals(keyHash) ? Code.NONE : Code.NAME_TAKEN;
    if (this.sql.retired.get(name)) return Code.NAME_TAKEN;
    if (this.sql.nameOfKey.get(keyHash)) return Code.LIMIT;
    return Code.NONE;
  }

  /** RELEASE (§3): stops routing and retires the name for good. */
  release(keyHash, name) {
    const row = this.sql.nameRow.get(name);
    if (!row) return this.sql.retired.get(name) ? Code.NAME_TAKEN : Code.UNKNOWN_NAME;
    if (!Buffer.from(row.key_hash).equals(keyHash)) return Code.NAME_TAKEN;
    this.db.exec("BEGIN");
    try {
      this.sql.deleteName.run(name);
      this.sql.retire.run(name, keyHash);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return Code.NONE;
  }

  /** SET_CAA (§5): the ACME account URI the name's CAA record names. */
  setCaa(keyHash, name, accountUri) {
    const row = this.sql.nameRow.get(name);
    if (!row) return Code.UNKNOWN_NAME;
    if (!Buffer.from(row.key_hash).equals(keyHash)) return Code.NAME_TAKEN;
    if (row.suspended) return Code.SUSPENDED;
    if (!/^https:\/\/[\x21-\x7e]+$/.test(accountUri) || /[";\\]/.test(accountUri)) return Code.NAME_NOT_ALLOWED;
    this.sql.setCaa.run(accountUri, name);
    return Code.NONE;
  }

  /**
   * TRANSFER (§3): rebinds `name` from `oldHash` to `newHash` (the caller
   * has checked the new key's signature). The CAA record is cleared until
   * the new key sets one. The new key must not hold a free name already.
   */
  transfer(oldHash, name, newHash) {
    const row = this.sql.nameRow.get(name);
    if (!row) return Code.UNKNOWN_NAME;
    if (!Buffer.from(row.key_hash).equals(oldHash)) return Code.NAME_TAKEN;
    if (row.suspended) return Code.SUSPENDED;
    if (this.sql.nameOfKey.get(newHash)) return Code.LIMIT;
    this.sql.rebind.run(newHash, name);
    return Code.NONE;
  }

  /** Whether `domain` may be an own domain at all: a host name of two or
   * more labels outside the relay's zone. */
  domainAllowed(domain, relayName) {
    return isHostName(domain) && domain.includes(".") && domain !== this.zone && !domain.endsWith(`.${this.zone}`) && domain !== relayName;
  }

  /**
   * ADD_DOMAIN (§3), after the caller has checked the TXT record proves
   * `keyHash`. `otherProven(hash)` says whether the TXT record also proves
   * the key the domain is bound to now: a household's domain moves to a new
   * key only when its DNS no longer names the old one.
   */
  addDomain(keyHash, domain, otherProven) {
    const row = this.sql.domainRow.get(domain);
    if (row && !Buffer.from(row.key_hash).equals(keyHash) && otherProven(Buffer.from(row.key_hash))) return Code.NAME_TAKEN;
    const own = this.sql.domainsOfKey.all(keyHash).filter((entry) => entry.domain !== domain);
    if (own.length >= DOMAINS_PER_KEY) return Code.LIMIT;
    this.sql.upsertDomain.run(domain, keyHash, this.today, this.today);
    return Code.NONE;
  }

  removeDomain(keyHash, domain) {
    const row = this.sql.domainRow.get(domain);
    if (!row) return Code.UNKNOWN_NAME;
    if (!Buffer.from(row.key_hash).equals(keyHash)) return Code.NAME_TAKEN;
    this.sql.deleteDomain.run(domain);
    return Code.NONE;
  }

  /** Every own domain, for the daily TXT check. */
  domains() { return this.sql.allDomains.all().map((row) => ({ domain: row.domain, keyHash: Buffer.from(row.key_hash) })); }
  domainVerified(domain) { this.sql.verifiedDomain.run(this.today, domain); }

  /** The operator suspends a name (or lifts it) after an abuse report.
   * Suspension never moves the name to another key. */
  suspend(name, suspended = true) {
    return this.sql.suspend.run(suspended ? 1 : 0, name).changes > 0;
  }

  /** Names claimed CERTIFICATE_GRACE_DAYS or more ago with no certificate
   * seen yet: the daily sweep asks Certificate Transparency about each. */
  uncertifiedNames() {
    return this.sql.uncertified.all(this.today - CERTIFICATE_GRACE_DAYS).map((row) => row.name);
  }
  markCertified(name) { this.sql.certified.run(this.today, name); }
  /** Frees a name that never got a certificate: no browser can have stored
   * anything for it, so it is the one case where reuse is safe (§3). It is
   * deleted, not retired. */
  freeUncertified(name) {
    const row = this.sql.nameRow.get(name);
    if (!row || row.certified_day !== null) return false;
    this.sql.deleteName.run(name);
    return true;
  }

  /** Adds to a name's counters for the current hour. */
  count(name, { connections = 0, bytesIn = 0, bytesOut = 0 }) {
    this.sql.count.run(name, Math.floor(this.now() / HOUR), connections, bytesIn, bytesOut);
  }
  /** Bytes both ways over the last 30 days. */
  usage(name) { return Number(this.sql.usage.get(name, Math.floor(this.now() / HOUR) - COUNTER_DAYS * 24).bytes); }

  error(code, count = 1) { this.sql.error.run(code, count); }
  errors() { return Object.fromEntries(this.sql.errors.all().map((row) => [row.code, Number(row.count)])); }

  /** Drops counters older than 30 days. */
  prune() { this.sql.pruneCounters.run(Math.floor(this.now() / HOUR) - COUNTER_DAYS * 24); }
}

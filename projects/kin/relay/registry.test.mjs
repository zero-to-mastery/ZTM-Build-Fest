// The name registry (#731): ADR 0025 §3's rules for free names and own
// domains, and what the registry keeps (§4), with an injected clock.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Code } from "./ktun.mjs";
import { DAY, HOUR } from "./limits.mjs";
import { CERTIFICATE_GRACE_DAYS, DORMANT_DAYS, RESERVED_NAMES, Registry, freeLabelAllowed } from "./registry.mjs";

const key = (byte) => Buffer.alloc(32, byte);
const START = Date.UTC(2026, 9, 22, 12);

function registry(options = {}) {
  const clock = { now: START };
  const value = new Registry({ zone: "home.test", now: () => clock.now, newNamesPerWeek: 0, ...options });
  return { registry: value, clock };
}

test("free names: 3–40 LDH characters, no edge hyphens, no xn-- pattern, not reserved", () => {
  for (const label of ["abc", "smith", "the-smiths", "a1b", "x".repeat(40), "007"]) assert.ok(freeLabelAllowed(label), label);
  for (const label of ["ab", "x".repeat(41), "-abc", "abc-", "ab--c", "xn--abc", "Smith", "smi_th", "smi.th", "", "www", "relay", "ns1", "kin", "acme"])
    assert.ok(!freeLabelAllowed(label), label);
  assert.ok(freeLabelAllowed("a-b-c"), "single hyphens are fine");
  for (const name of ["www", "relay", "ns1", "ns2", "mail", "admin", "api", "kin", "home", "help", "support", "status", "login", "account", "secure", "acme", "test", "example"])
    assert.ok(RESERVED_NAMES.includes(name), `the ADR reserves ${name}`);
  const { registry: withExtra } = registry({ reserved: ["Family"] });
  assert.equal(withExtra.claim(key(1), "family.home.test"), Code.NAME_NOT_ALLOWED, "the operator can add to the list");
  withExtra.close();
});

test("a name is claimed once, bound to one key forever, one free name per key", () => {
  const { registry: names } = registry();
  assert.equal(names.claim(key(1), "smith.home.test"), Code.NONE);
  assert.equal(names.claim(key(1), "smith.home.test"), Code.NONE, "the same key again");
  assert.equal(names.claim(key(2), "smith.home.test"), Code.NAME_TAKEN);
  assert.equal(names.claim(key(1), "jones.home.test"), Code.LIMIT, "one free name per key");
  assert.equal(names.claim(key(2), "jones.other.test"), Code.NAME_NOT_ALLOWED, "outside the zone");
  assert.equal(names.claim(key(2), "a.jones.home.test"), Code.NAME_NOT_ALLOWED, "one label only");
  assert.equal(names.claim(key(2), "jones.home.test", () => false), Code.LIMIT, "the source's limits apply to new names");
  assert.equal(names.claim(key(1), "smith.home.test", () => false), Code.NONE, "but not to a name the key holds");
  assert.deepEqual(names.routedNames(key(1)), ["smith.home.test"]);
  assert.deepEqual(names.keyOf("smith.home.test"), key(1));
  names.close();
});

test("RELEASE retires a name for good, for everyone", () => {
  const { registry: names } = registry();
  names.claim(key(1), "smith.home.test");
  assert.equal(names.release(key(2), "smith.home.test"), Code.NAME_TAKEN, "only its key may release it");
  assert.equal(names.release(key(1), "smith.home.test"), Code.NONE);
  assert.deepEqual(names.routedNames(key(1)), []);
  assert.equal(names.claim(key(1), "smith.home.test"), Code.NAME_TAKEN);
  assert.equal(names.claim(key(2), "smith.home.test"), Code.NAME_TAKEN);
  assert.equal(names.release(key(1), "smith.home.test"), Code.NAME_TAKEN);
  assert.equal(names.release(key(1), "never.home.test"), Code.UNKNOWN_NAME);
  // Retired names keep the name and the key hash only.
  assert.deepEqual(Object.keys(names.db.prepare("SELECT * FROM retired").get()), ["name", "key_hash"]);
  assert.equal(names.claim(key(1), "jones.home.test"), Code.NONE, "the key may claim another name");
  names.close();
});

test("a name with no certificate 7 days after its claim may be freed; one with a certificate never", () => {
  const { registry: names, clock } = registry();
  names.claim(key(1), "smith.home.test");
  names.claim(key(2), "jones.home.test");
  clock.now += (CERTIFICATE_GRACE_DAYS - 1) * DAY;
  assert.deepEqual(names.uncertifiedNames(), []);
  clock.now += DAY;
  assert.deepEqual(names.uncertifiedNames().sort(), ["jones.home.test", "smith.home.test"]);
  names.markCertified("jones.home.test");
  assert.equal(names.freeUncertified("jones.home.test"), false);
  assert.equal(names.freeUncertified("smith.home.test"), true);
  assert.equal(names.claim(key(3), "smith.home.test"), Code.NONE, "the one case where a name is claimed again");
  assert.deepEqual(names.uncertifiedNames(), []);
  names.close();
});

test("a name whose key hasn't connected for 365 days stops routing but stays bound", () => {
  const { registry: names, clock } = registry();
  names.claim(key(1), "smith.home.test");
  clock.now += (DORMANT_DAYS - 1) * DAY;
  assert.deepEqual(names.dnsInfo("smith.home.test"), { routed: true, caaAccountUri: null });
  clock.now += DAY;
  assert.deepEqual(names.dnsInfo("smith.home.test"), { routed: false, caaAccountUri: null });
  assert.deepEqual(names.routedNames(key(1)), []);
  assert.equal(names.claim(key(2), "smith.home.test"), Code.NAME_TAKEN, "never offered to anyone else");
  names.signedIn(key(1));
  assert.deepEqual(names.routedNames(key(1)), ["smith.home.test"], "connecting again brings it back");
  names.close();
});

test("SET_CAA, TRANSFER and suspension", () => {
  const { registry: names } = registry();
  names.claim(key(1), "smith.home.test");
  assert.equal(names.setCaa(key(2), "smith.home.test", "https://acme.test/acct/1"), Code.NAME_TAKEN);
  assert.equal(names.setCaa(key(1), "smith.home.test", "http://acme.test/acct/1"), Code.NAME_NOT_ALLOWED);
  assert.equal(names.setCaa(key(1), "smith.home.test", "https://acme.test/a\"; accounturi=x"), Code.NAME_NOT_ALLOWED, "no CAA injection");
  assert.equal(names.setCaa(key(1), "smith.home.test", "https://acme.test/acct/1"), Code.NONE);
  assert.equal(names.dnsInfo("smith.home.test").caaAccountUri, "https://acme.test/acct/1");
  names.claim(key(3), "jones.home.test");
  assert.equal(names.transfer(key(1), "smith.home.test", key(3)), Code.LIMIT, "the new key already holds a free name");
  assert.equal(names.transfer(key(2), "smith.home.test", key(4)), Code.NAME_TAKEN);
  assert.equal(names.transfer(key(1), "smith.home.test", key(4)), Code.NONE);
  assert.deepEqual(names.keyOf("smith.home.test"), key(4));
  assert.equal(names.dnsInfo("smith.home.test").caaAccountUri, null, "CAA is cleared until the new key sets it");
  assert.ok(names.suspend("smith.home.test"));
  assert.equal(names.signedIn(key(4)).suspended, true);
  assert.deepEqual(names.routedNames(key(4)), []);
  assert.equal(names.dnsInfo("smith.home.test").routed, false);
  assert.equal(names.setCaa(key(4), "smith.home.test", "https://acme.test/acct/2"), Code.SUSPENDED);
  assert.equal(names.transfer(key(4), "smith.home.test", key(5)), Code.SUSPENDED, "suspension never moves the name");
  names.suspend("smith.home.test", false);
  assert.deepEqual(names.routedNames(key(4)), ["smith.home.test"]);
  names.close();
});

test("the weekly cap holds new names to 20 a week, with a waiting list in order", () => {
  const { registry: names, clock } = registry({ newNamesPerWeek: 2 });
  assert.equal(names.claim(key(1), "aaa.home.test"), Code.NONE);
  assert.equal(names.claim(key(2), "bbb.home.test"), Code.NONE);
  assert.equal(names.claim(key(3), "ccc.home.test"), Code.LIMIT, "the third this week waits");
  assert.equal(names.claim(key(4), "ddd.home.test"), Code.LIMIT);
  clock.now += 8 * DAY;
  assert.equal(names.claim(key(4), "ddd.home.test"), Code.NONE, "two places this week; key 4 is second in line");
  assert.equal(names.claim(key(5), "eee.home.test"), Code.LIMIT, "key 3 is still ahead of a newcomer");
  assert.equal(names.claim(key(3), "ccc.home.test"), Code.NONE);
  assert.equal(names.claim(key(5), "eee.home.test"), Code.LIMIT);
  names.close();
});

test("own domains: two per key, outside the zone; a domain moves only when its TXT stops naming the old key", () => {
  const { registry: names, clock } = registry();
  assert.equal(names.domainAllowed("kin.smith.family", "relay.home.test"), true);
  for (const bad of ["family", "x.home.test", "home.test", "relay.home.test", "Kin.smith.family", "kin.smith.family."])
    assert.equal(names.domainAllowed(bad, "relay.home.test"), false, bad);
  assert.equal(names.addDomain(key(1), "kin.smith.family", () => false), Code.NONE);
  assert.equal(names.addDomain(key(1), "kin2.smith.family", () => false), Code.NONE);
  assert.equal(names.addDomain(key(1), "kin3.smith.family", () => false), Code.LIMIT);
  assert.equal(names.addDomain(key(1), "kin.smith.family", () => false), Code.NONE, "adding again rechecks it");
  assert.deepEqual(names.routedNames(key(1)), ["kin.smith.family", "kin2.smith.family"]);
  assert.equal(names.addDomain(key(2), "kin.smith.family", () => true), Code.NAME_TAKEN);
  assert.equal(names.addDomain(key(2), "kin.smith.family", () => false), Code.NONE);
  assert.deepEqual(names.routedNames(key(1)), ["kin2.smith.family"]);
  // Not checked good for two days: not routed until it is again.
  clock.now += 2 * DAY;
  assert.deepEqual(names.routedNames(key(2)), []);
  names.domainVerified("kin.smith.family");
  assert.deepEqual(names.routedNames(key(2)), ["kin.smith.family"]);
  assert.equal(names.removeDomain(key(1), "kin.smith.family"), Code.NAME_TAKEN);
  assert.equal(names.removeDomain(key(2), "kin.smith.family"), Code.NONE);
  assert.equal(names.removeDomain(key(2), "kin.smith.family"), Code.UNKNOWN_NAME);
  names.close();
});

test("counters are hourly and kept 30 days; errors are a code and a count", () => {
  const { registry: names, clock } = registry();
  names.count("smith.home.test", { connections: 2, bytesIn: 100, bytesOut: 900 });
  names.count("smith.home.test", { connections: 1, bytesIn: 10 });
  clock.now += HOUR;
  names.count("smith.home.test", { bytesOut: 5 });
  assert.equal(names.usage("smith.home.test"), 1015);
  assert.equal(names.db.prepare("SELECT COUNT(*) AS n FROM counters").get().n, 2);
  clock.now += 30 * DAY - HOUR;
  assert.equal(names.usage("smith.home.test"), 5, "only the last 30 days count");
  names.prune();
  assert.equal(names.db.prepare("SELECT COUNT(*) AS n FROM counters").get().n, 1);
  names.error("unrouted");
  names.error("unrouted", 4);
  assert.deepEqual(names.errors(), { unrouted: 5 });
  names.close();
});

test("the registry file holds the ADR's columns and nothing else", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-relay-registry-"));
  try {
    const path = join(directory, "registry.sqlite");
    const { registry: names } = registry({ path });
    names.claim(key(1), "smith.home.test");
    const columns = Object.fromEntries(["names", "domains", "retired", "counters", "errors", "waitlist"].map((table) =>
      [table, names.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)]));
    assert.deepEqual(columns, {
      names: ["name", "key_hash", "claimed_day", "last_seen_day", "caa_account_uri", "suspended", "certified_day"],
      domains: ["domain", "key_hash", "added_day", "verified_day"],
      retired: ["name", "key_hash"],
      counters: ["name", "hour", "connections", "bytes_in", "bytes_out"],
      errors: ["code", "count"],
      waitlist: ["key_hash", "day", "seq"],
    });
    assert.equal(names.db.prepare("PRAGMA user_version").get().user_version, 1);
    names.close();
    assert.ok(readFileSync(path).length > 0);
    // A newer file is refused rather than misread.
    const newer = new Registry({ zone: "home.test", path });
    newer.db.exec("PRAGMA user_version = 2");
    newer.close();
    assert.throws(() => new Registry({ zone: "home.test", path }), /version 2/);
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

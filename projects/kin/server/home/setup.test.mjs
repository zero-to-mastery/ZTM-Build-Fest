// The setup flow's state machine (#719), the codes that guard the loopback
// panel, its stored sessions, the settings it writes, and an own domain's
// DNS checks. Fakes stand in for the relay and the CA here; the loopback
// end-to-end test (control-setup-e2e.test.mjs) uses the real ones.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { keyHashText, rawEd25519PublicKey } from "../../relay/ktun.mjs";
import { CODE_ALPHABET, CODE_LENGTH, ISSUE_INTERVAL_MS, MAX_ATTEMPTS, OneTimeCode, displayCode, generateCode, normalizeCode } from "./access-codes.mjs";
import { ControlSessions, MAX_SESSIONS, SESSION_TTL_MS } from "./control-sessions.mjs";
import { checkDomainRecords, expectedRecords } from "./domain-records.mjs";
import { httpsQuery, parseServer, readHttpsAnswer } from "./dns-https.mjs";
import { homeSettingsPath, loadHomeSettings, resolveHomeSettings, writeHomeSettings } from "./settings.mjs";
import { HomeSetup, SetupError, interpretName } from "./setup.mjs";

const TIMEOUT = { timeout: 30_000 };
const POSIX = process.platform !== "win32";

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "kin-setup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

function clock(start = Date.UTC(2026, 9, 22, 12)) {
  let now = start;
  const tick = () => now;
  tick.advance = (ms) => { now += ms; };
  return tick;
}

// ------------------------------------------------------------ the codes

test("one-time codes: an unambiguous alphabet, single use, expiry, limited tries", TIMEOUT, () => {
  for (const character of "01ILOUV") assert.ok(!CODE_ALPHABET.includes(character), `${character} looks like another character`);
  const now = clock();
  const sample = generateCode();
  assert.equal(sample.length, CODE_LENGTH);
  assert.equal(normalizeCode(`${sample.slice(0, 5).toLowerCase()} - ${sample.slice(5)}`.replace(" - ", "-")), sample, "case and the hyphen don't matter");
  assert.equal(normalizeCode("short"), null);
  assert.equal(normalizeCode("ABCDE-0OIL1"), null, "look-alikes are never part of a code");
  assert.equal(displayCode("ABCDEFGHJK"), "ABCDE-FGHJK");

  const code = new OneTimeCode({ purpose: "access", ttlMs: 60 * 60_000, now });
  assert.equal(code.verify("ABCDE-FGHJK"), "none", "nothing issued yet");
  const issued = code.issue();
  assert.equal(code.issue(), null, "a second code within the interval is refused");
  assert.equal(code.verify("tiny"), "malformed", "a malformed entry doesn't count as a try");
  assert.equal(code.attemptsLeft, MAX_ATTEMPTS);
  assert.equal(code.verify(issued.code), "ok");
  assert.equal(code.verify(issued.code), "none", "used once");
  assert.equal(code.issue(), null, "an access code waits even after it was used");

  // A confirmation code, used correctly, lets the next change have its
  // code at once.
  const confirm = new OneTimeCode({ purpose: "confirm", ttlMs: 10 * 60_000, reissueAfterUse: true, now });
  assert.equal(confirm.verify(confirm.issue().code), "ok");
  const next = confirm.issue();
  assert.ok(next, "no wait after a confirmation code was used");
  assert.equal(confirm.issue(), null, "but not while that one waits");
  now.advance(ISSUE_INTERVAL_MS);
  const second = code.issue();
  now.advance(60 * 60_000);
  assert.equal(code.verify(second.code), "expired", "an hour later");

  const third = code.issue({ force: true });
  const wrong = third.code.startsWith("2") ? `3${third.code.slice(1)}` : `2${third.code.slice(1)}`;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) assert.equal(code.verify(wrong), "wrong");
  assert.equal(code.attemptsLeft, 1);
  assert.equal(code.verify(wrong), "locked", "the last wrong try destroys the code");
  assert.equal(code.verify(third.code), "none", "even the right code is gone after that");
  const lockedConfirm = confirm.issue({ force: true });
  const wrongConfirm = lockedConfirm.code.startsWith("2") ? `3${lockedConfirm.code.slice(1)}` : `2${lockedConfirm.code.slice(1)}`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) confirm.verify(wrongConfirm);
  assert.equal(confirm.issue(), null, "a locked code keeps the wait: guessing gets no faster");
});

test("one-time codes: the first code is never refused as too soon, however the clock ticks", TIMEOUT, () => {
  // A clock a millisecond on at every look, as a busy machine's can be.
  let ms = Date.UTC(2026, 9, 22, 12);
  const now = () => ms++;
  assert.ok(new OneTimeCode({ purpose: "access", ttlMs: 60 * 60_000, now }).issue(), "nothing issued yet");
  const confirm = new OneTimeCode({ purpose: "confirm", ttlMs: 10 * 60_000, reissueAfterUse: true, now });
  assert.equal(confirm.verify(confirm.issue().code), "ok");
  assert.ok(confirm.issue(), "straight after a confirmation code was used");
});

// ------------------------------------------------------- the settings file

test("writeHomeSettings merges, checks before writing, and writes 0600 in a 0700 home/", TIMEOUT, async (t) => {
  const data = temporary(t);
  const settings = await writeHomeSettings(data, { name: "Fern.home.kin.journeytocode.io", acmeTermsAgreed: true }, {});
  assert.equal(settings.name, "fern.home.kin.journeytocode.io");
  assert.equal(settings.configured, true);
  const path = homeSettingsPath(data);
  if (POSIX) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(data, "home")).mode & 0o777, 0o700);
  }
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { format: 1, name: "Fern.home.kin.journeytocode.io", acmeTermsAgreed: true });
  // A later change merges; null removes a field.
  await writeHomeSettings(data, { maxHouseholds: 3 }, {});
  assert.equal((await loadHomeSettings(data, {})).maxHouseholds, 3);
  assert.equal((await loadHomeSettings(data, {})).name, "fern.home.kin.journeytocode.io");
  await writeHomeSettings(data, { maxHouseholds: null }, {});
  assert.equal((await loadHomeSettings(data, {})).maxHouseholds, null);
  // A bad change leaves the file as it was.
  const before = readFileSync(path, "utf8");
  await assert.rejects(writeHomeSettings(data, { maxHouseholds: 11 }, {}), (error) => error.code === "home_settings_invalid");
  await assert.rejects(writeHomeSettings(data, { name: "not a name" }, {}), (error) => error.code === "home_settings_invalid");
  assert.equal(readFileSync(path, "utf8"), before);
  // The environment still wins for reading.
  assert.equal((await loadHomeSettings(data, { KIN_HOME_NAME: "other.home.kin.journeytocode.io" })).name, "other.home.kin.journeytocode.io");
  // A widened mode is put back to 0600 by the next write.
  if (POSIX) {
    const { chmodSync } = await import("node:fs");
    chmodSync(path, 0o644);
    await writeHomeSettings(data, { maxHouseholds: 2 }, {});
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.throws(() => resolveHomeSettings({ format: 1, maxHouseholds: 0 }, {}), /1 to 10/);
});

// ------------------------------------------------------------ the sessions

test("control sessions: stored as hashes, survive a restart, expire, and can be revoked", TIMEOUT, async (t) => {
  const data = temporary(t);
  const now = clock();
  const sessions = await new ControlSessions({ dataDirectory: data, now }).load();
  const token = await sessions.create();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!readFileSync(sessions.path, "utf8").includes(token), "only a hash is stored");
  if (POSIX) assert.equal(statSync(sessions.path).mode & 0o777, 0o600);
  const again = await new ControlSessions({ dataDirectory: data, now }).load();
  assert.equal(again.verify(token), true, "a restart keeps the session");
  assert.equal(again.verify(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`), false);
  assert.equal(again.verify("not-a-token"), false);
  await again.revoke(token);
  assert.equal((await new ControlSessions({ dataDirectory: data, now }).load()).verify(token), false, "signed out");
  const old = await again.create();
  now.advance(SESSION_TTL_MS);
  assert.equal(again.verify(old), false, "expired after 30 days");
  for (let index = 0; index < MAX_SESSIONS + 3; index += 1) await again.create();
  assert.equal(again.size, MAX_SESSIONS, "the oldest sessions go");
  // A damaged file is replaced, never trusted.
  writeFileSync(sessions.path, "{ not json");
  assert.equal((await new ControlSessions({ dataDirectory: data, now }).load()).size, 0);
});

// --------------------------------------------------------------- the names

test("names: a word becomes a free name; a dotted name outside the zone is an own domain", TIMEOUT, () => {
  const zone = "home.kin.journeytocode.io";
  assert.deepEqual(interpretName(" Fern ", zone), { name: `fern.${zone}`, freeName: true });
  assert.deepEqual(interpretName(`fern.${zone}`, zone), { name: `fern.${zone}`, freeName: true });
  assert.deepEqual(interpretName("Kin.Smith.Family.", zone), { name: "kin.smith.family", freeName: false });
  assert.deepEqual(interpretName("www", zone), { name: `www.${zone}`, freeName: true }, "reserved names are the relay's to refuse");
  for (const [input, code] of [
    ["", "setup-name-empty"], ["ab", "setup-name-length"], ["-fern", "setup-name-invalid"], ["fe--rn", "setup-name-invalid"],
["a.b.home.kin.journeytocode.io", "setup-name-invalid"], ["fern_home", "setup-name-invalid"],
    [zone, "setup-name-invalid"],
  ]) assert.throws(() => interpretName(input, zone), (error) => error instanceof SetupError && error.code === code, input);
});

// ------------------------------------------------------- the state machine

/** A home server stand-in: the tunnel answers CHECK from `answers`; the
 * certificate and tunnel states are the test's to set. */
function fakeHome() {
  const home = {
    answers: new Map(),
    tunnelStatus: { state: "connecting", routed: false, nameError: null, lastError: null, nextAttemptAt: null },
    certificateStatus: { state: "none", certificate: null, lastError: null, nextAttemptAt: null },
    renewals: 0,
    checks: [],
    tunnel: { check: async (name) => { home.checks.push(name); return home.answers.get(name) ?? "available"; } },
    certificates: { renew: async () => { home.renewals += 1; } },
    status: () => ({ tunnel: home.tunnelStatus, certificate: home.certificateStatus }),
  };
  return home;
}

function setupFor(t, { env = {}, home = fakeHome(), checkDomain, account = "https://acme.test/account/1" } = {}) {
  const data = temporary(t);
  let settings = resolveHomeSettings(null, env);
  const restarts = [];
  const directory = { newNonce: "https://ca.test/nonce", newAccount: "https://ca.test/account", newOrder: "https://ca.test/order", meta: { termsOfService: "https://ca.test/terms.pdf" } };
  // A CA stand-in that answers the directory, a nonce and newAccount.
  const acmeTransport = async (url, { method }) => {
    const headers = new Headers({ "replay-nonce": "nonce1", "content-type": "application/json" });
    if (url === "https://ca.test/directory") return new Response(JSON.stringify(directory), { status: 200, headers });
    if (method === "HEAD") return new Response(null, { status: 200, headers });
    headers.set("location", account);
    return new Response(JSON.stringify({ status: "valid" }), { status: 201, headers });
  };
  const setup = new HomeSetup({
    dataDirectory: data, env, getSettings: () => settings, setSettings: (next) => { settings = next; }, getHome: () => home,
    restart: (reason) => restarts.push(reason), acmeTransport, directoryUrl: "https://ca.test/directory",
    resolver: { resolve4: async () => ["192.0.2.10"], resolve6: async () => ["2001:db8::10"] },
    ...(checkDomain ? { checkDomain } : {}),
  });
  t.after(() => setup.close());
  return { setup, home, data, restarts, settings: () => settings, configure: (next) => { settings = next; } };
}

test("setup, a free name: name, terms, connect writes the settings and asks for a restart", TIMEOUT, async (t) => {
  const { setup, home, data, restarts, settings } = setupFor(t);
  const zone = settings().zone;
  assert.equal(setup.step(), "name");
  home.answers.set(`taken.${zone}`, "taken");
  assert.deepEqual(await setup.checkName("taken"), { name: `taken.${zone}`, freeName: true, answer: "taken" });
  await assert.rejects(setup.chooseName("taken"), (error) => error.code === "setup-name-taken");
  await assert.rejects(setup.connect(), (error) => error.code === "setup-name-first");
  let view = await setup.chooseName("Fern");
  assert.equal(view.step, "terms");
  assert.equal(view.name, `fern.${zone}`);
  assert.equal(view.freeName, true);
  await assert.rejects(setup.connect(), (error) => error.code === "setup-terms-required");
  await assert.rejects(setup.agreeTerms(false), (error) => error.code === "setup-terms-required");
  assert.equal(await setup.termsUrl(), "https://ca.test/terms.pdf", "the link comes from the CA's directory");
  view = await setup.agreeTerms(true);
  assert.equal(view.step, "connect");
  assert.equal(JSON.stringify(view).includes("PRIVATE"), false);
  // Nothing written until connect.
  assert.throws(() => statSync(homeSettingsPath(data)));
  view = await setup.connect();
  assert.deepEqual(restarts, ["setup"]);
  assert.equal(view.step, "connecting");
  const written = JSON.parse(readFileSync(homeSettingsPath(data), "utf8"));
  assert.deepEqual(written, { format: 1, name: `fern.${zone}`, acmeTermsAgreed: true });
  if (POSIX) assert.equal(statSync(homeSettingsPath(data)).mode & 0o777, 0o600);
  assert.equal(settings().configured, true);
  await assert.rejects(setup.chooseName("other"), (error) => error.code === "setup-restarting");
});

test("setup after the restart: progress, a refused name goes back to the name step, a certificate ends it", TIMEOUT, async (t) => {
  const { setup, home, configure, restarts } = setupFor(t);
  configure(resolveHomeSettings({ format: 1, name: "fern.home.kin.journeytocode.io", acmeTermsAgreed: true }, {}));
  assert.equal(setup.step(), "connecting");
  assert.equal(setup.view().progress.tunnel.state, "connecting");
  // The relay refused the name (taken since the check): choose again.
  home.tunnelStatus = { ...home.tunnelStatus, state: "connected", nameError: { code: "name-taken", at: "2026-10-22T12:00:00.000Z" } };
  assert.equal(setup.step(), "name");
  assert.equal(setup.view().progress.tunnel.nameError, "name-taken");
  let view = await setup.chooseName("bracken");
  assert.equal(view.step, "terms", "a restarted setup starts its choices afresh");
  view = await setup.agreeTerms(true);
  assert.equal(view.step, "connect");
  await setup.connect();
  assert.deepEqual(restarts, ["setup"]);
  setup.restarting = false;
  configure(resolveHomeSettings({ format: 1, name: "bracken.home.kin.journeytocode.io", acmeTermsAgreed: true }, {}));
  home.tunnelStatus = { state: "connected", routed: true, nameError: null, lastError: null, nextAttemptAt: null };
  assert.equal(setup.step(), "certificate");
  home.certificateStatus = { state: "failed", certificate: null, lastError: { code: "acme-rate-limited" }, nextAttemptAt: "2026-10-22T13:00:00.000Z" };
  assert.equal(setup.view().progress.certificate.error, "acme-rate-limited");
  await setup.retryCertificate();
  assert.equal(home.renewals, 1);
  home.certificateStatus = { state: "valid", certificate: { notAfter: "2027-01-20T12:00:00.000Z" }, lastError: null, nextAttemptAt: null };
  assert.equal(setup.step(), "done");
  assert.equal(setup.view().origin, "https://bracken.home.kin.journeytocode.io");
  // Once there is a certificate the name is the server's for good.
  await assert.rejects(setup.chooseName("other"), (error) => error.code === "setup-finished" && error.status === 409);
  await assert.rejects(setup.connect(), (error) => error.code === "setup-finished");
});

test("setup with KIN_HOME_NAME: progress only, the name can't be changed here", TIMEOUT, async (t) => {
  const env = { KIN_HOME_NAME: "fern.home.kin.journeytocode.io" };
  const { setup } = setupFor(t, { env });
  assert.equal(setup.view().nameFromEnvironment, true);
  await assert.rejects(setup.chooseName("other"), (error) => error.code === "setup-name-from-environment");
});

test("setup, an own domain: the account is made at the terms, then the records are checked before connecting", TIMEOUT, async (t) => {
  let report = { ok: false, relayAddresses: ["192.0.2.10"], records: [], checks: [{ id: "txt", ok: false, problem: "dns-txt-missing", found: [] }] };
  const calls = [];
  const { setup, home, data } = setupFor(t, { checkDomain: async (input) => { calls.push(input); return structuredClone(report); } });
  home.answers.set("kin.smith.family", "not-proven");
  let view = await setup.chooseName("kin.smith.family");
  assert.equal(view.step, "terms");
  assert.equal(view.freeName, false);
  view = await setup.agreeTerms(true);
  assert.equal(view.step, "records");
  const account = JSON.parse(readFileSync(join(data, "home", "acme-account.json"), "utf8"));
  assert.deepEqual(account, { directoryUrl: "https://ca.test/directory", accountUrl: "https://acme.test/account/1" }, "the certificate manager will reuse this account");
  const types = view.expectedRecords.map((record) => `${record.type} ${record.name}`);
  assert.deepEqual(types, ["A kin.smith.family", "AAAA kin.smith.family", "TXT _kin-relay.kin.smith.family", "CAA kin.smith.family", "CAA kin.smith.family"]);
  assert.match(view.expectedRecords[3].value, /^0 issue "letsencrypt\.org; accounturi=https:\/\/acme\.test\/account\/1; validationmethods=tls-alpn-01"$/);
  await assert.rejects(setup.connect(), (error) => error.code === "setup-records-not-ready");
  view = await setup.checkRecords();
  assert.equal(view.step, "records");
  assert.equal(view.records.checks[0].problem, "dns-txt-missing");
  assert.equal(calls[0].accountUrl, "https://acme.test/account/1");
  // Records in place, but the relay can't see the TXT record yet.
  report = { ok: true, relayAddresses: ["192.0.2.10"], records: [], checks: [{ id: "txt", ok: true, problem: null, found: [] }] };
  view = await setup.checkRecords();
  assert.equal(view.step, "records");
  assert.equal(view.records.checks.at(-1).problem, "relay-txt-not-seen");
  home.answers.set("kin.smith.family", "available");
  view = await setup.checkRecords();
  assert.equal(view.step, "connect");
  await setup.connect();
  assert.equal(JSON.parse(readFileSync(homeSettingsPath(data), "utf8")).name, "kin.smith.family");
});

// ----------------------------------------------------- own-domain records

function fakeResolver(records) {
  const answer = (map) => async (name) => {
    if (!(name in map)) throw Object.assign(new Error("no"), { code: "ENODATA" });
    return map[name];
  };
  return {
    resolve4: answer(records.a ?? {}), resolve6: answer(records.aaaa ?? {}), resolveCname: answer(records.cname ?? {}),
    resolveTxt: answer(records.txt ?? {}), resolveCaa: answer(records.caa ?? {}),
  };
}

test("own-domain records: addresses, no CNAME, the TXT hash, CAA for this account only, no ECH", TIMEOUT, async () => {
  const publicKey = rawEd25519PublicKey(generateKeyPairSync("ed25519").privateKey);
  const accountUrl = "https://acme.test/account/7";
  const relayHost = "relay.home.test";
  const domain = "kin.smith.family";
  const good = {
    a: { [relayHost]: ["192.0.2.10"], [domain]: ["192.0.2.10"] },
    aaaa: { [relayHost]: ["2001:db8::10"], [domain]: ["2001:db8::10"] },
    txt: { [`_kin-relay.${domain}`]: [["v=other"], [keyHashText(publicKey)]] },
    caa: { [domain]: [{ critical: 0, issue: `letsencrypt.org; accounturi=${accountUrl}; validationmethods=tls-alpn-01` }, { critical: 0, issuewild: ";" }] },
  };
  const check = (records, ech = false) => checkDomainRecords({ domain, relayHost, publicKey, accountUrl, resolver: fakeResolver(records), ech: async () => ech });
  const ok = await check(good);
  assert.equal(ok.ok, true, JSON.stringify(ok.checks));
  assert.deepEqual(ok.relayAddresses, ["192.0.2.10", "2001:db8::10"]);
  const problems = async (records, ech) => Object.fromEntries((await check(records, ech)).checks.filter((entry) => !entry.ok).map((entry) => [entry.id, entry.problem]));
  assert.deepEqual(await problems({ ...good, a: { [relayHost]: ["192.0.2.10"] }, aaaa: { [relayHost]: ["2001:db8::10"] } }), { address: "dns-address-missing" });
  assert.deepEqual(await problems({ ...good, a: { ...good.a, [domain]: ["192.0.2.10", "198.51.100.7"] } }), { address: "dns-address-wrong" });
  assert.deepEqual(await problems({ ...good, cname: { [domain]: ["x.home.test"] } }), { address: "dns-cname" });
  assert.deepEqual(await problems({ ...good, txt: {} }), { txt: "dns-txt-missing" });
  assert.deepEqual(await problems({ ...good, caa: {} }), { caa: "dns-caa-missing" });
  assert.deepEqual(await problems({ ...good, caa: { [domain]: [...good.caa[domain], { critical: 0, issue: "other-ca.test" }] } }), { caa: "dns-caa-other" });
  assert.deepEqual(await problems({ ...good, caa: { [domain]: [{ critical: 0, issue: "letsencrypt.org; accounturi=https://acme.test/account/8" }] } }), { caa: "dns-caa-missing" });
  assert.deepEqual(await problems(good, true), { ech: "dns-ech" });
  const unknown = await check(good, null);
  assert.equal(unknown.ok, true, "an ECH answer that can't be read doesn't block");
  assert.equal(unknown.checks.find((entry) => entry.id === "ech").unknown, true);
  assert.deepEqual(await problems({ ...good, a: { [domain]: ["192.0.2.10"] }, aaaa: { [domain]: ["2001:db8::10"] } }), { relay: "dns-relay-unknown", address: "dns-relay-unknown" });
  const records = expectedRecords({ domain, relayAddresses: ["192.0.2.10", "2001:db8::10"], publicKey, accountUrl });
  assert.deepEqual(records.map((record) => record.type), ["A", "AAAA", "TXT", "CAA", "CAA"]);
  assert.equal(records[2].value, keyHashText(publicKey));
  assert.equal(records[4].value, '0 issuewild ";"');
});

test("the HTTPS-record reader finds ech, and calls a truncated or malformed answer unknown", TIMEOUT, () => {
  const id = 0x1234;
  const query = httpsQuery("kin.smith.family", id);
  assert.equal(query.readUInt16BE(0), id);
  assert.equal(query.readUInt16BE(query.length - 4), 65);
  // A response: the query echoed, then one HTTPS answer pointing at the name.
  const answer = (params) => {
    const rdata = Buffer.concat([Buffer.from([0, 1, 0]), params]);
    const head = Buffer.from(query);
    head.writeUInt16BE(0x8180, 2);
    head.writeUInt16BE(1, 6);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(65, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(300, 6);
    record.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([head, record, rdata]);
  };
  const param = (key, value) => { const header = Buffer.alloc(4); header.writeUInt16BE(key, 0); header.writeUInt16BE(value.length, 2); return Buffer.concat([header, value]); };
  assert.deepEqual(readHttpsAnswer(answer(param(1, Buffer.from([2, 104, 50]))), id), { ech: false }, "alpn only");
  assert.deepEqual(readHttpsAnswer(answer(Buffer.concat([param(1, Buffer.from([2, 104, 50])), param(5, Buffer.alloc(8, 7))])), id), { ech: true });
  assert.equal(readHttpsAnswer(answer(param(5, Buffer.alloc(8, 7))), id + 1), null, "the wrong ID");
  const truncated = answer(Buffer.alloc(0));
  truncated.writeUInt16BE(0x8380, 2);
  assert.equal(readHttpsAnswer(truncated, id), null, "TC set");
  assert.equal(readHttpsAnswer(answer(param(5, Buffer.alloc(8))).subarray(0, -3), id), null, "cut short");
  const nxdomain = Buffer.from(query);
  nxdomain.writeUInt16BE(0x8183, 2);
  assert.deepEqual(readHttpsAnswer(nxdomain, id), { ech: false });
  assert.deepEqual(parseServer("[2001:db8::1]:5353"), { address: "2001:db8::1", port: 5353 });
  assert.deepEqual(parseServer("192.0.2.53"), { address: "192.0.2.53", port: 53 });
  assert.equal(parseServer("resolver.example"), null);
});

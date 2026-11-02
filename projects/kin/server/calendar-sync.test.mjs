// Outside calendars (#667, ADR 0022 §3): links, the guarded fetcher, and the
// service's rules, cache, backoff and purges. The fetcher is tested against
// a local fake HTTPS server (server/test-fixtures holds its test-only
// certificate) with DNS replaced: these tests never use the real internet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import test from "node:test";
import { CalendarFetcher, FeedFetchError } from "./calendar-fetcher.mjs";
import { BACKOFF_FIRST_MS, CALENDAR_SYNC_LIMITS, CalendarSyncService, FEED_CACHE_MS, backoffDelay } from "./calendar-sync-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { FEED_WARNING, feedSourceName, isPublicAddress, normalizeFeedUrl } from "../web/calendar/feed-link.js";

const cert = readFileSync(new URL("./test-fixtures/calendar-feed-test.crt", import.meta.url));
const key = readFileSync(new URL("./test-fixtures/calendar-feed-test.key", import.meta.url));
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kin test//EN", "X-WR-CALNAME:Work",
  "BEGIN:VEVENT", "UID:standup@test", "DTSTART:20261102T090000Z", "DTEND:20261102T093000Z",
  "SUMMARY:Stand-up SECRET-MARKER", "RRULE:FREQ=WEEKLY;BYDAY=MO", "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");
const rejects = (code, status) => (error) => (error instanceof PairingError || error instanceof FeedFetchError) &&
  error.code === code && (status === undefined || error.status === status);

// ---------------------------------------------------------------------------
// Links.

test("links: https and webcal are accepted, the fragment dropped; everything else is refused", () => {
  assert.equal(normalizeFeedUrl("  https://calendar.google.com/calendar/ical/x%40group/private-abc/basic.ics#top "),
    "https://calendar.google.com/calendar/ical/x%40group/private-abc/basic.ics");
  assert.equal(normalizeFeedUrl("webcal://p01-caldav.icloud.com/published/2/abc"), "https://p01-caldav.icloud.com/published/2/abc");
  assert.equal(normalizeFeedUrl("WEBCALS://outlook.office365.com/owa/calendar/a/b/calendar.ics"), "https://outlook.office365.com/owa/calendar/a/b/calendar.ics");
  assert.equal(normalizeFeedUrl("https://example.com:443/a.ics"), "https://example.com/a.ics");
  const refusedWith = (text, code) => assert.throws(() => normalizeFeedUrl(text), (error) => error.code === code, text);
  refusedWith("http://example.com/a.ics", "calendar_link_not_https");
  refusedWith("ftp://example.com/a.ics", "calendar_link_not_https");
  refusedWith("example.com/a.ics", "calendar_link_invalid");
  refusedWith("", "calendar_link_invalid");
  refusedWith(42, "calendar_link_invalid");
  refusedWith("https://user:pass@example.com/a.ics", "calendar_link_credentials");
  refusedWith("https://token@example.com/a.ics", "calendar_link_credentials");
  refusedWith("https://example.com:8443/a.ics", "calendar_link_port");
  refusedWith(`https://example.com/${"a".repeat(2100)}`, "calendar_link_too_long");
  for (const host of ["localhost", "printer.local", "nas.home.arpa", "intranet", "127.0.0.1", "10.1.2.3", "2130706433", "[::1]", "[fd00::1]", "[::ffff:192.168.0.1]", "169.254.169.254"])
    refusedWith(`https://${host}/a.ics`, "calendar_link_address");
  assert.equal(normalizeFeedUrl("https://8.8.8.8/a.ics"), "https://8.8.8.8/a.ics", "a public address is fine");
});

test("links: calendar hosts are named for the label", () => {
  assert.equal(feedSourceName("https://calendar.google.com/calendar/ical/a/b.ics"), "Google");
  assert.equal(feedSourceName("https://p42-caldav.icloud.com/published/2/x"), "Apple");
  assert.equal(feedSourceName("https://outlook.office365.com/owa/calendar/x/y/calendar.ics"), "Outlook");
  assert.equal(feedSourceName("https://outlook.live.com/owa/calendar/x/y/calendar.ics"), "Outlook");
  assert.equal(feedSourceName("https://www.school.example/term.ics"), "school.example");
  assert.match(FEED_WARNING, /^Your Kin server will download this calendar about every 30 minutes and can read it while it does\.$/);
});

test("addresses: only public unicast IPv4 and IPv6 pass", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"])
    assert.equal(isPublicAddress(address), true, address);
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.9", "224.0.0.1",
    "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1",
    "2001::1", "2001:db8::1", "2002:c0a8:101::1", "3fff::1", "5f00::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0",
    "fec0::1", "ff02::1", "ff05::1:3", "::127.0.0.1", "4000::1", "not-an-address", "1.2.3", "1.2.3.256", "1::2::3",
  ]) assert.equal(isPublicAddress(address), false, address);
});

// ---------------------------------------------------------------------------
// The fetcher, against a fake HTTPS server on 127.0.0.1.

async function feedServer(handler) {
  const server = createHttpsServer({ cert, key }, handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { port, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** A fetcher whose DNS is `names` (host → addresses) and which may reach
 * the fake server's loopback address and port. */
const fetcherFor = (port, names, limits = {}) => new CalendarFetcher({
  resolve: async (host) => {
    if (!names[host]) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return names[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
  unsafeTestHooks: { allowLoopback: true, ca: cert, connectPort: port },
  limits,
});

test("fetcher: downloads a calendar, sends its ETag back, and gets 304 when unchanged", async () => {
  const seen = [];
  const feed = await feedServer((request, response) => {
    seen.push({ url: request.url, etag: request.headers["if-none-match"] ?? null, encoding: request.headers["accept-encoding"], host: request.headers.host });
    if (request.headers["if-none-match"] === '"v1"') { response.writeHead(304); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/calendar", ETag: '"v1"' });
    response.end(ICS);
  });
  try {
    const fetcher = fetcherFor(feed.port, { "feed.test": ["127.0.0.1"] });
    const first = await fetcher.fetch(`https://feed.test/cal.ics?private=1`);
    assert.equal(first.body.toString(), ICS);
    assert.equal(first.etag, '"v1"');
    const second = await fetcher.fetch(`https://feed.test/cal.ics?private=1`, { etag: '"v1"' });
    assert.deepEqual(second, { notModified: true, etag: '"v1"' });
    assert.deepEqual(seen.map((entry) => entry.etag), [null, '"v1"']);
    assert.equal(seen[0].url, "/cal.ics?private=1");
    assert.equal(seen[0].encoding, "identity", "nothing compressed, so the size limit counts real bytes");
    assert.equal(seen[0].host, `feed.test`, "TLS and Host name the calendar's host, not the address");
  } finally { await feed.close(); }
});

test("fetcher: refuses loopback, private and reserved addresses, IPv4 and IPv6, before connecting", async () => {
  let connections = 0;
  const feed = await feedServer((_request, response) => { connections += 1; response.end(ICS); });
  try {
    // Without the test hook, even the real loopback is refused.
    const production = new CalendarFetcher({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    await assert.rejects(production.fetch("https://feed.test/cal.ics"), rejects("calendar_address_refused"));
    await assert.rejects(production.fetch("https://localhost/cal.ics"), rejects("calendar_address_refused"));
    await assert.rejects(production.fetch("https://127.0.0.1/cal.ics"), rejects("calendar_address_refused"));
    await assert.rejects(production.fetch("https://[::1]/cal.ics"), rejects("calendar_address_refused"));
    const productionV6 = new CalendarFetcher({ resolve: async () => [{ address: "::1", family: 6 }] });
    await assert.rejects(productionV6.fetch("https://feed.test/cal.ics"), rejects("calendar_address_refused"), "IPv6 loopback by name");
    await assert.rejects(production.fetch("https://feed.test:8443/cal.ics"), rejects("calendar_link_invalid"), "only port 443");
    await assert.rejects(fetcherFor(feed.port, { "feed.test": ["127.0.0.1"] }).fetch("https://feed.test:8443/cal.ics"), rejects("calendar_link_invalid"), "even with the test hooks");
    const names = {
      "private.test": ["10.0.0.7"], "metadata.test": ["169.254.169.254"], "cgnat.test": ["100.64.1.1"],
      "multicast.test": ["224.0.0.251"], "v6-ula.test": ["fd00::5"], "v6-link.test": ["fe80::1"],
      "v6-mapped.test": ["::ffff:10.0.0.1"], "v6-nat64.test": ["64:ff9b::a00:1"], "v6-site.test": ["fec0::1"],
      "v6-multicast.test": ["ff02::1"], "v6-teredo.test": ["2001::1"], "v6-6to4.test": ["2002:a00:1::1"],
      // A public answer mixed with a private one is refused as a whole.
      "mixed.test": ["8.8.8.8", "192.168.1.10"], "mixed6.test": ["2606:4700::1", "fd00::1"],
    };
    const fetcher = fetcherFor(feed.port, names);
    for (const host of Object.keys(names))
      await assert.rejects(fetcher.fetch(`https://${host}/cal.ics`), rejects("calendar_address_refused"), host);
    await assert.rejects(fetcher.fetch(`https://missing.test/cal.ics`), rejects("calendar_unreachable"));
    assert.equal(connections, 0, "nothing was ever requested");
  } finally { await feed.close(); }
});

test("fetcher: re-checks every redirect hop, follows at most 5, and refuses one away from https", async () => {
  const feed = await feedServer((request, response) => {
    const url = new URL(request.url, "https://feed.test");
    const hop = Number(url.searchParams.get("hop") ?? 0);
    const port = request.socket.localPort;
    if (url.pathname === "/chain") {
      const left = Number(url.searchParams.get("left"));
      if (left > 0) { response.writeHead(302, { Location: `/chain?left=${left - 1}` }); response.end(); return; }
      response.writeHead(200, { "Content-Type": "text/calendar" }); response.end(ICS); return;
    }
    if (url.pathname === "/to-private") { response.writeHead(301, { Location: `https://private.test/cal.ics` }); response.end(); return; }
    if (url.pathname === "/to-http") { response.writeHead(307, { Location: `http://feed.test/cal.ics` }); response.end(); return; }
    if (url.pathname === "/to-webcal") { response.writeHead(308, { Location: `webcal://feed.test/cal.ics` }); response.end(); return; }
    if (url.pathname === "/to-v6") { response.writeHead(302, { Location: `https://[fd00::1]/cal.ics` }); response.end(); return; }
    if (url.pathname === "/to-other") { response.writeHead(303, { Location: `https://other.test/cal.ics?hop=${hop + 1}` }); response.end(); return; }
    if (url.pathname === "/no-location") { response.writeHead(302); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/calendar" }); response.end(ICS);
  });
  try {
    const fetcher = fetcherFor(feed.port, { "feed.test": ["127.0.0.1"], "other.test": ["127.0.0.1"], "private.test": ["10.1.1.1"] });
    const base = `https://feed.test`;
    assert.equal((await fetcher.fetch(`${base}/chain?left=5`)).body.toString(), ICS, "five redirects are followed");
    await assert.rejects(fetcher.fetch(`${base}/chain?left=6`), rejects("calendar_too_many_redirects"));
    await assert.rejects(fetcher.fetch(`${base}/to-private`), rejects("calendar_address_refused"), "the next hop's DNS is checked again");
    await assert.rejects(fetcher.fetch(`${base}/to-v6`), rejects("calendar_address_refused"));
    await assert.rejects(fetcher.fetch(`${base}/to-http`), rejects("calendar_link_not_https"));
    await assert.rejects(fetcher.fetch(`${base}/to-webcal`), rejects("calendar_link_not_https"));
    await assert.rejects(fetcher.fetch(`${base}/no-location`), rejects("calendar_server_error"));
    assert.equal((await fetcher.fetch(`${base}/to-other`)).body.toString(), ICS, "a public next hop is followed");
  } finally { await feed.close(); }
});

test("fetcher: 2 MB and 15 seconds at most, a calendar only, and clear errors", async () => {
  const feed = await feedServer((request, response) => {
    const path = new URL(request.url, "https://x").pathname;
    if (path === "/declared-large") { response.writeHead(200, { "Content-Length": String(3 * 1024 * 1024) }); response.end(); return; }
    if (path === "/streamed-large") {
      response.writeHead(200, { "Content-Type": "text/calendar" });
      response.write("BEGIN:VCALENDAR\r\n");
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      let sent = 0;
      const pump = () => { while (sent < 40 && response.write(chunk)) sent += 1; if (sent < 40) response.once("drain", pump); else response.end(); };
      pump();
      return;
    }
    if (path === "/slow") { response.writeHead(200, { "Content-Type": "text/calendar" }); response.write("BEGIN:VCALENDAR\r\n"); return; }
    if (path === "/hang") return;
    if (path === "/html") { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><title>Sign in</title>"); return; }
    if (path === "/gzip") { response.writeHead(200, { "Content-Encoding": "gzip" }); response.end(Buffer.from([0x1f, 0x8b])); return; }
    if (path === "/gone") { response.writeHead(410); response.end(); return; }
    if (path === "/missing") { response.writeHead(404); response.end(); return; }
    if (path === "/forbidden") { response.writeHead(403); response.end(); return; }
    if (path === "/broken") { response.writeHead(500); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/calendar" }); response.end(`﻿\r\n${ICS}`);
  });
  try {
    const fetcher = fetcherFor(feed.port, { "feed.test": ["127.0.0.1"] }, { timeoutMs: 400 });
    const base = `https://feed.test`;
    assert.match((await fetcher.fetch(`${base}/ok`)).body.toString(), /BEGIN:VCALENDAR/, "a byte-order mark and blank line are fine");
    await assert.rejects(fetcher.fetch(`${base}/declared-large`), rejects("calendar_too_large"));
    await assert.rejects(fetcher.fetch(`${base}/streamed-large`), rejects("calendar_too_large"));
    await assert.rejects(fetcher.fetch(`${base}/slow`), rejects("calendar_timeout"));
    await assert.rejects(fetcher.fetch(`${base}/hang`), rejects("calendar_timeout"));
    await assert.rejects(fetcher.fetch(`${base}/html`), rejects("calendar_not_ical"));
    await assert.rejects(fetcher.fetch(`${base}/gzip`), rejects("calendar_not_ical"));
    await assert.rejects(fetcher.fetch(`${base}/gone`), rejects("calendar_link_not_found"));
    await assert.rejects(fetcher.fetch(`${base}/missing`), rejects("calendar_link_not_found"));
    await assert.rejects(fetcher.fetch(`${base}/forbidden`), rejects("calendar_link_refused"));
    await assert.rejects(fetcher.fetch(`${base}/broken`), rejects("calendar_server_error"));
    assert.equal(new CalendarFetcher().limits.maxBytes, 2 * 1024 * 1024);
    assert.equal(new CalendarFetcher().limits.timeoutMs, 15_000);
    assert.equal(new CalendarFetcher().limits.maxRedirects, 5);
    assert.equal(new CalendarFetcher().testHooks, null, "the service's own fetcher has no test hooks");
  } finally { await feed.close(); }
});

test("fetcher: a certificate that doesn't match the host is refused", async () => {
  const feed = await feedServer((_request, response) => response.end(ICS));
  try {
    const fetcher = fetcherFor(feed.port, { "wrong-name.example": ["127.0.0.1"] });
    await assert.rejects(fetcher.fetch(`https://wrong-name.example/cal.ics`), rejects("calendar_unreachable"));
    const untrusted = new CalendarFetcher({ resolve: async () => [{ address: "127.0.0.1", family: 4 }], unsafeTestHooks: { allowLoopback: true, connectPort: feed.port } });
    await assert.rejects(untrusted.fetch(`https://feed.test/cal.ics`), rejects("calendar_unreachable"), "an unknown certificate authority");
  } finally { await feed.close(); }
});

// ---------------------------------------------------------------------------
// The service.

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

/** A fake fetcher: answers from `script` (url → function), counting calls. */
function fakeFetcher(script = {}) {
  const fetcher = {
    calls: [],
    async fetch(url, { etag = null } = {}) {
      fetcher.calls.push({ url, etag });
      const answer = script[url] ?? script["*"];
      if (!answer) return { body: Buffer.from(ICS), etag: '"v1"' };
      return answer({ url, etag });
    },
  };
  return fetcher;
}

function household({ store = null, fetcher = fakeFetcher(), clock = { now: 1_800_000_000_000 } } = {}) {
  const now = () => clock.now;
  const pairing = new PairingService({ store, now });
  const sync = new EncryptedSyncService(pairing, { store, now });
  const calendars = new CalendarSyncService({ store, fetcher, now });
  pairing.onMemberRemoved = (_householdId, memberId) => calendars.forgetMember(memberId);
  const admin = pairing.bootstrap({ credential: credential(`admin-${Math.random()}`) });
  const join = (kind, extra = {}) => {
    const invitation = pairing.createPairing(admin.sessionToken, { kind, ...extra });
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`${kind}-${Math.random()}`), deviceLabel: kind });
    pairing.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const adult = join("adult");
  const child = join("limited");
  const sitter = join("temporary", { expiresAt: clock.now + 86_400_000 });
  const auth = (who) => pairing.authorize(who.sessionToken);
  return { pairing, sync, calendars, fetcher, clock, admin, adult, child, sitter, auth, store };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, async () => body(household()));
  test(`${name} (durable)`, async () => {
    const store = new DurableStore(":memory:");
    try { await body(household({ store })); } finally { store.close(); }
  });
}

const link = (n) => `https://calendar.google.com/calendar/ical/c${n}/private-x/basic.ics`;

bothStores("adults add calendars for themselves or everyone; children and sitters can't add", async (h) => {
  const mine = await h.calendars.add(h.auth(h.adult), { url: link(1).replace("https:", "webcal:"), audience: "me" });
  assert.equal(mine.source, "Google");
  assert.equal(mine.status, "ok");
  assert.equal(mine.audience, "me");
  assert.equal(mine.mine, true);
  assert.equal("url" in mine, false, "the link isn't sent back");
  assert.equal(h.fetcher.calls[0].url, link(1), "webcal became https and was fetched once before saving");
  const shared = await h.calendars.add(h.auth(h.admin), { url: link(2), audience: "household" });
  for (const who of [h.child, h.sitter])
    await assert.rejects(h.calendars.add(h.auth(who), { url: link(3), audience: "me" }), rejects("calendar_adult_required", 403));
  await assert.rejects(h.calendars.add(h.auth(h.adult), { url: link(1), audience: "household" }), rejects("calendar_subscription_exists", 409));
  await assert.rejects(h.calendars.add(h.auth(h.adult), { url: link(4), audience: "everyone" }), rejects("calendar_subscription_invalid", 400));
  await assert.rejects(h.calendars.add(h.auth(h.adult), { url: "http://example.com/a.ics", audience: "me" }), rejects("calendar_link_not_https", 400));
  await assert.rejects(h.calendars.add(h.auth(h.adult), { url: "https://10.0.0.1/a.ics", audience: "me" }), rejects("calendar_link_address", 400));
  // Who sees what.
  const ids = (who) => h.calendars.list(h.auth(who)).subscriptions.map((entry) => entry.id).sort();
  assert.deepEqual(ids(h.adult), [mine.id, shared.id].sort());
  assert.deepEqual(ids(h.admin), [shared.id]);
  assert.deepEqual(ids(h.child), [shared.id]);
  assert.deepEqual(ids(h.sitter), [shared.id], "everyone in the household includes a sitter while they're a member");
  assert.equal(h.calendars.list(h.auth(h.child)).canAdd, false);
  assert.equal(h.calendars.list(h.auth(h.adult)).canAdd, true);
});

bothStores("a link that doesn't work is refused when added, and nothing is saved", async (h) => {
  h.fetcher.calls.length = 0;
  const failing = { [link(9)]: () => { throw new FeedFetchError("calendar_link_not_found", { status: 404 }); } };
  const calendars = new CalendarSyncService({ store: h.store, fetcher: fakeFetcher(failing), now: () => h.clock.now });
  await assert.rejects(calendars.add(h.auth(h.adult), { url: link(9), audience: "me" }), rejects("calendar_link_not_found", 422));
  assert.deepEqual(calendars.list(h.auth(h.adult)).subscriptions, []);
});

bothStores("10 calendars per member and 30 per household", async (h) => {
  for (let n = 0; n < CALENDAR_SYNC_LIMITS.perMember; n += 1) await h.calendars.add(h.auth(h.adult), { url: link(n), audience: "me" });
  await assert.rejects(h.calendars.add(h.auth(h.adult), { url: link(99), audience: "me" }), rejects("calendar_subscription_limit", 409));
  // Two more adults (four at most) fill the household's 30.
  const extra = [h.admin];
  for (let index = 0; index < 2; index += 1) {
    const invitation = h.pairing.createPairing(h.admin.sessionToken, { kind: "adult" });
    const claim = h.pairing.claimPairing({ code: invitation.code, credential: credential(`more-${index}-${Math.random()}`), deviceLabel: "more" });
    h.pairing.approvePairing(h.admin.sessionToken, invitation.pairingId, claim.version);
    extra.push(h.pairing.activateClaim(claim.claimToken));
  }
  h.calendars.adds = new (h.calendars.adds.constructor)({ limit: 1_000, windowMs: 1, now: () => h.clock.now });
  let added = CALENDAR_SYNC_LIMITS.perMember;
  for (const who of extra) {
    for (let n = 0; n < CALENDAR_SYNC_LIMITS.perMember && added < CALENDAR_SYNC_LIMITS.perHousehold; n += 1, added += 1)
      await h.calendars.add(h.auth(who), { url: link(100 + added), audience: "household" });
  }
  assert.equal(added, 30);
  await assert.rejects(h.calendars.add(h.auth(extra[2]), { url: link(500), audience: "me" }), rejects("calendar_subscription_limit", 409));
});

bothStores("additions are rate-limited per member, since each one fetches", async (h) => {
  const failing = fakeFetcher({ "*": () => { throw new FeedFetchError("calendar_not_ical"); } });
  h.calendars.fetcher = failing;
  for (let n = 0; n < CALENDAR_SYNC_LIMITS.addsPerMemberHour; n += 1)
    await assert.rejects(h.calendars.add(h.auth(h.adult), { url: link(n), audience: "me" }), rejects("calendar_not_ical"));
  await assert.rejects(h.calendars.add(h.auth(h.adult), { url: link(50), audience: "me" }), rejects("calendar_rate_limited", 429));
  assert.equal(failing.calls.length, CALENDAR_SYNC_LIMITS.addsPerMemberHour, "the refused one didn't fetch");
  h.clock.now += 60 * 60_000 + 1;
  await assert.rejects(h.calendars.add(h.auth(h.adult), { url: link(51), audience: "me" }), rejects("calendar_not_ical"), "an hour later");
});

bothStores("the feed goes only to devices in the audience, from memory for 30 minutes", async (h) => {
  const mine = await h.calendars.add(h.auth(h.adult), { url: link(1), audience: "me" });
  const shared = await h.calendars.add(h.auth(h.admin), { url: link(2), audience: "household" });
  assert.equal(h.fetcher.calls.length, 2);
  // The download made when adding is reused.
  assert.equal((await h.calendars.feed(h.auth(h.adult), mine.id)).body.toString(), ICS);
  assert.equal((await h.calendars.feed(h.auth(h.child), shared.id)).body.toString(), ICS);
  assert.equal(h.fetcher.calls.length, 2, "no new download within 30 minutes");
  for (const who of [h.admin, h.child, h.sitter])
    await assert.rejects(h.calendars.feed(h.auth(who), mine.id), rejects("calendar_subscription_not_found", 404), "not in the audience");
  await assert.rejects(h.calendars.feed(h.auth(h.adult), "f".repeat(32)), rejects("calendar_subscription_not_found", 404));
  // The device's ETag: unchanged, so no body.
  assert.deepEqual(await h.calendars.feed(h.auth(h.adult), mine.id, { ifNoneMatch: '"v1"' }), { notModified: true, etag: '"v1"', fetchedAt: h.clock.now });
  // After 30 minutes the next request downloads again, conditionally when
  // the device has the current version.
  h.clock.now += FEED_CACHE_MS;
  const notModified = fakeFetcher({ "*": ({ etag }) => (etag ? { notModified: true, etag } : { body: Buffer.from(ICS), etag: '"v1"' }) });
  h.calendars.fetcher = notModified;
  const conditional = await h.calendars.feed(h.auth(h.adult), mine.id, { ifNoneMatch: '"v1"' });
  assert.equal(conditional.notModified, true);
  assert.deepEqual(notModified.calls, [{ url: link(1), etag: '"v1"' }]);
  // A device without it gets the whole feed (a second, plain download).
  assert.equal((await h.calendars.feed(h.auth(h.adult), mine.id)).body.toString(), ICS);
  assert.deepEqual(notModified.calls.at(-1), { url: link(1), etag: null });
  // Devices asking at once share one download.
  h.clock.now += FEED_CACHE_MS;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = fakeFetcher({ "*": async () => { await gate; return { body: Buffer.from(ICS), etag: '"v2"' }; } });
  h.calendars.fetcher = slow;
  const together = [h.calendars.feed(h.auth(h.admin), shared.id), h.calendars.feed(h.auth(h.child), shared.id), h.calendars.feed(h.auth(h.adult), shared.id)];
  release();
  for (const result of await Promise.all(together)) assert.equal(result.etag, '"v2"');
  assert.equal(slow.calls.length, 1);
  // The memory cache is swept after 30 minutes.
  h.clock.now += FEED_CACHE_MS + 1;
  h.calendars.sweep();
  assert.equal(h.calendars.cache.size, 0);
  assert.equal(h.calendars.cacheBytes, 0);
});

bothStores("a failing calendar backs off and says why, then recovers", async (h) => {
  const sub = await h.calendars.add(h.auth(h.adult), { url: link(1), audience: "household" });
  h.clock.now += FEED_CACHE_MS + 1;
  let failing = true;
  const flaky = fakeFetcher({ "*": () => { if (failing) throw new FeedFetchError("calendar_server_error", { status: 503 }); return { body: Buffer.from(ICS), etag: null }; } });
  h.calendars.fetcher = flaky;
  await assert.rejects(h.calendars.feed(h.auth(h.adult), sub.id), rejects("calendar_server_error", 502));
  let view = h.calendars.list(h.auth(h.child)).subscriptions[0];
  assert.equal(view.status, "error");
  assert.equal(view.error, "calendar_server_error");
  assert.match(view.message, /try again later/);
  assert.equal(view.retryAt, h.clock.now + BACKOFF_FIRST_MS);
  // Meanwhile nobody's request reaches the calendar's server.
  await assert.rejects(h.calendars.feed(h.auth(h.child), sub.id), rejects("calendar_server_error", 503));
  assert.equal(flaky.calls.length, 1);
  // The wait doubles with each failure, to at most 6 hours.
  h.clock.now += BACKOFF_FIRST_MS;
  await assert.rejects(h.calendars.feed(h.auth(h.adult), sub.id), rejects("calendar_server_error", 502));
  assert.equal(h.calendars.list(h.auth(h.adult)).subscriptions[0].retryAt, h.clock.now + 2 * BACKOFF_FIRST_MS);
  assert.deepEqual([1, 2, 3, 4, 7, 8, 20].map(backoffDelay), [5, 10, 20, 40, 320, 360, 360].map((minutes) => minutes * 60_000));
  h.clock.now += 2 * BACKOFF_FIRST_MS;
  failing = false;
  assert.equal((await h.calendars.feed(h.auth(h.adult), sub.id)).body.toString(), ICS);
  view = h.calendars.list(h.auth(h.adult)).subscriptions[0];
  assert.deepEqual([view.status, view.error, view.retryAt, view.fetchedAt], ["ok", null, null, h.clock.now]);
});

bothStores("turning a calendar off removes it for everyone; only its owner or an admin can", async (h) => {
  const shared = await h.calendars.add(h.auth(h.adult), { url: link(1), audience: "household" });
  const other = await h.calendars.add(h.auth(h.adult), { url: link(2), audience: "household" });
  assert.throws(() => h.calendars.remove(h.auth(h.child), shared.id), rejects("calendar_owner_required", 403));
  assert.equal(h.calendars.list(h.auth(h.child)).subscriptions.find((entry) => entry.id === shared.id).canRemove, false);
  assert.equal(h.calendars.list(h.auth(h.admin)).subscriptions.find((entry) => entry.id === shared.id).canRemove, true);
  assert.deepEqual(h.calendars.remove(h.auth(h.adult), shared.id), { id: shared.id, removed: true });
  assert.deepEqual(h.calendars.remove(h.auth(h.admin), other.id), { id: other.id, removed: true }, "a household admin may");
  for (const who of [h.adult, h.child]) {
    assert.deepEqual(h.calendars.list(h.auth(who)).subscriptions, []);
    await assert.rejects(h.calendars.feed(h.auth(who), shared.id), rejects("calendar_subscription_not_found", 404));
  }
  assert.equal(h.calendars.cache.size, 0, "its feed left memory too");
  assert.throws(() => h.calendars.remove(h.auth(h.adult), shared.id), rejects("calendar_subscription_not_found", 404));
});

bothStores("a removed member's calendars are purged, for everyone", async (h) => {
  const shared = await h.calendars.add(h.auth(h.adult), { url: link(1), audience: "household" });
  await h.calendars.add(h.auth(h.adult), { url: link(2), audience: "me" });
  const kept = await h.calendars.add(h.auth(h.admin), { url: link(3), audience: "household" });
  h.pairing.removeOtherAdult(h.admin.sessionToken, h.adult.memberId, h.admin.memberId);
  assert.deepEqual(h.calendars.list(h.auth(h.child)).subscriptions.map((entry) => entry.id), [kept.id]);
  assert.equal(h.calendars.cache.has(shared.id), false);
  if (h.store) assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM calendar_subscriptions").get().n, 1);
});

test("the database holds links and status, never a calendar's contents, and household deletion purges it", async () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household({ store });
    await h.calendars.add(h.auth(h.adult), { url: link(1), audience: "household" });
    await h.calendars.add(h.auth(h.admin), { url: link(2), audience: "me" });
    const rows = store.db.prepare("SELECT * FROM calendar_subscriptions").all();
    assert.equal(rows.length, 2);
    const dump = JSON.stringify(rows);
    assert.equal(dump.includes("SECRET-MARKER") || dump.includes("VCALENDAR") || dump.includes("Stand-up"), false);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["attempted_at", "audience", "created_at", "etag", "failures", "fetch_error", "fetch_status", "fetched_at", "household_id", "id", "owner_member_id", "retry_at", "url"]);
    assert.equal(store.householdPurgeStatus(h.admin.householdId).counts.calendarSubscriptions, 2);
    store.forcePurgeHousehold(h.admin.householdId, h.clock.now);
    h.calendars.forgetHousehold(h.admin.householdId);
    const status = store.householdPurgeStatus(h.admin.householdId);
    assert.equal(status.counts.calendarSubscriptions, 0);
    assert.equal(status.purged, true);
    assert.equal(h.calendars.cache.size, 0);
    assert.equal(store.validate(), true);
  } finally { store.close(); }
});

test("subscriptions survive a restart; feeds don't", async () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household({ store });
    const sub = await h.calendars.add(h.auth(h.adult), { url: link(1), audience: "me" });
    const restarted = new CalendarSyncService({ store, fetcher: fakeFetcher(), now: () => h.clock.now });
    const view = restarted.list(h.auth(h.adult)).subscriptions[0];
    assert.deepEqual([view.id, view.status, view.source], [sub.id, "ok", "Google"]);
    assert.equal(restarted.cache.size, 0);
    assert.equal((await restarted.feed(h.auth(h.adult), sub.id)).body.toString(), ICS);
    assert.equal(restarted.fetcher.calls.length, 1, "downloaded again after the restart");
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// The routes, end to end: a real Kin server whose fetcher reaches the fake
// calendar server.

test("routes: add, list, fetch the feed with its ETag, and turn off", async () => {
  let downloads = 0;
  const feed = await feedServer((request, response) => {
    downloads += 1;
    if (request.headers["if-none-match"] === '"r1"') { response.writeHead(304, { ETag: '"r1"' }); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/calendar", ETag: '"r1"' });
    response.end(ICS);
  });
  const clock = { now: 1_800_000_000_000 };
  const app = createKinServer({
    store: false, origin: "https://kin.example.org", host: "127.0.0.1", feedbackGithub: false, now: () => clock.now,
    calendarFetcher: fetcherFor(feed.port, { "feed.test": ["127.0.0.1"] }),
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const admin = app.service.bootstrap({ credential: credential("route-admin") });
    const cookie = `kin_session=${admin.sessionToken}`;
    const call = (path, options = {}) => fetch(base + path, { ...options, headers: { cookie, "content-type": "application/json", ...(options.headers ?? {}) } });
    assert.equal((await fetch(`${base}/api/calendar/subscriptions`)).status, 401, "signed in only");
    const added = await call("/api/calendar/subscriptions", { method: "POST", body: JSON.stringify({ url: "webcal://feed.test/private/cal.ics", audience: "household" }) });
    assert.equal(added.status, 201);
    const { subscription } = await added.json();
    assert.equal(downloads, 1, "checked once when added");
    const refused = await call("/api/calendar/subscriptions", { method: "POST", body: JSON.stringify({ url: "https://feed.test:8443/cal.ics", audience: "me" }) });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "calendar_link_port");
    const unreachable = await call("/api/calendar/subscriptions", { method: "POST", body: JSON.stringify({ url: "https://calendar.google.com/x.ics", audience: "me" }) });
    assert.equal(unreachable.status, 422);
    assert.deepEqual(Object.keys(await unreachable.json()).sort(), ["error", "message"]);
    const list = await (await call("/api/calendar/subscriptions")).json();
    assert.equal(list.canAdd, true);
    assert.deepEqual(list.subscriptions.map((entry) => [entry.id, entry.source, entry.status, entry.mine]), [[subscription.id, "feed.test", "ok", true]]);
    const first = await call(`/api/calendar/subscriptions/${subscription.id}/feed`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(first.headers.get("etag"), '"r1"');
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(first.headers.get("x-kin-calendar-fetched-at"), String(clock.now));
    assert.equal(await first.text(), ICS);
    const again = await call(`/api/calendar/subscriptions/${subscription.id}/feed`, { headers: { "if-none-match": '"r1"' } });
    assert.equal(again.status, 304);
    assert.equal(downloads, 1, "both answers came from memory");
    const removed = await call(`/api/calendar/subscriptions/${subscription.id}`, { method: "DELETE" });
    assert.deepEqual(await removed.json(), { id: subscription.id, removed: true });
    assert.equal((await call(`/api/calendar/subscriptions/${subscription.id}/feed`)).status, 404);
    assert.deepEqual((await (await call("/api/calendar/subscriptions")).json()).subscriptions, []);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await feed.close();
  }
});

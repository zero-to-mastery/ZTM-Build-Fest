// The published install identity (#78): validation, admin authority, stale
// revisions, withdrawal and deletion, and the per-device manifest and icons.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import {
  builtInManifest,
  etagMatches,
  installDescription,
  installIcon,
  installName,
  installShortName,
  installContentTag,
} from "./install-identity.mjs";
import { PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

// A PNG by framing only (what the service checks): signature, IHDR, one
// IDAT chunk of filler, IEND. CRCs other than IEND's are not checked.
function png(size, { width = size, height = size, depth = 8, colorType = 6, filler = 16 } = {}) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.alloc(filler, 7)),
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
}

const icons = (mark = 16) => ({
  icon192: png(192, { filler: mark }).toString("base64url"),
  icon512: png(512, { filler: mark }).toString("base64url"),
  maskable512: png(512, { filler: mark + 1 }).toString("base64url"),
  apple180: png(180, { filler: mark }).toString("base64url"),
});

test("names, short names and descriptions follow the household-name rules", () => {
  assert.equal(installName("  Café Home "), "Café Home");
  assert.equal(installName("Café"), "Café", "NFC");
  for (const bad of ["", "  ", "x".repeat(81), "日".repeat(81), "a‮b", "a\nb", 7])
    assert.throws(() => installName(bad), { code: "install_identity_invalid" });
  assert.equal(installShortName("👩‍👩‍👧‍👦 Home"), "👩‍👩‍👧‍👦 Home", "a ZWJ family is one grapheme");
  assert.equal(installShortName("abcdefghijkl"), "abcdefghijkl");
  for (const bad of ["", "abcdefghijklm", "a​b"])
    assert.throws(() => installShortName(bad), { code: "install_identity_invalid" });
  assert.equal(installDescription(undefined), "");
  assert.equal(installDescription(" Our place "), "Our place");
  assert.throws(() => installDescription("d".repeat(201)), { code: "install_identity_invalid" });
});

test("icons are checked by PNG framing and exact size, never decoded", () => {
  assert.ok(installIcon(png(192), 192).length > 0);
  assert.ok(installIcon(png(192).toString("base64url"), 192).length > 0);
  const truncated = png(192).subarray(0, 40);
  const notPng = Buffer.from(png(192)); notPng[1] = 0;
  const badDepth = png(192, { depth: 3 });
  const tooBig = png(512, { filler: 512 * 1024 });
  for (const [bytes, size] of [
    [png(192), 512], [png(192, { width: 191 }), 192], [png(192, { height: 193 }), 192],
    [truncated, 192], [notPng, 192], [badDepth, 192], [tooBig, 512], ["not base64!", 192], [42, 192],
  ])
    assert.throws(() => installIcon(bytes, size), { code: "install_identity_invalid" });
});

async function start(t, { databasePath = ":memory:" } = {}) {
  const store = new DurableStore(databasePath);
  let now = 1_800_000_000_000;
  const service = new PairingService({ store, now: () => now });
  const app = createKinServer({ service, store, now: () => now, acquireProcessLock: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)).finally(() => store.close()));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { token, device, method = "GET", body, headers = {} } = {}) => {
    const cookie = [token && `kin_session=${token}`, device && `kin_device=${device}`].filter(Boolean).join("; ");
    const response = await fetch(url + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = response.headers.get("content-type") ?? "";
    const payload = response.status === 304 ? null
      : type.startsWith("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, body: payload };
  };
  const admin = service.bootstrap({ credential: credential("admin") });
  const join = (id) => {
    now += 60_001;
    const invitation = service.createPairing(admin.sessionToken);
    const claim = service.claimPairing({ code: invitation.code, credential: credential(id), deviceLabel: "Edge on Windows" });
    service.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return service.activateClaim(claim.claimToken);
  };
  return { app, store, service, call, admin, join, advance: (ms) => { now += ms; } };
}

const publish = (h, who, overrides = {}) => h.call("/api/household/install-identity", {
  token: who.sessionToken, method: "PUT",
  body: { expectedRev: 0, name: "The \"Nest\" — 家", shortName: "Nest", description: "Home base", iconSource: "letter", icons: icons(), ...overrides },
});

test("only household admins publish and withdraw; stale revisions conflict", async (t) => {
  const h = await start(t);
  const partner = h.join("partner");
  let view = await h.call("/api/household/install-identity", { token: partner.sessionToken });
  assert.deepEqual(view.body, { admin: false, published: null });
  assert.equal((await publish(h, partner)).status, 403);
  assert.equal((await h.call("/api/household/install-identity", { token: partner.sessionToken, method: "DELETE", body: { expectedRev: 1 } })).status, 403);
  assert.equal((await h.call("/api/household/install-identity", { method: "PUT", body: {} })).status, 401);

  const first = await publish(h, h.admin);
  assert.deepEqual(first.body, { rev: 1, accepted: true });
  assert.equal((await publish(h, h.admin)).status, 409, "a write from revision 0 is stale now");
  assert.equal((await publish(h, h.admin, { shortName: "x".repeat(13), expectedRev: 1 })).status, 400);
  assert.equal((await publish(h, h.admin, { icons: { ...icons(), icon512: png(256).toString("base64url") }, expectedRev: 1 })).status, 400);
  view = await h.call("/api/household/install-identity", { token: partner.sessionToken });
  assert.equal(view.body.published.rev, 1);
  assert.equal(view.body.published.name, "The \"Nest\" — 家");
  assert.match(view.body.published.icons.icon512, /^\/install-icon\/512\.png\?v=[a-f0-9]{16}$/);

  assert.equal((await h.call("/api/household/install-identity", { token: h.admin.sessionToken, method: "DELETE", body: { expectedRev: 2 } })).status, 409);
  assert.deepEqual((await h.call("/api/household/install-identity", { token: h.admin.sessionToken, method: "DELETE", body: { expectedRev: 1 } })).body, { withdrawn: true });
  assert.equal(h.store.getInstallIdentity(h.admin.householdId), null);
  // Revisions keep growing across a withdrawal, so icon URLs never repeat.
  assert.equal((await publish(h, h.admin)).body.rev, 2);
  const audit = h.service.events.map((event) => event.type).filter((type) => type.startsWith("install_identity"));
  assert.deepEqual(audit, ["install_identity_published", "install_identity_withdrawn", "install_identity_published"]);
});

test("a household with no recorded admin cannot publish", async (t) => {
  const h = await start(t);
  h.service.members.get(h.admin.memberId).householdAdmin = false;
  assert.equal((await publish(h, h.admin)).status, 403);
});

test("the manifest and icons follow the requesting device's household", async (t) => {
  const h = await start(t);
  const partner = h.join("partner");
  const kin = builtInManifest();
  let response = await h.call("/manifest.webmanifest");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/manifest+json");
  assert.equal(response.headers.get("etag"), kin.etag);
  assert.match(response.headers.get("cache-control"), /no-cache/);
  assert.equal(JSON.parse(response.body).short_name, "Kin");
  assert.equal((await h.call("/manifest.webmanifest", { device: h.admin.deviceToken, headers: { "if-none-match": kin.etag } })).status, 304,
    "nothing published: the trusted device gets the built-in manifest too");

  await publish(h, h.admin);
  const tag = h.store.getInstallIdentity(h.admin.householdId).contentTag;
  response = await h.call("/manifest.webmanifest", { device: partner.deviceToken });
  const manifest = JSON.parse(response.body);
  const base = JSON.parse(kin.body);
  assert.equal(manifest.name, "The \"Nest\" — 家", "quotes and Unicode survive JSON encoding");
  assert.equal(manifest.short_name, "Nest");
  assert.equal(manifest.description, "Home base");
  for (const key of ["id", "start_url", "scope", "display"]) assert.equal(manifest[key], base[key], key);
  assert.deepEqual(manifest.icons.map((icon) => [icon.src, icon.purpose]), [
    [`/install-icon/192.png?v=${tag}`, "any"], [`/install-icon/512.png?v=${tag}`, "any"], [`/install-icon/maskable-512.png?v=${tag}`, "maskable"]]);
  const etag = response.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{24}"$/);
  assert.notEqual(etag, kin.etag);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal((await h.call("/manifest.webmanifest", { device: partner.deviceToken, headers: { "if-none-match": etag } })).status, 304);
  assert.equal((await h.call("/manifest.webmanifest", { headers: { "if-none-match": etag } })).status, 200, "no cookie: Kin's manifest");

  let icon = await h.call(`/install-icon/512.png?v=${tag}`, { device: partner.deviceToken });
  assert.equal(icon.headers.get("content-type"), "image/png");
  assert.match(icon.headers.get("cache-control"), /immutable/);
  assert.ok(icon.body.equals(png(512)));
  icon = await h.call("/install-icon/apple-180.png", { device: partner.deviceToken });
  assert.match(icon.headers.get("cache-control"), /no-cache/, "unversioned URLs revalidate");
  assert.ok(icon.body.equals(png(180)));
  icon = await h.call(`/install-icon/512.png?v=${tag}`);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml", "no trusted device: Kin's icon");
  assert.equal((await h.call("/install-icon/apple-180.png")).status, 404, "no PNG touch icon to fall back to: iOS keeps its own");
  assert.equal((await h.call("/install-icon/other.png", { device: partner.deviceToken })).headers.get("content-type"), "image/svg+xml");

  // An update changes the ETag and the icon URLs.
  await publish(h, h.admin, { expectedRev: 1, shortName: "Nest 2", icons: icons(20) });
  const nextTag = h.store.getInstallIdentity(h.admin.householdId).contentTag;
  assert.notEqual(nextTag, tag);
  response = await h.call("/manifest.webmanifest", { device: partner.deviceToken, headers: { "if-none-match": etag } });
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get("etag"), etag);
  assert.equal(JSON.parse(response.body).icons[0].src, `/install-icon/192.png?v=${nextTag}`);
  assert.match((await h.call(`/install-icon/512.png?v=${tag}`, { device: partner.deviceToken })).headers.get("cache-control"), /no-cache/);

  // A revoked device gets Kin's manifest again.
  h.service.revokeDevice(h.admin.sessionToken, partner.deviceId, h.admin.memberId);
  response = await h.call("/manifest.webmanifest", { device: partner.deviceToken });
  assert.equal(JSON.parse(response.body).short_name, "Kin");
});

test("another household's device sees only its own household's identity", async (t) => {
  const h = await start(t);
  await publish(h, h.admin);
  const other = h.service.bootstrap({ credential: credential("other-admin") });
  assert.notEqual(other.householdId, h.admin.householdId);
  let manifest = JSON.parse((await h.call("/manifest.webmanifest", { device: other.deviceToken })).body);
  assert.equal(manifest.short_name, "Kin");
  await publish(h, other, { shortName: "Work", name: "Work" });
  manifest = JSON.parse((await h.call("/manifest.webmanifest", { device: other.deviceToken })).body);
  assert.equal(manifest.short_name, "Work");
  manifest = JSON.parse((await h.call("/manifest.webmanifest", { device: h.admin.deviceToken })).body);
  assert.equal(manifest.short_name, "Nest");
});

test("the published copy survives restart and is purged with the household", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kin-install-identity-"));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const databasePath = join(directory, "kin.sqlite");
  store = new DurableStore(databasePath);
  const value = { name: "Nest", shortName: "Nest", description: "", iconSource: "upload",
    icons: { icon192: png(192), icon512: png(512), maskable512: png(512), apple180: png(180) },
    memberId: "a".repeat(32), deviceId: "b".repeat(32), updatedAt: 1 };
  value.contentTag = installContentTag(value);
  const service = new PairingService({ store, now: () => 1_800_000_000_000 });
  const admin = service.bootstrap({ credential: credential("admin") });
  assert.equal(store.putInstallIdentity(admin.householdId, 0, value), 1);
  store.close();
  store = new DurableStore(databasePath);
  assert.equal(store.getInstallIdentity(admin.householdId).iconSource, "upload");
  assert.equal(store.getInstallIdentity(admin.householdId).icons, undefined, "metadata reads carry no icon bytes");
  assert.ok(store.getInstallIcon(admin.householdId, "apple180").equals(png(180)));
  assert.equal(store.getInstallIcon(admin.householdId, "nope"), null);
  assert.equal(store.validate(), true);
  assert.equal(store.householdPurgeStatus(admin.householdId).counts.installIdentity, 2);
  const status = store.forcePurgeHousehold(admin.householdId, 1_800_000_000_001);
  assert.equal(status.counts.installIdentity, 0);
  assert.equal(store.getInstallIdentity(admin.householdId), null);
  assert.equal(store.validate(), true);
});

test("ETag matching accepts lists, weak tags and *", () => {
  assert.equal(etagMatches('"a", W/"b"', '"b"'), true);
  assert.equal(etagMatches("*", '"x"'), true);
  assert.equal(etagMatches('"c"', '"b"'), false);
  assert.equal(etagMatches(undefined, '"b"'), false);
});

test("the content tag follows every published field and icon", () => {
  const base = { name: "Nest", shortName: "Nest", description: "", iconSource: "letter",
    icons: { icon192: png(192), icon512: png(512), maskable512: png(512), apple180: png(180) } };
  const tag = installContentTag(base);
  assert.match(tag, /^[a-f0-9]{16}$/);
  assert.equal(installContentTag(structuredClone(base)), tag, "same content, same tag (a restore cannot reuse a URL for other content)");
  for (const changed of [{ name: "Nest!" }, { shortName: "N" }, { description: "x" }, { iconSource: "upload" },
    { icons: { ...base.icons, apple180: png(180, { filler: 17 }) } }])
    assert.notEqual(installContentTag({ ...base, ...changed }), tag);
});

test("in-memory households erase the published copy when deletion finalizes", async (t) => {
  const { EncryptedSyncService } = await import("./sync-service.mjs");
  let now = 1_800_000_000_000;
  const service = new PairingService({ now: () => now });
  const sync = new EncryptedSyncService(service, { now: () => now });
  const admin = service.bootstrap({ credential: credential("admin") });
  sync.publishInstallIdentity(admin.sessionToken, { expectedRev: 0, name: "Nest", shortName: "Nest", iconSource: "letter", icons: icons() });
  assert.ok(service.households.get(admin.householdId).installIdentity);
  service.requestHouseholdDeletion(admin.sessionToken, admin.memberId);
  now += 31 * 24 * 60 * 60 * 1000;
  service.finalizeExpiredDeletions(now);
  assert.equal(service.households.get(admin.householdId).installIdentity, undefined);
  assert.equal(sync.installIdentityForDevice(admin.deviceToken), null);
});

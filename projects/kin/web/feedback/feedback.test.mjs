// Reports and suggestions on the device (#632, #633, #628, ADR 0021 §3):
// the shared format, gathering diagnostics, the outbox, where reports go,
// and the screenshot's crop, size and type. The dialog itself runs in the
// browser regression (scripts/report-problem-regression.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAGNOSTIC_FIELDS, MAX_BODY_BYTES, MAX_SCREENSHOT_BYTES, REFERENCE_PATTERN, bodyBytes, isReference, newReference,
  normalizeDiagnostics, normalizeReport, reportTitle, sniffImageType,
} from "./format.js";
import { browserVersion, collectDiagnostics, deviceType, previewRows, withoutRemoved } from "./collect.js";
import { FeedbackOutbox, MAX_OUTBOX, OutboxFullError, memoryOutboxStorage } from "./outbox.js";
import { destinationText } from "./channel.js";
import { MIN_SCREENSHOT_WIDTH, ScreenshotError, clampCrop, cropFromTrim, encodeWithinLimit, screenshotPayload } from "./screenshot.js";
import { DiagnosticRing } from "../diagnostics/ring-buffer.js";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test("references are KR- or KS- and three groups of Crockford base32, made from random bytes", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(newReference(i % 2 ? "problem" : "suggestion"));
  assert.equal(seen.size, 200);
  for (const reference of seen) assert.match(reference, REFERENCE_PATTERN);
  assert.equal(newReference("problem", () => new Uint8Array(12)), "KR-0000-0000-0000");
  assert.equal(newReference("suggestion", () => new Uint8Array(12).fill(31)), "KS-ZZZZ-ZZZZ-ZZZZ");
  assert.equal(isReference("KR-0000-0000-000I"), false, "I, L, O and U aren't Crockford digits");
  assert.throws(() => newReference("other"));
});

test("a report keeps typed text as typed (line endings, no control characters) and is bounded", () => {
  const reference = newReference("problem");
  const report = normalizeReport({ kind: "problem", reference, text: { happened: "  It froze\r\nafter milk\u0007  ", expected: "", extra: "dropped" }, diagnostics: { version: "1.5.0", made: "up" } });
  assert.deepEqual(report, { kind: "problem", reference, text: { happened: "It froze\nafter milk" }, diagnostics: { version: "1.5.0" } });
  assert.equal(reportTitle(report), "It froze");
  assert.equal(reportTitle({ kind: "problem", text: {} }), "Problem report");
  assert.equal(reportTitle({ kind: "suggestion", text: { wish: "x".repeat(100) } }).length, 72);
  assert.throws(() => normalizeReport({ kind: "suggestion", reference: newReference("suggestion"), text: { why: "only why" } }), /What you'd like is needed/);
  // A suggestion carries the version and nothing else.
  const idea = normalizeReport({ kind: "suggestion", reference: newReference("suggestion"), text: { wish: "A pantry" }, diagnostics: { version: "1.5.0", browser: "Chrome", online: true } });
  assert.deepEqual(idea.diagnostics, { version: "1.5.0" });
  assert.throws(() => normalizeReport({ kind: "problem", reference, text: { happened: "中".repeat(4000), expected: "中".repeat(4000) } }), (error) => error.code === "feedback_too_large");
  assert.ok(bodyBytes(normalizeReport({ kind: "problem", reference, text: { happened: "x".repeat(4000), expected: "y".repeat(4000) } })) <= MAX_BODY_BYTES);
});

test("diagnostics keep only table values: no free text, IDs or names", () => {
  const secret = "Sam's room 4b";
  const kept = normalizeDiagnostics({
    version: "1.5.0 beta", build: "a".repeat(40), browser: secret, browserVersion: -1, os: "Android", deviceType: "phone",
    page: "lists", segment: secret, syncState: "ready", lastSyncAt: 1_800_000_000_000, pixelRatio: 2.6251, online: "yes", installed: true,
    householdId: "f".repeat(32), recent: [{ t: 1, code: "alert_shown", fields: { text: secret } }, { t: 2, code: secret }],
  });
  assert.deepEqual(kept, { os: "Android", deviceType: "phone", installed: true, page: "lists", syncState: "ready", lastSyncAt: 1_800_000_000_000,
    pixelRatio: 2.63, recent: [{ t: 1, code: "alert_shown", fields: {} }] });
  assert.ok(!JSON.stringify(kept).includes("Sam"));
  for (const { spec } of Object.values(DIAGNOSTIC_FIELDS)) assert.ok(["list", "number", "boolean", "pattern"].includes(spec.type));
});

test("diagnostics are gathered from the browser and the app, with the ring buffer", async () => {
  const ring = new DiagnosticRing({ now: () => 1_800_000_000_000 });
  ring.append("sync_failed", { reason: "connection_unavailable" });
  const win = {
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", maxTouchPoints: 5, onLine: false,
      storage: { estimate: async () => ({ usage: 12.34 * 1024 * 1024, quota: 2048 * 1024 * 1024 }) } },
    document: { documentElement: { dataset: { kinTextSize: "large", kinSimple: "on" } }, querySelector: () => ({ getAttribute: () => "1.5.0+abc123" }) },
    screen: { width: 412, height: 915 }, innerWidth: 412, innerHeight: 800, devicePixelRatio: 2.625,
    matchMedia: () => ({ matches: true }), caches: { keys: async () => ["kin-static-v1.5.0+abc123", "other"] },
  };
  const app = { vault: { locked: false }, route: { page: "lists", segment: "shopping" }, household: { identity: { memberId: "m" } },
    syncState: { state: "paused", code: "connection_unavailable", message: "Offline" }, lastSyncAt: 1_799_999_000_000 };
  const values = await collectDiagnostics({ app, win, recent: ring.snapshot() });
  assert.deepEqual(values, {
    version: "1.5.0", build: "abc123", browser: "Chrome", browserVersion: 131, os: "Android", deviceType: "phone", screenWidth: 412, screenHeight: 915,
    viewportWidth: 412, viewportHeight: 800, pixelRatio: 2.63, textSize: "large", installed: true, page: "lists", segment: "shopping",
    easyMode: false, simpleView: true, signedIn: true, syncState: "paused", lastSyncAt: 1_799_999_000_000, storageUsedMB: 12.3, storageQuotaMB: 2048,
    serviceWorker: "1.5.0+abc123", online: false, recent: [{ t: 1_800_000_000_000, code: "sync_failed", fields: { reason: "connection_unavailable" } }],
  });
  // On the lock screen: no route, no sync, not signed in.
  const locked = await collectDiagnostics({ app: { vault: null, security: { manifest: {} } }, win, recent: [] });
  assert.equal(locked.page, "locked");
  assert.equal(locked.signedIn, false);
  assert.equal(locked.syncState, "off");
  assert.equal("segment" in locked, false);
  assert.equal((await collectDiagnostics({ app: null, win, recent: [] })).page, "setup");
  // The preview's rows, in table order, and removal.
  const rows = previewRows(values);
  assert.deepEqual(rows.slice(0, 3).map((row) => [row.label, row.value]), [["Kin version", "1.5.0"], ["Build", "abc123"], ["Browser", "Chrome"]]);
  assert.equal(rows.at(-1).key, "recent");
  assert.deepEqual(rows.at(-1).lines, ["2027-01-15T08:00:00Z sync_failed reason=connection_unavailable"]);
  assert.equal(rows.find((row) => row.key === "online").value, "No");
  assert.deepEqual(Object.keys(withoutRemoved(values, new Set(["recent", "build"]))).includes("recent"), false);
  assert.equal(browserVersion("Safari", "Version/17.4 Mobile/15E148 Safari/604.1"), 17);
  assert.equal(deviceType({ os: "Android", userAgent: "Android 14; SM-X200" }), "tablet");
  assert.equal(deviceType({ os: "Windows" }), "computer");
});

test("the outbox keeps sends until the service has them, and waits for the right member", async () => {
  const sent = [];
  let answer = 201;
  let online = true;
  const outbox = new FeedbackOutbox({
    storage: memoryOutboxStorage(),
    send: async (item) => {
      if (!online) throw new TypeError("Failed to fetch");
      sent.push(item.reference);
      return { status: answer, value: answer >= 400 ? { message: "That report could not be read." } : { reference: item.reference } };
    },
  });
  const item = (signed, memberId = null) => ({ reference: newReference("problem"), kind: "problem", signed, memberId, body: {}, title: "t" });
  const anonymous = item(false);
  const mine = item(true, "member-a");
  const theirs = item(true, "member-b");
  online = false;
  for (const entry of [anonymous, mine, theirs]) await outbox.add(entry);
  assert.deepEqual((await outbox.flush({ identity: { memberId: "member-a" }, online: false })), [], "offline: nothing is tried");
  assert.deepEqual((await outbox.flush({ identity: { memberId: "member-a" } })).map((entry) => entry.outcome), ["waiting"], "a failed request stops the round");
  assert.equal((await outbox.list()).length, 3);
  online = true;
  const results = await outbox.flush({ identity: { memberId: "member-a" } });
  assert.deepEqual(results.map((entry) => [entry.reference, entry.outcome]), [[anonymous.reference, "sent"], [mine.reference, "sent"], [theirs.reference, "waiting"]]);
  assert.deepEqual((await outbox.list()).map((entry) => entry.reference), [theirs.reference], "another member's report waits for them");
  // Refused: kept, marked, never retried by itself; the service's reason is kept.
  answer = 400;
  const refused = await outbox.flush({ identity: { memberId: "member-b" } });
  assert.deepEqual(refused.map((entry) => entry.outcome), ["refused"]);
  const [kept] = await outbox.list();
  assert.equal(kept.lastStatus, 400);
  assert.equal(kept.lastMessage, "That report could not be read.");
  const before = sent.length;
  await outbox.flush({ identity: { memberId: "member-b" } });
  assert.equal(sent.length, before);
  await outbox.remove(kept.reference);
  // Rate limited: kept for later.
  answer = 429;
  await outbox.add(item(false));
  assert.deepEqual((await outbox.flush()).map((entry) => entry.outcome), ["waiting"]);
  // Bounded.
  for (let i = (await outbox.list()).length; i < MAX_OUTBOX; i++) await outbox.add(item(false));
  await assert.rejects(outbox.add(item(false)), OutboxFullError);
});

test("the preview says where a report goes, and warns when the tracker is public", () => {
  assert.match(destinationText({ forwarding: false, trackerPublic: null }), /stays on that service/);
  assert.match(destinationText({ forwarding: true, trackerPublic: true }), /anyone on the internet can read/);
  assert.match(destinationText({ forwarding: true, trackerPublic: null }), /anyone on the internet can read/, "unknown reads as public");
  assert.match(destinationText({ forwarding: true, trackerPublic: false }), /only the Kin team can read/);
  assert.match(destinationText(null), /may be public/);
});

test("a crop stays inside the picture and keeps a minimum size", () => {
  const bounds = { width: 800, height: 600 };
  assert.deepEqual(clampCrop({ x: -10, y: 700, width: 5000, height: 2 }, bounds), { x: 0, y: 584, width: 800, height: 16 });
  assert.deepEqual(cropFromTrim({ left: 10, top: 0, right: 10, bottom: 50 }, bounds), { x: 80, y: 0, width: 640, height: 300 });
  assert.deepEqual(cropFromTrim({ left: 95, right: 95 }, bounds), { x: 720, y: 0, width: 16, height: 600 }, "each trim stops at 90%, and the crop keeps its minimum");
  assert.deepEqual(clampCrop({}, { width: 10, height: 8 }), { x: 0, y: 0, width: 10, height: 8 });
});

/** A canvas stand-in whose PNG size grows with its area. */
function fakeCanvasKit({ bytesPerPixel = 1, jpegFactor = 0.1 } = {}) {
  const drawn = [];
  const makeCanvas = (width, height) => ({ width, height, getContext: () => ({ drawImage: (...args) => drawn.push(args) }) });
  const encode = async (canvas, type, quality = 1) => {
    const size = Math.round(canvas.width * canvas.height * bytesPerPixel * (type === "image/jpeg" ? jpegFactor * quality : 1));
    return { size, type };
  };
  return { makeCanvas, encode, drawn };
}

test("the screenshot is PNG at most 1 MiB, scaled down to fit, then JPEG", async () => {
  const source = { width: 1000, height: 800 };
  const crop = { x: 0, y: 0, width: 1000, height: 800 };
  const small = fakeCanvasKit({ bytesPerPixel: 1 });
  const fits = await encodeWithinLimit({ source, crop, ...small });
  assert.deepEqual([fits.type, fits.width, fits.height], ["image/png", 1000, 800]);
  const big = fakeCanvasKit({ bytesPerPixel: 2 });
  const scaled = await encodeWithinLimit({ source, crop, ...big });
  assert.equal(scaled.type, "image/png");
  assert.ok(scaled.blob.size <= MAX_SCREENSHOT_BYTES && scaled.width < 1000 && scaled.width >= MIN_SCREENSHOT_WIDTH);
  assert.equal(big.drawn.at(-1)[7], scaled.width, "drawn at the size it was encoded");
  const huge = fakeCanvasKit({ bytesPerPixel: 40, jpegFactor: 0.05 });
  const jpeg = await encodeWithinLimit({ source, crop, ...huge });
  assert.equal(jpeg.type, "image/jpeg");
  assert.ok(jpeg.blob.size <= MAX_SCREENSHOT_BYTES);
  const impossible = fakeCanvasKit({ bytesPerPixel: 400, jpegFactor: 1 });
  await assert.rejects(encodeWithinLimit({ source, crop, ...impossible }), (error) => error instanceof ScreenshotError && error.code === "too_large");
});

test("only a real PNG or JPEG of at most 1 MiB becomes the report's screenshot", async () => {
  const png = new Blob([new Uint8Array([...PNG_HEAD, 1, 2, 3])], { type: "image/png" });
  const payload = await screenshotPayload(png);
  assert.equal(payload.type, "image/png");
  assert.deepEqual([...Buffer.from(payload.data, "base64")].slice(0, 8), PNG_HEAD);
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  assert.equal((await screenshotPayload(new Blob([jpegBytes], { type: "image/jpeg" }))).type, "image/jpeg");
  assert.equal(sniffImageType(jpegBytes), "image/jpeg");
  await assert.rejects(screenshotPayload(new Blob([jpegBytes], { type: "image/png" })), ScreenshotError, "the declared type must match the bytes");
  await assert.rejects(screenshotPayload(new Blob([new TextEncoder().encode("<svg></svg> not an image")], { type: "image/png" })), ScreenshotError);
  await assert.rejects(screenshotPayload(new Blob([new Uint8Array([...PNG_HEAD]), new Uint8Array(MAX_SCREENSHOT_BYTES)], { type: "image/png" })), (error) => error.code === "too_large");
});

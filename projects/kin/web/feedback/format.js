// What a problem report or a feature suggestion is (#630, #627, ADR 0021 §3),
// shared by the device that writes it and the service that stores it
// (server/feedback-service.mjs imports this file): the reference number, the
// typed fields, the diagnostics a report may carry and their labels, the size
// bounds and the screenshot's type check.
//
// Diagnostics are a fixed table. Each value is a number, a yes/no, a value
// from a fixed list, or a version that matches a strict pattern, so nothing a
// person typed and no household name or ID can be a diagnostic. The person's
// own typed text is the only free text a report holds, and it is shown in the
// preview before anything is sent.
import { DEVICE_BROWSER_NAMES, DEVICE_OS_NAMES } from "../platform.js";
import { PAGES, normalizeEntry } from "../diagnostics/registry.js";
import { SEGMENTS } from "../routes.js";
import { RING_CAPACITY } from "../diagnostics/ring-buffer.js";

export const FEEDBACK_KINDS = Object.freeze(["problem", "suggestion"]);
export const FEEDBACK_STATUSES = Object.freeze(["received", "planned", "done", "wont_do"]);
/** How a status reads to the person who sent it. */
export const STATUS_LABELS = Object.freeze({ received: "Received", planned: "Planned", done: "Done", wont_do: "Won't do" });

/** The stored body (everything but the screenshot), as UTF-8 JSON. */
export const MAX_BODY_BYTES = 16 * 1024;
/** One typed field. */
export const MAX_TEXT_CHARS = 4000;
/** The optional screenshot. */
export const MAX_SCREENSHOT_BYTES = 1024 * 1024;
export const SCREENSHOT_TYPES = Object.freeze(["image/png", "image/jpeg"]);

/** The typed fields of each kind, in order, with their labels. A problem
 * report may be sent with nothing typed; a suggestion needs its first. */
export const TEXT_FIELDS = Object.freeze({
  problem: Object.freeze([
    Object.freeze({ name: "happened", label: "What happened", required: false }),
    Object.freeze({ name: "expected", label: "What you expected", required: false }),
  ]),
  suggestion: Object.freeze([
    Object.freeze({ name: "wish", label: "What you'd like", required: true }),
    Object.freeze({ name: "why", label: "Why it would help", required: false }),
  ]),
});

// References: "KR-" (report) or "KS-" (suggestion) and three groups of four
// Crockford base32 characters (60 random bits), made on the device so an
// outbox retry is recognized as the same report.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REFERENCE_PATTERN = /^K[RS]-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** A new reference for `kind`. `random(n)` returns n random bytes. */
export function newReference(kind, random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  if (!FEEDBACK_KINDS.includes(kind)) throw new TypeError("Unknown feedback kind.");
  const bytes = random(12);
  const chars = [...bytes].map((byte) => CROCKFORD[byte & 31]);
  return `${kind === "problem" ? "KR" : "KS"}-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

export const isReference = (value) => typeof value === "string" && REFERENCE_PATTERN.test(value);
export const referenceKind = (reference) => (reference.startsWith("KR-") ? "problem" : "suggestion");

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const BUILD = /^[0-9a-z]{1,32}$/;
const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:\+[0-9a-z]{1,32})?$/;
const SEGMENT_IDS = Object.freeze([...new Set(Object.values(SEGMENTS).flat().map((entry) => entry.id)), "none"]);
const list = (values) => Object.freeze({ type: "list", values: Object.freeze([...values]) });
const number = (max, digits = 0) => Object.freeze({ type: "number", max, digits });
const BOOLEAN = Object.freeze({ type: "boolean" });
const pattern = (expression) => Object.freeze({ type: "pattern", pattern: expression });

/**
 * The diagnostics a report may carry, in preview order: key → { label, spec,
 * format }. `recent` (the ring buffer) is separate. The service drops any key
 * not here and any value its spec refuses.
 */
export const DIAGNOSTIC_FIELDS = Object.freeze({
  version: { label: "Kin version", spec: pattern(VERSION) },
  build: { label: "Build", spec: pattern(BUILD) },
  browser: { label: "Browser", spec: list([...DEVICE_BROWSER_NAMES, "Other"]) },
  browserVersion: { label: "Browser version", spec: number(100_000) },
  os: { label: "System", spec: list([...DEVICE_OS_NAMES, "Other"]) },
  deviceType: { label: "Device type", spec: list(["phone", "tablet", "computer"]) },
  screenWidth: { label: "Screen width (px)", spec: number(100_000) },
  screenHeight: { label: "Screen height (px)", spec: number(100_000) },
  viewportWidth: { label: "Window width (px)", spec: number(100_000) },
  viewportHeight: { label: "Window height (px)", spec: number(100_000) },
  pixelRatio: { label: "Pixel ratio", spec: number(16, 2) },
  textSize: { label: "Text size", spec: list(["normal", "large", "larger"]) },
  installed: { label: "Installed app (not a browser tab)", spec: BOOLEAN },
  page: { label: "Page", spec: list(PAGES) },
  segment: { label: "Section", spec: list(SEGMENT_IDS) },
  easyMode: { label: "Easy mode", spec: BOOLEAN },
  simpleView: { label: "Simple view", spec: BOOLEAN },
  signedIn: { label: "Signed in", spec: BOOLEAN },
  syncState: { label: "Sync", spec: list(["ready", "syncing", "paused", "disabled", "deleted", "off", "other"]) },
  lastSyncAt: { label: "Last sync", spec: number(2 ** 48) },
  storageUsedMB: { label: "Storage used (MB)", spec: number(10_000_000, 1) },
  storageQuotaMB: { label: "Storage available (MB)", spec: number(10_000_000, 1) },
  serviceWorker: { label: "Offline copy (service worker)", spec: pattern(RELEASE) },
  online: { label: "Online", spec: BOOLEAN },
});
export const RECENT_LABEL = "Recent problems on this device";

/** A value as `spec` keeps it, or undefined when it doesn't fit. */
function keepValue(spec, value) {
  switch (spec.type) {
    case "list": return typeof value === "string" && spec.values.includes(value) ? value : undefined;
    case "boolean": return typeof value === "boolean" ? value : undefined;
    case "pattern": return typeof value === "string" && spec.pattern.test(value) ? value : undefined;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > spec.max) return undefined;
      const scale = 10 ** spec.digits;
      return Math.round(value * scale) / scale;
    }
    default: return undefined;
  }
}

/**
 * The diagnostics that survive the table: known keys with acceptable values,
 * and `recent` as at most 50 registry entries. Never throws.
 */
export function normalizeDiagnostics(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, { spec }] of Object.entries(DIAGNOSTIC_FIELDS)) {
    if (!Object.hasOwn(value, key)) continue;
    const kept = keepValue(spec, value[key]);
    if (kept !== undefined) out[key] = kept;
  }
  if (Array.isArray(value.recent)) {
    const recent = value.recent.slice(-RING_CAPACITY).map(normalizeEntry).filter(Boolean);
    if (recent.length) out.recent = recent.map(({ t, code, fields }) => ({ t, code, fields: { ...fields } }));
  }
  return out;
}

/** How a diagnostic value reads in the preview and the forwarded issue. */
export function formatDiagnostic(key, value) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (key === "lastSyncAt") return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
  return String(value);
}

export class FeedbackFormatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeedbackFormatError";
    this.code = code;
  }
}

/** Typed text as stored: line endings made "\n" and control characters
 * other than newline and tab removed; at most MAX_TEXT_CHARS. */
export function cleanText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new FeedbackFormatError("feedback_invalid", "A report's text must be text.");
  const cleaned = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (cleaned.length > MAX_TEXT_CHARS)
    throw new FeedbackFormatError("feedback_too_large", `Each box holds up to ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters.`);
  return cleaned;
}

/**
 * Checks a report as the device sends it, `{ kind, reference, text,
 * diagnostics }`, and returns the stored form. Throws FeedbackFormatError.
 * Suggestions carry only the Kin version as a diagnostic.
 */
export function normalizeReport(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new FeedbackFormatError("feedback_invalid", "That report could not be read.");
  const { kind, reference } = body;
  if (!FEEDBACK_KINDS.includes(kind) || !isReference(reference) || referenceKind(reference) !== kind)
    throw new FeedbackFormatError("feedback_invalid", "That report could not be read.");
  const typed = body.text && typeof body.text === "object" && !Array.isArray(body.text) ? body.text : {};
  const text = {};
  for (const field of TEXT_FIELDS[kind]) {
    const value = cleanText(typed[field.name]);
    if (field.required && !value)
      throw new FeedbackFormatError("feedback_invalid", `${field.label} is needed.`);
    if (value) text[field.name] = value;
  }
  const all = normalizeDiagnostics(body.diagnostics);
  const diagnostics = kind === "suggestion" ? (all.version ? { version: all.version } : {}) : all;
  const report = { kind, reference, text, diagnostics };
  if (bodyBytes(report) > MAX_BODY_BYTES)
    throw new FeedbackFormatError("feedback_too_large", "That report is too long to send. Shorten what you typed, or remove some details.");
  return report;
}

/** The stored body's size in bytes. */
export function bodyBytes(report) {
  return new TextEncoder().encode(JSON.stringify(report)).length;
}

/** A short title: the first line of what was typed, or a plain default. */
export function reportTitle(report) {
  const first = report.kind === "problem" ? report.text.happened : report.text.wish;
  const line = String(first ?? "").split("\n", 1)[0].trim();
  const chars = [...line];
  const summary = chars.length > 72 ? `${chars.slice(0, 71).join("").trimEnd()}…` : line;
  return summary || (report.kind === "problem" ? "Problem report" : "Suggestion");
}

/** "image/png", "image/jpeg" or null, from the bytes themselves. */
export function sniffImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  return null;
}

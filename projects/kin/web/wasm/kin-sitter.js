// The sitter page (#442, ADR 0017) codecs, matching rust/src/sitter.rs:
// - "set-sitter-page" (KCMD action 70, SITTER_PAGE_SET): { intro, entries:
//   [{ kind: "note" | "reference-record" | "routine", id (hex) }] }, the whole
//   page (0–30 entries), replacing the previous one. Payload: entry count
//   u16, reserved u16, each entry (kind u8, three reserved, ID [16]), then the
//   intro (u16 length + UTF-8).
// - KSIT v1: { intro, entries: [{ kind, id }] }, only the entries whose
//   record exists and isn't archived, in the page's order. The host takes
//   titles, fields and text from the main projection by ID.
//
// Commands carry the event's exact canonical payload, so the intro is
// trimmed here exactly as Rust's `str::trim` does (Unicode White_Space, which
// is not JavaScript's `\s`), with line breaks normalized to "\n". Rust decides
// the rest: no entry twice, every entry names a live record of its kind, and
// the page changes.
//
// Who may change the page is an owner decision: Adults only, not Limited or
// Temporary members. Rust does not know a member's kind; the host does
// (`memberKind` in the sync status), so the single command append path
// (components/app/commands/append.js) refuses the command for anyone else
// with `canChangeSitterPage`, as removing attachments is gated
// (attachments/attachment-permissions.js).
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_ID = /^[a-f0-9]{32}$/;
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");
const CONTROL_BUT_NEWLINE = /[\0-\t\v-\x1f\x7f-\x9f]/u;

export const SITTER_COMMANDS = Object.freeze(["set-sitter-page"]);
export const SITTER_EVENT_KINDS = Object.freeze(["SITTER_PAGE_SET"]);
export const SITTER_PAGE_KIND = 70;
export const MAX_SITTER_ENTRIES = 30;
export const MAX_SITTER_INTRO_BYTES = 500;
export const SITTER_PAGE_FORBIDDEN = "Only Adults can change the sitter page.";

// Entry kinds and their payload codes.
const ENTRY_CODES = Object.freeze({ note: 1, "reference-record": 2, routine: 3 });
const ENTRY_KINDS = Object.freeze([null, "note", "reference-record", "routine"]);

export class SitterFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "SitterFormatError";
  }
}

/** Whether a member of `memberKind` may change the sitter page: Adults only.
 * A device with no server membership (a local-only household) is its own
 * Adult, as for attachments; pass "adult" for it. Anything else, including
 * an unknown kind, is refused. */
export function canChangeSitterPage(memberKind) {
  return memberKind === "adult";
}

const idBytes = (value, what) => {
  if (value instanceof Uint8Array && value.length === 16 && value.some(Boolean)) return value;
  if (typeof value !== "string" || !HEX_ID.test(value) || /^0+$/.test(value)) throw new SitterFormatError(`Kin received an invalid ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
};
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The intro as Rust stores it: line breaks as "\n", trimmed, at most 500
 * UTF-8 bytes, no control characters but newline. Empty means none. */
export function normalizeSitterIntro(intro) {
  const value = String(intro ?? "").replace(/\r\n?/g, "\n").replace(EDGE_SPACE, "");
  if (encoder.encode(value).length > MAX_SITTER_INTRO_BYTES) throw new SitterFormatError("The note for the sitter is too long.");
  if (CONTROL_BUT_NEWLINE.test(value)) throw new SitterFormatError("The note for the sitter can only hold plain text.");
  return value;
}

/** The canonical kind-70 payload for { intro, entries }. */
export function encodeSitterPagePayload({ intro = "", entries }) {
  if (!Array.isArray(entries) || entries.length > MAX_SITTER_ENTRIES)
    throw new SitterFormatError(`The sitter page can show at most ${MAX_SITTER_ENTRIES} things.`);
  const text = encoder.encode(normalizeSitterIntro(intro));
  const out = new Uint8Array(4 + entries.length * 20 + 2 + text.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, entries.length, true);
  let at = 4;
  for (const entry of entries) {
    const code = Object.hasOwn(ENTRY_CODES, entry?.kind) ? ENTRY_CODES[entry.kind] : 0;
    if (!code) throw new SitterFormatError("Kin received an invalid sitter page entry.");
    out[at] = code;
    out.set(idBytes(entry.id, "sitter page entry"), at + 4);
    at += 20;
  }
  view.setUint16(at, text.length, true);
  out.set(text, at + 2);
  return out;
}

/** A KCMD packet for "set-sitter-page": the 128-byte header (identity and
 * logical time as for every command) with the payload as its text. */
export function encodeSitterIntent(command, identity) {
  if (command?.type !== "set-sitter-page") throw new SitterFormatError("Kin received an invalid sitter page change.");
  const payload = encodeSitterPagePayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, SITTER_PAGE_KIND, true);
  packet.set(idBytes(identity.eventId, "event"), 12);
  packet.set(idBytes(identity.householdId, "household"), 28);
  packet.set(idBytes(identity.actorId, "member"), 44);
  packet.set(idBytes(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new SitterFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new SitterFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/** KSIT v1 as { intro, entries: [{ kind, id }] } in the page's order. */
export function decodeSitterPage(bytes) {
  const invalid = () => new SitterFormatError("Kin received an invalid sitter page.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 14 || String.fromCharCode(...bytes.subarray(0, 4)) !== "KSIT" || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw invalid();
  const count = view.getUint32(8, true);
  if (count > MAX_SITTER_ENTRIES || bytes.length < 12 + count * 20 + 2) throw invalid();
  const entries = [];
  const seen = new Set();
  let at = 12;
  for (let index = 0; index < count; index += 1, at += 20) {
    const kind = ENTRY_KINDS[bytes[at]];
    const id = toHex(bytes.subarray(at + 4, at + 20));
    if (!kind || bytes[at + 1] || bytes[at + 2] || bytes[at + 3] || /^0+$/.test(id) || seen.has(`${kind}:${id}`)) throw invalid();
    seen.add(`${kind}:${id}`);
    entries.push({ kind, id });
  }
  const length = view.getUint16(at, true);
  if (at + 2 + length !== bytes.length || length > MAX_SITTER_INTRO_BYTES) throw invalid();
  let intro;
  try { intro = decoder.decode(bytes.subarray(at + 2)); } catch { throw invalid(); }
  return { intro, entries };
}

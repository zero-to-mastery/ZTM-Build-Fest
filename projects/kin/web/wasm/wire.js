// Protocol-24 wire constants and helpers shared by the engine bridge and the
// projection decoder. Wire validation only; Rust owns every domain rule.
import { recordDiagnostic } from "../diagnostics/ring-buffer.js";

export const PROTOCOL_VERSION = 24;
export const MAX_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_EVENT_COUNT = 10_000;
export const MAX_PROTOCOL_BYTES = 64 * 1024 * 1024;
export const MAX_ITEM_TEXT_BYTES = 4096;
export const MAX_STEP_TEXT_BYTES = 256;
export const MAX_STEP_TEXT_CHARS = 80;
export const MAX_STEPS_PER_ITEM = 16;
export const MAX_SUMMARY_ENTRIES = 8;
export const PULSE_VALUES = ["good", "okay", "drained", "rough-day", "need-quiet"];
export const SUMMARY_KINDS = [
  "",
  "item-added",
  "item-completed",
  "item-reopened",
  "item-archived",
  "handoff-added",
  "handoff-acknowledged",
  "handoff-archived",
  "talk-added",
  "talk-resolved",
  "talk-reopened",
  "talk-archived",
  "routine-created",
  "routine-occurrence-completed",
  "routine-occurrence-reopened",
  "routine-archived",
];
// Wire cadence codes, in Rust's `Cadence` order. Weekdays needs protocol 24.
export const ROUTINE_CADENCES = Object.freeze(["daily", "weekly", "biweekly", "monthly", "weekdays"]);
export const ZERO_ID = "00".repeat(16);

export const strictTextDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export class KinEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KinEngineError";
    this.code = code;
    // The engine's numeric category only (#631).
    recordDiagnostic("engine_error", { code: typeof code === "number" ? code : undefined });
  }
}

export function assertCivilDate(value) {
  if (!isCivilDate(value)) {
    throw new KinEngineError(2, "Kin requires a valid civil date.");
  }
}

export function isCivilDate(value) {
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return !(
    !Number.isInteger(value) ||
    year < 1 ||
    year > 9999 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  );
}

export function civilOrdinal(value) {
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const previousYear = year - 1;
  let days =
    365 * previousYear +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400);
  const monthLengths = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  for (let index = 0; index < month - 1; index += 1) days += monthLengths[index];
  return days + (value % 100) - 1;
}

export function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_TIMESTAMP) {
    throw new KinEngineError(2, "Kin needs a valid evaluation time.");
  }
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

export function idToHex(value) {
  const bytes = asBytes(value);
  let hex = "";
  for (let index = 0; index < bytes.length; index += 1) hex += HEX[bytes[index]];
  return hex;
}

export function asBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new KinEngineError(2, "Kin could not read a stored event record.");
}

export function readAscii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

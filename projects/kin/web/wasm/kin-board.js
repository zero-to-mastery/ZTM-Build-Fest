// The family fridge's wire formats on the browser side (#317, ADR 0011).
// Rust (rust/src/board.rs) owns the rules and is the authority on every
// payload; this module only builds well-formed packets, keeps strokes inside
// one event, and reads the KBRD table Rust returns.
//
// Board coordinates: x 0..4095, y 0..5460 (a 3:4 portrait door).

export const BOARD_WIDTH = 4096;
export const BOARD_HEIGHT = 5461;
export const MAX_X = BOARD_WIDTH - 1;
export const MAX_Y = BOARD_HEIGHT - 1;
export const MAX_STROKE_POINTS = 1024;
export const MAX_STROKE_PAYLOAD_BYTES = 4096;
export const MAX_VISIBLE_STROKES = 2000;
export const MAX_VISIBLE_MAGNETS = 200;
export const MAX_BOARD_EVENT_COUNT = 250_000;
export const PALETTE_COLOURS = 8;
export const PEN_WIDTHS = 3;
export const KIN_MAGNETS = 12;
export const MAX_NOTE_CHARS = 60;
export const MAX_NOTE_BYTES = 240;

/** KCMD actions and event kinds 52–58, in order. */
export const BOARD_COMMANDS = Object.freeze([
  "add-stroke", "hide-stroke", "place-magnet", "move-magnet", "hide-magnet", "clear-board", "undo-clear",
]);
export const BOARD_EVENT_KINDS = Object.freeze([
  "BOARD_STROKE_ADDED", "BOARD_STROKE_HIDDEN", "BOARD_MAGNET_PLACED", "BOARD_MAGNET_MOVED",
  "BOARD_MAGNET_HIDDEN", "BOARD_CLEARED", "BOARD_CLEAR_UNDONE",
]);
export const FIRST_BOARD_KIND = 52;

const MAGNET_KINDS = ["", "emoji", "kin", "note"];
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export class BoardFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "BoardFormatError";
  }
}

function hexId(value, what) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value) || /^0{32}$/.test(value))
    throw new BoardFormatError(`Kin received an invalid fridge ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function point(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= MAX_X && y <= MAX_Y;
}

/** A note magnet's canonical text, or null when it can't be one. */
export function normalizeNote(text) {
  if (typeof text !== "string" || !text.isWellFormed()) return null;
  const trimmed = text.trim();
  const chars = [...trimmed];
  if (chars.length < 1 || chars.length > MAX_NOTE_CHARS || encoder.encode(trimmed).length > MAX_NOTE_BYTES) return null;
  if (chars.some((character) => /\p{Cc}/u.test(character))) return null;
  return trimmed;
}

function zigzag(value) {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function varint(out, value) {
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value);
}

/** The stroke payload's size for `points`, without building it. */
export function strokePayloadSize(points) {
  let size = 24;
  for (let index = 1; index < points.length; index += 1) {
    for (const delta of [points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]]) {
      const value = zigzag(delta);
      size += value < 0x80 ? 1 : value < 0x4000 ? 2 : 3;
    }
  }
  return size;
}

/** Ramer–Douglas–Peucker in board units; keeps both ends. */
export function simplifyStroke(points, tolerance = 2) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const squared = tolerance * tolerance;
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax, dy = by - ay;
    const length = dx * dx + dy * dy;
    let worst = -1, worstDistance = squared;
    for (let index = first + 1; index < last; index += 1) {
      const [px, py] = points[index];
      let distance;
      if (length === 0) distance = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const cross = dx * (py - ay) - dy * (px - ax);
        distance = (cross * cross) / length;
      }
      if (distance > worstDistance) { worst = index; worstDistance = distance; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

/** Splits a stroke into pieces that each fit one event; consecutive pieces
 * share their joining point so they draw as one line. */
export function splitStroke(points) {
  const pieces = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + MAX_STROKE_POINTS);
    while (end - start > 1 && strokePayloadSize(points.slice(start, end)) > MAX_STROKE_PAYLOAD_BYTES) end -= 1;
    pieces.push(points.slice(start, end));
    if (end >= points.length) break;
    start = end - 1;
  }
  return pieces;
}

/** Rounds and clamps raw board coordinates and drops repeated points. */
export function boardPoints(raw) {
  const points = [];
  for (const [rawX, rawY] of raw) {
    const x = Math.min(MAX_X, Math.max(0, Math.round(rawX)));
    const y = Math.min(MAX_Y, Math.max(0, Math.round(rawY)));
    const last = points.at(-1);
    if (!last || last[0] !== x || last[1] !== y) points.push([x, y]);
  }
  return points;
}

/** The exact event payload for a board command (board.rs layouts). */
export function encodeBoardPayload(command) {
  switch (command?.type) {
    case "add-stroke": {
      const { colour, width, points } = command;
      if (!Number.isInteger(colour) || colour < 0 || colour >= PALETTE_COLOURS ||
        !Number.isInteger(width) || width < 0 || width >= PEN_WIDTHS ||
        !Array.isArray(points) || points.length < 1 || points.length > MAX_STROKE_POINTS ||
        !points.every((entry) => Array.isArray(entry) && point(entry[0], entry[1])))
        throw new BoardFormatError("Kin received an invalid fridge stroke.");
      const out = [...hexId(command.strokeId, "stroke"), colour, width, points.length & 0xff, points.length >> 8,
        points[0][0] & 0xff, points[0][0] >> 8, points[0][1] & 0xff, points[0][1] >> 8];
      for (let index = 1; index < points.length; index += 1) {
        varint(out, zigzag(points[index][0] - points[index - 1][0]));
        varint(out, zigzag(points[index][1] - points[index - 1][1]));
      }
      if (out.length > MAX_STROKE_PAYLOAD_BYTES) throw new BoardFormatError("That stroke is too long to save.");
      return Uint8Array.from(out);
    }
    case "hide-stroke":
    case "hide-magnet": {
      if (typeof command.hidden !== "boolean") throw new BoardFormatError("Kin received an invalid fridge change.");
      const payload = new Uint8Array(24);
      payload.set(hexId(command.type === "hide-stroke" ? command.strokeId : command.magnetId, "item"));
      payload[16] = command.hidden ? 1 : 0;
      return payload;
    }
    case "place-magnet": {
      const { x, y, content } = command;
      if (!point(x, y)) throw new BoardFormatError("Kin received an invalid magnet position.");
      const kind = MAGNET_KINDS.indexOf(content?.kind);
      let number = 0, text = "";
      if (kind === 1 && typeof content.emoji === "string" && content.emoji.length > 0 && content.emoji.isWellFormed()) text = content.emoji;
      else if (kind === 2 && Number.isInteger(content.number) && content.number >= 1 && content.number <= KIN_MAGNETS) number = content.number;
      else if (kind === 3 && normalizeNote(content.text) === content.text) text = content.text;
      else throw new BoardFormatError("Kin received an invalid magnet.");
      const textBytes = encoder.encode(text);
      const payload = new Uint8Array(24 + textBytes.length);
      const view = new DataView(payload.buffer);
      payload.set(hexId(command.magnetId, "magnet"));
      payload[16] = kind;
      payload[17] = number;
      view.setUint16(18, x, true);
      view.setUint16(20, y, true);
      view.setUint16(22, textBytes.length, true);
      payload.set(textBytes, 24);
      return payload;
    }
    case "move-magnet": {
      if (!point(command.x, command.y)) throw new BoardFormatError("Kin received an invalid magnet position.");
      const payload = new Uint8Array(24);
      const view = new DataView(payload.buffer);
      payload.set(hexId(command.magnetId, "magnet"));
      view.setUint16(16, command.x, true);
      view.setUint16(18, command.y, true);
      return payload;
    }
    case "clear-board":
    case "undo-clear":
      return hexId(command.clearId, "clear");
    default:
      throw new BoardFormatError("Kin received an invalid fridge change.");
  }
}

/** A KCMD packet for a board command: the 128-byte header (identity and
 * logical time as for every command) and the payload as its text. */
export function encodeBoardIntent(command, identity) {
  const action = BOARD_COMMANDS.indexOf(command?.type);
  if (action < 0) throw new BoardFormatError("Kin received an invalid fridge change.");
  const payload = encodeBoardPayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, FIRST_BOARD_KIND + action, true);
  packet.set(hexId(identity.eventId, "event"), 12);
  packet.set(hexId(identity.householdId, "household"), 28);
  packet.set(hexId(identity.actorId, "member"), 44);
  packet.set(hexId(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new BoardFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new BoardFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/** Reads KBRD v1 (board.rs `encode_board`). Points are a flat Uint16Array
 * of x, y pairs. */
export function decodeBoard(bytes) {
  const invalid = () => new BoardFormatError("Kin received an invalid fridge.");
  if (!(bytes instanceof Uint8Array) || bytes.length < 36) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "KBRD" || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0)
    throw invalid();
  const strokeCount = view.getUint32(8, true);
  const magnetCount = view.getUint32(12, true);
  const hasClear = bytes[16];
  if (hasClear > 1 || bytes[17] || bytes[18] || bytes[19] || strokeCount > MAX_VISIBLE_STROKES * 4 || magnetCount > MAX_VISIBLE_MAGNETS * 4) throw invalid();
  const openClear = hasClear ? toHex(bytes.subarray(20, 36)) : null;
  let at = 36;
  const strokes = [];
  for (let index = 0; index < strokeCount; index += 1) {
    if (at + 36 > bytes.length) throw invalid();
    const count = view.getUint16(at + 34, true);
    if (count < 1 || at + 36 + count * 4 > bytes.length) throw invalid();
    const points = new Uint16Array(count * 2);
    for (let p = 0; p < count * 2; p += 1) points[p] = view.getUint16(at + 36 + p * 2, true);
    strokes.push({
      id: toHex(bytes.subarray(at, at + 16)),
      author: toHex(bytes.subarray(at + 16, at + 32)),
      colour: bytes[at + 32],
      width: bytes[at + 33],
      points,
    });
    at += 36 + count * 4;
  }
  const magnets = [];
  for (let index = 0; index < magnetCount; index += 1) {
    if (at + 40 > bytes.length) throw invalid();
    const kind = MAGNET_KINDS[bytes[at + 32]];
    const length = view.getUint16(at + 38, true);
    if (!kind || at + 40 + length > bytes.length) throw invalid();
    let text = "";
    try { text = strictDecoder.decode(bytes.subarray(at + 40, at + 40 + length)); } catch { throw invalid(); }
    magnets.push({
      id: toHex(bytes.subarray(at, at + 16)),
      author: toHex(bytes.subarray(at + 16, at + 32)),
      kind,
      number: bytes[at + 33],
      x: view.getUint16(at + 34, true),
      y: view.getUint16(at + 36, true),
      text,
    });
    at += 40 + length;
  }
  if (at !== bytes.length) throw invalid();
  return { strokes, magnets, openClear };
}

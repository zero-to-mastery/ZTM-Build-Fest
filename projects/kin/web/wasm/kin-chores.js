// The chore chart (#676, ADR 0022 §6) codecs, matching rust/src/chores.rs:
// - "set-chore-points" (KCMD action 77, CHORE_POINTS_SET): { routineId,
//   points } with points 0–10. Payload: routine ID [16], points u8, three
//   reserved.
// - "set-chore-reward" (78, CHORE_REWARD_SET): { memberId, goal, text }, goal
//   1–1000 and text 1–120 bytes; goal 0 with no text clears it. Payload:
//   member ID [16], goal u16, reserved u16, text (u16 length + UTF-8).
// - "set-chore-chart-joined" (79, CHORE_CHART_JOINED): { memberId, joined }.
//   Rust accepts it only from the member it names. Payload: member ID [16],
//   joined u8, three reserved.
// - KCCQ v1, the query, and KCCD v1, the chart (decodeChoreChart).
//
// Rust doesn't know member kinds or service settings, so the host decides who
// may send what (canSendChoreCommand): points and rewards are for Adults;
// joining is for an Adult once a household admin allows adults on the chart.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_ID = /^[a-f0-9]{32}$/;
// Unicode White_Space, as Rust's str::trim (not JavaScript's \s).
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");
const CONTROL = /[\0-\x1f\x7f-\x9f]/u;

export const CHORE_COMMANDS = Object.freeze(["set-chore-points", "set-chore-reward", "set-chore-chart-joined"]);
export const CHORE_EVENT_KINDS = Object.freeze(["CHORE_POINTS_SET", "CHORE_REWARD_SET", "CHORE_CHART_JOINED"]);
export const FIRST_CHORE_KIND = 77;
export const DEFAULT_CHORE_POINTS = 1;
export const MAX_CHORE_POINTS = 10;
export const MAX_REWARD_GOAL = 1000;
export const MAX_REWARD_TEXT_BYTES = 120;
export const MAX_CHART_MEMBERS = 32;
export const CHORES_FORBIDDEN = "Only Adults can set chore points and rewards.";
export const JOIN_FORBIDDEN = "Adults can join the chore chart only when a household admin allows it.";

export class ChoreFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChoreFormatError";
  }
}

const idBytes = (value, what) => {
  if (value instanceof Uint8Array && value.length === 16 && value.some(Boolean)) return value;
  if (typeof value !== "string" || !HEX_ID.test(value) || /^0+$/.test(value)) throw new ChoreFormatError(`Kin received an invalid ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
};
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Whether a member may send `type`: points and rewards are for Adults
 * (a device with no server membership is its own Adult; pass "adult");
 * joining or leaving is for an Adult, and joining only while a household
 * admin allows adults on the chart. Leaving is always possible. */
export function canSendChoreCommand(type, { memberKind, adultsAllowed = false, joined = false } = {}) {
  if (memberKind !== "adult") return false;
  if (type === "set-chore-chart-joined") return joined ? true : adultsAllowed === true;
  return CHORE_COMMANDS.includes(type);
}

/** A reward text as Rust stores it: trimmed, 1–120 UTF-8 bytes, no control
 * characters. */
export function normalizeRewardText(text) {
  const value = String(text ?? "").replace(EDGE_SPACE, "");
  if (!value) throw new ChoreFormatError("Write what the reward is.");
  if (encoder.encode(value).length > MAX_REWARD_TEXT_BYTES) throw new ChoreFormatError("The reward is too long. Keep it short, like “Movie night”.");
  if (CONTROL.test(value)) throw new ChoreFormatError("The reward can only hold plain text on one line.");
  return value;
}

/** The canonical kind 77–79 payload for a command. */
export function encodeChorePayload(command) {
  switch (command?.type) {
    case "set-chore-points": {
      const points = command.points;
      if (!Number.isInteger(points) || points < 0 || points > MAX_CHORE_POINTS) throw new ChoreFormatError(`Points are 0 to ${MAX_CHORE_POINTS}.`);
      const out = new Uint8Array(20);
      out.set(idBytes(command.routineId, "routine"), 0);
      out[16] = points;
      return out;
    }
    case "set-chore-reward": {
      const goal = command.goal;
      if (!Number.isInteger(goal) || goal < 0 || goal > MAX_REWARD_GOAL) throw new ChoreFormatError(`A goal is 1 to ${MAX_REWARD_GOAL} points.`);
      const text = goal === 0 ? new Uint8Array(0) : encoder.encode(normalizeRewardText(command.text));
      if (goal === 0 && String(command.text ?? "").replace(EDGE_SPACE, "")) throw new ChoreFormatError("A reward needs a goal of at least 1 point.");
      const out = new Uint8Array(22 + text.length);
      const view = new DataView(out.buffer);
      out.set(idBytes(command.memberId, "member"), 0);
      view.setUint16(16, goal, true);
      view.setUint16(20, text.length, true);
      out.set(text, 22);
      return out;
    }
    case "set-chore-chart-joined": {
      if (typeof command.joined !== "boolean") throw new ChoreFormatError("Kin received an invalid chore chart change.");
      const out = new Uint8Array(20);
      out.set(idBytes(command.memberId, "member"), 0);
      out[16] = command.joined ? 1 : 0;
      return out;
    }
    default:
      throw new ChoreFormatError("Kin received an invalid chore chart change.");
  }
}

/** A KCMD packet for a chore command: the 128-byte header (identity and
 * logical time as for every command) with the payload as its text. */
export function encodeChoreIntent(command, identity) {
  const index = CHORE_COMMANDS.indexOf(command?.type);
  if (index < 0) throw new ChoreFormatError("Kin received an invalid chore chart change.");
  const payload = encodeChorePayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, FIRST_CHORE_KIND + index, true);
  packet.set(idBytes(identity.eventId, "event"), 12);
  packet.set(idBytes(identity.householdId, "household"), 28);
  packet.set(idBytes(identity.actorId, "member"), 44);
  packet.set(idBytes(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new ChoreFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new ChoreFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

const civil = (date) => date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();

/** The week (Monday to Sunday) holding civil date `today` in this device's
 * time zone: `{ start, bounds }`, the Monday and the eight instants (ms) that
 * start each day and the next Monday. Local midnights, so a week across a
 * daylight saving change has a 23- or 25-hour day. */
export function choreWeek(today) {
  const year = Math.floor(today / 10000), month = Math.floor(today / 100) % 100, day = today % 100;
  const offset = (new Date(year, month - 1, day).getDay() + 6) % 7;
  const bounds = Array.from({ length: 8 }, (_, index) => new Date(year, month - 1, day - offset + index).getTime());
  return { start: civil(new Date(year, month - 1, day - offset)), bounds };
}

/** KCCQ v1: { start, bounds, adultsAllowed, members: [{ memberId, kind:
 * "child" | "adult" }] }, members in join order. */
export function encodeChartQuery({ start, bounds, adultsAllowed = false, members = [] }) {
  if (!Number.isInteger(start) || !Array.isArray(bounds) || bounds.length !== 8 || !bounds.every(Number.isSafeInteger))
    throw new ChoreFormatError("Kin received an invalid week.");
  if (!Array.isArray(members) || members.length > MAX_CHART_MEMBERS) throw new ChoreFormatError("Kin received too many people for the chore chart.");
  const out = new Uint8Array(84 + members.length * 20);
  const view = new DataView(out.buffer);
  out.set(encoder.encode("KCCQ"));
  view.setUint16(4, 1, true);
  view.setUint32(8, start, true);
  out[12] = adultsAllowed ? 1 : 0;
  bounds.forEach((bound, index) => view.setBigInt64(16 + index * 8, BigInt(bound), true));
  view.setUint16(80, members.length, true);
  members.forEach((member, index) => {
    const at = 84 + index * 20;
    out.set(idBytes(member.memberId, "member"), at);
    out[at + 16] = member.kind === "adult" ? 2 : member.kind === "child" ? 1 : 0;
    if (!out[at + 16]) throw new ChoreFormatError("Kin received an invalid member for the chore chart.");
  });
  return out;
}

/** KCCD v1 as { start, today, routinesPaused, points: Map(routineId ->
 * points), members: [{ memberId, adult, points, reward: { goal, text } |
 * null, chores: [{ kind: "item" | "routine", id, date, occurrenceKey, done,
 * today, points }] }] }. */
export function decodeChoreChart(bytes) {
  const invalid = () => new ChoreFormatError("Kin received an invalid chore chart.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(0, 4)) !== "KCCD" || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw invalid();
  const start = view.getUint32(8, true), today = view.getUint32(12, true);
  if (bytes[16] > 1 || bytes[17] || bytes[18] || bytes[19]) throw invalid();
  const memberCount = view.getUint16(20, true), settingCount = view.getUint16(22, true);
  if (memberCount > MAX_CHART_MEMBERS) throw invalid();
  let at = 24;
  const need = (length) => { if (at + length > bytes.length) throw invalid(); };
  const points = new Map();
  for (let index = 0; index < settingCount; index += 1, at += 20) {
    need(20);
    const id = toHex(bytes.subarray(at, at + 16));
    if (bytes[at + 16] > MAX_CHORE_POINTS || bytes[at + 17] || bytes[at + 18] || bytes[at + 19] || points.has(id)) throw invalid();
    points.set(id, bytes[at + 16]);
  }
  const members = [];
  for (let index = 0; index < memberCount; index += 1) {
    need(26);
    const memberId = toHex(bytes.subarray(at, at + 16));
    const flags = bytes[at + 16];
    if (flags > 3 || bytes[at + 17] || /^0+$/.test(memberId)) throw invalid();
    const total = view.getUint16(at + 18, true), goal = view.getUint16(at + 20, true), count = view.getUint16(at + 22, true);
    const textLength = view.getUint16(at + 24, true);
    at += 26;
    need(textLength);
    let text;
    try { text = decoder.decode(bytes.subarray(at, at + textLength)); } catch { throw invalid(); }
    at += textLength;
    const rewarded = (flags & 2) !== 0;
    if (rewarded !== goal > 0 || (!rewarded && textLength)) throw invalid();
    const chores = [];
    for (let chore = 0; chore < count; chore += 1, at += 28) {
      need(28);
      const kind = bytes[at] === 1 ? "item" : bytes[at] === 2 ? "routine" : null;
      const choreFlags = bytes[at + 1];
      if (!kind || choreFlags > 3 || bytes[at + 2] > MAX_CHORE_POINTS || bytes[at + 3]) throw invalid();
      const occurrenceKey = view.getUint32(at + 24, true);
      if ((kind === "item") !== (occurrenceKey === 0)) throw invalid();
      chores.push({
        kind, id: toHex(bytes.subarray(at + 4, at + 20)), date: view.getUint32(at + 20, true),
        occurrenceKey: kind === "routine" ? occurrenceKey : null,
        done: (choreFlags & 1) !== 0, today: (choreFlags & 2) !== 0, points: bytes[at + 2],
      });
    }
    members.push({ memberId, adult: (flags & 1) !== 0, points: total, reward: rewarded ? { goal, text } : null, chores });
  }
  if (at !== bytes.length) throw invalid();
  return { start, today, routinesPaused: bytes[16] === 1, points, members };
}

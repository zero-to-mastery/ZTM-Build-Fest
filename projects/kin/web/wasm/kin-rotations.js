// Taking turns on routines (#429, ADR 0016) codecs, matching
// rust/src/rotations.rs:
// - "set-routine-rotation" (KCMD action 68, ROUTINE_ROTATION_SET):
//   { routineId, memberIds: [hex] (2–12 distinct, or [] to end the
//   rotation), currentIndex }. Payload: routine ID [16], member count u8,
//   current index u8, reserved u16, then each member ID [16].
// - "set-routine-turn" (KCMD action 69, ROUTINE_TURN_SET): { routineId,
//   memberId } — Skip to next, Swap with… Payload: routine ID [16], member ID
//   [16].
// - KRRS v1: [{ routineId, memberIds, current, next }] for each routine that
//   exists, isn't archived and rotates, in routine-ID order.
//
// Rust decides whether a change applies (the routine exists and isn't
// archived, something changes, the member is listed). Rust counts every
// listed member as taking turns: membership lives with the service, so the
// host passes over members who aren't active when it shows the turn
// (`turnAmong`) and, when the current member isn't active, writes a
// "set-routine-turn" to the next active member. Nothing here counts turns.
const HEX_ID = /^[a-f0-9]{32}$/;

export const ROTATION_COMMANDS = Object.freeze(["set-routine-rotation", "set-routine-turn"]);
export const ROTATION_EVENT_KINDS = Object.freeze(["ROUTINE_ROTATION_SET", "ROUTINE_TURN_SET"]);
export const ROUTINE_ROTATION_KIND = 68;
export const ROUTINE_TURN_KIND = 69;
export const MIN_ROTATION_MEMBERS = 2;
export const MAX_ROTATION_MEMBERS = 12;

export class RotationFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "RotationFormatError";
  }
}

const idBytes = (value, what) => {
  if (value instanceof Uint8Array && value.length === 16 && value.some(Boolean)) return value;
  if (typeof value !== "string" || !HEX_ID.test(value) || /^0+$/.test(value)) throw new RotationFormatError(`Kin received an invalid ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
};
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The canonical kind-68 payload for { routineId, memberIds, currentIndex }. */
export function encodeRotationPayload({ routineId, memberIds, currentIndex = 0 }) {
  if (!Array.isArray(memberIds)) throw new RotationFormatError("Kin received an invalid rotation.");
  const count = memberIds.length;
  if (count !== 0 && (count < MIN_ROTATION_MEMBERS || count > MAX_ROTATION_MEMBERS))
    throw new RotationFormatError(`Taking turns needs ${MIN_ROTATION_MEMBERS} to ${MAX_ROTATION_MEMBERS} people.`);
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || (count ? currentIndex >= count : currentIndex !== 0))
    throw new RotationFormatError("Kin received an invalid turn.");
  const members = memberIds.map((id) => idBytes(id, "member"));
  if (new Set(members.map(toHex)).size !== count) throw new RotationFormatError("Each person takes turns once.");
  const out = new Uint8Array(20 + 16 * count);
  out.set(idBytes(routineId, "routine"), 0);
  out[16] = count;
  out[17] = currentIndex;
  members.forEach((member, index) => out.set(member, 20 + 16 * index));
  return out;
}

/** The canonical kind-69 payload for { routineId, memberId }. */
export function encodeTurnPayload({ routineId, memberId }) {
  const out = new Uint8Array(32);
  out.set(idBytes(routineId, "routine"), 0);
  out.set(idBytes(memberId, "member"), 16);
  return out;
}

/** A KCMD packet for a rotation command: the 128-byte header (identity and
 * logical time as for every command) with the payload as its text. */
export function encodeRotationIntent(command, identity) {
  const kind = command?.type === "set-routine-rotation" ? ROUTINE_ROTATION_KIND
    : command?.type === "set-routine-turn" ? ROUTINE_TURN_KIND : 0;
  if (!kind) throw new RotationFormatError("Kin received an invalid turn change.");
  const payload = kind === ROUTINE_ROTATION_KIND ? encodeRotationPayload(command) : encodeTurnPayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, kind, true);
  packet.set(idBytes(identity.eventId, "event"), 12);
  packet.set(idBytes(identity.householdId, "household"), 28);
  packet.set(idBytes(identity.actorId, "member"), 44);
  packet.set(idBytes(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new RotationFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new RotationFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/** KRRS v1 as [{ routineId, memberIds, current, next }]: the members in
 * turn order, whose turn it is and who is next, every listed member counted
 * (see `turnAmong`). */
export function decodeRoutineRotations(bytes) {
  const invalid = () => new RotationFormatError("Kin received invalid turns.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (count) => { if (at + count > bytes.length) throw invalid(); };
  const id = () => { need(16); const value = toHex(bytes.subarray(at, at + 16)); at += 16; return value; };
  need(12);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "KRRS" || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw invalid();
  const count = view.getUint32(8, true);
  at = 12;
  const rotations = [];
  let previous = "";
  for (let index = 0; index < count; index += 1) {
    const routineId = id();
    need(4);
    const [members, current, next, reserved] = bytes.subarray(at, at + 4);
    at += 4;
    if (routineId <= previous || members < MIN_ROTATION_MEMBERS || members > MAX_ROTATION_MEMBERS ||
        current >= members || next !== (current + 1) % members || reserved !== 0) throw invalid();
    previous = routineId;
    const memberIds = Array.from({ length: members }, id);
    if (new Set(memberIds).size !== members || memberIds.some((member) => /^0+$/.test(member))) throw invalid();
    rotations.push({ routineId, memberIds, current: memberIds[current], next: memberIds[next] });
  }
  if (at !== bytes.length) throw invalid();
  return rotations;
}

/** Whose turn it is and who is next among the members who are active
 * (ADR 0016): members not in `activeMemberIds` are passed over, starting
 * from Rust's current member; with fewer than two active, nobody's turn
 * ({ current: null, next: null }). `activeMemberIds` null means membership
 * isn't known (offline, no sync): everyone listed takes turns. */
export function turnAmong(rotation, activeMemberIds = null) {
  const { memberIds, current } = rotation;
  const active = activeMemberIds ? new Set(activeMemberIds) : null;
  const taking = (id) => !active || active.has(id);
  if (memberIds.filter(taking).length < MIN_ROTATION_MEMBERS) return { current: null, next: null };
  const start = memberIds.indexOf(current);
  const after = (from) => {
    for (let step = 1; step <= memberIds.length; step += 1) {
      const id = memberIds[(from + step) % memberIds.length];
      if (taking(id)) return id;
    }
    return null;
  };
  const shown = taking(current) ? current : after(start);
  return { current: shown, next: after(memberIds.indexOf(shown)) };
}

// Node's single-executable "fuse" (ADR 0025 §10, #714). Every official node
// binary contains the sentinel string below followed by ":0". Node looks
// for its SEA blob only when that byte reads "1", so injection flips it.
// The sentinel must appear exactly once; anything else means this is not a
// node binary Kin knows how to turn into an executable.

export const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export class FuseError extends Error {
  constructor(message) {
    super(message);
    this.name = "FuseError";
  }
}

/** The offset of the fuse's state byte ("0" or "1"). */
export function fuseOffset(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const needle = Buffer.from(`${SEA_FUSE}:`, "latin1");
  const at = buffer.indexOf(needle);
  if (at < 0) throw new FuseError("The SEA fuse isn't in this binary; it isn't a node binary that supports single executable applications.");
  if (buffer.indexOf(needle, at + 1) >= 0) throw new FuseError("The SEA fuse appears more than once in this binary.");
  return at + needle.length;
}

/** Whether the fuse is already flipped. */
export function fuseFlipped(bytes) {
  const state = bytes[fuseOffset(bytes)];
  if (state === 0x31) return true;
  if (state === 0x30) return false;
  throw new FuseError("The SEA fuse has an unexpected value.");
}

/** Flips the fuse in place. Refuses a binary whose fuse is already flipped. */
export function flipFuse(bytes) {
  const at = fuseOffset(bytes);
  if (bytes[at] === 0x31) throw new FuseError("The SEA fuse is already flipped. Start from an unmodified node binary.");
  if (bytes[at] !== 0x30) throw new FuseError("The SEA fuse has an unexpected value.");
  bytes[at] = 0x31;
  return bytes;
}

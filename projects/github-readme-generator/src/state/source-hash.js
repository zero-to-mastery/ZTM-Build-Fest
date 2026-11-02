// Deterministic, non-cryptographic fingerprint of exact source bytes. Used to
// notice local edits, never as a security or integrity boundary.
export function sourceHash(source) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(source)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

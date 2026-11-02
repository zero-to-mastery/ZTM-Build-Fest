// For tests of clean-ups that must outlast Windows holding a file for a
// moment (#785): a service that just stopped, or an antivirus scan, keeps a
// file open without sharing, and deleting it fails with EPERM or EBUSY until
// it lets go.
import assert from "node:assert/strict";
import { closeSync, openSync, unlinkSync } from "node:fs";

// libuv's UV_FS_O_EXLOCK: open with no sharing at all. Node doesn't list it
// in fs.constants, but passes it through on Windows.
const EXCLUSIVE = 0x10000000;

/**
 * Holds `file` open as another program would on Windows, and lets go after
 * `ms`. Resolves once it has let go. Elsewhere an open file can still be
 * deleted, so the clean-up under test just succeeds at once.
 */
export function holdFor(file, ms) {
  const windows = process.platform === "win32";
  const descriptor = openSync(file, windows ? EXCLUSIVE : "r");
  // The hold is real: without retries the file can't be deleted.
  if (windows) assert.throws(() => unlinkSync(file), { code: /^(EPERM|EBUSY)$/ });
  return new Promise((resolve) => setTimeout(() => { closeSync(descriptor); resolve(); }, ms));
}

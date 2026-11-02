import { rmSync } from "node:fs";

/**
 * Remove a temporary folder a spec made, at the end of the spec. On Windows a server that just
 * exited, a virus scanner or the search indexer can hold a handle in the folder for a moment, so
 * the removal is retried, and a folder that still cannot be removed is reported, not failed: a
 * leftover temporary folder is not a failure of the feature under test.
 */
export function removeTree(path) {
  if (!path) return;
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`Could not remove the temporary folder ${path}: ${error.code || error.message}`);
  }
}

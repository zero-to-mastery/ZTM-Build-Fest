import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DurableStoreError } from "./durable-store.mjs";

export const webRoot = resolve(import.meta.dirname, "..", "web");

export function isInsideRoot(candidate, root) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
  );
}

// Resolve the nearest existing ancestor, including when several parent
// directories have yet to be created. Never guess through a dangling symlink.
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (
      error.code !== "ENOENT" ||
      lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ||
      dirname(path) === path
    )
      throw error;
    return resolve(canonicalPath(dirname(path)), basename(path));
  }
}

export function resolveDurablePath(path) {
  const candidate = resolve(path);
  const canonical = canonicalPath(candidate);
  if (
    isInsideRoot(candidate, webRoot) ||
    isInsideRoot(canonical, realpathSync(webRoot))
  )
    throw new DurableStoreError(
      "Kin database files and backups must be outside the static web root.",
    );
  // Use the same canonical spelling for the database and its adjacent locks.
  return canonical;
}

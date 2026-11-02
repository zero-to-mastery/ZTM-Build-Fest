// Where the injector tests find official node binaries for the targets this
// machine can't run (#747, #748). They aren't downloaded by the tests (no
// network in the verification gates): `node scripts/build-sea.mjs` caches
// them in target/sea/node after checking them against SHASUMS256.txt, and
// KIN_SEA_NODE_DIR can point at another folder holding files named the same
// way (node-v<version>-<target>[.exe]). Tests that need one skip without it;
// the CI job home-executables runs them after its build has filled the cache.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "./node-release.mjs";

const DEFAULT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "target", "sea", "node");

/** Paths of the cached official node binaries for `target`, newest name
 * last; empty when there are none. */
export function officialBinaries(target, directory = process.env.KIN_SEA_NODE_DIR || DEFAULT_DIRECTORY) {
  if (!existsSync(directory)) return [];
  const suffix = TARGETS[target].suffix;
  const pattern = new RegExp(`^node-v\\d+\\.\\d+\\.\\d+-${target}${suffix.replace(".", "\\.")}$`);
  return readdirSync(directory).filter((name) => pattern.test(name)).sort().map((name) => join(directory, name));
}

// Every browser and server script parses. A module no unit test imports (an
// app controller, say) can otherwise ship a syntax error that only the full
// browser run notices.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function scripts(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...scripts(path));
    else if (/\.(m?js)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("every web, server and relay script parses", () => {
  const files = [...scripts(join(root, "web")), ...scripts(join(root, "server")), ...scripts(join(root, "relay"))];
  assert.ok(files.length > 100, "found the scripts");
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) failures.push(`${file.slice(root.length + 1)}: ${result.stderr.split("\n").find((line) => /Error/.test(line)) ?? "does not parse"}`);
  }
  assert.deepEqual(failures, []);
});

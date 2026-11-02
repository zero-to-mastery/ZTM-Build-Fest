// The repository-root workflow is the one GitHub runs; this project keeps a
// reference copy (docs/ci). They must not drift apart (#326).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const projectCopy = new URL("../docs/ci/kin-verification.workflow.yml", import.meta.url);
const activeCopy = new URL("../../../.github/workflows/kin-verification.yml", import.meta.url);

test("the active Kin workflow matches its reference copy", async (t) => {
  let active;
  // Compared as LF: a Windows checkout may give either copy CRLF endings.
  try { active = (await readFile(activeCopy, "utf8")).replace(/\r\n/g, "\n"); } catch {
    t.skip("not inside the parent repository");
    return;
  }
  const reference = (await readFile(projectCopy, "utf8")).replace(/\r\n/g, "\n").split("\n");
  // The reference copy starts with a three-line note saying what it is.
  assert.match(reference[0], /^# Reference copy/);
  assert.equal(active, reference.slice(3).join("\n"));
});

test("every third-party action is pinned to a full commit", async () => {
  const workflow = await readFile(projectCopy, "utf8");
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  // owner/repo, or owner/repo/path for an action in a subdirectory (such as
  // gradle/actions/setup-gradle), always at a full commit.
  for (const action of uses) assert.match(action, /^[\w.-]+\/[\w.-]+(\/[\w.-]+)*@[0-9a-f]{40}$/, `${action} is pinned by commit`);
});

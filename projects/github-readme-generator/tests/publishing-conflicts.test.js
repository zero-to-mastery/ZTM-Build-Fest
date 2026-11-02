import { it, expect } from "vitest";
import { mergeThreeWay, resolveMerge } from "../src/publishing/conflicts.js";
import {
  savePublishCheckpoint,
  readPublishingHistory,
  recordPublish,
} from "../src/publishing/history.js";
it("merges independent section changes without normalizing CRLF or Unicode", () => {
  const base =
    "# Profile\r\n\r\n## Projects\r\nOld\r\n\r\n## Writing\r\nOld\r\n";
  const local = base.replace("Projects\r\nOld", "Projects\r\n🦀"),
    remote = base.replace("Writing\r\nOld", "Writing\r\nNew");
  expect(resolveMerge(mergeThreeWay(base, local, remote), {})).toBe(
    local.replace("Writing\r\nOld", "Writing\r\nNew"),
  );
});
it("requires every conflict decision and preserves manual text exactly", () => {
  const parts = mergeThreeWay(
    "## About\nBase",
    "## About\nLocal",
    "## About\nRemote",
  );
  expect(() => resolveMerge(parts, {})).toThrow("every conflict");
  expect(resolveMerge(parts, { 0: { choice: "remote" } })).toBe(
    "## About\nRemote",
  );
  expect(resolveMerge(parts, { 0: { choice: "local" } })).toBe(
    "## About\nLocal",
  );
  expect(
    resolveMerge(parts, { 0: { choice: "manual", content: "custom\r\n🦀" } }),
  ).toBe("custom\r\n🦀");
  expect(resolveMerge(parts, { 0: { choice: "combine" } })).toContain(
    "Local\n\n## About\nRemote",
  );
});
it("treats reorders, duplicate headings and changed structures conservatively", () => {
  const base = "## A\none\n## B\ntwo";
  expect(
    mergeThreeWay(base, "## B\ntwo\n## A\none", base + "\nremote")[0].conflict,
  ).toBe(true);
  expect(
    mergeThreeWay("## A\n1\n## A\n2", "## A\nx", "## A\ny")[0].conflict,
  ).toBe(true);
});
it("whitelists history and retains a source recovery checkpoint without credentials", () => {
  const values = new Map(),
    storage = {
      getItem: (k) => values.get(k) || null,
      setItem: (k, v) => values.set(k, v),
    };
  savePublishCheckpoint("draft-1", "# exact\r\n", storage);
  recordPublish(
    {
      repository: "octocat/octocat",
      branch: "main",
      path: "README.md",
      commitSha: "a".repeat(40),
      token: "DO_NOT_STORE",
    },
    "b".repeat(40),
    storage,
  );
  const state = readPublishingHistory(storage);
  expect(state.checkpoint.source).toBe("# exact\r\n");
  expect(state.entries).toHaveLength(1);
  expect(JSON.stringify(state)).not.toContain("DO_NOT_STORE");
});
it("preserves corrupt storage and refuses an unsaved pre-write checkpoint", () => {
  let writes = 0;
  const storage = { getItem: () => "{broken", setItem: () => writes++ };
  expect(() => savePublishCheckpoint("id", "source", storage)).toThrow();
  expect(writes).toBe(0);
  expect(() =>
    savePublishCheckpoint("id", "source", {
      getItem: () => null,
      setItem: () => {
        throw Error("quota");
      },
    }),
  ).toThrow("could not be saved");
});
it("cleans persisted history records and refuses malformed targets without writing", () => {
  const value = {
    version: 1,
    token: "secret",
    entries: [
      {
        repository: "example/readme",
        branch: "main",
        path: "README.md",
        commitSha: "a".repeat(40),
        timestamp: 1,
        token: "secret",
      },
    ],
    checkpoint: { draftId: "a", source: "# exact", token: "secret" },
  };
  const storage = {
    getItem: () => JSON.stringify(value),
    setItem: () => {
      throw Error("must not write");
    },
  };
  expect(JSON.stringify(readPublishingHistory(storage))).not.toContain(
    "secret",
  );
  value.entries[0].path = "../README.md";
  expect(() => readPublishingHistory(storage)).toThrow(/invalid target/);
});

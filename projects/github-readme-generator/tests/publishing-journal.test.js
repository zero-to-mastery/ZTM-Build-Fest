// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  clearPublishJournal,
  readPublishJournal,
  reconcilePublishJournal,
  startPublishJournal,
  updatePublishJournal,
} from "../src/publishing/journal.js";

const sha = (letter, length = 40) => letter.repeat(length);
const changeSet = {
  version: 1,
  id: sha("c", 64),
  target: { repository: "octocat/octocat", branch: "main" },
  baseCommitSha: sha("d"),
  entries: [
    {
      path: "assets/banner.svg",
      kind: "asset",
      action: "create",
      baseSha: null,
      resultSha: sha("a"),
      bytes: 12,
    },
    {
      path: "README.md",
      kind: "readme",
      action: "update",
      baseSha: sha("b"),
      resultSha: sha("e"),
      bytes: 8,
    },
  ],
};
const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
};

describe("machine-local publish journal", () => {
  it("saves a content-free plan before writes and treats an interrupted request as unknown", () => {
    const s = storage();
    startPublishJournal(changeSet, s, () => 10);
    updatePublishJournal(changeSet.id, "assets/banner.svg", "pending", {}, s);
    const raw = [...s.values.values()][0];
    expect(raw).not.toContain("<svg");
    expect(raw).not.toContain("content");
    expect(readPublishJournal(s)).toMatchObject({
      changeSetId: changeSet.id,
      target: changeSet.target,
      entries: [
        { path: "assets/banner.svg", status: "unknown" },
        { path: "README.md", status: "not-attempted" },
      ],
    });
  });

  it("reconciles Result SHA, Base SHA or absence, and divergent remote state", () => {
    const s = storage();
    const journal = startPublishJournal(changeSet, s, () => 10);
    const written = reconcilePublishJournal(journal, {
      "assets/banner.svg": { sha: sha("a"), commitSha: sha("1") },
      "README.md": { sha: sha("b"), commitSha: sha("2") },
    });
    expect(written.entries.map((entry) => entry.status)).toEqual([
      "written",
      "not-written",
    ]);
    expect(written.entries[0].commitSha).toBe(sha("1"));

    const absent = reconcilePublishJournal(journal, {
      "assets/banner.svg": { sha: null },
      "README.md": { sha: sha("x") },
    });
    expect(absent.entries.map((entry) => entry.status)).toEqual([
      "not-written",
      "diverged",
    ]);
  });

  it("preserves malformed data, blocks replacement, and clears only explicitly", () => {
    const s = storage();
    s.setItem("readme-studio-publish-journal-v1", '{"token":"keep me"}');
    expect(() => readPublishJournal(s)).toThrow("malformed");
    expect(() => startPublishJournal(changeSet, s)).toThrow("malformed");
    expect([...s.values.values()][0]).toContain("keep me");
    clearPublishJournal(s);
    expect(readPublishJournal(s)).toBeNull();
  });
  it("never overwrites an existing valid attempt with a blind retry", () => {
    const s = storage();
    const first = startPublishJournal(changeSet, s, () => 10);
    expect(() => startPublishJournal(changeSet, s, () => 20)).toThrow(
      "still unsettled",
    );
    expect(readPublishJournal(s)).toEqual(first);
  });
});

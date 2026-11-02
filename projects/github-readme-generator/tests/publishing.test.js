import { describe, it, expect } from "vitest";
import { target, writeInput } from "../src/publishing/validation.js";
import { publishDiff } from "../src/publishing/diff.js";
import { PublishingClient } from "../src/github/publishing-client.js";
const t = { repository: "octocat/octocat", branch: "main", path: "README.md" },
  reviewed = { resultSha: "d".repeat(40), changeSetId: "c".repeat(64) };
describe("publishing boundaries", () => {
  it("requires exact confirmed target, source, SHA, Result SHA, id and message", () => {
    const input = writeInput({
      ...t,
      ...reviewed,
      sha: null,
      content: "🧑‍💻\r\n",
      message: " My update ",
      confirmed: true,
    });
    expect(input.content).toBe("🧑‍💻\r\n");
    expect(input).toMatchObject({ ...reviewed, message: "My update" });
    for (const changed of [
      { confirmed: false },
      { sha: "not-sha" },
      { sha: undefined },
      { message: "" },
      { content: "x".repeat(750001) },
      { resultSha: undefined },
      { resultSha: "D".repeat(40) },
      { resultSha: "d".repeat(64) },
      { changeSetId: undefined },
      { changeSetId: "c".repeat(40) },
    ])
      expect(() =>
        writeInput({
          ...t,
          ...reviewed,
          sha: null,
          content: "text",
          message: "update",
          confirmed: true,
          ...changed,
        }),
      ).toThrow();
  });
  it("rejects traversal, special branches, credentials and non-README paths", () => {
    for (const path of [
      "../README.md",
      "/README.md",
      ".env",
      ".github/workflows/test.yml",
      "a/../../README.md",
      "a\\README.md",
      "a/%2e%2e/README.md",
    ])
      expect(() => target({ ...t, path })).toThrow();
    for (const branch of [
      "../main",
      "a..b",
      "refs/@{x}",
      "- bad",
      "a.lock",
      "a//b",
    ])
      expect(() => target({ ...t, branch })).toThrow();
    expect(() =>
      target({ ...t, repository: "https://user:token@github.com/x/y" }),
    ).toThrow();
  });
  it("preserves exact source and handles a large linear-size diff", () => {
    const before = "# Hi\r\n" + "a\n".repeat(125000),
      after = before + "🦀";
    const result = publishDiff(before, after);
    expect(result.text).toContain("+🦀");
    expect(result.added).toBe(1);
    expect(publishDiff(before, before).text).toBe("No source changes.");
  });
});
describe("publishing client write outcomes", () => {
  it("marks a lost commit response ambiguous but an offline refusal definitive", async () => {
    const lost = new PublishingClient({
      fetchImpl: async () => {
        throw new Error("lost");
      },
      online: () => true,
    });
    await expect(lost.request("commit", {})).rejects.toMatchObject({
      ambiguous: true,
    });
    const offline = new PublishingClient({ online: () => false });
    await expect(offline.request("commit", {})).rejects.not.toMatchObject({
      ambiguous: true,
    });
  });
});

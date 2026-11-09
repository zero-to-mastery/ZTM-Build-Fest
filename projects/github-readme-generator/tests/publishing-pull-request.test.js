import { describe, expect, it } from "vitest";
import {
  PULL_REQUEST_JOURNAL_KEY,
  clearPullRequestJournal,
  completePullRequestJournal,
  pullRequestInput,
  readPullRequestJournal,
  startPullRequestJournal,
} from "../src/publishing/pull-request.js";

const sha = "a".repeat(40);
const input = {
  repository: "octocat/octocat",
  head: "docs/readme",
  base: "main",
  headSha: sha,
  baseSha: "b".repeat(40),
  title: " Improve README ",
  body: "Reviewed locally.",
  confirmed: true,
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

describe("pull request review input", () => {
  it("normalizes an exact same-repository draft request", () => {
    expect(pullRequestInput(input)).toEqual({
      ...input,
      title: "Improve README",
    });
  });

  it.each([
    [{ ...input, head: "main" }, "different head"],
    [{ ...input, headSha: "no" }, "exact head"],
    [{ ...input, title: "" }, "title"],
    [{ ...input, confirmed: false }, "confirm"],
  ])("refuses invalid or unconfirmed input", (value, message) => {
    expect(() => pullRequestInput(value)).toThrow(message);
  });
});

describe("pull request recovery journal", () => {
  it("stores metadata but no PR body or credentials", () => {
    const s = storage();
    const journal = startPullRequestJournal(input, s, () => 123);
    expect(journal).toMatchObject({ status: "unknown", bodyBytes: 17 });
    expect(s.values.get(PULL_REQUEST_JOURNAL_KEY)).not.toContain(
      "Reviewed locally",
    );
    expect(() => startPullRequestJournal(input, s)).toThrow("unsettled");
  });

  it("records a reconciled result and can be cleared", () => {
    const s = storage();
    const journal = startPullRequestJournal(input, s, () => 123);
    const done = completePullRequestJournal(
      journal,
      { number: 42, url: "https://github.com/octocat/octocat/pull/42" },
      s,
    );
    expect(done).toMatchObject({ status: "created", number: 42 });
    expect(readPullRequestJournal(s)).toEqual(done);
    clearPullRequestJournal(s);
    expect(readPullRequestJournal(s)).toBeNull();
  });

  it("blocks on malformed recovery without overwriting it", () => {
    const s = storage();
    s.setItem(PULL_REQUEST_JOURNAL_KEY, '{"version":1}');
    expect(() => readPullRequestJournal(s)).toThrow("malformed");
    expect(s.values.get(PULL_REQUEST_JOURNAL_KEY)).toBe('{"version":1}');
  });
});

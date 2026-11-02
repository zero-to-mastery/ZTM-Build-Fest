import { describe, expect, it } from "vitest";
import { classifyReadme } from "../src/repository-audit/classify.js";
import {
  attentionItem,
  attentionQueue,
  filterAttention,
  readmeRevision,
} from "../src/repository-audit/attention.js";
import {
  ATTENTION_KEY,
  AttentionPreferences,
  validateAttention,
} from "../src/repository-audit/attention-storage.js";
const now = Date.parse("2026-09-28T12:00:00Z"),
  day = 86400000;
const prose =
  "This repository explores practical approaches to local data storage and documents the tradeoffs observed while comparing several implementations in a reproducible experiment.";
const record = (name, source = prose, extra = {}) => {
  const repo = {
    name,
    full_name: `example/${name}`,
    pushed_at: new Date(now - 3 * day).toISOString(),
    language: "Rust",
    topics: ["game"],
    stargazers_count: 0,
    forks_count: 0,
    ...extra,
  };
  return {
    repo,
    result: classifyReadme(source, repo),
    readme: { sha: "a".repeat(40) },
  };
};
const memory = (raw = null) => {
  let value = raw;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
};

describe("descriptive attention queue", () => {
  it("puts active thin documentation high with specific game evidence", () => {
    const item = attentionItem(record("swing-or-cast"), { now });
    expect(item.priority).toBe("high");
    expect(item.reasons.join(" ")).toContain(
      "Pushed 3 days ago; recently active",
    );
    expect(item.reasons.join(" ")).toContain("Minimal for a Game");
    expect(item.reasons.join(" ")).toContain(
      "Game controls not detected. Commonly useful for this project type.",
    );
    expect(item.reasons.join(" ")).toContain(
      "Build/run or setup instructions not detected",
    );
    expect(item).not.toHaveProperty("score");
  });
  it("uses medium for useful README with type gaps, low for archived/inactive", () => {
    const source =
      prose +
      "\n\n## Controls\n\nUse the arrow keys to move your character through the world and discover new areas.\n\n## Gameplay\n\nCollect items and finish each level to unlock the next stage of the story.";
    expect(attentionItem(record("basic", source), { now }).priority).toBe(
      "medium",
    );
    for (const extra of [
      { archived: true },
      { pushed_at: new Date(now - 181 * day).toISOString() },
    ]) {
      const item = attentionItem(
        record("old", null, {
          ...extra,
          stargazers_count: 10000,
          forks_count: 500,
          homepage: "https://example.org",
        }),
        { now },
      );
      expect(item.priority).toBe("low");
      expect(item.active).toBe(false);
      expect(item.reasons.join(" ")).toMatch(/Archived|180 days/);
    }
  });
  it("does not assume unknown/future activity or turn failures into missing READMEs", () => {
    for (const pushed_at of [
      "",
      "invalid",
      new Date(now + day).toISOString(),
    ]) {
      const item = attentionItem(record("unknown", null, { pushed_at }), {
        now,
      });
      expect(item.priority).toBe("medium");
      expect(item.days).toBe(null);
      expect(item.reasons.join(" ")).toContain("not assumed active");
    }
    expect(
      attentionItem(
        { repo: record("failed").repo, error: "Rate limited" },
        { now },
      ),
    ).toBe(null);
  });
  it("lists Audit finding messages, not finding objects, as reasons", () => {
    const rec = record("todo", `TODO ${prose}`, { topics: ["experiment"] });
    rec.review = {
      findings: [
        {
          id: "link:unavailable:fnv1a32:4eabad4e",
          message:
            "Link unavailable: https://example.org/old (HTTP 404/410 at check time).",
          url: "https://example.org/old",
        },
      ],
      notes: [],
    };
    const reasons = attentionItem(rec, { now }).reasons;
    expect(reasons).toContain(
      "Possible unresolved TODO in README prose; review whether it is intentional.",
    );
    expect(reasons).toContain(
      "Link unavailable: https://example.org/old (HTTP 404/410 at check time).",
    );
    expect(reasons.join(" ")).not.toContain("[object Object]");
  });
  it("omits appropriate short experiments and respects manual project types", () => {
    const rec = record("experiment", prose, { topics: ["experiment"] });
    expect(attentionItem(rec, { now })).toBe(null);
    const queue = attentionQueue([rec], {
      now,
      overrides: new Map([[rec.repo.full_name, "web-app"]]),
    });
    expect(queue[0].priority).toBe("high");
    expect(queue[0].gaps).toContain("configuration");
  });
  it("orders deterministically by tier, activity, state, interest, push age and name without popularity scores", () => {
    const records = [
      record("z"),
      record("a"),
      record("missing", null),
      record("popular", prose, { stargazers_count: 10 }),
      record("huge", prose, { stargazers_count: 100000 }),
      record("demo", prose, { homepage: "https://example.org" }),
      record("old", null, { archived: true }),
    ];
    const expected = ["missing", "demo", "huge", "popular", "a", "z", "old"];
    expect(attentionQueue(records, { now }).map((r) => r.repo.name)).toEqual(
      expected,
    );
    expect(
      attentionQueue([...records].reverse(), { now }).map((r) => r.repo.name),
    ).toEqual(expected);
    expect(attentionQueue(records, { now })).toEqual(
      attentionQueue(records, { now }),
    );
    expect(attentionQueue(records, { now })[1].reasons.join(" ")).toContain(
      "availability not verified",
    );
  });
  it("combines every filter and excludes missing evidence from date/star filters", () => {
    const items = attentionQueue(
      [
        record("missing", null, { stargazers_count: 5 }),
        record("old", prose, { archived: true, language: "Python" }),
        record("unknown", null, { pushed_at: "", stargazers_count: null }),
      ],
      { now },
    );
    expect(
      filterAttention(items, {
        priority: "high",
        active: true,
        missing: true,
        language: "Rust",
        type: "game",
        stars: 5,
        pushed: 30,
      }).map((r) => r.repo.name),
    ).toEqual(["missing"]);
    expect(
      filterAttention(items, {
        archived: "only",
        priority: "low",
        language: "Python",
      }).map((r) => r.repo.name),
    ).toEqual(["old"]);
    expect(filterAttention(items, { archived: "include" })).toHaveLength(3);
    expect(filterAttention(items, { stars: 6 })).toHaveLength(0);
    expect(filterAttention(items, { type: "cli" })).toHaveLength(0);
    expect(filterAttention(items, { pushed: 1 })).toHaveLength(0);
  });
  it("handles 1,000 assessments without modifying input source/metadata", () => {
    const records = Array.from({ length: 1000 }, (_, i) =>
      record(`repo-${String(i).padStart(4, "0")}`),
    );
    const before = JSON.stringify(records);
    expect(attentionQueue(records.reverse(), { now })).toHaveLength(1000);
    expect(JSON.stringify(records.reverse())).toBe(before);
  });
});

describe("revision-bound decisions", () => {
  it("suppresses intentionally minimal across reload until the README changes, not merely a repository push", () => {
    const storage = memory(),
      rec = record("small");
    new AttentionPreferences(() => storage).set(
      rec.repo.full_name,
      "minimal",
      readmeRevision(rec),
      now,
    );
    const preferences = new AttentionPreferences(() => storage).entries;
    const options = { now: now + 365 * day, preferences };
    const queue = attentionQueue([rec], options);
    expect(filterAttention(queue)).toHaveLength(0);
    expect(filterAttention(queue, { deferred: "only" })).toHaveLength(1);
    rec.repo.pushed_at = new Date(now + day).toISOString();
    expect(attentionQueue([rec], options)[0].suppressed).toContain(
      "Intentionally minimal",
    );
    rec.readme.sha = "b".repeat(40);
    expect(attentionQueue([rec], options)[0].suppressed).toBe("");
  });
  it("returns missing READMEs when one is created and expires ignore after seven days", () => {
    const storage = memory(),
      prefs = new AttentionPreferences(() => storage),
      rec = record("missing", null);
    prefs.set(rec.repo.full_name, "minimal", readmeRevision(rec), now);
    expect(
      attentionQueue([record("missing")], {
        now,
        preferences: prefs.entries,
      })[0].suppressed,
    ).toBe("");
    prefs.set(rec.repo.full_name, "ignore", readmeRevision(rec), now);
    expect(
      attentionQueue([rec], {
        now: now + 6 * day,
        preferences: prefs.entries,
      })[0].suppressed,
    ).toContain("Ignored until");
    expect(
      attentionQueue([rec], {
        now: now + 7 * day,
        preferences: prefs.entries,
      })[0].suppressed,
    ).toBe("");
    prefs.set(rec.repo.full_name, null, "", now);
    expect(prefs.entries).toEqual([]);
  });
  it("requires reliable revisions for permanent suppression and scopes decisions to owner/repository", () => {
    const rec = record("small"),
      storage = memory(),
      prefs = new AttentionPreferences(() => storage);
    rec.readme.sha = "";
    expect(() =>
      prefs.set(rec.repo.full_name, "minimal", readmeRevision(rec), now),
    ).toThrow("README revision");
    prefs.set("Example/small", "ignore", "", now);
    const another = record("small");
    another.repo.full_name = "another/small";
    expect(
      attentionQueue([another], { now, preferences: prefs.entries })[0]
        .suppressed,
    ).toBe("");
  });
  it.each([
    "broken",
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({
      version: 1,
      entries: [{ repository: "<script>", kind: "minimal" }],
    }),
  ])("preserves unreadable storage: %s", (raw) => {
    const storage = memory(raw),
      prefs = new AttentionPreferences(() => storage);
    expect(prefs.error).toContain("Original storage is untouched");
    expect(() => prefs.set("example/a", "ignore", "", now)).toThrow();
    expect(storage.getItem(ATTENTION_KEY)).toBe(raw);
    prefs.reset();
    expect(new AttentionPreferences(() => storage).entries).toEqual([]);
  });
  it("reports quota/unavailable storage without falsely applying decisions", () => {
    const prefs = new AttentionPreferences(() => ({
      getItem: () => null,
      setItem: () => {
        throw Error("quota");
      },
    }));
    expect(() => prefs.set("example/a", "ignore", "", now)).toThrow(
      "not applied",
    );
    expect(prefs.entries).toEqual([]);
    expect(
      new AttentionPreferences(() => {
        throw Error("unavailable");
      }).error,
    ).toContain("could not be read");
  });
  it("rejects duplicate identities and merges latest saved decisions", () => {
    const storage = memory(),
      first = new AttentionPreferences(() => storage),
      second = new AttentionPreferences(() => storage);
    first.set("example/a", "ignore", "", now);
    second.set("example/b", "ignore", "", now);
    expect(second.entries).toHaveLength(2);
    expect(() =>
      validateAttention({
        version: 1,
        entries: [second.entries[0], second.entries[0]],
      }),
    ).toThrow("Invalid attention entry");
  });
});

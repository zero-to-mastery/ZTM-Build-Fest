import { createGitHubAccess } from "../src/github-access.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultIntent,
  applyOutcome,
  recommendProjects,
  validateIntent,
  intentStore,
} from "../src/onboarding-model.mjs";
import { generateGuidedDesign } from "../src/onboarding-generator.mjs";
import { createPreviewData } from "../src/preview-data.mjs";

const repos = Array.from({ length: 12 }, (_, i) => ({
  name: `r${i}`,
  full_name: `alice/r${i}`,
  created_at: `${2010 + i}-01-01`,
  updated_at: "2026-01-01",
  languages: { Rust: 100 },
  topics: ["tools"],
  stargazers_count: i,
}));
test("outcome actions normalize only their promised state and preserve curated content", () => {
  const selected = ["alice/r1", "alice/r2"],
    roles = {
      "alice/r1": { role: "featured", priority: 1 },
      "alice/r2": { role: "historical", priority: 1 },
    },
    base = {
      ...defaultIntent(repos),
      projects: selected,
      projectShowcase: roles,
      languages: ["Rust"],
      topics: ["tools"],
      relationships: "languages",
      topology: "automatic",
      history: "history",
    };
  const map = applyOutcome(structuredClone(base), "project-map");
  assert.equal(map.topology, "later");
  assert.equal(map.history, "current");
  const focus = applyOutcome(structuredClone(base), "technical-focus");
  assert.equal(focus.topology, "automatic");
  assert.equal(focus.history, "current");
  const history = applyOutcome(structuredClone(base), "project-history");
  assert.equal(history.topology, "later");
  assert.equal(history.history, "history");
  const readme = applyOutcome(structuredClone(base), "readme");
  assert.equal(readme.topology, "later");
  assert.equal(readme.history, "current");
  assert.equal(readme.motion, "still");
  assert.equal(readme.vibe, "clean");
  for (const outcome of [map, focus, history, readme]) {
    assert.deepEqual(outcome.projects, selected);
    assert.deepEqual(outcome.projectShowcase, roles);
    assert.deepEqual(outcome.languages, ["Rust"]);
    assert.deepEqual(outcome.topics, ["tools"]);
    assert.equal(outcome.relationships, "languages");
  }
  const generated = generateGuidedDesign("alice", repos, readme, {
    seed: "readme-outcome",
    year: 2026,
  });
  assert.equal(generated.config.options.layout, "compact");
  assert.equal(generated.config.options.legend, false);
});
test("saved project selections resolve GitHub names case-insensitively", () => {
  for (const outcome of ["project-map", "technical-focus"]) {
    const intent = applyOutcome(
      {
        ...defaultIntent(repos),
        projects: ["ALICE/R1", "alice/R2"],
        projectShowcase: { "ALICE/R1": { role: "featured", priority: 1 } },
      },
      outcome,
    );
    const generated = generateGuidedDesign("alice", repos, intent, {
      seed: `case-${outcome}`,
      year: 2026,
    });
    assert.deepEqual(generated.config.options.includeRepos, [
      "alice/r1",
      "alice/r2",
    ]);
    assert.deepEqual(generated.config.options.projectShowcase, {
      "alice/r1": { role: "featured", priority: 1 },
    });
  }
  assert.throws(
    () =>
      generateGuidedDesign(
        "alice",
        repos,
        { ...defaultIntent(repos), projects: ["alice/deleted"] },
        { seed: "missing", year: 2026 },
      ),
    /Some selected projects are unavailable/,
  );
});
test("saved projects resolve by canonical owner/repository after reorder and duplicate labels", () => {
  const repos = [
    { full_name: "owner-a/api", name: "api", language: "Rust" },
    { full_name: "owner-b/api", name: "api", language: "JavaScript" },
    { full_name: "alice/site", name: "site", language: "HTML" },
  ];
  const answers = {
    ...defaultIntent(repos),
    projects: ["owner-a/api", "alice/site"],
  };
  const before = generateGuidedDesign("alice", repos, answers, { seed: "saved-identity", year: 2026 });
  const after = generateGuidedDesign("alice", [repos[2], repos[1], repos[0]], answers, { seed: "saved-identity", year: 2026 });
  assert.deepEqual(before.config.options.includeRepos, ["owner-a/api", "alice/site"]);
  assert.deepEqual(after.config.options.includeRepos, ["owner-a/api", "alice/site"]);
  assert.equal(after.config.options.includeRepos.includes("owner-b/api"), false);
});
test("guided generation is deterministic and preserves explicit constraints across seeds", () => {
  for (const history of ["current", "history", "3d", "surprise"])
    for (const activity of [
      "none",
      "orbit",
      "asteroids",
      "recent",
      "subtle",
      "surprise",
    ]) {
      const intent = {
        ...defaultIntent(repos),
        languages: ["Rust"],
        topics: ["tools"],
        history,
        activity,
        motion: "still",
      };
      const context = { seed: "fixture", year: 2026 };
      assert.deepEqual(
        generateGuidedDesign("alice", repos, intent, context),
        generateGuidedDesign("alice", repos, intent, context),
      );
      for (const seed of ["one", "two"]) {
        const {
          config: { options },
          history: resolved,
        } = generateGuidedDesign("alice", repos, intent, { ...context, seed });
        assert.deepEqual(options.includeRepos, intent.projects);
        assert.deepEqual(options.languages, ["Rust"]);
        assert.deepEqual(options.topics, ["tools"]);
        assert.equal(options.maxRepos, 12);
        assert.equal(options.animate, false);
        assert.equal(options.floatingAnimation.enabled, false);
        assert.equal(options.history.timeLapse.enabled, false);
        assert.equal(
          options.contributionOrbit.enabled,
          activity === "orbit" ||
            (activity === "surprise" && options.contributionOrbit.enabled),
        );
        if (history === "3d") {
          assert.equal(options.arrangement, "temporal-stack");
          assert.equal(options.temporalStack.yearStart, 2010);
        }
        if (resolved === "current")
          assert.notEqual(options.arrangement, "temporal-stack");
      }
    }
});
test("smart default generates a useful deterministic project map without terminology choices", () => {
  const intent = { ...defaultIntent(repos), topology: "later" };
  const context = { seed: "smart-alice", year: 2026 };
  const first = generateGuidedDesign("alice", repos, intent, context);
  const second = generateGuidedDesign("alice", repos, intent, context);
  assert.deepEqual(first, second);
  assert.deepEqual(first.config.options.includeRepos, intent.projects);
  assert.equal(first.config.options.nodeMode, "repositories");
  assert.equal(first.config.options.arrangement === "profile", false);
  assert.equal(first.activity, "none");
  assert.equal(first.config.options.animate, true);
});
test("clean guided output uses the existing compact README profile", () => {
  const intent = {
    ...defaultIntent(repos),
    topology: "later",
    vibe: "clean",
    motion: "still",
  };
  const result = generateGuidedDesign("alice", repos, intent, {
    seed: "readme-output",
    year: 2026,
  });
  assert.equal(result.config.options.layout, "compact");
  assert.equal(result.config.options.legend, false);
  assert.equal(result.config.options.animate, false);
});
test("recommendation is stable, multi-signal and honors private exclusions", () => {
  const pool = [
    {
      ...repos[0],
      full_name: "alice/active",
      description: "Useful",
      language: "Rust",
    },
    { ...repos[0], full_name: "alice/archive", archived: true, fork: true },
    { ...repos[11], private: true },
  ];
  assert.deepEqual(recommendProjects(pool), ["alice/active", "alice/archive"]);
  assert.deepEqual(
    recommendProjects([...pool].reverse()),
    recommendProjects(pool),
  );
});
test("unsupported history and unavailable activity safely compile to current, quiet designs", () => {
  const small = repos.slice(0, 2),
    intent = { ...defaultIntent(small), history: "3d", activity: "orbit" };
  const result = generateGuidedDesign("alice", small, intent, {
    seed: "quiet",
    year: 2026,
    activityAvailable: false,
  });
  assert.equal(result.history, "current");
  assert.equal(result.activity, "none");
  assert.equal(result.config.options.contributionOrbit.enabled, false);
});
test("skipping or clearing topics leaves selected projects visible", () => {
  for (const topics of [null, []]) {
    const result = generateGuidedDesign(
      "alice",
      repos,
      { ...defaultIntent(repos), topics, activity: "none" },
      { seed: "skip-topics", year: 2026 },
    );
    assert.equal(result.config.options.topics, null);
    assert.deepEqual(
      result.config.options.includeRepos,
      defaultIntent(repos).projects,
    );
  }
});
test("intent storage validates, isolates accounts, and tolerates unavailable storage", () => {
  const values = new Map(),
    store = intentStore({
      getItem: (key) => values.get(key),
      setItem: (key, value) => values.set(key, value),
    });
  const intent = defaultIntent(repos);
  store.save("Alice", intent);
  assert.deepEqual(store.read("alice"), intent);
  assert.equal(store.read("bob"), null);
  assert.equal(intentStore().save("alice", intent), false);
  assert.equal(intentStore().read("alice"), null);
  assert.throws(() => validateIntent({ ...intent, version: 2 }));
  assert.throws(() => validateIntent({ ...intent, projects: [] }));
});
test("explicit showcase roles persist and compile without assigning roles to suggestions", () => {
  const intent = defaultIntent(repos);
  assert.equal(intent.projectShowcase, undefined);
  const curated = validateIntent({
    ...intent,
    projectShowcase: { "alice/r0": { role: "featured", priority: 1 } },
  });
  const generated = generateGuidedDesign("alice", repos, curated, {
    seed: "curated",
    year: 2026,
  });
  assert.deepEqual(
    generated.config.options.projectShowcase,
    curated.projectShowcase,
  );
  assert.deepEqual(
    validateIntent({
      ...curated,
      projectShowcase: {
        "alice/not-selected": { role: "featured", priority: 1 },
      },
    }).projectShowcase,
    { "alice/not-selected": { role: "featured", priority: 1 } },
  );
  assert.throws(() =>
    validateIntent({
      ...curated,
      projectShowcase: { "alice/r0": { role: "featured", priority: 0 } },
    }),
  );
});
test("guided topology offers explicit emphasis without changing project roles", () => {
  const intent = validateIntent({
    ...defaultIntent(repos),
    topology: "systems",
    projectShowcase: { "alice/r0": { role: "featured", priority: 1 } },
  });
  const generated = generateGuidedDesign("alice", repos, intent, {
    seed: "topology",
    year: 2026,
  });
  assert.equal(generated.config.options.arrangement, "profile");
  assert.equal(generated.config.options.profileEmphasis, "systems");
  assert.deepEqual(
    generated.config.options.projectShowcase,
    intent.projectShowcase,
  );
  assert.equal(
    validateIntent({ ...intent, topology: "later" }).topology,
    "later",
  );
});
test("guided topology compiles from cached repository data without additional GitHub reads", async () => {
  const calls = [];
  const data = authenticatedPreviewData({
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json(
        url.includes("/repos?") ? repos : { login: "alice", type: "User" },
      );
    },
  });
  await data.load(
    "alice",
    { maxRepos: 100 },
    { activity: false, languages: false },
  );
  const existingReads = calls.length;
  const intent = { ...defaultIntent(repos), topology: "systems" };
  const generated = generateGuidedDesign("alice", repos, intent, {
    seed: "cached-topology",
    year: 2026,
  });
  assert.equal(generated.config.options.arrangement, "profile");
  assert.equal(calls.length, existingReads);
});
test("guided account load postpones optional activity and reuses cached repositories", async () => {
  const calls = [];
  const data = authenticatedPreviewData({
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json(
        url.includes("/events")
          ? []
          : url.includes("/repos?")
            ? repos
            : { login: "alice", type: "User" },
      );
    },
  });
  await data.load("alice", { maxRepos: 100 }, { activity: false });
  assert.equal(
    calls.some((url) => url.includes("/events")),
    false,
  );
  await data.loadActivity("alice");
  assert.equal(calls.filter((url) => url.includes("/events")).length, 1);
  await data.load("alice", { maxRepos: 100 }, { activity: false });
  assert.equal(calls.filter((url) => url.includes("/repos?")).length, 1);
});
test("guided entry loads metadata first and hydrates only chosen projects", async () => {
  const calls = [],
    metadata = repos.map(({ languages, ...repo }) => ({
      ...repo,
      language: "Rust",
    }));
  const data = authenticatedPreviewData({
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json(
        url.endsWith("/languages")
          ? { Rust: 100 }
          : url.includes("/repos?")
            ? metadata
            : { login: "alice", type: "User" },
      );
    },
  });
  await data.load(
    "alice",
    { maxRepos: 100 },
    { activity: false, languages: false },
  );
  assert.equal(
    calls.some((url) => url.endsWith("/languages")),
    false,
  );
  await data.load(
    "alice",
    { maxRepos: 1, includeRepos: ["alice/r0"] },
    { activity: false },
  );
  assert.deepEqual(
    calls.filter((url) => url.endsWith("/languages")),
    ["https://api.github.com/repos/alice/r0/languages"],
  );
  assert.equal(
    calls.some((url) => url.includes("/events")),
    false,
  );
});

function authenticatedPreviewData(options = {}) { return createPreviewData({ ...options, access: createGitHubAccess({ authenticated: true }) }); }

import { createGitHubAccess } from "../src/github-access.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewData, canRenderPreview } from "../src/preview-data.mjs";
import {
  randomizeMatchingDesign,
  randomizeDesign,
} from "../src/design-randomizer.mjs";
import {
  renderConstellation,
  selectRepositoryPool,
} from "../src/constellation.mjs";

test("randomization skips nonempty recipes that would retain an old empty preview awaiting language data", () => {
  const repos = Array.from({ length: 60 }, (_, i) => ({
    name: `repo-${i}`,
    full_name: `tester/repo-${i}`,
    language: "Rust",
    ...(i < 45 ? { languages: { Rust: 100 } } : {}),
    stargazers_count: 100 - i,
    topics: ["tools"],
    created_at: "2018-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }));
  const options = { referenceDate: "2026-09-27T00:00:00Z", maxRepos: 60 };
  assert.equal(selectRepositoryPool(repos, options).length, 60);
  assert.equal(canRenderPreview(repos, options), false);
  assert.equal(canRenderPreview(repos, { ...options, maxRepos: 45 }), true);
  assert.equal(canRenderPreview(repos, { ...options, minStars: 1000 }), false);
  let missingCode, readyCode;
  for (let i = 0; i < 300 && (!missingCode || !readyCode); i++) {
    const code = `v5:m000-y2026-f2018-ready-${i}`;
    const recipe = {
      ...randomizeDesign(code),
      referenceDate: options.referenceDate,
    };
    const pool = selectRepositoryPool(repos, recipe);
    if (pool.length && pool.some((repo) => !repo.languages))
      missingCode ??= code;
    if (canRenderPreview(repos, recipe)) readyCode ??= code;
  }
  assert.ok(missingCode && readyCode);
  const candidates = [missingCode, readyCode];
  const selected = randomizeMatchingDesign(
    () => candidates.shift(),
    (recipe) =>
      canRenderPreview(repos, {
        ...recipe,
        referenceDate: options.referenceDate,
      }),
  );
  assert.equal(selected.designCode, readyCode);
  assert.equal(candidates.length, 0);
  assert.match(renderConstellation("tester", repos, selected), /class="star"/);
});

function fixture() {
  const calls = [];
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  const repos = Array.from({ length: 8 }, (_, i) => ({
    name: `repo-${i}`,
    full_name: `octocat/repo-${i}`,
    stargazers_count: 8 - i,
  }));
  const fetchImpl = async (url) => {
    calls.push(url);
    if (/\/users\/[^/?]+$/.test(url))
      return {
        ok: true,
        json: async () => ({ login: "octocat", type: "User" }),
      };
    return {
      ok: true,
      json: async () =>
        url.includes("/events/public")
          ? []
          : url.includes("/users/")
            ? repos
            : { JavaScript: 100, CSS: 20 },
    };
  };
  return { calls, storage, fetchImpl };
}

test("customization, returning to an account, and tab reloads reuse the first snapshot", async () => {
  const f = fixture();
  let data = authenticatedPreviewData(f);
  const repos = await data.load("Octocat", { maxRepos: 5 });
  assert.equal(f.calls.length, 8);
  for (const maxRepos of [1, 3, 5]) {
    renderConstellation("octocat", repos, {
      maxRepos,
      css: ".star { opacity: .8; }",
      topics: [],
      theme: "auto",
    });
    assert.equal(
      selectRepositoryPool(data.snapshot("octocat"), { maxRepos }).length,
      maxRepos,
    );
  }
  await data.load("OCTOCAT", { maxRepos: 5 });
  data = authenticatedPreviewData(f);
  await data.load("octocat", { maxRepos: 5 });
  assert.equal(f.calls.length, 8);
  assert.equal(
    selectRepositoryPool(data.snapshot("octocat"), { maxRepos: 8 }).filter(
      (repo) => !repo.languages,
    ).length,
    3,
  );
  assert.equal(f.calls.length, 8, "changing the pool does not fetch");
  await data.load("octocat", { maxRepos: 8 });
  assert.equal(
    f.calls.length,
    11,
    "explicit load fetches only missing languages",
  );
  await data.load("octocat", { maxRepos: 5 }, { refresh: true });
  assert.equal(
    f.calls.length,
    19,
    "explicit refresh fetches a fresh list and selected languages",
  );
});

test("partial successes survive a failed load and a tab reload", async () => {
  const f = fixture();
  const original = f.fetchImpl;
  f.fetchImpl = async (url) => {
    if (url.includes("repo-1/languages")) {
      f.calls.push(url);
      return { ok: false, status: 429 };
    }
    return original(url);
  };
  const data = authenticatedPreviewData(f);
  await assert.rejects(data.load("octocat", { maxRepos: 5 }), /limit/);
  assert.ok(data.snapshot("octocat").some((repo) => repo.languages));
  const saved = data
    .snapshot("octocat")
    .filter((repo) => repo.languages).length;
  f.calls.length = 0;
  f.fetchImpl = original;
  await authenticatedPreviewData(f).load("octocat", { maxRepos: 5 });
  assert.equal(f.calls.length, 5 - saved);
  assert.ok(f.calls.every((url) => !url.includes("/users/")));
});

test("storage restrictions do not break in-memory caching and concurrent loads are shared", async () => {
  const f = fixture();
  f.storage = {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("quota");
    },
  };
  const data = authenticatedPreviewData(f);
  await Promise.all([
    data.load("octocat", { maxRepos: 5 }),
    data.load("octocat", { maxRepos: 5 }),
  ]);
  await data.load("octocat", { maxRepos: 5 });
  assert.equal(f.calls.length, 8);
});

test("a delayed earlier account load cannot overwrite an explicit refresh", async () => {
  let listCalls = 0,
    startOld,
    finishOld;
  const oldListStarted = new Promise((resolve) => {
    startOld = resolve;
  });
  const delayedOldList = new Promise((resolve) => {
    finishOld = resolve;
  });
  const response = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
  const fetchImpl = async (url) => {
    if (/\/users\/octocat$/.test(url))
      return response({ login: "octocat", type: "User" });
    if (url.includes("/users/octocat/repos")) {
      listCalls++;
      if (listCalls === 1) {
        startOld();
        return delayedOldList;
      }
      return response([
        {
          name: "fresh",
          full_name: "octocat/fresh",
          private: false,
          languages: { Rust: 1 },
        },
      ]);
    }
    throw Error(`Unexpected request ${url}`);
  };
  const data = authenticatedPreviewData({ fetchImpl });
  const earlier = data.load(
    "octocat",
    { maxRepos: 5 },
    { activity: false, languages: false },
  );
  await oldListStarted;
  const refreshed = await data.load(
    "octocat",
    { maxRepos: 5 },
    { refresh: true, activity: false, languages: false },
  );
  finishOld(
    response([
      {
        name: "stale",
        full_name: "octocat/stale",
        private: false,
        languages: { Rust: 1 },
      },
    ]),
  );
  await earlier;
  assert.equal(refreshed[0].full_name, "octocat/fresh");
  assert.equal(data.snapshot("octocat")[0].full_name, "octocat/fresh");
  assert.equal(listCalls, 2);
});

function authenticatedPreviewData(options = {}) { return createPreviewData({ ...options, access: createGitHubAccess({ authenticated: true }) }); }

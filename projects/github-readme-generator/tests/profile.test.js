import { describe, it, expect, vi } from "vitest";
import {
  githubUsername,
  fetchGithubProfile,
  publicWebsite,
} from "../src/state/github-profile.js";
import {
  autofillProfile,
  profileOptions,
} from "../src/state/profile-autofill.js";
import {
  newDraft,
  validateDraft,
  saveDrafts,
  readDrafts,
  withoutDetachedCopies,
} from "../src/state/drafts.js";
import { render } from "../src/markdown/render.js";
import { template, templateNames } from "../src/data/templates.js";
import { createBlock, serializeBlocks } from "../src/markdown/serialize.js";
import { Store } from "../src/state/store.js";
const user = {
  login: "octocat",
  name: "Mona Octocat",
  bio: "Building accessible tools.",
  company: "Example Co",
  location: "Earth",
  blog: "example.org",
  followers: 12,
  following: 4,
  public_repos: 3,
  public_gists: 0,
  created_at: "2011-02-03T00:00:00Z",
};
const repo = (id, overrides = {}) => ({
  id,
  name: `project-${id}`,
  owner: { login: "octocat" },
  stargazers_count: 5,
  forks_count: 2,
  language: "JavaScript",
  description: "A useful tool",
  ...overrides,
});
const response = (data, next = false) => ({
  ok: true,
  json: async () => data,
  headers: {
    get: () => (next ? '<https://api.github.com/next>; rel="next"' : null),
  },
});
async function profile() {
  return fetchGithubProfile("octocat", async (url) =>
    response(
      url.includes("/repos?")
        ? [
            repo(1),
            repo(2, { fork: true, stargazers_count: 500 }),
            repo(3, { archived: true, language: "Rust" }),
          ]
        : user,
    ),
  );
}
describe("public GitHub profile lookup", () => {
  it("cancels a pending profile request without starting repository requests", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = fetchGithubProfile(
      "octocat",
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          calls++;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
  it("does not fetch when already canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      fetchGithubProfile("octocat", fetcher, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps completed pages on timeout and releases the timeout timer", async () => {
    vi.useFakeTimers();
    try {
      let pages = 0;
      const pending = fetchGithubProfile("octocat", async (url, { signal }) => {
        if (!url.includes("/repos?")) return response(user);
        if (++pages === 1) return response([repo(1)], true);
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      });
      await vi.advanceTimersByTimeAsync(30000);
      const p = await pending;
      expect(p.complete).toBe(false);
      expect(p.stars).toBe(5);
      expect(p.warning).toContain("timed out");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects malformed profile JSON and keeps usable data on malformed repository pages", async () => {
    await expect(
      fetchGithubProfile("octocat", async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("bad JSON");
        },
      })),
    ).rejects.toThrow("unreadable response");
    const p = await fetchGithubProfile("octocat", async (url) =>
      response(url.includes("/repos?") ? [null, {}] : user),
    );
    expect(p.complete).toBe(false);
    expect(p.warning).toContain("invalid repository");
    expect(p.projects).toEqual([]);
  });
  it.each([
    "octocat",
    "@octocat",
    "https://github.com/octocat/",
    "https://github.com/octocat?tab=repositories",
  ])("accepts %s", (value) => expect(githubUsername(value)).toBe("octocat"));
  it.each([
    "owner/repo",
    "https://github.com.evil.test/octocat",
    "https://github.com/owner/repo",
    "../bad",
    "https://user:secret@github.com/octocat",
  ])("rejects %s", (value) => expect(() => githubUsername(value)).toThrow());
  it("normalizes public websites without permitting executable schemes", () => {
    expect(publicWebsite("example.org")).toBe("https://example.org/");
    expect(publicWebsite("javascript:alert(1)")).toBe("");
    expect(publicWebsite("data:text/html,x")).toBe("");
  });
  it("computes received stars on non-forks, language counts, and eligible projects", async () => {
    const p = await profile();
    expect(p.stars).toBe(10);
    expect(p.forks).toBe(4);
    expect(p.projects).toHaveLength(1);
    expect(p.languages).toEqual([
      { name: "JavaScript", repositories: 1 },
      { name: "Rust", repositories: 1 },
    ]);
    expect(p.publicGists).toBe(0);
    expect(p.complete).toBe(true);
  });
  it("follows pagination and deduplicates repos", async () => {
    let pages = 0;
    const p = await fetchGithubProfile("octocat", async (url) => {
      if (!url.includes("/repos?")) return response(user);
      pages++;
      return response(
        pages === 1 ? [repo(1)] : [repo(1), repo(2)],
        pages === 1,
      );
    });
    expect(pages).toBe(2);
    expect(p.stars).toBe(10);
    expect(p.complete).toBe(true);
  });
  it("bounds pagination and labels partial totals", async () => {
    let pages = 0;
    const p = await fetchGithubProfile("octocat", async (url) =>
      url.includes("/repos?")
        ? response([repo(++pages)], true)
        : response(user),
    );
    expect(pages).toBe(10);
    expect(p.complete).toBe(false);
    expect(p.warning).toContain("first 1,000");
  });
  it("keeps the profile when repository requests are rate limited", async () => {
    const p = await fetchGithubProfile("octocat", async (url) =>
      url.includes("/repos?")
        ? { ok: false, status: 403 }
        : response({ ...user, name: null, bio: null }),
    );
    expect(p.name).toBe("octocat");
    expect(p.bio).toBe("");
    expect(p.complete).toBe(false);
    expect(p.warning).toContain("rate limit");
    expect(p.fetchedRepos).toBe(0);
  });
  it("reports profile errors and network failure", async () => {
    await expect(
      fetchGithubProfile("missing", async () => ({ ok: false, status: 404 })),
    ).rejects.toThrow("not found");
    await expect(
      fetchGithubProfile("octocat", async () => {
        throw new Error("network");
      }),
    ).rejects.toThrow("Could not reach GitHub");
  });
});
describe("conservative profile autofill", () => {
  it("does not refill generated introductions or contact URLs that the user explicitly cleared", async () => {
    const p = await profile();
    const d = newDraft("Draft", template("Minimal"));
    const first = autofillProfile(d, p);
    first.blocks[0].settings.subtitle = "";
    first.blocks.find((b) => b.profileAutofill?.kind === "bio").settings.body =
      "";
    first.blocks
      .find((b) => b.type === "social")
      .settings.items.find((i) => i.name === "Portfolio").url = "";
    const next = autofillProfile({ ...d, ...first }, p);
    expect(next.blocks[0].settings.subtitle).toBe("");
    expect(
      next.blocks.find((b) => b.profileAutofill?.kind === "bio").settings.body,
    ).toBe("");
    expect(next.markdown).not.toContain("https://example.org/");
  });
  it("refreshes owned introductions and portfolio URLs, including removals, while preserving edits", async () => {
    const p = await profile();
    const d = newDraft("Draft", template("Minimal"));
    const first = autofillProfile(d, p);
    const second = autofillProfile(
      { ...d, ...first },
      { ...p, bio: "New public bio", website: "https://new.example.org/" },
    );
    expect(second.blocks[0].settings.subtitle).toBe("New public bio");
    expect(second.markdown).not.toContain("https://example.org/");
    expect(second.markdown).toContain("https://new.example.org/");
    const removed = autofillProfile(
      { ...d, ...second },
      { ...p, bio: "", company: "", location: "", website: "" },
    );
    expect(removed.blocks[0].settings.subtitle).toBe("");
    expect(removed.markdown).not.toContain("https://new.example.org/");
    second.blocks[0].settings.subtitle = "My private wording";
    const social = second.blocks.find((b) => b.type === "social");
    social.settings.items.find((i) => i.name === "Portfolio").url =
      "https://my-own.example/";
    const third = autofillProfile(
      { ...d, ...second },
      { ...p, bio: "Another public bio", website: "https://third.example/" },
    );
    expect(third.blocks[0].settings.subtitle).toBe("My private wording");
    expect(third.markdown).toContain("https://my-own.example/");
  });
  it("removes generated public email when the API no longer returns it", async () => {
    const p = { ...(await profile()), email: "public@example.org" };
    const d = newDraft("Draft", template());
    const first = autofillProfile(d, p);
    expect(first.markdown).toContain("mailto:public@example.org");
    const next = autofillProfile({ ...d, ...first }, { ...p, email: "" });
    expect(next.markdown).not.toContain("mailto:public@example.org");
  });
  it("retains new field ownership across storage, JSON backup, undo and redo", async () => {
    const p = await profile();
    const d = newDraft("Draft", template());
    const first = autofillProfile(d, p);
    saveDrafts({ drafts: [{ ...d, ...first }], active: d.id, settings: {} });
    const saved = readDrafts().drafts[0];
    const backup = validateDraft(JSON.parse(JSON.stringify(saved)));
    const store = new Store(backup);
    const next = autofillProfile(backup, {
      ...p,
      bio: "After reload",
      website: "https://updated.example/",
    });
    store.blocks(next.blocks, next.metadata);
    expect(store.draft.markdown).toContain("After reload");
    store.undo();
    expect(store.draft.markdown).toBe(first.markdown);
    store.redo();
    expect(store.draft.markdown).toBe(next.markdown);
  });
  it("accepts legacy draft metadata without rewriting original Markdown on load", async () => {
    const d = newDraft("Legacy", template());
    d.blocks[0].profileIdentity = { invalid: true };
    const loaded = validateDraft(d);
    expect(loaded.markdown).toBe(d.markdown);
    expect(() =>
      autofillProfile(loaded, {
        login: "octocat",
        name: "Mona",
        bio: "",
        company: "",
        location: "",
        url: "https://github.com/octocat",
        website: "",
        projects: [],
        languages: [],
        email: "",
        twitter: "",
        complete: false,
        fetchedRepos: 0,
        fetchedAt: "2026-09-27",
      }),
    ).not.toThrow();
  });
  it("renders untrusted API fields as text and blocks executable public URLs", async () => {
    const p = await fetchGithubProfile("octocat", async (url) =>
      response(
        url.includes("/repos?")
          ? [
              repo(1, {
                description: '<img src=x onerror="alert(1)">',
                homepage: "javascript:alert(1)",
              }),
            ]
          : {
              ...user,
              name: "<script>evil()</script>",
              bio: '<iframe src="https://evil.test"></iframe>',
              blog: "javascript:alert(1)",
            },
      ),
    );
    const result = autofillProfile(newDraft("Safe", template()), p, {
      projects: true,
    });
    const node = document.createElement("div");
    node.innerHTML = render(result.markdown);
    expect(
      node.querySelector('script,iframe,[onerror],[href^="javascript"]'),
    ).toBeNull();
    expect(node.textContent).toContain("<iframe");
  });
  it("refreshes a filled display name while preserving subsequent manual name edits", async () => {
    const p = await profile();
    const draft = newDraft("Minimal", template("Minimal"));
    const first = autofillProfile(draft, p);
    const second = autofillProfile(
      { ...draft, ...first },
      { ...p, name: "Mona Updated" },
    );
    expect(second.markdown).toContain("# Mona Updated");
    second.blocks[0].settings.name = "My custom name";
    const third = autofillProfile(
      { ...draft, ...second },
      { ...p, name: "Another update" },
    );
    expect(third.markdown).toContain("# My custom name");
  });
  it("does not add back a removed section after a project file blanks its text", async () => {
    const p = await profile();
    const d = newDraft("Draft", template("Minimal"));
    const first = autofillProfile(d, p);
    const bio = first.blocks.find((b) => b.profileAutofill?.kind === "bio");
    const removed = {
      ...d,
      ...first,
      blocks: first.blocks.filter((b) => b !== bio),
    };
    removed.markdown = serializeBlocks(removed.blocks);
    const portable = withoutDetachedCopies(removed);
    expect(portable.metadata.githubProfile.sections.bio).toBe("");
    const next = autofillProfile(portable, p);
    expect(next.preserved).toContain("bio");
    expect(next.blocks.some((b) => b.profileAutofill?.kind === "bio")).toBe(
      false,
    );
  });
  it("keeps optional autofill idempotent including project headings", async () => {
    const p = await profile();
    const draft = newDraft("Minimal", template("Minimal"));
    const options = { projects: true, languages: true, avatar: true };
    const first = autofillProfile(draft, p, options);
    const second = autofillProfile({ ...draft, ...first }, p, options);
    expect(second.markdown).toBe(first.markdown);
  });
  it.each(templateNames)(
    "personalizes placeholders across %s",
    async (name) => {
      const p = await profile();
      const draft = newDraft(name, template(name));
      const result = autofillProfile(draft, p);
      expect(result.markdown).toContain("Mona Octocat");
      expect(result.markdown).not.toContain("Your Name");
      expect(result.markdown).not.toContain("github.com/your-name");
      expect(result.markdown).toContain("example.org");
      expect(draft.markdown).toContain("Your Name");
    },
  );
  it("escapes API text in raw placeholders and keeps surrounding bytes", async () => {
    const p = {
      ...(await profile()),
      name: "<img src=x onerror=evil()> [Mona]",
    };
    const draft = newDraft("Raw", [
      createBlock("custom", {
        markdown:
          "# Your Name\n\nHello {{display_name}} / {{username}}.  \nKeep my text.\n",
      }),
    ]);
    const result = autofillProfile(draft, p, {
      identity: true,
      bio: false,
      links: false,
      stats: false,
    });
    expect(result.markdown).toContain("&lt;img");
    expect(result.markdown).not.toContain("<img");
    expect(result.markdown).toContain(" / octocat.  \nKeep my text.\n");
  });
  it("preserves custom names, bios, and project writeups", async () => {
    const p = await profile();
    const blocks = template("Minimal");
    blocks[0].settings.name = "My chosen name";
    blocks[1].settings.body = "My own bio";
    blocks.find((b) => b.type === "projects").settings.items[0].description =
      "My custom project story";
    const result = autofillProfile(newDraft("Custom", blocks), p, {
      projects: true,
    });
    expect(result.markdown).toContain("My chosen name");
    expect(result.markdown).toContain("My own bio");
    expect(result.markdown).toContain("My custom project story");
    expect(result.markdown).toContain("project-1");
  });
  it("replaces untouched sample projects, adds optional languages, and snapshots stats", async () => {
    const result = autofillProfile(
      newDraft("Minimal", template("Minimal")),
      await profile(),
      { projects: true, languages: true },
    );
    expect(result.markdown).not.toContain("Project One");
    expect(result.markdown).toContain("project-1");
    expect(result.markdown).toContain("**Followers:** 12");
    expect(result.markdown).toContain("**Public gists:** 0");
    expect(result.markdown).toContain("not a measure of proficiency");
    expect(result.markdown).toContain("Public snapshot");
  });
  it("is idempotent and refreshes unedited owned stats after backup reload", async () => {
    const p = await profile();
    const draft = newDraft("Draft", template());
    const first = autofillProfile(draft, p);
    const second = autofillProfile({ ...draft, ...first }, p);
    expect(second.markdown).toBe(first.markdown);
    const restored = validateDraft({ ...draft, ...first });
    const refreshed = autofillProfile(restored, { ...p, followers: 99 });
    expect(refreshed.markdown).toContain("**Followers:** 99");
    expect(refreshed.markdown.match(/## GitHub at a Glance/g)).toHaveLength(1);
  });
  it("preserves edited generated sections and does not duplicate detached sections", async () => {
    const p = await profile();
    const draft = newDraft("Draft", template());
    const first = autofillProfile(draft, p);
    const stats = first.blocks.find((b) => b.profileAutofill?.kind === "stats");
    stats.settings.body = "My edited stats";
    const second = autofillProfile({ ...draft, ...first }, p);
    expect(second.markdown).toContain("My edited stats");
    expect(second.preserved).toContain("stats");
    const store = new Store({ ...draft, ...first });
    store.raw(serializeBlocks(first.blocks) + "\nManual edits.");
    const raw = autofillProfile(store.draft, p);
    const again = autofillProfile({ ...store.draft, ...raw }, p);
    expect(again.markdown.match(/## GitHub at a Glance/g)).toHaveLength(1);
    expect(again.markdown).toContain("Manual edits.");
  });
  it("undo restores metadata and content together", async () => {
    const store = new Store(newDraft("Draft", template()));
    const before = structuredClone(store.draft);
    const result = autofillProfile(store.draft, await profile());
    store.blocks(result.blocks, result.metadata);
    expect(store.draft.metadata.githubProfile.login).toBe("octocat");
    store.undo();
    expect(store.draft.blocks).toEqual(before.blocks);
    expect(store.draft.metadata).toEqual(before.metadata);
  });
  it("initializes a blank draft with a real name and honors unchecked options", async () => {
    const p = await profile();
    const result = autofillProfile(newDraft("Blank"), p, {
      ...Object.fromEntries(Object.keys(profileOptions).map((k) => [k, false])),
      identity: true,
    });
    expect(result.markdown).toBe("# Mona Octocat\n\n");
    expect(result.metadata.githubProfile.login).toBe("octocat");
  });
});

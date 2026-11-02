import { baseTheme } from "../src/themes/theme-model.js";
import { it, expect, vi } from "vitest";
import {
  generatedRegistry,
  projectOwnership,
  refreshedAge,
} from "../src/generated/registry.js";
import {
  applyRefresh,
  refreshPreview,
  fetchRefresh,
} from "../src/github/refresh.js";
import {
  authorRepositories,
  repositoryContext,
} from "../src/github/repository-context.js";
import { autofillProfile } from "../src/state/profile-autofill.js";
import { newDraft, validateDraft } from "../src/state/drafts.js";
import { Store } from "../src/state/store.js";
import { createBlock, serializeBlocks } from "../src/markdown/serialize.js";
const repo = (description = "Old", homepage = "https://old.example") =>
  repositoryContext({
    name: "demo",
    full_name: "ada/demo",
    description,
    homepage,
    topics: ["react"],
    language: "JavaScript",
    default_branch: "main",
    lastFetched: "2026-01-01T00:00:00Z",
  });
const profile = (name = "Ada", n = 4) => ({
  login: "ada",
  name,
  bio: "Public bio",
  company: "",
  location: "",
  website: "https://example.com",
  email: "",
  twitter: "",
  avatar: "https://example.com/avatar.png",
  url: "https://github.com/ada",
  publicRepos: n,
  followers: 3,
  following: 1,
  publicGists: 0,
  joined: "2020-01-01",
  fetchedAt: "2026-09-27T00:00:00Z",
  complete: true,
  fetchedRepos: 1,
  stars: 3,
  forks: 0,
  languages: [{ name: "JavaScript", repositories: 1 }],
  projects: [],
  repositories: [],
});
const data = () => ({
  profiles: { ada: profile("Ada New", 5) },
  repositories: { "ada/demo": repo("New", "https://new.example") },
  errors: [],
});
it("project refresh preserves manual fields and records their ownership", () => {
  const d = newDraft("D", [
    authorRepositories([repo()], { action: "projects" }),
  ]);
  const p = d.blocks[0].settings.items[0];
  p.description = "My words";
  d.markdown = serializeBlocks(d.blocks);
  expect(projectOwnership(p).description).toBe("manual");
  const id = generatedRegistry(d)[0].id,
    result = applyRefresh(d, data(), [id]);
  expect(result.blocks[0].settings.items[0].description).toBe("My words");
  expect(result.blocks[0].settings.items[0].liveUrl).toBe(
    "https://new.example",
  );
  expect(result.skipped).toContain("Manual project.description preserved");
  expect(d.blocks[0].settings.items[0].liveUrl).toBe("https://old.example");
});
it("repo list diff previews exact changes and applies in one undo checkpoint", () => {
  const d = newDraft("D", [
      authorRepositories([repo()], { layout: "detailed" }),
    ]),
    id = generatedRegistry(d)[0].id;
  const plan = refreshPreview(d, data(), [id]);
  expect(plan[0].before).toContain("Old");
  expect(plan[0].after).toContain("New");
  const before = d.markdown;
  const result = applyRefresh(d, data(), [id]),
    store = new Store(d);
  store.blocks(result.blocks, result.metadata);
  expect(store.draft.markdown).toContain("New");
  store.undo();
  expect(store.draft.markdown).toBe(before);
});
it("manually changed repo sections are skipped", () => {
  const d = newDraft("D", [authorRepositories([repo()])]);
  d.blocks[0].settings.markdown = "My manual section";
  d.markdown = serializeBlocks(d.blocks);
  const u = generatedRegistry(d)[0];
  expect(u.ownership).toBe("manual");
  expect(applyRefresh(d, data(), [u.id]).markdown).toBe("My manual section");
});
it("raw detachment survives backups and explicit recreation appends without overwriting", () => {
  const store = new Store(newDraft("D", [authorRepositories([repo()])]));
  store.raw("MY RAW SOURCE\r\n");
  const d = validateDraft(JSON.parse(JSON.stringify(store.draft))),
    u = generatedRegistry(d)[0];
  expect(u.ownership).toBe("detached");
  expect(applyRefresh(d, data(), [u.id]).markdown).toBe("MY RAW SOURCE\r\n");
  const next = applyRefresh(d, data(), [u.id], [u.id]);
  expect(next.markdown.startsWith("MY RAW SOURCE\r\n")).toBe(true);
  expect(next.markdown).toContain("New");
  expect(
    generatedRegistry(next).filter((u) => u.ownership === "detached"),
  ).toHaveLength(0);
});
it("identity refresh updates only owned paths, not manual placeholder text", () => {
  const d = newDraft("D", [
    createBlock("hero", { name: "Your Name", subtitle: "" }),
  ]);
  const initial = autofillProfile(d, profile(), {
    identity: true,
    bio: false,
    links: false,
    stats: false,
  });
  const current = { ...d, ...initial };
  current.blocks[0].settings.subtitle = "My own {{name}}";
  current.blocks.push(createBlock("custom", { markdown: "Custom {{name}}" }));
  current.markdown = serializeBlocks(current.blocks);
  const next = applyRefresh(current, data(), ["profile:identity"]);
  expect(next.blocks[0].settings.name).toBe("Ada New");
  expect(next.blocks[0].settings.subtitle).toBe("My own {{name}}");
  expect(next.blocks[1].settings.markdown).toBe("Custom {{name}}");
});
it("stats refresh can be selected separately and unrelated refresh ages remain unchanged", () => {
  const d = newDraft("D", [
    createBlock("hero", { name: "Your Name", subtitle: "" }),
  ]);
  const initial = autofillProfile(d, {
    ...profile(),
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  const current = { ...d, ...initial };
  const result = applyRefresh(current, data(), ["profile:stats"]);
  expect(result.markdown).toContain("**Public repositories:** 5");
  expect(
    generatedRegistry(result).find((u) => u.id === "profile:identity")
      .lastFetched,
  ).toBe("2026-01-01T00:00:00Z");
  expect(
    generatedRegistry(result).find((u) => u.id === "profile:stats").lastFetched,
  ).toBe(profile().fetchedAt);
});
it("partial failures leave unsuccessful sources unchanged and support selected success", () => {
  const a = authorRepositories([repo()]),
    b = authorRepositories([
      repositoryContext({ name: "other", full_name: "ada/other" }),
    ]);
  const d = newDraft("D", [a, b]),
    ids = generatedRegistry(d).map((u) => u.id);
  const plan = refreshPreview(d, data(), ids);
  expect(plan[1].error).toContain("did not load");
  const result = applyRefresh(d, data(), ids);
  expect(result.blocks[1]).toEqual(b);
  expect(result.errors).toHaveLength(1);
  expect(result.blocks[0].settings.markdown).toContain("New");
});
it("incomplete profile repository totals never replace generated summaries", () => {
  const d = newDraft("D"),
    initial = autofillProfile(d, profile());
  const current = { ...d, ...initial },
    remote = data();
  remote.profiles.ada.complete = false;
  const next = applyRefresh(current, remote, ["profile:stats"]);
  expect(next.markdown).toBe(current.markdown);
  expect(next.errors[0]).toContain("incomplete");
});
it("refresh fetches each repository once and lists public API failures", async () => {
  const d = newDraft("D", [
      authorRepositories([repo()]),
      authorRepositories([repo()]),
    ]),
    fetcher = vi.fn(async () => new Response(null, { status: 404 }));
  const result = await fetchRefresh(
    d,
    generatedRegistry(d).map((u) => u.id),
    { fetcher },
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.errors[0]).toContain("not found");
});
it("fetch age is informational and generated ownership stays outside README export", () => {
  expect(refreshedAge("2026-09-06", Date.parse("2026-09-27"))).toBe(
    "Last refreshed 21 days ago",
  );
  const d = newDraft("D", [authorRepositories([repo()])]);
  expect(d.markdown).not.toContain("generatedValue");
  expect(d.markdown).not.toContain("lastFetched");
});
it("manual profile body and unowned sample-looking links survive refresh", () => {
  const initial = newDraft("D", [
    createBlock("social", {
      style: "links",
      items: [{ name: "Site", url: "https://example.com" }],
    }),
  ]);
  const filled = autofillProfile(initial, profile());
  const d = { ...initial, ...filled };
  const links = d.blocks.find((b) => b.profileLinks);
  links.settings.items.push({
    name: "Manual example",
    url: "https://example.com",
  });
  const bio = d.blocks.find((b) => b.profileAutofill?.kind === "bio");
  bio.settings.body = "My manual biography";
  d.markdown = serializeBlocks(d.blocks);
  const remote = data();
  remote.profiles.ada.website = "https://new.example";
  const next = applyRefresh(d, remote, ["profile:bio", "profile:links"]);
  expect(next.blocks.find((b) => b.id === bio.id).settings.body).toBe(
    "My manual biography",
  );
  expect(next.blocks.find((b) => b.id === links.id).settings.items[1].url).toBe(
    "https://example.com",
  );
});

it("malformed optional source metadata cannot destroy raw editing", () => {
  const d = newDraft("D", [createBlock("custom", { markdown: "Keep me" })]);
  d.metadata = {
    detachedGenerated: { bad: true },
    githubProfile: { login: "ada", sections: { future: "x" } },
  };
  d.blocks[0].githubGenerated = { version: 1, repositories: "not-an-array" };
  const store = new Store(d);
  expect(() => store.raw("Still editable")).not.toThrow();
  expect(store.draft.markdown).toBe("Still editable");
});

it("null optional identity records do not block editing or refresh inventory", () => {
  const d = newDraft("D", [
    createBlock("hero", { name: "Manual", subtitle: "" }),
  ]);
  d.metadata.githubProfile = { login: "ada", sections: {} };
  d.blocks[0].profileIdentity = [null, { path: null }];
  d.blocks[0].profileLinks = [null];
  expect(() => generatedRegistry(d)).not.toThrow();
  const store = new Store(d);
  expect(() => store.raw("Preserved")).not.toThrow();
  expect(store.draft.markdown).toBe("Preserved");
});
it("themed recreation preview equals applied source and remains refreshable", () => {
  const d = newDraft("D"),
    initial = autofillProfile(d, profile(), {
      identity: false,
      bio: false,
      links: false,
      stats: true,
    });
  const store = new Store({ ...d, ...initial });
  store.draft.metadata.visualTheme = {
    ...baseTheme,
    headings: { style: "centered", decoration: "*" },
  };
  store.raw("Manual source");
  const id = "profile:stats";
  const preview = refreshPreview(store.draft, data(), [id], [id])[0];
  const result = applyRefresh(store.draft, data(), [id], [id]);
  store.blocks(result.blocks, result.metadata);
  expect(store.draft.markdown).toBe(preview.after);
  expect(store.draft.markdown).toContain('<h2 align="center">');
  expect(
    generatedRegistry(store.draft).find((u) => u.id === id).ownership,
  ).toBe("generated");
});

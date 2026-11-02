import { it, expect } from "vitest";
import {
  suggestions,
  projectCandidates,
  profileLinks,
  stackGroups,
  dismissSuggestion,
  profileSnapshot,
} from "../src/github/suggestions.js";
import { repositoryContext } from "../src/github/repository-context.js";
const r = (name, extra = {}) =>
  repositoryContext({
    name,
    full_name: `ada/${name}`,
    language: "JavaScript",
    topics: ["react", "vite", "playwright", "vitest", "rust"],
    stargazers_count: 10,
    updated_at: "2026-09-20T00:00:00Z",
    ...extra,
  });
const draft = () => ({
  blocks: [],
  markdown: "# Ada",
  metadata: {
    githubProfile: {
      snapshot: { website: "https://example.com", email: "public@example.com" },
    },
    repositoryContext: [r("one"), r("two"), r("three")],
  },
});
it("explains missing sections and known technology groups without scoring", () => {
  const all = suggestions(draft(), Date.parse("2026-09-27"));
  expect(all.map((s) => s.id)).toEqual(
    expect.arrayContaining([
      "about",
      "projects",
      "contact",
      "stack",
      "groups",
      "featured",
    ]),
  );
  expect(all.every((s) => s.reason && !("score" in s))).toBe(true);
  expect(stackGroups([r("one")]).Testing).toContain("Playwright");
});
it("recognizes manual Markdown and HTML headings, ignoring code examples", () => {
  const d = draft();
  d.markdown =
    "## About\n## Projects\n<h2>Contact</h2>\n## Tech Stack\n## Featured";
  expect(suggestions(d).map((s) => s.id)).not.toContain("projects");
  expect(suggestions(d).map((s) => s.id)).not.toContain("contact");
  d.markdown = "```md\n## Projects\n```";
  expect(suggestions(d).map((s) => s.id)).toContain("projects");
});
it("candidate eligibility excludes archived, fork and profile repositories", () => {
  const result = projectCandidates(
    [
      r("ada"),
      r("old", { archived: true }),
      r("copy", { fork: true }),
      r("real"),
    ],
    Date.parse("2026-09-27"),
  );
  expect(result.map((c) => c.repository)).toEqual(["ada/real"]);
  expect(result[0].reasons.join(" ")).toContain("Most starred");
});
it("dismissals are scoped to relevant context, not unrelated updates", () => {
  const d = draft(),
    s = suggestions(d).find((s) => s.id === "contact");
  d.metadata = dismissSuggestion(d.metadata, s);
  expect(suggestions(d).map((s) => s.id)).not.toContain("contact");
  d.metadata.githubProfile.snapshot.website = "https://other.example";
  expect(suggestions(d).map((s) => s.id)).toContain("contact");
});
it("public profile links validate destinations and do not guess company domains", () => {
  expect(
    profileLinks({
      email: "x<script>@example.com",
      website: "javascript:bad",
      company: "Acme",
      twitter: "bad/path",
    }),
  ).toEqual([]);
  expect(
    profileLinks({ company: "@example", email: "public@example.com" }),
  ).toHaveLength(2);
  expect(profileSnapshot({ token: "secret", login: "ada" })).toEqual({
    login: "ada",
  });
});
it("archived project labelled Active gets an explained status review", () => {
  const d = draft();
  d.metadata.repositoryContext = [r("one", { archived: true })];
  d.blocks = [
    {
      type: "projects",
      settings: {
        items: [
          { repositoryUrl: "https://github.com/ada/one", status: "Active" },
        ],
      },
    },
  ];
  expect(
    suggestions(d).find((s) => s.id === "archived:ada/one").reason,
  ).toContain("archived");
});

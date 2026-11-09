import { marked } from "marked";
import { visitTokens } from "../markdown/visit-tokens.js";
import {
  contextRepositories,
  technologySuggestions,
} from "./repository-context.js";
import { safeUrl } from "../markdown/url-safety.js";
export function profileSnapshot(p = {}) {
  return Object.fromEntries(
    [
      "login",
      "name",
      "bio",
      "company",
      "location",
      "website",
      "avatar",
      "email",
      "twitter",
      "url",
      "followers",
      "following",
      "publicRepos",
      "publicGists",
      "joined",
      "fetchedAt",
      "complete",
      "warning",
      "fetchedRepos",
      "stars",
      "forks",
      "languages",
      "projects",
    ]
      .filter((k) => p[k] !== undefined)
      .map((k) => [k, structuredClone(p[k])]),
  );
}
export function profileLinks(p = {}) {
  const links = [];
  const add = (name, url) => {
    if (safeUrl(url, { relative: false })) links.push({ name, url });
  };
  if (/^https?:\/\//i.test(p.website || "")) add("Website", p.website);
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(p.email || ""))
    add("Public email", `mailto:${p.email}`);
  if (/^[a-z\d_]{1,15}$/i.test(p.twitter || ""))
    add("X / Twitter", `https://x.com/${p.twitter}`);
  if (/^@[a-z\d-]+$/i.test(p.company || ""))
    add("Company", `https://github.com/${p.company.slice(1)}`);
  return links;
}
const groups = {
  React: "Frontend",
  Vite: "Frontend",
  CSS: "Frontend",
  HTML: "Frontend",
  Vue: "Frontend",
  Angular: "Frontend",
  "Node.js": "Backend",
  Express: "Backend",
  Rust: "Backend",
  Python: "Backend",
  Vitest: "Testing",
  Playwright: "Testing",
  Jest: "Testing",
  PostgreSQL: "Databases",
  MySQL: "Databases",
  Docker: "DevOps",
  Kubernetes: "DevOps",
};
export function stackGroups(repos) {
  const out = {};
  for (const t of technologySuggestions(repos)) {
    const group = groups[t.name];
    if (group) (out[group] ||= []).push(t.name);
  }
  return out;
}
export function projectCandidates(repos, now = Date.now()) {
  const eligible = repos.filter(
    (r) =>
      !r.fork && !r.archived && r.name.toLowerCase() !== r.owner.toLowerCase(),
  );
  const most = Math.max(0, ...eligible.map((r) => r.stars || 0));
  return eligible
    .map((r) => ({
      repository: r.fullName,
      reasons: [
        ...(r.stars > 0 && r.stars === most
          ? [`Most starred in the loaded eligible set (${r.stars})`]
          : []),
        ...(Date.parse(r.updatedAt) <= now &&
        now - Date.parse(r.updatedAt) < 90 * 86400000
          ? ["Updated within the last 90 days"]
          : []),
        ...(r.homepage ? ["Repository homepage provided (not verified)"] : []),
        ...(r.topics.length >= 3
          ? ["Several descriptive repository topics"]
          : []),
      ],
    }))
    .filter((r) => r.reasons.length)
    .sort((a, b) => a.repository.localeCompare(b.repository))
    .slice(0, 6);
}
export function suggestions(draft, now = Date.now()) {
  const repos = contextRepositories(draft),
    p = draft.metadata?.githubProfile?.snapshot || {},
    links = profileLinks(p),
    candidates = projectCandidates(repos, now);
  let headings = "",
    hasContact = false;
  visitTokens(marked.lexer(draft.markdown || ""), (t) => {
    if (t.type === "heading") headings += " " + t.text;
    if (
      t.type === "link" &&
      (/^mailto:|x.com|twitter.com/i.test(t.href) ||
        links.some((l) => l.url === t.href))
    )
      hasContact = true;
    if (t.type === "html") {
      const html = t.text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
      for (const m of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi))
        headings += " " + m[1].replace(/<[^>]*>/g, "");
      if (/href=["']mailto:/i.test(html)) hasContact = true;
    }
  });
  const result = [],
    add = (id, title, reason, action, context) =>
      result.push({
        id,
        type: "content-opportunity",
        severity: "info",
        title,
        reason,
        action,
        fingerprint: JSON.stringify(context),
      });
  const eligible = repos.filter(
    (r) =>
      !r.archived && !r.fork && r.name.toLowerCase() !== r.owner.toLowerCase(),
  );
  if (
    !/about|bio|introduction/i.test(headings) &&
    !draft.blocks.some((b) => b.type === "about")
  )
    add(
      "about",
      "Consider an About section",
      "No About or introduction section was found.",
      "components",
      "about",
    );
  if (
    eligible.length &&
    !/projects|repositories|portfolio|work/i.test(headings) &&
    !draft.blocks.some((b) => b.type === "projects")
  )
    add(
      "projects",
      "Consider adding projects",
      `You have ${eligible.length} loaded eligible public repositories and no Projects section.`,
      "repositories",
      Math.floor(eligible.length / 5),
    );
  if (
    links.length &&
    !hasContact &&
    !/contact|connect|find me/i.test(headings) &&
    !draft.blocks.some((b) => b.type === "social")
  )
    add(
      "contact",
      "Consider public contact links",
      "Your fetched public profile provides links, but no contact section was found.",
      "contact",
      links,
    );
  if (
    repos.length >= 3 &&
    !/stack|technolog|skills|tools/i.test(headings) &&
    !draft.blocks.some((b) => b.type === "stack")
  )
    add(
      "stack",
      "Consider a technology section",
      `${repos.length} loaded repositories provide language/topic context. Confirm suggestions; this does not describe proficiency.`,
      "repositories",
      Object.keys(stackGroups(repos)).sort(),
    );
  if (
    candidates.length &&
    !/featured/i.test(headings) &&
    !draft.blocks.some(
      (b) =>
        b.type === "projects" &&
        ["featured", "featured-first"].includes(b.settings.layout),
    )
  )
    add(
      "featured",
      "Possible projects to feature",
      candidates
        .map((c) => `${c.repository}: ${c.reasons.join("; ")}`)
        .join(" • "),
      "repositories",
      candidates.map((c) => c.repository),
    );
  const group = stackGroups(repos);
  if (Object.values(group).flat().length >= 5)
    add(
      "groups",
      "Consider grouping technologies",
      Object.entries(group)
        .map(([k, v]) => `${k}: ${v.join(", ")}`)
        .join(" • "),
      "repositories",
      group,
    );
  for (const b of draft.blocks)
    for (const item of b.type === "projects" ? b.settings.items || [] : []) {
      const r = repos.find((r) => r.htmlUrl === item.repositoryUrl);
      if (r?.archived && item.status === "Active")
        add(
          "archived:" + r.fullName,
          "Review a featured project status",
          `${r.fullName} is archived on GitHub but labelled Active in this draft.`,
          "projects",
          r.fullName + ":archived",
        );
    }
  return result.filter(
    (s) => draft.metadata?.suggestionDismissals?.[s.id] !== s.fingerprint,
  );
}
export function dismissSuggestion(metadata, s) {
  return {
    ...metadata,
    suggestionDismissals: {
      ...metadata?.suggestionDismissals,
      [s.id]: s.fingerprint,
    },
  };
}

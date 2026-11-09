import {
  publicRepository,
  applyRepository,
  importedFields,
  suggestedTechnologies,
} from "../projects/github-project.js";
import { githubBadge } from "../badges/providers/github.js";
import {
  html,
  text,
  createBlock,
  serializeBlock,
} from "../markdown/serialize.js";
export function repositoryContext(raw) {
  if (
    !raw ||
    raw.private === true ||
    (raw.visibility && raw.visibility !== "public")
  )
    throw Error("Only public repositories can be used.");
  const r = publicRepository(raw.fullName ? repositoryAPI(raw) : raw);
  const [owner, name] = r.full_name.split("/");
  return {
    owner,
    name,
    fullName: r.full_name,
    htmlUrl: r.html_url,
    homepage: r.homepage,
    description: r.description,
    language: r.language,
    topics: r.topics,
    stars: r.stargazers_count,
    forks: r.forks_count,
    archived: r.archived,
    fork: r.fork,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pushedAt: r.pushed_at,
    defaultBranch: String(raw.defaultBranch || raw.default_branch || ""),
    license: r.license,
    visibility: "public",
    lastFetched: raw.lastFetched || r.lastFetched,
  };
}
export function repositoryAPI(r) {
  return {
    name: r.name,
    full_name: r.fullName,
    description: r.description,
    homepage: r.homepage,
    language: r.language,
    topics: r.topics,
    stargazers_count: r.stars,
    forks_count: r.forks,
    archived: r.archived,
    fork: r.fork,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    pushed_at: r.pushedAt,
    default_branch: r.defaultBranch,
    license: r.license,
    lastFetched: r.lastFetched,
    html_url: r.htmlUrl,
    private: r.visibility && r.visibility !== "public",
  };
}
export function contextRepositories(draft) {
  const all = [
    ...(Array.isArray(draft.metadata?.githubProfile?.repositories)
      ? draft.metadata.githubProfile.repositories
      : []),
    ...(Array.isArray(draft.metadata?.repositoryContext)
      ? draft.metadata.repositoryContext
      : []),
  ];
  return [
    ...new Map(
      all.flatMap((r) => {
        try {
          const c = repositoryContext(r);
          return [[c.fullName.toLowerCase(), c]];
        } catch {
          return [];
        }
      }),
    ).values(),
  ];
}
export function filterContexts(
  repos,
  {
    search = "",
    language = "",
    archived = "any",
    fork = "any",
    sort = "updated",
  } = {},
) {
  return repos
    .filter(
      (r) =>
        (r.fullName + " " + r.description + " " + r.topics.join(" "))
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (!language || r.language === language) &&
        (archived === "any" || r.archived === (archived === "only")) &&
        (fork === "any" || r.fork === (fork === "only")),
    )
    .sort(
      (a, b) =>
        (sort === "stars"
          ? (b.stars || 0) - (a.stars || 0)
          : sort === "name"
            ? 0
            : String(
                sort === "created" ? b.createdAt : b.updatedAt,
              ).localeCompare(
                String(sort === "created" ? a.createdAt : a.updatedAt),
              )) || a.fullName.localeCompare(b.fullName),
    );
}
export function technologySuggestions(repos) {
  const result = new Map();
  for (const r of repos) {
    for (const t of suggestedTechnologies(repositoryAPI(r)))
      result.set(t.name.toLowerCase(), {
        ...t,
        reason: `Primary language or topic in ${r.fullName}`,
      });
    for (const topic of r.topics)
      if (["pwa", "accessibility"].includes(topic.toLowerCase()))
        result.set(topic.toLowerCase(), {
          name: topic.toLowerCase() === "pwa" ? "PWA" : "Accessibility",
          reason: `Repository topic in ${r.fullName}`,
        });
  }
  return [...result.values()];
}
const literal = (v) => text(html(v)).replace(/\|/g, "&#124;");
const link = (label, url) =>
  `[${literal(label)}](${url.replace(/[()\s]/g, encodeURIComponent)})`;
export function repoBadges(
  r,
  kinds = ["stars", "forks", "issues", "license", "release"],
  workflow = "",
) {
  return kinds
    .map((kind) => {
      const b = githubBadge(kind, { repository: r.fullName, workflow });
      const query = new URLSearchParams(b.query || {}).toString();
      return `[![${literal(b.alt)}](https://img.shields.io/${b.path}${query ? "?" + query : ""})](${b.link})`;
    })
    .join(" ");
}
export function authorRepositories(
  repos,
  {
    action = "list",
    layout = "compact",
    title = "Selected Repositories",
    technologies,
    workflow = "",
    badges = ["stars", "forks", "issues", "license", "release"],
  } = {},
) {
  if (!repos.length || repos.length > 50)
    throw Error("Select 1–50 public repositories.");
  repos = repos.map(repositoryContext);
  let b;
  if (action === "projects")
    b = createBlock("projects", {
      version: 1,
      title,
      layout: "detailed",
      items: repos.map(
        (r) => applyRepository(repositoryAPI(r), importedFields).project,
      ),
    });
  else if (action === "tech")
    b = createBlock("stack", {
      title: "Technology suggestions",
      style: "text",
      headings: false,
      items: technologySuggestions(repos).filter(
        (t) => !technologies || technologies.includes(t.name),
      ),
    });
  else {
    const rows = repos.map((r) => {
      const name = link(r.name, r.htmlUrl),
        home = r.homepage
          ? link("Live Demo (repository homepage)", r.homepage)
          : "";
      if (action === "badges" || layout === "badges")
        return repoBadges(r, badges, workflow);
      if (action === "link") return `- ${name}`;
      if (action === "homepage")
        return home
          ? `- ${literal(r.name)}: ${home}`
          : `- ${literal(r.name)}: no repository homepage provided`;
      const status = r.archived ? " · Archived" : r.fork ? " · Fork" : "";
      if (layout === "table")
        return `| ${name} | ${literal(r.description)} | ${literal(r.language)} | ${r.stars ?? "—"} | ${home} | ${status.replace(/^ · /, "")} |`;
      if (layout === "detailed")
        return `### ${name}\n\n${literal(r.description)}\n\n${literal(r.language)}${status}${r.stars !== null ? ` · ${r.stars} stars` : ""}${home ? ` · ${home}` : ""}`;
      return `- ${name}${r.description ? ` — ${literal(r.description)}` : ""}${status}`;
    });
    const markdown =
      `## ${literal(title)}\n\n` +
      (layout === "table" && action === "list"
        ? "| Repository | Description | Language | Stars | Homepage | Status |\n| --- | --- | --- | --- | --- | --- |\n"
        : "") +
      rows.join(layout === "detailed" ? "\n\n" : "\n");
    b = createBlock("custom", { markdown });
  }
  b.githubGenerated = {
    version: 1,
    sourceType: "github-repository",
    repositories: repos.map((r) => r.fullName),
    snapshot: repos,
    options: { action, layout, title, technologies, workflow, badges },
    generatedValue: serializeBlock(b),
    lastFetched: new Date().toISOString(),
    ownership: "generated",
  };
  return b;
}

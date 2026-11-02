import { safeUrl } from "../markdown/url-safety.js";
import { logos } from "../badges/badge-model.js";
import { repositoryIdentity } from "./github-project.js";
const aliases = new Map(
  logos.flatMap((t) =>
    [t.name, t.id, t.shieldsLogo, ...t.aliases].map((n) => [
      n.toLowerCase(),
      t.id,
    ]),
  ),
);
export const technologyIdentity = (name) =>
  aliases.get(name.trim().toLowerCase()) || name.trim().toLowerCase();
export function projectMatches(p, query) {
  return [
    p.name,
    p.status,
    p.repositoryUrl,
    p.metadata.github?.owner,
    p.metadata.github?.repo,
    ...p.technologies.flatMap((t) => [t.name, technologyIdentity(t.name)]),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query.trim().toLowerCase());
}
export function projectHealth(projects, now = Date.now()) {
  const issues = [],
    names = new Set(),
    repos = new Set();
  projects.forEach((p, i) => {
    const add = (message) =>
      issues.push({
        category: "Projects",
        projectId: p.id,
        message: `Project ${i + 1} (${p.name || "Untitled"}): ${message}`,
      });
    if (!p.description.trim())
      add("Add a description so readers understand what the project does.");
    if (
      ![
        p.repositoryUrl,
        p.liveUrl,
        p.caseStudyUrl,
        ...p.links.map((l) => l.url),
      ].some((u) => safeUrl(u))
    )
      add(
        "Consider linking a live demo, repository, or case study so readers can explore the work.",
      );
    if (p.imageUrl && !p.imageAlt.trim())
      add(
        "Add screenshot alt text so the image is understandable without seeing it.",
      );
    if (!p.role.trim())
      add(
        "Consider adding what you personally worked on; readers should not have to infer your role.",
      );
    if (p.highlights.some((v) => !v.title.trim() && !v.description.trim()))
      add(
        "Remove or fill the empty highlight before presenting your engineering work.",
      );
    if (p.description.length > 600)
      add(
        "The description is long. Consider moving technical depth into highlights or a case study.",
      );
    if (p.technologies.length > 12)
      add(
        "The technology list is large; emphasize the stack relevant to your contribution.",
      );
    const tech = p.technologies.map((t) => technologyIdentity(t.name));
    if (new Set(tech).size < tech.length)
      add(
        "Repeated technologies or aliases (such as Node and Node.js) may be redundant. Review before removing any.",
      );
    const name = p.name.trim().toLowerCase(),
      repo = repositoryIdentity(p.repositoryUrl);
    if (name && names.has(name))
      add("Duplicate project name may confuse readers.");
    if (repo && repos.has(repo))
      add("This repository is already included in the showcase.");
    if (name) names.add(name);
    if (repo) repos.add(repo);
    if (
      p.metadata.github?.snapshot?.archived &&
      /^(active|maintained|in development)$/i.test(p.status)
    )
      add(
        "GitHub reports this repository as archived, but the displayed status suggests ongoing development. Review the status.",
      );
    const pushed = Date.parse(p.metadata.github?.snapshot?.pushed_at);
    if (Number.isFinite(pushed) && now - pushed > 730 * 86400000)
      add(
        "Repository has not been updated recently. This does not imply it is abandoned.",
      );
    const highlights = p.highlights
      .map((v) => v.title + " " + v.description)
      .join(" ");
    if (
      p.highlights.length >= 2 &&
      /\b(feature|supports?|allows?|users? can)\b/i.test(highlights) &&
      !/\b(architect|test|performance|accessib|security|trade.?off|design|cache|boundary|boundaries|because)/i.test(
        highlights,
      )
    )
      add(
        "Your highlights may describe features only; engineering decisions may be more useful. Add your own explanation where relevant.",
      );
    for (const [key, image] of [
      ["repositoryUrl", false],
      ["liveUrl", false],
      ["caseStudyUrl", false],
      ["imageUrl", true],
      ["darkImageUrl", true],
      ["imageLink", false],
    ])
      if (p[key] && !safeUrl(p[key], { image }))
        add(
          `${key} is unsafe or malformed and will be omitted from generated markup.`,
        );
    if (p.links.some((l) => l.url && !safeUrl(l.url)))
      add(
        "An additional link is unsafe or malformed and will be omitted from generated markup.",
      );
  });
  return issues;
}

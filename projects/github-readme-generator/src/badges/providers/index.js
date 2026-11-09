import { githubBadge } from "./github.js";
import { npmBadge } from "./npm.js";
import { cratesBadge } from "./crates.js";
import { netlifyBadge } from "./netlify.js";
import { badgeOptions } from "../shields.js";
import { safeUrl } from "../../markdown/url-safety.js";
const field = (key, label) => ({ key, label });
export const providers = [
  ...["stars", "forks", "issues", "license", "release", "workflow"].map(
    (kind) => ({
      id: `github-${kind}`,
      name:
        kind === "workflow"
          ? "GitHub Actions workflow status"
          : `GitHub ${kind}`,
      category:
        kind === "workflow"
          ? "CI/Deployment"
          : ["stars", "forks"].includes(kind)
            ? "GitHub / Social"
            : "GitHub",
      fields: [
        field("repository", "GitHub repository (owner/repository)"),
        ...(kind === "workflow"
          ? [
              field("workflow", "Workflow file or name"),
              field("branch", "Branch (optional)"),
              field("event", "Event (optional)"),
            ]
          : []),
      ],
      build: (c) => githubBadge(kind, c),
    }),
  ),
  ...["version", "downloads"].map((kind) => ({
    id: `npm-${kind}`,
    name: `npm ${kind === "downloads" ? "monthly downloads" : kind}`,
    category: "Packages",
    fields: [field("package", "npm package name")],
    build: (c) => npmBadge(kind, c),
  })),
  ...["version", "downloads"].map((kind) => ({
    id: `crates-${kind}`,
    name: `crates.io ${kind}`,
    category: "Packages",
    fields: [field("crate", "Crate name")],
    build: (c) => cratesBadge(kind, c),
  })),
  {
    id: "pypi-version",
    name: "PyPI version",
    category: "Packages",
    fields: [field("package", "PyPI package name")],
    build: (c) => {
      if (!/^[a-z\d](?:[a-z\d._-]{0,98}[a-z\d])?$/i.test(c.package || ""))
        throw new Error("Enter a valid PyPI package name.");
      return {
        path: `pypi/v/${encodeURIComponent(c.package)}`,
        link: `https://pypi.org/project/${encodeURIComponent(c.package)}/`,
        alt: `${c.package} PyPI version`,
      };
    },
  },
  ...["version", "pulls"].map((kind) => ({
    id: `docker-${kind}`,
    name: `Docker image ${kind}`,
    category: "Packages",
    fields: [
      field("image", "Docker image (user/repository, or _/official-image)"),
    ],
    build: (c) => {
      if (!/^(?:[a-z\d][a-z\d_-]*|_)\/[a-z\d][a-z\d_.-]*$/.test(c.image || ""))
        throw new Error(
          "Enter a Docker image as user/repository or _/official-image.",
        );
      return {
        path: `docker/${kind === "version" ? "v" : "pulls"}/${c.image}`,
        link: `https://hub.docker.com/${c.image.startsWith("_/") ? c.image : "r/" + c.image}`,
        alt: `${c.image} Docker ${kind}`,
      };
    },
  })),
  {
    id: "netlify",
    name: "Netlify deployment status",
    category: "CI/Deployment",
    fields: [field("siteId", "Netlify site ID")],
    build: netlifyBadge,
  },
  {
    id: "custom-endpoint",
    name: "Custom Shields JSON endpoint",
    category: "Custom",
    fields: [field("endpoint", "Public JSON endpoint URL")],
    build: (c) => {
      if (
        !/^https?:\/\//i.test(c.endpoint || "") ||
        !safeUrl(c.endpoint, { relative: false })
      )
        throw new Error(
          "Use a public HTTP(S) endpoint URL without credentials.",
        );
      return {
        path: "endpoint",
        query: { url: c.endpoint },
        link: c.endpoint,
        alt: "Custom endpoint status",
      };
    },
  },
];
export function buildDynamicBadge(id, config, options = {}) {
  const provider = providers.find((p) => p.id === id);
  if (!provider) throw new Error("Choose a supported badge provider.");
  const result = provider.build(config),
    query = badgeOptions(options);
  for (const [k, v] of Object.entries(result.query || {})) query.set(k, v);
  return {
    label: provider.name,
    alt: result.alt,
    link: result.link,
    style: options.style || "flat",
    lightUrl: `https://img.shields.io/${result.path}?${query}`,
    cacheSeconds: options.cacheSeconds || "",
  };
}
export function repositorySuggestions(draft) {
  const suggestions = [],
    source = draft.metadata?.importSource,
    profile = draft.metadata?.githubProfile;
  if (source?.owner && source?.repository)
    suggestions.push(`${source.owner}/${source.repository}`);
  if (profile?.login) suggestions.push(`${profile.login}/${profile.login}`);
  for (const b of draft.blocks || [])
    for (const p of b.type === "projects" ? b.settings.items || [] : []) {
      const match = (p.github || p.url || "").match(
        /^https:\/\/github.com\/([^/]+\/[^/#?]+)\/?$/,
      );
      if (match) suggestions.push(match[1]);
    }
  return [...new Set(suggestions)];
}

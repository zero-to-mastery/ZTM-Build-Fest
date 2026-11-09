import { githubRepository } from "../badges/providers/github.js";
import { safeUrl } from "../markdown/url-safety.js";
import { rateLimitMessage, networkMessage } from "../state/network-errors.js";
import { logos } from "../badges/badge-model.js";
import { normalizeProject } from "./project-model.js";
export function repositoryIdentity(value) {
  try {
    const u = new URL(value);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.hostname !== "github.com" ||
      u.username ||
      u.password
    )
      return "";
    return githubRepository(
      u.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, ""),
    ).toLowerCase();
  } catch {
    return "";
  }
}
const string = (v) => (typeof v === "string" ? v : "");
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
export function publicRepository(raw) {
  if (
    !raw ||
    raw.private === true ||
    (raw.visibility && raw.visibility !== "public")
  )
    throw new Error("Only public repositories can be imported.");
  const fullName =
    string(raw.full_name) || `${string(raw.owner?.login)}/${string(raw.name)}`;
  githubRepository(fullName);
  if (!string(raw.name))
    throw new Error("GitHub returned incomplete repository metadata.");
  return {
    name: raw.name,
    full_name: fullName,
    description: string(raw.description),
    html_url: `https://github.com/${fullName}`,
    homepage: /^https?:\/\//i.test(raw.homepage || "")
      ? safeUrl(raw.homepage, { relative: false })
      : "",
    language: string(raw.language),
    topics: Array.isArray(raw.topics)
      ? raw.topics.filter((t) => typeof t === "string").slice(0, 100)
      : [],
    stargazers_count: count(raw.stargazers_count),
    forks_count: count(raw.forks_count),
    archived: raw.archived === true,
    fork: raw.fork === true,
    created_at: string(raw.created_at),
    updated_at: string(raw.updated_at),
    pushed_at: string(raw.pushed_at),
    license: string(raw.license?.spdx_id) || string(raw.license),
    default_branch: string(raw.default_branch),
    visibility: "public",
    lastFetched: new Date().toISOString(),
  };
}
export async function fetchProject(
  repository,
  { fetcher = fetch, signal, timeout = 12000 } = {},
) {
  const name = githubRepository(repository.trim()),
    controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("Timeout", "TimeoutError")),
    timeout,
  );
  try {
    controller.signal.throwIfAborted();
    const response = await fetcher(`https://api.github.com/repos/${name}`, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? "Repository not found or not publicly available."
          : [403, 429].includes(response.status)
            ? rateLimitMessage(response)
            : `GitHub request failed (${response.status}).`,
      );
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("GitHub returned unreadable repository data.");
    }
    controller.signal.throwIfAborted();
    return publicRepository(data);
  } catch (e) {
    if (signal?.aborted) throw e;
    if (controller.signal.aborted)
      throw new Error("GitHub repository lookup timed out. Try again.");
    if (e instanceof TypeError) throw new Error(networkMessage());
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export async function fetchProjects(names, options = {}) {
  const unique = [...new Set(names)];
  if (unique.length > 50)
    throw new Error("Import up to 50 repositories at a time.");
  const results = Array(unique.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, unique.length) }, async () => {
      while (cursor < unique.length) {
        if (options.signal?.aborted) return;
        const i = cursor++;
        try {
          results[i] = {
            repository: unique[i],
            data: await fetchProject(unique[i], options),
          };
        } catch (e) {
          results[i] = { repository: unique[i], error: e.message };
        }
      }
    }),
  );
  return results.filter(Boolean);
}
export function suggestedTechnologies(repo) {
  const result = new Map();
  for (const name of [repo.language, ...repo.topics]) {
    if (!name) continue;
    const match = logos.find((t) =>
      [t.name, t.id, t.shieldsLogo, ...t.aliases].some(
        (v) => v.toLowerCase() === name.toLowerCase(),
      ),
    );
    if (match)
      result.set(match.id, {
        name: match.name,
        id: match.id,
        logo: match.shieldsLogo,
        brandColor: match.brandColor,
      });
    else if (name === repo.language) result.set(name.toLowerCase(), { name });
  }
  return [...result.values()];
}
export const importedFields = [
  "name",
  "description",
  "repositoryUrl",
  "liveUrl",
  "technologies",
  "status",
];
export function applyRepository(repo, fields, existing = null) {
  const p = existing ? structuredClone(existing) : normalizeProject({});
  const generated = { ...(p.metadata.github?.generatedFields || {}) },
    values = {
      name: repo.name,
      description: repo.description,
      repositoryUrl: repo.html_url,
      liveUrl: repo.homepage,
      technologies: suggestedTechnologies(repo),
      status: repo.archived ? "Archived" : "",
    },
    preserved = [];
  for (const key of importedFields) {
    if (!fields.includes(key)) continue;
    if (
      existing &&
      (!Object.hasOwn(generated, key) ||
        JSON.stringify(
          key === "technologies"
            ? normalizeProject({ technologies: p[key] }).technologies
            : p[key],
        ) !==
          JSON.stringify(
            key === "technologies"
              ? normalizeProject({ technologies: generated[key] }).technologies
              : generated[key],
          ))
    ) {
      preserved.push(key);
      continue;
    }
    p[key] = structuredClone(values[key]);
    generated[key] = structuredClone(values[key]);
  }
  const [owner, name] = repo.full_name.split("/");
  p.metadata.github = {
    owner,
    repo: name,
    lastFetched: repo.lastFetched,
    generatedFields: generated,
    snapshot: structuredClone(repo),
  };
  return { project: p, preserved };
}
export function filterRepositories(
  repos,
  {
    search = "",
    language = "",
    archived = "any",
    fork = "any",
    sort = "name",
  } = {},
) {
  return repos
    .filter(
      (r) =>
        (r.full_name + " " + r.description)
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (!language || r.language === language) &&
        (archived === "any" || r.archived === (archived === "only")) &&
        (fork === "any" || r.fork === (fork === "only")),
    )
    .sort((a, b) =>
      sort === "stars"
        ? (b.stargazers_count || 0) - (a.stargazers_count || 0)
        : sort === "updated"
          ? b.updated_at.localeCompare(a.updated_at)
          : a.full_name.localeCompare(b.full_name),
    );
}

export function repositoryChanges(repo, existing) {
  const next = applyRepository(repo, importedFields).project;
  return importedFields.filter(
    (k) =>
      Object.hasOwn(existing.metadata.github?.generatedFields || {}, k) &&
      JSON.stringify(existing.metadata.github.generatedFields[k]) !==
        JSON.stringify(next[k]),
  );
}

import { username } from "./constellation.mjs";
import { repositoryName } from "./repository-commits.mjs";
import { requireGitHubCapability } from "./github-access.mjs";

export function createContributedRepositories({
  fetchImpl = fetch,
  token,
  access = fetchImpl.access,
  storage,
} = {}) {
  let manualRequests = 0;
  const budgetKey = "constellation-public-manual-lookups-v1";
  try {
    const saved = Number(storage?.getItem(budgetKey));
    if (Number.isInteger(saved) && saved >= 0)
      manualRequests = Math.min(saved, 10);
  } catch {}
  const metadata = new Map(),
    epochs = new Map();
  async function request(path, refresh = false) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
      ...(refresh ? { refresh: true } : {}),
    });
    if (!response.ok)
      throw Error(
        [403, 429].includes(response.status)
          ? "GitHub request limit reached. Try again later."
          : response.status === 404
            ? "Repository not found. Enter a public repository as owner/repository."
            : `Could not load repositories (HTTP ${response.status}).`,
      );
    return response.json();
  }
  async function repository(value, { refresh = false } = {}) {
    const name = repositoryName(value),
      key = name.toLowerCase();
    if (!refresh && metadata.has(key)) return metadata.get(key);
    if (access?.mode === "public") {
      if (manualRequests >= 10)
        throw new Error(
          "Public mode allows 10 manual repository lookups per session. Keep exploring your loaded projects, or sign in with GitHub to add more.",
        );
      manualRequests++;
      try {
        storage?.setItem(budgetKey, String(manualRequests));
      } catch {}
    }
    const epoch = refresh ? (epochs.get(key) || 0) + 1 : epochs.get(key) || 0;
    if (refresh) epochs.set(key, epoch);
    const raw = await request(`/repos/${name}`, refresh);
    if (raw?.private !== false || raw.full_name?.toLowerCase() !== key)
      throw Error(
        "Choose a public repository. Private repositories are not supported.",
      );
    // Keep only public graph metadata, never permissions or token-bearing fields.
    const repo = Object.fromEntries(
      [
        "name",
        "full_name",
        "private",
        "created_at",
        "updated_at",
        "pushed_at",
        "archived",
        "fork",
        "stargazers_count",
        "forks_count",
        "language",
        "topics",
        "homepage",
        "default_branch",
        "description",
      ]
        .filter((field) => raw[field] !== undefined)
        .map((field) => [field, raw[field]]),
    );
    if ((epochs.get(key) || 0) === epoch) metadata.set(key, repo);
    return (epochs.get(key) || 0) === epoch ? repo : metadata.get(key) || repo;
  }
  async function discover(
    account,
    { organization = "", onProgress, refresh = false } = {},
  ) {
    requireGitHubCapability(access, "contributionDiscovery");
    const author = username(account),
      org = organization.trim() ? username(organization.trim()) : "";
    const names = new Map(),
      diagnostics = [];
    let partial = false;
    for (const kind of ["issues", "commits"]) {
      const query = `author:${author}${org ? ` org:${org}` : ""}${kind === "issues" ? " is:pr" : ""} is:public`;
      for (let page = 1; page <= 5; page++) {
        onProgress?.(
          `Searching public ${kind === "issues" ? "pull requests" : "commits"}… page ${page}`,
        );
        try {
          const body = await request(
            `/search/${kind}?q=${encodeURIComponent(query)}&per_page=100&page=${page}&sort=${kind === "issues" ? "created" : "committer-date"}&order=desc`,
            refresh,
          );
          if (!Array.isArray(body?.items))
            throw Error("Unexpected contribution search response.");
          for (const item of body.items) {
            if (
              kind === "issues"
                ? !item.pull_request ||
                  item.user?.login?.toLowerCase() !== author.toLowerCase()
                : item.author?.login?.toLowerCase() !== author.toLowerCase() ||
                  item.repository?.private !== false
            )
              continue;
            let name;
            try {
              name = repositoryName(
                kind === "issues"
                  ? String(item.repository_url || "").replace(
                      /^https:\/\/api\.github\.com\/repos\//,
                      "",
                    )
                  : item.repository.full_name,
              );
            } catch {
              continue;
            }
            if (org && name.split("/")[0].toLowerCase() !== org.toLowerCase())
              continue;
            names.set(name.toLowerCase(), name);
          }
          partial ||= !!body.incomplete_results;
          if (body.items.length < 100 || page * 100 >= body.total_count) break;
          if (page === 5) partial = true;
        } catch (error) {
          diagnostics.push(error.message);
          partial = true;
          break;
        }
      }
    }
    const repositories = [];
    // Bound metadata requests independently of the number of commits or PRs.
    if (names.size > 40) partial = true;
    for (const name of [...names.values()].slice(0, 40)) {
      onProgress?.(
        `Loading contributed repositories… ${repositories.length + 1}/${Math.min(40, names.size)}`,
      );
      try {
        repositories.push(await repository(name, { refresh }));
      } catch (error) {
        diagnostics.push(error.message);
        partial = true;
        if (/limit reached/.test(error.message)) break;
      }
    }
    if (partial)
      diagnostics.push(
        "Results are incomplete. Narrow the organization or add a repository directly.",
      );
    return {
      repositories,
      partial,
      diagnostic: [...new Set(diagnostics)].join(" "),
    };
  }
  return {
    repository,
    discover,
    remember(repositories) {
      for (const repo of repositories) {
        if (!repo || repo.private !== false) continue;
        try {
          metadata.set(repositoryName(repo.full_name).toLowerCase(), repo);
        } catch {}
      }
    },
  };
}

// Full names in saved selections must work on another device and in the CLI.
export async function loadSelectedRepositories(
  repositories,
  options,
  client,
  { refresh = false } = {},
) {
  if (options.repoSource === "pinned") return repositories;
  const names = new Map(
    repositories.map((repo) => [repo.full_name.toLowerCase(), repo]),
  );
  const missing = [
    ...new Set(
      (options.includeRepos || [])
        .filter((name) => name.includes("/"))
        .map((name) => repositoryName(name).toLowerCase()),
    ),
  ].filter((name) => !names.has(name));
  if (missing.length > 100)
    throw Error("Choose at most 100 additional repositories.");
  for (const name of missing) {
    const repo = await client.repository(name, { refresh });
    names.set(repo.full_name.toLowerCase(), repo);
  }
  return [...names.values()];
}

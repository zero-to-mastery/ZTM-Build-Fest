import { organizationOptions } from "./settings.mjs";
import {
  representativeRepositories,
  scopeRepositories,
  normalizeContributors,
} from "./model.mjs";
const safeName = (value) => {
  if (!/^[a-z\d][a-z\d-]{0,38}$/i.test(value)) throw Error("Invalid account.");
  return value;
};
const repositoryMetadata = (repo) =>
  Object.fromEntries(
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
    ].map((field) => [field, repo[field]]),
  );
export function attachFocusEvidence(snapshot, focus, login, repos) {
  if (!focus || !login) return snapshot;
  const records = Object.fromEntries(
    Object.entries(snapshot.records || {}).map(([id, rows]) => [
      id,
      rows.map((row) => ({ ...row })),
    ]),
  );
  for (const repo of focus.repositories) {
    const evidence = focus.evidence[repo.full_name];
    if (!evidence) continue;
    const rows = (records[repo.full_name] ||= []);
    let person = rows.find(
      (row) => row.login?.toLowerCase() === login.toLowerCase(),
    );
    if (!person) {
      person = { login, contributions: 0 };
      rows.push(person);
    }
    person.pullRequestCount = evidence.count;
    person.evidenceUrl = evidence.url;
  }
  return {
    ...snapshot,
    records,
    contributors: normalizeContributors(records, repos),
    focus: {
      login,
      totalPullRequests: focus.total,
      foundRepositories: focus.repositories.length,
      partial: focus.partial,
      diagnostic: focus.diagnostic,
    },
    diagnostic: [snapshot.diagnostic, focus.diagnostic]
      .filter(Boolean)
      .join(" "),
  };
}
export function createOrganizationData({
  fetchImpl = fetch,
  token,
  storage,
} = {}) {
  const key = "constellation-organization-v1";
  let cache = {};
  try {
    cache = JSON.parse(storage?.getItem(key) || "{}");
    if (!cache || Array.isArray(cache) || typeof cache !== "object") cache = {};
  } catch {}
  const epochs = new Map();
  const save = () => {
    try {
      storage?.setItem(key, JSON.stringify(cache));
    } catch {}
  };
  const request = async (path, refresh = false) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
      ...(refresh ? { refresh: true } : {}),
    });
    if (!response.ok) {
      const error = Error(
        response.status === 403 || response.status === 429
          ? "GitHub request limit reached; cached partial results retained."
          : `GitHub request failed (${response.status}).`,
      );
      error.rateLimited = [403, 429].includes(response.status);
      throw error;
    }
    const body = response.status === 204 ? [] : await response.json();
    return {
      body,
      exhausted: response.headers?.get("x-ratelimit-remaining") === "0",
    };
  };
  async function resolve(account, options = {}, refresh = false) {
    const name = safeName(account).toLowerCase(),
      { accountType } = organizationOptions(options);
    const id = `account:${name}:${accountType}`;
    if (!refresh && cache[id]) return cache[id];
    const epoch = refresh ? (epochs.get(id) || 0) + 1 : epochs.get(id) || 0;
    if (refresh) epochs.set(id, epoch);
    const isCurrent = () => (epochs.get(id) || 0) === epoch;
    const { body } = await request(
      `/${accountType === "organization" ? "orgs" : "users"}/${name}`,
      refresh,
    );
    if (!isCurrent()) return cache[id];
    if (!body || !["User", "Organization"].includes(body.type))
      throw Error("Unexpected GitHub account response.");
    const actual =
      accountType === "auto"
        ? body.type
        : accountType === "user"
          ? "User"
          : "Organization";
    let metadata = body;
    if (actual === "Organization" && accountType === "auto")
      metadata = (await request(`/orgs/${name}`, refresh)).body;
    const result = Object.fromEntries(
      [
        "login",
        "name",
        "description",
        "avatar_url",
        "html_url",
        "blog",
        "location",
        "created_at",
        "public_repos",
        "followers",
      ].map((field) => [field, metadata[field] ?? null]),
    );
    result.type = actual;
    if (isCurrent()) {
      cache[id] = result;
      save();
    }
    return isCurrent() ? result : cache[id] || result;
  }
  async function discover(
    account,
    options = {},
    { refresh = false, onProgress } = {},
  ) {
    const name = safeName(account).toLowerCase(),
      settings = organizationOptions(options);
    const sort =
      settings.scope === "active"
        ? "pushed"
        : settings.scope === "recent"
          ? "updated"
          : "full_name";
    const id = `repos:${name}:${sort}`;
    if (refresh) delete cache[id];
    const state = (cache[id] ||= { repos: [], nextPage: 1, complete: false });
    const maxPages = settings.scope === "all-metadata" ? 1000 : 3;
    let diagnostic = "";
    try {
      while (!state.complete && state.nextPage <= maxPages) {
        const { body, exhausted } = await request(
          `/orgs/${name}/repos?type=public&sort=${sort}&per_page=100&page=${state.nextPage}`,
          refresh,
        );
        if (!Array.isArray(body))
          throw Error("Unexpected organization repository response.");
        const known = new Set(state.repos.map((repo) => repo.full_name));
        for (const repo of body)
          if (
            repo.private === false &&
            repo.full_name?.toLowerCase().startsWith(`${name}/`) &&
            !known.has(repo.full_name)
          ) {
            state.repos.push(repositoryMetadata(repo));
            known.add(repo.full_name);
          }
        state.nextPage++;
        state.complete = body.length < 100;
        save();
        onProgress?.(state.repos.length);
        if (exhausted && !state.complete) {
          diagnostic =
            "GitHub request limit reached; partial metadata retained.";
          break;
        }
      }
    } catch (error) {
      if (!state.repos.length) throw error;
      diagnostic = error.message;
    }
    return {
      repositories: state.repos,
      complete: state.complete,
      diagnostic,
      discovered: state.repos.length,
    };
  }
  async function focusRepositories(account, login, { refresh = false } = {}) {
    const name = safeName(account).toLowerCase(),
      user = safeName(login).toLowerCase(),
      id = `focus:${name}:${user}`;
    if (refresh) delete cache[id];
    const state = (cache[id] ||= {
      evidence: {},
      nextPage: 1,
      total: 0,
      complete: false,
    });
    const repositories = [],
      diagnostics = [];
    try {
      while (!state.complete && state.nextPage <= 5) {
        const query = encodeURIComponent(
          `author:${user} org:${name} is:pr is:public`,
        );
        const { body, exhausted } = await request(
          `/search/issues?q=${query}&per_page=100&page=${state.nextPage}&sort=created&order=desc`,
          refresh,
        );
        if (!Array.isArray(body.items))
          throw Error("Unexpected contribution search response.");
        state.total = Number(body.total_count) || 0;
        for (const item of body.items) {
          const fullName = item.repository_url?.replace(
            "https://api.github.com/repos/",
            "",
          );
          if (
            !item.pull_request ||
            item.user?.login?.toLowerCase() !== user ||
            !fullName?.toLowerCase().startsWith(`${name}/`) ||
            !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(fullName) ||
            !Number.isInteger(item.number)
          )
            continue;
          const evidence = (state.evidence[fullName] ||= {
            numbers: [],
            count: 0,
            url: `https://github.com/${fullName}/pull/${item.number}`,
          });
          if (!evidence.numbers.includes(item.number)) {
            evidence.numbers.push(item.number);
            evidence.count++;
          }
        }
        state.nextPage++;
        state.complete =
          !body.incomplete_results &&
          ((state.nextPage - 1) * 100 >= state.total ||
            body.items.length < 100);
        save();
        if (exhausted) break;
      }
      // Fetch actual public project metadata; never manufacture repositories from search hits.
      for (const fullName of Object.keys(state.evidence).sort().slice(0, 20)) {
        const repoId = `focus-repository:${fullName}`;
        if (refresh || !cache[repoId]) {
          const epoch = refresh
            ? (epochs.get(repoId) || 0) + 1
            : epochs.get(repoId) || 0;
          if (refresh) epochs.set(repoId, epoch);
          const { body } = await request(`/repos/${fullName}`, refresh);
          if (
            body.private !== false ||
            body.full_name?.toLowerCase() !== fullName.toLowerCase()
          )
            continue;
          if ((epochs.get(repoId) || 0) === epoch) {
            cache[repoId] = repositoryMetadata(body);
            save();
          }
        }
        repositories.push({ ...cache[repoId], focusCandidate: user });
      }
    } catch (error) {
      diagnostics.push("Targeted contribution lookup: " + error.message);
    }
    // Retain metadata already fetched before a failed refresh or rate limit.
    for (const fullName of Object.keys(state.evidence).sort().slice(0, 20))
      if (
        !repositories.some((repo) => repo.full_name === fullName) &&
        cache[`focus-repository:${fullName}`]
      )
        repositories.push({
          ...cache[`focus-repository:${fullName}`],
          focusCandidate: user,
        });
    return {
      repositories,
      evidence: state.evidence,
      total: state.total,
      partial:
        !state.complete ||
        Object.keys(state.evidence).length > repositories.length,
      diagnostic: diagnostics.join(" "),
    };
  }
  async function contributors(
    repos,
    options,
    { refresh = false, onProgress } = {},
  ) {
    const settings = organizationOptions(options).contributors;
    if (!settings.enabled || settings.strategy === "off")
      return {
        contributors: [],
        records: {},
        scanned: 0,
        selected: 0,
        diagnostic: "Contributor discovery is off.",
      };
    const count = Math.min(
      settings.maxRepositories,
      settings.strategy === "deep" ? 2000 : 100,
    );
    const targets = repos.filter(
      (repo) =>
        repo.focusCandidate === options.organizationUser?.toLowerCase() &&
        repo.focusCandidate,
    );
    const rest = repos.filter((repo) => !targets.includes(repo));
    const selected = [
      ...targets,
      ...(settings.strategy === "representative" || settings.strategy === "deep"
        ? representativeRepositories(rest, count)
        : scopeRepositories(
            rest,
            {
              ...options,
              organizationScope:
                settings.strategy === "featured" ? "featured" : "active",
            },
            count,
          )),
    ].slice(0, count);
    const records = {},
      diagnostics = [];
    let cursor = 0,
      stop = false;
    // Three workers at most; stop scheduling when GitHub reports a rate limit.
    await Promise.all(
      Array.from({ length: Math.min(3, selected.length) }, async () => {
        while (!stop && cursor < selected.length) {
          const repo = selected[cursor++],
            id = `contributors:${repo.full_name}:${settings.maxContributorsPerRepo}`;
          if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repo.full_name))
            continue;
          try {
            const epoch = refresh
              ? (epochs.get(id) || 0) + 1
              : epochs.get(id) || 0;
            if (refresh) epochs.set(id, epoch);
            if (refresh || !cache[id]) {
              const { body, exhausted } = await request(
                `/repos/${repo.full_name}/contributors?per_page=${settings.maxContributorsPerRepo}&page=1`,
                refresh,
              );
              if (!Array.isArray(body))
                throw Error("Unexpected contributor response.");
              if ((epochs.get(id) || 0) === epoch) {
                cache[id] = body
                  .slice(0, settings.maxContributorsPerRepo)
                  .map(({ login, avatar_url, contributions }) => ({
                    login,
                    avatar_url,
                    contributions,
                  }));
                save();
              }
              if (exhausted) {
                stop = true;
                diagnostics.push("GitHub request limit reached.");
              }
            }
            if (cache[id]) records[repo.full_name] = cache[id];
            onProgress?.(Object.keys(records).length, selected.length);
          } catch (error) {
            diagnostics.push(error.message);
            if (cache[id]) records[repo.full_name] = cache[id];
            if (error.rateLimited) stop = true;
          }
        }
      }),
    );
    // Cached results are still usable after a rate limit stopped new requests.
    for (const repo of selected) {
      const value =
        cache[
          `contributors:${repo.full_name}:${settings.maxContributorsPerRepo}`
        ];
      if (value) records[repo.full_name] = value;
    }
    return {
      contributors: normalizeContributors(records, repos),
      records,
      scanned: Object.keys(records).length,
      selected: selected.length,
      perRepositoryLimit: settings.maxContributorsPerRepo,
      diagnostic: [...new Set(diagnostics)].join(" "),
      complete: false,
    };
  }
  return { resolve, discover, contributors, focusRepositories };
}

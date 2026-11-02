import {
  username,
  fetchRepositories,
  fetchRepositoryLanguages,
  fetchPinnedRepositories,
  selectRepositoryPool,
  graphNodes,
} from "./constellation.mjs";
import { fetchPublicActivity } from "./github-activity.mjs";
import { sanitizeActivityEvents } from "./activity.mjs";
import {
  createOrganizationData,
  attachFocusEvidence,
} from "./organization/data.mjs";
import {
  organizationEnabled,
  needsContributorData,
} from "./organization/settings.mjs";
import {
  createContributedRepositories,
  loadSelectedRepositories,
} from "./contributed-repositories.mjs";
import { createRepositoryCommits } from "./repository-commits.mjs";
import { commitHistoryOptions } from "./commit-constellation.mjs";
import { createGitHubRequestCache } from "./github-request-cache.mjs";
import {
  createGitHubAccess,
  requireGitHubCapability,
} from "./github-access.mjs";

// Match the studio's render gate, not just repository metadata. A recipe that
// needs uncached languages would leave the previous (possibly empty) SVG visible.
export function canRenderPreview(repositories, options, access, { allowPrimaryLanguages = false } = {}) {
  if (options.nodeMode === "commits")
    return graphNodes(repositories, options).nodes.length > 0;
  const pool = selectRepositoryPool(repositories, options);
  if (
    !pool.length ||
    (!allowPrimaryLanguages && access?.mode !== "public" &&
      !organizationEnabled(options) &&
      pool.some((repo) => !repo.languages))
  )
    return false;
  const hidden = new Set(options.hiddenNodes || []);
  return graphNodes(repositories, options).nodes.some(
    (node) => !hidden.has(node.full_name),
  );
}

export function createPreviewFetch({
  proxyBase,
  fetchImpl = fetch,
  session,
  storage,
  localAuth = false,
  requestCache,
} = {}) {
  const access = createGitHubAccess({
    authenticated: () => Boolean(session?.token || (proxyBase && localAuth)),
  });
  const cache =
    requestCache ||
    createGitHubRequestCache({
      storage: localAuth ? undefined : storage,
      fetchImpl: (url, options) => {
        const target = new URL(url);
        if (session?.token && target.origin === "https://api.github.com")
          return session.fetch(url, options);
        const destination =
          proxyBase && localAuth && target.origin === "https://api.github.com"
            ? `${proxyBase}${target.pathname}${target.search}`
            : url;
        return fetchImpl(destination, options);
      },
    });
  const cachedFetch = (url, options = {}) => {
    const target = new URL(url);
    if (!access.authenticated && target.origin === "https://api.github.com") {
      const path = target.pathname;
      const metadata = /^\/repos\/[^/]+\/[^/]+$/.test(path);
      // The explicit project-structure workflow is separately bounded by
      // fetchGitHubProjectConstellation (tree, manifest, and file byte limits).
      const projectStructure = /^\/repos\/[\w.-]{1,100}\/[\w.-]{1,100}\/(?:commits\/[^/]{1,256}|git\/trees\/[a-f\d]{40}|contents\/.+)$/.test(path);
      const profile = /^\/(users|orgs)\/[^/]+$/.test(path);
      const listing =
        /^\/(users|orgs)\/[^/]+\/repos$/.test(path) &&
        Number(target.searchParams.get("page") || 1) === 1 &&
        Number(target.searchParams.get("per_page") || 30) <= 100;
      if (
        (options.method && options.method !== "GET") ||
        !(metadata || profile || listing || projectStructure)
      )
        return Promise.reject(
          new Error("Sign in with GitHub to load this data."),
        );
    }
    const authContext =
      session?.token ||
      (proxyBase && localAuth && target.origin === "https://api.github.com"
        ? "local-proxy-authenticated"
        : null);
    return cache.fetch(url, options, {
      authContext,
      publicBudget: !access.authenticated,
    });
  };
  cachedFetch.requestCache = cache;
  cachedFetch.access = access;
  return cachedFetch;
}

export function createPinnedFetch({
  proxyBase,
  fetchImpl = fetch,
  session,
  localAuth = false,
} = {}) {
  return async (account) => {
    if (session?.token)
      return fetchPinnedRepositories(account, {
        token: session.token,
        fetchImpl: session.fetch,
      });
    if (!proxyBase || !localAuth)
      throw new Error(
        "Continue with GitHub to preview pinned repositories, or use GH_TOKEN in the local studio.",
      );
    const response = await fetchImpl(
      `${proxyBase}/users/${username(account)}/pinned`,
      { signal: AbortSignal.timeout(20000) },
    );
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.message || "Could not load pinned repositories.");
    if (!Array.isArray(body))
      throw new Error("Unexpected pinned repository response.");
    return body;
  };
}

// Network requests are explicit; rendering and customization read snapshots.
export function createPreviewData({
  storage,
  fetchImpl = fetch,
  fetchPinned = createPinnedFetch(),
  access = fetchImpl.access || createGitHubAccess(),
} = {}) {
  const organization = createOrganizationData({ storage, fetchImpl });
  const contributed = createContributedRepositories({
    fetchImpl,
    access,
    storage,
  });
  const commitClient = createRepositoryCommits({ fetchImpl, access }),
    commitSnapshots = new Map();
  const profiles = new Map(),
    organizationSnapshots = new Map();
  const key = "constellation-public-data-v1";
  let accounts = {};
  let modes = {};
  let manual = {};
  try {
    const saved = JSON.parse(storage?.getItem(key) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved))
      accounts = saved;
    const savedModes = JSON.parse(storage?.getItem(key + "-modes") || "{}");
    if (
      savedModes &&
      typeof savedModes === "object" &&
      !Array.isArray(savedModes)
    )
      modes = savedModes;
    const savedManual = JSON.parse(storage?.getItem(key + "-manual") || "{}");
    if (
      savedManual &&
      typeof savedManual === "object" &&
      !Array.isArray(savedManual)
    )
      manual = Object.fromEntries(
        Object.entries(savedManual).filter(([, names]) => Array.isArray(names)),
      );
  } catch {
    /* Storage is optional, including in private browsing. */
  }
  for (const repositories of Object.values(accounts))
    if (Array.isArray(repositories)) contributed.remember(repositories);
  const caches = new Map();
  const pending = new Map();
  const loadEpochs = new Map();
  const activityKey = "constellation-public-activity-v1";
  let activityAccounts = {};
  try {
    const saved = JSON.parse(storage?.getItem(activityKey) || "{}");
    if (saved && !Array.isArray(saved) && typeof saved === "object")
      activityAccounts = Object.fromEntries(
        Object.entries(saved)
          .filter(([, value]) => Number.isFinite(Date.parse(value?.asOf)))
          .map(([account, value]) => [
            account,
            {
              asOf: value.asOf,
              coverageStart: Number.isFinite(Date.parse(value.coverageStart))
                ? value.coverageStart
                : undefined,
              events: sanitizeActivityEvents(value.events),
              diagnostic: value.diagnostic
                ? "Public activity unavailable. Refresh data to retry."
                : "",
            },
          ]),
      );
  } catch {}
  const activityPending = new Map();
  const activityEpochs = new Map();
  async function loadActivity(name, refresh) {
    requireGitHubCapability(access, "activity");
    if (activityPending.has(name) && !refresh) return activityPending.get(name);
    if (!refresh && Object.hasOwn(activityAccounts, name))
      return activityAccounts[name];
    const epoch = refresh
      ? (activityEpochs.get(name) || 0) + 1
      : activityEpochs.get(name) || 0;
    if (refresh) activityEpochs.set(name, epoch);
    const request = fetchPublicActivity(name, {
      fetchImpl,
      accountType:
        profiles.get(name)?.type === "Organization" ? "organization" : "user",
    }).then((snapshot) => {
      if ((activityEpochs.get(name) || 0) === epoch) {
        activityAccounts[name] = snapshot;
        try {
          storage?.setItem(activityKey, JSON.stringify(activityAccounts));
        } catch {}
      }
      return snapshot;
    });
    activityPending.set(name, request);
    try {
      return await request;
    } finally {
      if (activityPending.get(name) === request) activityPending.delete(name);
    }
  }
  const save = () => {
    try {
      storage?.setItem(key, JSON.stringify(accounts));
      storage?.setItem(key + "-modes", JSON.stringify(modes));
      storage?.setItem(key + "-manual", JSON.stringify(manual));
    } catch {}
  };
  const sourceKey = (account, options = {}) => {
    const source = options.repoSource ?? "all";
    if (!["all", "pinned"].includes(source))
      throw new Error("repoSource must be all or pinned.");
    return (
      username(account).toLowerCase() + (source === "pinned" ? ":pinned" : "")
    );
  };
  const snapshot = (account, options) => {
    const value = accounts[sourceKey(account, options)];
    return Array.isArray(value) ? value : undefined;
  };
  async function load(
    account,
    options = {},
    {
      refresh = false,
      onProgress,
      activity = access.capabilities.activity,
      languages = access.capabilities.languageBreakdowns,
    } = {},
  ) {
    const name = username(account).toLowerCase();
    if (options.repoSource === "pinned")
      requireGitHubCapability(access, "pinnedRepositories");
    if (options.nodeMode === "commits")
      requireGitHubCapability(access, "commitHistory");
    const key = sourceKey(name, options);
    if (pending.has(key) && !refresh) return pending.get(key);
    const epoch = refresh
      ? (loadEpochs.get(key) || 0) + 1
      : loadEpochs.get(key) || 0;
    if (refresh) loadEpochs.set(key, epoch);
    const isCurrent = () => (loadEpochs.get(key) || 0) === epoch;
    const request = (async () => {
      if (!access.authenticated) {
        // Publish atomically: a failed refresh leaves the previous snapshot usable.
        let profile = !refresh && profiles.get(name);
        if (!profile) {
          const response = await fetchImpl(
            `https://api.github.com/users/${name}`,
            { refresh },
          );
          if (!response.ok)
            throw new Error(
              `Could not load public account (HTTP ${response.status}).`,
            );
          const raw = await response.json();
          profile = {
            login: raw.login || name,
            name: raw.name,
            type: raw.type || "User",
            avatar_url: raw.avatar_url,
            public_repos: raw.public_repos,
          };
        }
        if (!isCurrent()) return snapshot(name, options);
        let listed = !refresh && snapshot(name, options);
        if (!listed) {
          const kind = profile.type === "Organization" ? "orgs" : "users";
          const response = await fetchImpl(
            `https://api.github.com/${kind}/${name}/repos?type=${kind === "orgs" ? "public" : "owner"}&sort=updated&per_page=100&page=1`,
            { refresh },
          );
          if (!response.ok)
            throw new Error(
              `Could not load public repositories (HTTP ${response.status}).`,
            );
          const raw = await response.json();
          if (!Array.isArray(raw))
            throw new Error("Unexpected repository response.");
          listed = raw
            .slice(0, 100)
            .filter(
              (repo) =>
                repo.private === false &&
                repo.full_name?.split("/")[0].toLowerCase() === name,
            );
          const remembered = new Set(manual[key] || []);
          const external = (snapshot(name, options) || []).filter(
            (repo) =>
              repo.private === false &&
              (remembered.has(repo.full_name.toLowerCase()) ||
                repo.full_name?.split("/")[0].toLowerCase() !== name),
          );
          listed = [
            ...new Map(
              [...external, ...listed].map((repo) => [
                repo.full_name.toLowerCase(),
                repo,
              ]),
            ).values(),
          ];
        }
        if (isCurrent()) {
          profiles.set(name, profile);
          accounts[key] = listed;
          modes[key] = "public";
          contributed.remember(listed);
          save();
        }
        return snapshot(name, options);
      }
      const profile = await organization.resolve(name, options, refresh);
      if (!isCurrent()) return snapshot(name, options);
      profiles.set(name, profile);
      const effective = { ...options, accountData: profile };
      const focus =
        profile.type === "Organization" && options.organizationUser
          ? await organization.focusRepositories(
              name,
              options.organizationUser,
              { refresh },
            )
          : null;
      if (!isCurrent()) return snapshot(name, options);
      // Keep the previous snapshot available if refreshing fails.
      let listed =
        !refresh && modes[key] !== "public" && snapshot(name, options);
      let discovered;
      if (profile.type === "Organization" && options.repoSource !== "pinned") {
        discovered = await organization.discover(name, options, { refresh });
        const hydrated = new Map(
          (listed || []).map((repo) => [repo.full_name, repo.languages]),
        );
        listed = discovered.repositories.map((repo) => ({
          ...repo,
          ...(hydrated.get(repo.full_name)
            ? { languages: hydrated.get(repo.full_name) }
            : {}),
        }));
      } else if (!listed)
        listed =
          options.repoSource === "pinned"
            ? await fetchPinned(name)
            : await fetchRepositories(name, { fetchImpl });
      if (!isCurrent()) return snapshot(name, options);
      if (focus && options.repoSource !== "pinned")
        listed = [
          ...new Map(
            [...listed, ...focus.repositories].map((repo) => [
              repo.full_name,
              repo,
            ]),
          ).values(),
        ];
      listed = await loadSelectedRepositories(listed, options, contributed, {
        refresh,
      });
      if (!isCurrent()) return snapshot(name, options);
      if (refresh) caches.delete(name);
      const cache = caches.get(name) || new Map();
      caches.set(name, cache);
      accounts[key] = listed;
      modes[key] = "authenticated";
      if (isCurrent()) save();
      if (activity) await loadActivity(name, refresh);
      if (!isCurrent()) return snapshot(name, options);
      if (options.nodeMode === "commits") {
        const history = commitHistoryOptions(options),
          previous = commitSnapshots.get(name);
        if (
          history &&
          (refresh ||
            !previous ||
            previous.repository.toLowerCase() !==
              history.repository.toLowerCase() ||
            (history.branch && previous.branch !== history.branch))
        ) {
          const historyData = await commitClient.load(history.repository, {
            branch: history.branch,
            refresh,
          });
          if (isCurrent()) commitSnapshots.set(name, historyData);
        }
        if (!isCurrent()) return snapshot(name, options);
      }
      if (needsContributorData(effective)) {
        const targets =
          profile.type === "Organization"
            ? listed
            : selectRepositoryPool(listed, effective);
        const loadedContributors = await organization.contributors(
          targets,
          effective,
          { refresh },
        );
        if (!isCurrent()) return snapshot(name, options);
        const contributors = attachFocusEvidence(
          loadedContributors,
          focus,
          options.organizationUser,
          targets,
        );
        organizationSnapshots.set(name, {
          ...contributors,
          discovered: listed.length,
          metadataComplete: discovered?.complete ?? true,
          diagnostic: [discovered?.diagnostic, contributors.diagnostic]
            .filter(Boolean)
            .join(" "),
        });
        effective.organizationData = organizationSnapshots.get(name);
      }
      try {
        if (languages && options.nodeMode !== "commits")
          await fetchRepositoryLanguages(
            selectRepositoryPool(listed, effective),
            { fetchImpl, cache, onProgress },
          );
      } catch (error) {
        if (profile.type !== "Organization") throw error;
        organizationSnapshots.get(name).diagnostic +=
          " Some language details unavailable; using primary languages. " +
          error.message;
      } finally {
        // Preserve successful lookups even when another request hits a rate limit.
        if (isCurrent()) {
          const entries = await Promise.all(
            [...cache].map(async ([repo, value]) => {
              try {
                return [repo, await value];
              } catch {
                return [repo, undefined];
              }
            }),
          );
          if (isCurrent()) {
            const languages = new Map(entries);
            accounts[key] = listed.map((repo) =>
              languages.get(repo.full_name) !== undefined
                ? { ...repo, languages: languages.get(repo.full_name) }
                : repo,
            );
            save();
          }
        }
      }
      return snapshot(name, options);
    })();
    pending.set(key, request);
    try {
      return await request;
    } finally {
      if (pending.get(key) === request) pending.delete(key);
    }
  }
  function remember(account, repositories) {
    const key = sourceKey(account);
    manual[key] = [
      ...new Set([
        ...(manual[key] || []),
        ...repositories.map((repo) => repo.full_name.toLowerCase()),
      ]),
    ];
    if (Array.isArray(accounts[key])) {
      const merged = new Map(
        accounts[key].map((repo) => [repo.full_name.toLowerCase(), repo]),
      );
      for (const repo of repositories)
        if (!merged.has(repo.full_name.toLowerCase()))
          merged.set(repo.full_name.toLowerCase(), repo);
      accounts[key] = [...merged.values()];
      save();
    }
  }
  return {
    access,
    snapshot,
    load,
    loadActivity: (account, refresh = false) =>
      loadActivity(username(account).toLowerCase(), refresh),
    contributed,
    remember,
    requestCache: fetchImpl.requestCache,
    commitHistory: (account) =>
      commitSnapshots.get(username(account).toLowerCase()),
    setCommitHistory: (account, snapshot) =>
      commitSnapshots.set(username(account).toLowerCase(), snapshot),
    activity: (account) => activityAccounts[username(account).toLowerCase()],
    profile: (account) => profiles.get(username(account).toLowerCase()),
    organization: (account) =>
      organizationSnapshots.get(username(account).toLowerCase()),
  };
}

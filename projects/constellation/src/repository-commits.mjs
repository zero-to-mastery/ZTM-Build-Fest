const repoPattern = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]+$/i;
const shaPattern = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
export function repositoryName(value) {
  const name = String(value || "")
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\/$/, "");
  if (
    !repoPattern.test(name) ||
    name.split("/")[1] === "." ||
    name.split("/")[1] === ".."
  )
    throw Error("Choose a repository or enter owner/repository.");
  return name;
}
export function normalizeCommits(raw) {
  if (!Array.isArray(raw)) throw Error("Unexpected commit history response.");
  const seen = new Set();
  return raw.flatMap((item) => {
    if (!shaPattern.test(item?.sha) || seen.has(item.sha)) return [];
    seen.add(item.sha);
    const login =
      typeof item.author?.login === "string" &&
      /^[a-z\d][a-z\d-]*(?:\[bot\])?$/i.test(item.author.login)
        ? item.author.login
        : null;
    return [
      {
        sha: item.sha,
        parents: [
          ...new Set(
            (item.parents || [])
              .map((parent) => parent.sha)
              .filter((sha) => shaPattern.test(sha) && sha !== item.sha),
          ),
        ],
        login,
        author:
          login ||
          String(item.commit?.author?.name || "Unlinked author").slice(0, 80),
        date: Number.isFinite(Date.parse(item.commit?.committer?.date))
          ? new Date(item.commit.committer.date).toISOString()
          : null,
        subject: String(item.commit?.message || "Untitled commit")
          .split(/\r?\n/)[0]
          .slice(0, 140),
      },
    ];
  });
}

export function createRepositoryCommits({ fetchImpl = fetch, token, access = fetchImpl.access } = {}) {
  const cache = new Map(),
    pending = new Map(),
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
    if (response.status === 409) return { empty: true };
    if (!response.ok)
      throw Error(
        [403, 429].includes(response.status)
          ? "GitHub request limit reached. Try again later or use the authenticated local Studio."
          : response.status === 404
            ? "Repository or branch not found."
            : `Could not load commit history (HTTP ${response.status}).`,
      );
    return {
      body: response.status === 204 ? [] : await response.json(),
      more: /rel="next"/.test(response.headers.get("link") || ""),
    };
  }
  async function load(
    value,
    { branch = "", refresh = false, limit = 300 } = {},
  ) {
    if (access && !access.capabilities.commitHistory) throw new Error("Sign in with GitHub to load repository history and commit activity.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 300)
      throw Error("Commit limit must be between 1 and 300.");
    const name = repositoryName(value),
      ref = branch.trim();
    if (ref.length > 200 || /[\x00-\x1f]/.test(ref))
      throw Error("Invalid branch or commit reference.");
    const key = `${name.toLowerCase()}:${ref}:${limit}`;
    if (pending.has(key) && !refresh) return pending.get(key);
    if (!refresh && cache.has(key)) return cache.get(key);
    const epoch = refresh ? (epochs.get(key) || 0) + 1 : epochs.get(key) || 0;
    if (refresh) epochs.set(key, epoch);
    const isCurrent = () => (epochs.get(key) || 0) === epoch;
    const operation = (async () => {
      const metadata = (await request(`/repos/${name}`, refresh)).body;
      if (!isCurrent()) return pending.get(key) || cache.get(key);
      if (
        !metadata ||
        metadata.private !== false ||
        metadata.full_name?.toLowerCase() !== name.toLowerCase()
      )
        throw Error("Choose a public repository.");
      const selectedBranch = ref || metadata.default_branch || "HEAD";
      let commits = [],
        more = false,
        diagnostic = "",
        head = selectedBranch;
      for (let page = 1; page <= Math.ceil(limit / 100); page++) {
        try {
          const result = await request(
            `/repos/${name}/commits?per_page=${Math.min(100, limit)}&page=${page}&sha=${encodeURIComponent(head)}`,
            refresh,
          );
          if (!isCurrent()) return pending.get(key) || cache.get(key);
          if (result.empty) {
            if (page === 1) break;
            throw Error("History changed while loading. Refresh to retry.");
          }
          const batch = normalizeCommits(result.body);
          if (page === 1 && batch.length) head = batch[0].sha;
          const known = new Set(commits.map((commit) => commit.sha));
          commits.push(...batch.filter((commit) => !known.has(commit.sha)));
          more = result.more;
          if (!more) break;
        } catch (error) {
          if (!commits.length) throw error;
          diagnostic = `${error.message} Showing the commits already loaded.`;
          more = true;
          break;
        }
      }
      const snapshot = {
        repository: metadata.full_name,
        branch: selectedBranch,
        commits: commits.slice(0, limit),
        partial: more || commits.length > limit,
        diagnostic,
      };
      if (!diagnostic && isCurrent()) cache.set(key, snapshot);
      return snapshot;
    })();
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      if (pending.get(key) === operation) pending.delete(key);
    }
  }
  return { load };
}

import { githubUsername } from "../state/github-profile.js";
import { publicRepository } from "../projects/github-project.js";
import { githubRepository } from "../badges/providers/github.js";
import { boundedText } from "../state/import.js";
import { networkMessage, rateLimitMessage } from "../state/network-errors.js";

export const REPOSITORY_LIMIT = 1000,
  README_LIMIT = 1_000_000;
const TTL = 5 * 60_000,
  CACHE_BYTES = 20_000_000;
export class AuditError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}
export class AuditClient {
  constructor({
    fetcher = fetch,
    now = () => Date.now(),
    timeout = 15000,
  } = {}) {
    this.fetcher = (...args) => fetcher(...args);
    this.now = now;
    this.timeout = timeout;
    this.histories = new Map();
    this.cooldown = 0;
    this.pages = new Map();
    this.readmes = new Map();
    this.bytes = 0;
  }
  clear() {
    this.histories.clear();
    this.pages.clear();
    this.readmes.clear();
    this.bytes = 0;
  }
  async request(path, signal) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      if (this.now() < this.cooldown)
        throw new AuditError(
          "rate-limit",
          `GitHub requests paused until ${new Date(this.cooldown).toLocaleTimeString()}. Completed results are retained.`,
        );
      try {
        return await this.requestOnce(path, signal);
      } catch (error) {
        if (
          signal?.aborted ||
          attempt >= 1 ||
          !["transient", "network"].includes(error.kind)
        )
          throw error;
        await new Promise((resolve, reject) => {
          const finish = () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          };
          const timer = setTimeout(finish, 300);
          const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(signal.reason);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
    }
  }
  async requestOnce(path, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException("Timeout", "TimeoutError")),
      this.timeout,
    );
    try {
      controller.signal.throwIfAborted();
      const response = await this.fetcher(`https://api.github.com${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 404)
          throw new AuditError(
            "not-found",
            "GitHub resource not found or no longer public.",
          );
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers.get("x-ratelimit-remaining") === "0" ||
              response.headers.has("retry-after")))
        ) {
          const retry = response.headers.get("retry-after"),
            reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
          const after =
            retry && /^\d+$/.test(retry)
              ? this.now() + Number(retry) * 1000
              : Date.parse(retry);
          this.cooldown = Math.max(
            this.now() + 60_000,
            Number.isFinite(after) ? after : 0,
            Number.isFinite(reset) ? reset : 0,
          );
          throw new AuditError("rate-limit", rateLimitMessage(response));
        }
        if (response.status === 403)
          throw new AuditError(
            "forbidden",
            "GitHub denied the request. Access restrictions or a secondary rate limit may apply; try again later.",
          );
        throw new AuditError(
          [502, 503, 504].includes(response.status) ? "transient" : "http",
          `GitHub request failed (${response.status}). Retry this repository later.`,
        );
      }
      let data;
      try {
        data = JSON.parse(await boundedText(response, 2_000_000));
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new AuditError(
          "response",
          "GitHub returned unreadable or oversized metadata. README not assessed.",
        );
      }
      controller.signal.throwIfAborted();
      return {
        data,
        next: /rel="next"/.test(response.headers.get("link") || ""),
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (controller.signal.aborted)
        throw new AuditError(
          "timeout",
          "GitHub request timed out. Retry this repository later.",
        );
      if (error instanceof TypeError)
        throw new AuditError("network", networkMessage());
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async history(repo, path, { signal } = {}) {
    const name = githubRepository(repo.full_name);
    const key = `${name}:${repo.default_branch}:${path}`;
    const cached = this.histories.get(key);
    if (cached && this.now() - cached.at < TTL) return cached.value;
    const base = `/repos/${name.split("/").map(encodeURIComponent).join("/")}/commits`;
    const branch = encodeURIComponent(repo.default_branch || "HEAD");
    const latest = await this.request(
      `${base}?sha=${branch}&path=${encodeURIComponent(path)}&per_page=1`,
      signal,
    );
    if (!Array.isArray(latest.data))
      throw new AuditError("response", "Unreadable README commit history.");
    const raw = latest.data[0]?.commit?.committer?.date;
    const timestamp = Date.parse(raw);
    const updated =
      Number.isFinite(timestamp) && timestamp <= this.now()
        ? new Date(timestamp).toISOString()
        : "";
    let commits = [];
    if (updated && this.now() - timestamp >= 90 * 86400000) {
      const since = new Date(this.now() - 30 * 86400000).toISOString();
      const recent = await this.request(
        `${base}?sha=${branch}&since=${encodeURIComponent(since)}&per_page=30`,
        signal,
      );
      if (!Array.isArray(recent.data) || recent.data.length > 30)
        throw new AuditError(
          "response",
          "Unreadable repository activity history.",
        );
      commits = recent.data.map((c) => ({
        sha: c.sha,
        commit: { committer: { date: c.commit?.committer?.date } },
      }));
    }
    const value = { updated, commits };
    this.histories.set(key, { at: this.now(), value });
    if (this.histories.size > 1000)
      this.histories.delete(this.histories.keys().next().value);
    return value;
  }
  async repositories(input, page = 1, { signal, force = false } = {}) {
    const username = githubUsername(input);
    if (!Number.isInteger(page) || page < 1 || page > 10)
      throw Error("Load up to 10 pages of 100 repositories.");
    const key = `${username.toLowerCase()}:${page}`,
      cached = this.pages.get(key);
    if (!force && cached && this.now() - cached.at < TTL) return cached.value;
    const { data, next } = await this.request(
      `/users/${encodeURIComponent(username)}/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=${page}`,
      signal,
    );
    if (!Array.isArray(data) || data.length > 100)
      throw new AuditError(
        "response",
        "GitHub returned an invalid repository page.",
      );
    let skipped = 0;
    const repositories = data.flatMap((raw) => {
      try {
        const repo = publicRepository(raw);
        if (
          repo.full_name.split("/")[0].toLowerCase() !== username.toLowerCase()
        )
          return [];
        return [repo];
      } catch {
        skipped++;
        return [];
      }
    });
    const value = {
      username,
      repositories,
      next: next && page < 10,
      capped: next && page === 10,
      skipped,
    };
    this.pages.set(key, { at: this.now(), value });
    while (this.pages.size > 30)
      this.pages.delete(this.pages.keys().next().value);
    return value;
  }
  put(key, value) {
    const size = (value.source?.length || 0) * 2;
    const previous = this.readmes.get(key);
    if (previous) this.bytes -= previous.size;
    this.readmes.delete(key);
    this.readmes.set(key, { value, size, at: this.now() });
    this.bytes += size;
    while (this.bytes > CACHE_BYTES || this.readmes.size > REPOSITORY_LIMIT) {
      const first = this.readmes.keys().next().value;
      this.bytes -= this.readmes.get(first).size;
      this.readmes.delete(first);
    }
    return value;
  }
  async readme(repo, { signal, force = false } = {}) {
    const fullName = githubRepository(repo.full_name),
      key = `${fullName.toLowerCase()}:${repo.default_branch}`;
    const cached = this.readmes.get(key);
    if (!force && cached && this.now() - cached.at < TTL) {
      this.readmes.delete(key);
      this.readmes.set(key, cached);
      return cached.value;
    }
    const base = `/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`;
    const ref = repo.default_branch
      ? `?ref=${encodeURIComponent(repo.default_branch)}`
      : "";
    let data;
    try {
      ({ data } = await this.request(`${base}/readme${ref}`, signal));
    } catch (error) {
      if (error.kind === "not-found")
        return this.put(key, { source: null, path: "", sha: "", root: true });
      throw error;
    }
    // GitHub can prefer .github/README over root README. Check the root explicitly.
    if (typeof data?.path === "string" && data.path.includes("/")) {
      const listing = (await this.request(`${base}/contents/${ref}`, signal))
        .data;
      if (!Array.isArray(listing))
        throw new AuditError(
          "response",
          "Could not verify the repository root. README not assessed.",
        );
      const files = listing.filter(
        (f) =>
          f?.type === "file" &&
          typeof f.name === "string" &&
          /^readme(?:\.[\w-]+)?$/i.test(f.name) &&
          f.path === f.name,
      );
      files.sort(
        (a, b) =>
          Number(/^readme\.md$/i.test(b.name)) -
            Number(/^readme\.md$/i.test(a.name)) ||
          a.name.localeCompare(b.name),
      );
      if (!files.length) {
        if (listing.length >= 1000)
          throw new AuditError(
            "response",
            "Root listing may be truncated. README not assessed.",
          );
        return this.put(key, {
          source: null,
          path: "",
          sha: "",
          root: true,
          alternatePath: data.path,
        });
      }
      data = (
        await this.request(
          `${base}/contents/${encodeURIComponent(files[0].name)}${ref}`,
          signal,
        )
      ).data;
    }
    if (
      !data ||
      typeof data.path !== "string" ||
      !/^readme(?:\.[\w-]+)?$/i.test(data.path)
    )
      throw new AuditError(
        "response",
        "GitHub returned an unsupported README path. README not assessed.",
      );
    if (
      data.size > README_LIMIT ||
      data.encoding !== "base64" ||
      typeof data.content !== "string"
    )
      throw new AuditError(
        "size",
        "README exceeds the 1 MB audit limit or is not available as text. Open it on GitHub.",
      );
    let source;
    try {
      const bytes = Uint8Array.from(
        atob(data.content.replace(/\s/g, "")),
        (c) => c.charCodeAt(0),
      );
      if (
        bytes.length > README_LIMIT ||
        !Number.isSafeInteger(data.size) ||
        bytes.length !== data.size
      )
        throw Error("Incomplete or oversized source");
      source = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new AuditError(
        "encoding",
        "README is not readable UTF-8 text within the audit limit.",
      );
    }
    return this.put(key, {
      source,
      path: data.path,
      sha: typeof data.sha === "string" ? data.sha : "",
      root: true,
    });
  }
}

export function filterRepositories(
  repositories,
  { includeForks = false, includeArchived = false } = {},
) {
  return repositories.filter(
    (repo) =>
      (includeForks || !repo.fork) && (includeArchived || !repo.archived),
  );
}
export async function auditRepositories(
  repositories,
  { client, analyze, signal, onResult = () => {}, force = false } = {},
) {
  const unique = [
    ...new Map(
      repositories.map((repo) => [repo.full_name.toLowerCase(), repo]),
    ).values(),
  ].slice(0, REPOSITORY_LIMIT);
  let cursor = 0,
    stopped = "",
    completed = 0,
    failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, unique.length) }, async () => {
      while (cursor < unique.length && !stopped && !signal?.aborted) {
        const repo = unique[cursor++];
        try {
          const readme = await client.readme(repo, { signal, force });
          signal?.throwIfAborted();
          const result = await analyze(readme.source, repo);
          signal?.throwIfAborted();
          const { source, ...metadata } = readme;
          if (readme.alternatePath)
            result.evidence = [
              "No root README found",
              `GitHub displays ${readme.alternatePath} instead`,
              ...result.evidence.filter(
                (v) => v !== "GitHub reports no README",
              ),
            ];
          completed++;
          onResult({ repo, result, readme: metadata, checkedAt: client.now() });
        } catch (error) {
          if (signal?.aborted) return;
          if (["rate-limit", "forbidden"].includes(error.kind))
            stopped = error.message;
          completed++;
          failed++;
          onResult({
            repo,
            error: error.message,
            kind: error.kind || "analysis",
            checkedAt: client.now(),
          });
        }
      }
    }),
  );
  return {
    completed,
    total: unique.length,
    assessed: completed - failed,
    failed,
    remaining: unique.length - completed,
    stopped,
    cancelled: signal?.aborted === true,
  };
}
export const auditClient = new AuditClient();
export const auditSession = {
  username: "",
  repositories: [],
  page: 0,
  next: false,
  selected: new Set(),
  results: new Map(),
  typeOverrides: new Map(),
  // Improvement plan decisions for this session only, keyed by canonical
  // owner/name: skipped -> Set(finding ID), dismissed -> Map(ID -> revision).
  skipped: new Map(),
  dismissed: new Map(),
  includeForks: false,
  includeArchived: false,
  viewPage: 0,
  notice: "",
};

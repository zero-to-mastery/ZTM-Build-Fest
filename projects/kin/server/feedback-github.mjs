// Forwarding reports and suggestions to the project's GitHub issues (#637,
// ADR 0021 §3), with Node's own fetch and no dependency.
//
// Configured by the operator with KIN_FEEDBACK_GITHUB_REPO ("owner/name")
// and KIN_FEEDBACK_GITHUB_TOKEN (a fine-grained token with Issues read and
// write on that repository only). Both or neither: one without the other is
// a configuration error at start-up. KIN_FEEDBACK_GITHUB_API may point at a
// GitHub Enterprise API (https only); tests point it at a fake server.
//
// The token is sent only to that API, in the Authorization header, and never
// logged. Nothing here sees household or member IDs, usernames or
// screenshots: feedback-service.mjs builds the issue text without them.

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const DEFAULT_API = "https://api.github.com";
/** Tries within one call for a transient failure (network, 5xx, 429). */
const ATTEMPTS = 3;
const BACKOFF_MS = 1_000;
/** Longest a single wait for GitHub's rate limit may be within a call; a
 * longer one is left to the service's own retry schedule. */
const MAX_WAIT_MS = 30_000;
const TIMEOUT_MS = 20_000;

export class GitHubError extends Error {
  constructor(status, message, { retryable = false } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * The forwarding configuration from the environment (or `options`), or null
 * when forwarding is off. Throws `feedback_github_invalid` when half
 * configured or malformed.
 */
export function parseGitHubConfig({ repo, token, api } = {}) {
  const blank = (value) => value === undefined || value === null || value === "";
  if (blank(repo) && blank(token)) return null;
  const fail = (message) => Object.assign(new Error(message), { code: "feedback_github_invalid" });
  if (blank(repo) || blank(token))
    throw fail("Set both KIN_FEEDBACK_GITHUB_REPO and KIN_FEEDBACK_GITHUB_TOKEN to forward reports to GitHub, or neither.");
  if (!REPO.test(String(repo))) throw fail("KIN_FEEDBACK_GITHUB_REPO must be owner/name.");
  if (/\s/.test(String(token)) || String(token).length > 512) throw fail("KIN_FEEDBACK_GITHUB_TOKEN is malformed.");
  let base;
  try { base = new URL(blank(api) ? DEFAULT_API : String(api)); } catch { throw fail("KIN_FEEDBACK_GITHUB_API must be a URL."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))
    throw fail("KIN_FEEDBACK_GITHUB_API must use https.");
  if (base.username || base.password || base.search || base.hash) throw fail("KIN_FEEDBACK_GITHUB_API must be a plain URL.");
  return Object.freeze({ repo: String(repo), token: String(token), api: base.href.replace(/\/$/, "") });
}

export class GitHubIssues {
  constructor(config, { fetch = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
    this.repo = config.repo;
    this.token = config.token;
    this.api = config.api;
    this.fetch = fetch;
    this.sleep = sleep;
    this.now = now;
  }

  /**
   * One API request, retried on a network failure, a 5xx or a rate limit
   * (waiting as GitHub asks, up to MAX_WAIT_MS). Returns the parsed JSON.
   * Creating an issue is not retried here except after a rate limit, where
   * GitHub did nothing: after a lost answer or a 5xx it may exist already,
   * so the service's next attempt looks it up first (FeedbackService
   * forwardOne).
   */
  async request(method, path, body = undefined) {
    let last;
    const safe = method === "GET";
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt && !safe && !last?.limited) break;
      if (attempt) await this.sleep(last?.waitMs ?? BACKOFF_MS * 2 ** (attempt - 1));
      let response;
      try {
        response = await this.fetch(`${this.api}${path}`, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "kin-feedback",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        last = new GitHubError(0, "GitHub could not be reached.", { retryable: true });
        continue;
      }
      if (response.ok) return response.status === 204 ? null : response.json();
      const waitMs = this.waitFor(response);
      const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      await response.body?.cancel().catch(() => {});
      if (response.status >= 500 || limited) {
        last = new GitHubError(response.status, `GitHub answered ${response.status}.`, { retryable: true });
        last.limited = limited;
        if (waitMs !== null && waitMs > MAX_WAIT_MS) break;
        last.waitMs = waitMs ?? undefined;
        continue;
      }
      throw new GitHubError(response.status, `GitHub refused the request (${response.status}).`);
    }
    throw last;
  }

  /** How long GitHub asks to wait, in ms, or null. */
  waitFor(response) {
    const after = Number(response.headers.get("retry-after"));
    if (Number.isFinite(after) && after >= 0) return after * 1000;
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0 && response.headers.get("x-ratelimit-remaining") === "0")
      return Math.max(0, reset * 1000 - this.now());
    return null;
  }

  /** Whether the repository is private (null when it can't be told). */
  async repositoryPrivate() {
    const value = await this.request("GET", `/repos/${this.repo}`);
    return typeof value?.private === "boolean" ? value.private : null;
  }

  /** Opens an issue; resolves its number. */
  async createIssue({ title, body, labels }) {
    const value = await this.request("POST", `/repos/${this.repo}/issues`, { title, body, labels });
    if (!Number.isSafeInteger(value?.number) || value.number < 1) throw new GitHubError(0, "GitHub's answer had no issue number.");
    return value.number;
  }

  /**
   * The number of an issue labelled `label` whose title carries `reference`,
   * among those updated since `sinceMs`, or null. Used before creating one
   * again after an attempt whose outcome isn't known, so forwarding is
   * idempotent by reference.
   */
  async findIssue(reference, { label, sinceMs }) {
    const since = new Date(Math.max(0, sinceMs - 60_000)).toISOString();
    for (let page = 1; page <= 5; page++) {
      const issues = await this.request("GET",
        `/repos/${this.repo}/issues?state=all&labels=${encodeURIComponent(label)}&since=${encodeURIComponent(since)}&per_page=100&page=${page}`);
      if (!Array.isArray(issues)) return null;
      const match = issues.find((issue) => typeof issue?.title === "string" && issue.title.includes(`[${reference}]`) && !issue.pull_request);
      if (match && Number.isSafeInteger(match.number)) return match.number;
      if (issues.length < 100) return null;
    }
    return null;
  }

  /** An issue's state: { state, stateReason, labels }. */
  async issueState(number) {
    const value = await this.request("GET", `/repos/${this.repo}/issues/${number}`);
    return {
      state: value?.state === "closed" ? "closed" : "open",
      stateReason: typeof value?.state_reason === "string" ? value.state_reason : null,
      labels: Array.isArray(value?.labels) ? value.labels.map((label) => (typeof label === "string" ? label : label?.name)).filter((name) => typeof name === "string") : [],
    };
  }
}

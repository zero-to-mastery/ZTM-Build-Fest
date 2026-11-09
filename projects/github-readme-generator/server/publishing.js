import { generateWorkflow } from "../src/workflows/model.js";
import { randomBytes } from "node:crypto";
import { validateGeneratedAsset } from "../src/publishing/assets.js";
import { gitBlobSha } from "../src/publishing/change-set.js";
import {
  evaluatePreflight,
  blockingFailure,
  passes,
  ACCESS_CHECKS,
  branchChecks,
} from "../src/publishing/preflight.js";
import {
  target,
  writeInput,
  MAX_SOURCE_BYTES,
} from "../src/publishing/validation.js";
import { pullRequestInput } from "../src/publishing/pull-request.js";
const random = () => randomBytes(32).toString("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
const cookieName = "__Host-readme-studio";
const encodedPath = (path) => path.split("/").map(encodeURIComponent).join("/");
// No persistent credentials, refresh-token storage, arbitrary proxy routes, or logging.
export function createPublishingService({
  origin,
  clientId,
  allowWorkflows = false,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (
    !origin ||
    new URL(origin).origin !== origin ||
    !origin.startsWith("https://")
  )
    throw new Error("Configure an exact HTTPS PUBLISH_ORIGIN.");
  const sessions = new Map();
  async function remote(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw fail(
        502,
        "GitHub could not be reached. Your local draft is safe. Check connectivity and retry.",
      );
    }
    if (!response.ok) {
      const messages = {
        401: "GitHub authorization expired. Disconnect and reconnect.",
        403: "GitHub denied access: check app permissions, rate limits, or branch protection. Download remains available.",
        404: "GitHub repository, branch, or file was not found.",
        409: "Remote content changed or the branch is unavailable. Reload and review before retrying.",
        422: "GitHub rejected the update. Check branch rules and reload the remote file.",
      };
      throw fail(
        response.status,
        messages[response.status] ||
          "GitHub could not complete this request. No automatic retry was made.",
      );
    }
    try {
      return await response.json();
    } catch {
      throw fail(502, "GitHub returned an unreadable response.");
    }
  }
  const github = (s, path, method = "GET", data) =>
    remote(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${s.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "README-Studio",
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const oauth = (path, data) =>
    remote(`https://github.com/login/${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: clientId, ...data }),
    });
  async function pages(s, path, field) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const separator = path.includes("?") ? "&" : "?",
        data = await github(s, `${path}${separator}per_page=100&page=${page}`),
        rows = field ? data[field] : data;
      if (!Array.isArray(rows))
        throw fail(502, "GitHub returned an unreadable repository list.");
      out.push(...rows);
      if (rows.length < 100) return out;
    }
    throw fail(
      413,
      "This account has too many installations or repositories for this picker. Download your README instead.",
    );
  }
  async function repositories(s) {
    const installations = await pages(
        s,
        "/user/installations",
        "installations",
      ),
      rows = new Map(),
      facts = new Map();
    for (const installation of installations) {
      const repos = await pages(
        s,
        `/user/installations/${Number(installation.id)}/repositories`,
        "repositories",
      );
      for (const repo of repos) {
        // Preflight facts stay in server memory; the picker only gets labels.
        const fact = {
          installation: {
            permissions: {
              contents: installation.permissions?.contents,
              workflows: installation.permissions?.workflows,
              pullRequests: installation.permissions?.pull_requests,
            },
          },
          repository: {
            push: repo.permissions?.push === true,
            archived: repo.archived === true,
            defaultBranch: repo.default_branch,
          },
        };
        const judged = (kind) =>
          evaluatePreflight(
            { configured: true, connected: true, allowWorkflows, ...fact },
            { kind },
          );
        facts.set(repo.full_name, fact);
        rows.set(repo.full_name, {
          repository: repo.full_name,
          branch: repo.default_branch,
          visibility: repo.private ? "private" : "public",
          workflowsWritable: passes(judged("workflow"), [
            ...ACCESS_CHECKS,
            "workflow-permission",
          ]),
          writable: passes(judged(), ACCESS_CHECKS),
          pullRequestsWritable:
            installation.permissions?.pull_requests === "write",
        });
      }
    }
    s.repositoryFacts = facts;
    s.repositories = [...rows.values()];
    return s.repositories;
  }
  // Read-only fact gathering for a Preflight. Never writes; GitHub failures
  // become unknown checks (with redacted reasons) instead of errors.
  async function preflightFacts(s, value, { rules = true } = {}) {
    const facts = {
      configured: true,
      connected: !!s.token,
      allowWorkflows,
      target: value,
      reasons: {},
    };
    if (!s.token) return facts;
    // Repository and branch must be well formed before anything is requested.
    const t = target({
      repository: value?.repository,
      branch: value?.branch,
      path: "README.md",
    });
    try {
      await repositories(s);
    } catch (e) {
      facts.reasons.installation = e.message;
      return facts;
    }
    const fact = s.repositoryFacts.get(t.repository);
    facts.installation = fact ? fact.installation : null;
    facts.repository = fact ? fact.repository : null;
    if (!fact) return facts;
    try {
      const branch = await github(
        s,
        `/repos/${t.repository}/branches/${encodeURIComponent(t.branch)}`,
      );
      facts.branch = {
        protected: branch.protected === true,
        commitSha:
          typeof branch.commit?.sha === "string" ? branch.commit.sha : null,
      };
    } catch (e) {
      if (e.status === 404) facts.branch = null;
      else facts.reasons.branch = e.message;
    }
    if (rules && facts.branch)
      try {
        const found = await github(
          s,
          `/repos/${t.repository}/rules/branches/${encodeURIComponent(t.branch)}`,
        );
        if (Array.isArray(found)) facts.rules = found;
      } catch {
        // Advisory only: unreadable rules stay unknown and never block.
      }
    return facts;
  }
  async function preflight(s, value, options) {
    return evaluatePreflight(await preflightFacts(s, value, options), {
      kind: value?.kind,
    });
  }
  // mode: "read" (installation only), "write" (every blocking Preflight check)
  // or "branch" (access and source branch checks for branch creation).
  async function authorizeTarget(s, value, mode = "read") {
    const t = target(value);
    if (mode === "read") {
      const repos = await repositories(s);
      if (!repos.some((r) => r.repository === t.repository))
        throw fail(
          403,
          "This repository is not shared with the GitHub App. Download remains available.",
        );
      return t;
    }
    // Enforcement equals display: the same evaluator, without advisory reads.
    const failure = blockingFailure(
      await preflight(s, t, { rules: false }),
      mode === "branch" ? branchChecks(t.kind) : undefined,
    );
    // Marked so the dialog can tell its own Preflight refusal from GitHub's.
    if (failure)
      throw Object.assign(
        fail(failure.status === "unknown" ? 502 : 403, failure.message),
        { preflight: failure.id },
      );
    return t;
  }
  async function read(s, t) {
    // Verify the branch first: a missing repository/branch must never look like a new README.
    const branch = await github(
      s,
      `/repos/${t.repository}/branches/${encodeURIComponent(t.branch)}`,
    );
    try {
      const file = await github(
        s,
        `/repos/${t.repository}/contents/${encodedPath(t.path)}?ref=${encodeURIComponent(t.branch)}`,
      );
      if (
        file.type !== "file" ||
        file.encoding !== "base64" ||
        file.size > MAX_SOURCE_BYTES ||
        !file.sha
      )
        throw fail(
          413,
          "Remote file is not a supported text file or exceeds 750 KB.",
        );
      return {
        ...t,
        sha: file.sha,
        // Keep a leading BOM: the reviewed content must be exactly the bytes
        // the Base SHA names, or a no-op publish would silently drop it.
        content: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(Buffer.from(file.content, "base64")),
        commitSha: branch.commit.sha,
      };
    } catch (e) {
      if (e.status !== 404) throw e;
      return { ...t, sha: null, content: "", commitSha: branch.commit.sha };
    }
  }
  function requirePullRequests(s, repository) {
    const fact = s.repositoryFacts?.get(repository);
    if (!fact)
      throw fail(
        403,
        "This repository is not shared with the GitHub App. Download remains available.",
      );
    if (fact.installation.permissions.pullRequests !== "write")
      throw fail(
        403,
        "Draft pull requests require Pull requests: read and write permission for this GitHub App.",
      );
  }
  function pullRequestRow(pull, repository) {
    const number = pull?.number,
      title = pull?.title,
      head = pull?.head?.ref,
      base = pull?.base?.ref,
      url = `https://github.com/${repository}/pull/${number}`;
    try {
      target({ repository, branch: head, path: "README.md" });
      target({ repository, branch: base, path: "README.md" });
    } catch {
      return null;
    }
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      typeof title !== "string" ||
      !title.trim() ||
      title.length > 256 ||
      /[\x00-\x1f\x7f]/.test(title) ||
      pull.html_url !== url ||
      pull.head?.repo?.full_name !== repository ||
      pull.base?.repo?.full_name !== repository ||
      !/^[a-f0-9]{40,64}$/.test(pull.head?.sha || "") ||
      !/^[a-f0-9]{40,64}$/.test(pull.base?.sha || "")
    )
      return null;
    return {
      number,
      title,
      url,
      draft: pull.draft === true,
      head,
      headSha: pull.head.sha,
      base,
      baseSha: pull.base.sha,
      createdAt:
        typeof pull.created_at === "string"
          ? Date.parse(pull.created_at)
          : null,
      mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : null,
    };
  }
  async function compatiblePullRequests(s, value, state = "open") {
    const t = target({ ...value, path: "README.md" });
    await authorizeTarget(s, t);
    const pulls = await pages(s, `/repos/${t.repository}/pulls?state=${state}`);
    return pulls
      .filter(
        (pull) =>
          pull.head?.repo?.full_name === t.repository &&
          pull.base?.repo?.full_name === t.repository &&
          typeof pull.head?.ref === "string" &&
          typeof pull.base?.ref === "string" &&
          /^[a-f0-9]{40,64}$/.test(pull.head?.sha || "") &&
          /^[a-f0-9]{40,64}$/.test(pull.base?.sha || ""),
      )
      .map((pull) => pullRequestRow(pull, t.repository))
      .filter(Boolean);
  }
  return async function handle(request) {
    const headers = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Type": "application/json",
    };
    const reply = (value, status = 200) =>
      new Response(JSON.stringify(value), { status, headers });
    try {
      const url = new URL(request.url),
        operation = url.pathname.split("/").at(-1);
      if (url.origin !== origin || url.search)
        throw fail(400, "Invalid publishing request.");
      if (!clientId)
        return reply(
          operation === "preflight"
            ? evaluatePreflight({ configured: false })
            : { configured: false, connected: false },
        );
      for (const [key, s] of sessions)
        if (s.expires <= now()) sessions.delete(key);
      const id = request.headers
        .get("cookie")
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      let s = sessions.get(id);
      if (request.method === "GET" && operation === "session") {
        if (!s) {
          if (sessions.size >= 1000)
            throw fail(503, "Publishing is busy. Please try later.");
          const next = random();
          s = { csrf: random(), expires: now() + 3600000 };
          sessions.set(next, s);
          headers["Set-Cookie"] =
            `${cookieName}=${next}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`;
        }
        return reply({
          configured: true,
          connected: !!s.token,
          csrf: s.csrf,
          identity: s.identity || null,
        });
      }
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== origin ||
        !s ||
        request.headers.get("x-studio-csrf") !== s.csrf ||
        !request.headers.get("content-type")?.startsWith("application/json")
      )
        throw fail(
          403,
          "Session or request verification failed. Reopen publishing.",
        );
      const raw = await request.text();
      if (raw.length > MAX_SOURCE_BYTES * 2)
        throw fail(413, "Publishing request is too large.");
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw fail(400, "Invalid request data.");
      }
      if (operation === "disconnect") {
        sessions.delete(id);
        headers["Set-Cookie"] =
          `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
        return reply({ connected: false });
      }
      if (s.busy) throw fail(429, "A GitHub request is already in progress.");
      s.busy = true;
      try {
        if (operation === "connect") {
          if (s.token) throw fail(409, "Already connected. Disconnect first.");
          if (s.auth && s.auth.expires > now())
            return reply({
              code: s.auth.code,
              verificationUrl: "https://github.com/login/device",
              interval: s.auth.interval,
            });
          const auth = await oauth("device/code", {});
          if (!auth.device_code || !auth.user_code)
            throw fail(
              503,
              "Enable GitHub App device authorization on the publishing server.",
            );
          s.auth = {
            device: auth.device_code,
            code: auth.user_code,
            expires: now() + Math.min(auth.expires_in || 900, 900) * 1000,
            interval: Math.max(5, auth.interval || 5),
            next: now() + Math.max(5, auth.interval || 5) * 1000,
          };
          return reply({
            code: auth.user_code,
            verificationUrl: "https://github.com/login/device",
            interval: s.auth.interval,
          });
        }
        if (operation === "poll") {
          if (!s.auth || s.auth.expires <= now())
            throw fail(401, "Authorization expired. Connect again.");
          if (now() < s.auth.next) return reply({ pending: true });
          s.auth.next = now() + s.auth.interval * 1000;
          const auth = await oauth("oauth/access_token", {
            device_code: s.auth.device,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          });
          if (auth.error === "slow_down") {
            s.auth.interval += 5;
            s.auth.next = now() + s.auth.interval * 1000;
            return reply({ pending: true });
          }
          if (auth.error === "authorization_pending")
            return reply({ pending: true });
          if (
            !auth.access_token ||
            !Number.isFinite(auth.expires_in) ||
            auth.expires_in <= 0
          ) {
            delete s.auth;
            throw fail(
              401,
              "Authorization declined, expired, or token expiration is disabled. Connect again after checking the GitHub App.",
            );
          }
          s.token = auth.access_token;
          s.expires = Math.min(s.expires, now() + auth.expires_in * 1000);
          delete s.auth;
          try {
            const user = await github(s, "/user");
            s.identity = {
              login: user.login,
              name: user.name || user.login,
              avatar: `https://avatars.githubusercontent.com/u/${Number(user.id)}`,
            };
          } catch (e) {
            delete s.token;
            throw e;
          }
          return reply({ connected: true, identity: s.identity });
        }
        if (operation === "preflight") {
          try {
            target({
              repository: data?.repository,
              branch: data?.branch,
              path: "README.md",
            });
          } catch (e) {
            throw fail(400, e.message);
          }
          return reply(await preflight(s, data));
        }
        if (!s.token) throw fail(401, "Connect GitHub first.");
        if (operation === "repositories")
          return reply({ repositories: await repositories(s) });
        if (operation === "pull-requests")
          return reply({ pullRequests: await compatiblePullRequests(s, data) });
        if (operation === "pull-request-check") {
          const t = target({ ...data, branch: data?.head, path: "README.md" });
          await authorizeTarget(s, t);
          if (!Number.isSafeInteger(data?.number) || data.number < 1)
            throw fail(400, "Choose a compatible open pull request.");
          const pull = await github(
            s,
            `/repos/${t.repository}/pulls/${data.number}`,
          );
          if (
            pull.state !== "open" ||
            pull.head?.repo?.full_name !== t.repository ||
            pull.base?.repo?.full_name !== t.repository ||
            pull.head?.ref !== data.head ||
            pull.base?.ref !== data.base
          )
            throw fail(
              409,
              "The selected pull request is no longer a compatible open PR. Select it again.",
            );
          if (pull.head?.sha !== data.headSha)
            throw fail(
              409,
              "The selected pull request head changed. Reload it before publishing.",
            );
          if (pull.mergeable === false)
            throw fail(
              409,
              "The selected pull request conflicts with its base branch. Resolve conflicts on GitHub first.",
            );
          if (pull.mergeable !== true)
            throw fail(
              409,
              "GitHub has not confirmed whether the selected pull request can merge. Re-check it before publishing.",
            );
          const row = pullRequestRow(pull, t.repository);
          if (!row)
            throw fail(502, "GitHub returned an unreadable pull request.");
          return reply(row);
        }
        if (operation === "pull-request-status") {
          const t = target({ ...data, branch: data?.head, path: "README.md" });
          await authorizeTarget(s, t);
          const earliest = Math.floor(data.createdAt / 1000) * 1000 - 300_000,
            latest = Math.ceil(data.createdAt / 1000) * 1000 + 600_000,
            matches = (await compatiblePullRequests(s, t, "all")).filter(
              (pull) =>
                pull.head === data.head &&
                pull.base === data.base &&
                pull.headSha === data.headSha &&
                pull.baseSha === data.baseSha &&
                pull.title === data.title &&
                Number.isFinite(pull.createdAt) &&
                pull.createdAt >= earliest &&
                pull.createdAt <= latest,
            );
          if (matches.length > 1)
            throw fail(
              409,
              "GitHub returned multiple pull requests matching this recovery operation. Nothing was retried; inspect them on GitHub.",
            );
          return reply({ found: matches[0] || null });
        }
        if (operation === "pull-request") {
          let input;
          try {
            input = pullRequestInput(data);
          } catch (error) {
            throw fail(400, error.message);
          }
          await repositories(s);
          requirePullRequests(s, input.repository);
          const [head, base] = await Promise.all([
            github(
              s,
              `/repos/${input.repository}/branches/${encodeURIComponent(input.head)}`,
            ),
            github(
              s,
              `/repos/${input.repository}/branches/${encodeURIComponent(input.base)}`,
            ),
          ]);
          if (
            head.commit?.sha !== input.headSha ||
            base.commit?.sha !== input.baseSha
          )
            throw fail(
              409,
              "The pull request head or base changed. Reload both exact SHAs and review again.",
            );
          const duplicate = (
            await compatiblePullRequests(s, {
              repository: input.repository,
              branch: input.head,
            })
          ).find(
            (pull) => pull.head === input.head && pull.base === input.base,
          );
          if (duplicate)
            throw Object.assign(
              fail(
                409,
                `An open pull request already exists for ${input.head} into ${input.base}. No duplicate was created.`,
              ),
              { pullRequest: duplicate },
            );
          const [latestHead, latestBase] = await Promise.all([
            github(
              s,
              `/repos/${input.repository}/branches/${encodeURIComponent(input.head)}`,
            ),
            github(
              s,
              `/repos/${input.repository}/branches/${encodeURIComponent(input.base)}`,
            ),
          ]);
          if (
            latestHead.commit?.sha !== input.headSha ||
            latestBase.commit?.sha !== input.baseSha
          )
            throw fail(
              409,
              "The pull request head or base changed during review. Nothing was created; reload and approve again.",
            );
          let created;
          try {
            created = await github(
              s,
              `/repos/${input.repository}/pulls`,
              "POST",
              {
                title: input.title,
                body: input.body,
                head: input.head,
                base: input.base,
                draft: true,
              },
            );
          } catch (error) {
            if (error.status >= 500) error.ambiguous = true;
            throw error;
          }
          const createdRow = pullRequestRow(created, input.repository);
          if (
            !createdRow ||
            created.state !== "open" ||
            !createdRow.draft ||
            createdRow.title !== input.title ||
            createdRow.head !== input.head ||
            createdRow.base !== input.base ||
            createdRow.headSha !== input.headSha ||
            createdRow.baseSha !== input.baseSha
          )
            throw Object.assign(
              fail(
                502,
                "GitHub returned an unreadable PR response. Reconcile the pull request journal before retrying.",
              ),
              { ambiguous: true },
            );
          return reply(createdRow);
        }
        if (operation === "read")
          return reply(await read(s, await authorizeTarget(s, data)));
        if (operation === "branch") {
          const t = await authorizeTarget(s, data, "branch");
          const next = target({ ...t, branch: data.newBranch });
          if (
            data.confirmed !== true ||
            next.branch === t.branch ||
            !/^[a-f0-9]{40,64}$/.test(data.commitSha || "")
          )
            throw fail(
              400,
              "Review the source branch SHA and confirm creation of a different branch.",
            );
          const current = await github(
            s,
            `/repos/${t.repository}/branches/${encodeURIComponent(t.branch)}`,
          );
          if (current.commit.sha !== data.commitSha)
            throw fail(
              409,
              "Source branch changed. Reload it before creating a branch.",
            );
          await github(s, `/repos/${t.repository}/git/refs`, "POST", {
            ref: `refs/heads/${next.branch}`,
            sha: data.commitSha,
          });
          return reply(next);
        }
        if (operation === "commit") {
          let input;
          try {
            input = writeInput(data);
            if (input.kind === "asset") validateGeneratedAsset(data);
            if (
              input.kind === "workflow" &&
              (generateWorkflow(data.workflow).yaml !== input.content ||
                generateWorkflow(data.workflow).path !== input.path)
            )
              throw new Error(
                "Workflow source and path must match the reviewed generator settings.",
              );
          } catch (e) {
            throw fail(400, e.message);
          }
          // The write must be exactly the reviewed content (ADR epic69-02).
          let resultSha;
          try {
            resultSha = await gitBlobSha(input.content);
          } catch (e) {
            throw fail(503, e.message);
          }
          if (resultSha !== input.resultSha)
            throw fail(
              400,
              "Content does not match the reviewed Result SHA. Nothing was written; review the change set again.",
            );
          const t = await authorizeTarget(s, input, "write");
          const current = await read(s, t);
          if (data.expectedBranchSha != null) {
            if (!/^[a-f0-9]{40,64}$/.test(data.expectedBranchSha || ""))
              throw fail(400, "Reload the selected pull request head.");
            if (current.commitSha !== data.expectedBranchSha)
              throw fail(
                409,
                "The selected pull request head changed before this write. Nothing was written; reload and review it again.",
              );
          }
          // A retry whose Result SHA is already remote must never create a
          // second commit. The client reconciles this as written.
          if (current.sha === input.resultSha && current.sha !== input.sha)
            throw Object.assign(
              fail(
                409,
                `${t.path} already has the reviewed Result SHA. No duplicate write was made; reconcile the Publish journal.`,
              ),
              { remote: current, alreadyApplied: true },
            );
          // A create requires the file to be absent; an update requires the
          // Base SHA. There is no force, delete or ref-rewrite path.
          if (current.sha !== input.sha)
            throw Object.assign(
              fail(
                409,
                input.sha === null
                  ? `${t.path} now exists on GitHub. Nothing was written; review the remote file and build a new change set.`
                  : "Remote README changed since you loaded it. Review the latest version.",
              ),
              { remote: current },
            );
          let result;
          try {
            result = await github(
              s,
              `/repos/${t.repository}/contents/${encodedPath(t.path)}`,
              "PUT",
              {
                message: input.message,
                content: Buffer.from(input.content, "utf8").toString("base64"),
                branch: t.branch,
                ...(input.sha ? { sha: input.sha } : {}),
              },
            );
            if (
              !/^[a-f0-9]{40,64}$/.test(result?.commit?.sha || "") ||
              result?.content?.sha !== input.resultSha
            )
              throw fail(
                502,
                "GitHub returned an unreadable write response. Reconcile the Publish journal before retrying.",
              );
          } catch (error) {
            // A 5xx or lost response after sending PUT cannot prove whether
            // GitHub committed the content. Never invite a blind retry.
            if (error.status >= 500) error.ambiguous = true;
            throw error;
          }
          return reply({
            commitSha: result.commit.sha,
            sha: result.content.sha,
            previousCommitSha: current.commitSha,
            ...t,
          });
        }
        throw fail(404, "Unknown publishing operation.");
      } finally {
        s.busy = false;
      }
    } catch (e) {
      return reply(
        {
          error: e.status
            ? e.message
            : "Publishing could not complete. Your local draft is safe.",
          ...(e.remote ? { remote: e.remote } : {}),
          ...(e.preflight ? { preflight: e.preflight } : {}),
          ...(e.ambiguous ? { ambiguous: true } : {}),
          ...(e.alreadyApplied ? { alreadyApplied: true } : {}),
          ...(e.pullRequest ? { pullRequest: e.pullRequest } : {}),
        },
        Number.isInteger(e.status) && e.status >= 400 && e.status < 600
          ? e.status
          : 500,
      );
    }
  };
}

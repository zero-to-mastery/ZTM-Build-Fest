import { target as validTarget } from "./validation.js";
// Preflight (ADR epic69-01): one pure evaluator judges the facts the server
// gathered. The dialog displays the report and the server's write
// authorization enforces the same blocking checks, so a refusal always
// matches what the author saw. Reports live in memory only and are never saved.
export const PREFLIGHT_CHECKS = [
  "service",
  "session",
  "installation",
  "contents-permission",
  "user-push",
  "not-archived",
  "branch-exists",
  "path-supported",
  "workflow-permission",
  "branch-rules",
  "default-branch",
];
export const ADVISORY_CHECKS = ["branch-rules", "default-branch"];
// Checks the repository picker labels use (they do not depend on a branch).
export const ACCESS_CHECKS = [
  "installation",
  "contents-permission",
  "user-push",
  "not-archived",
];
// Checks that must pass before the remote file can be loaded for review.
export const READ_CHECKS = [
  "service",
  "session",
  "installation",
  "branch-exists",
  "path-supported",
];
// Checks the "Publish on a new branch" route enforces on the source branch.
export const BRANCH_CHECKS = [...ACCESS_CHECKS, "branch-exists"];
// Branch checks for a target kind: a workflow branch also needs the server
// opt-in and Workflows: write, exactly like a workflow commit.
export const branchChecks = (kind) =>
  kind === "workflow"
    ? [...BRANCH_CHECKS, "workflow-permission"]
    : BRANCH_CHECKS;
export const CHECK_LABELS = {
  service: "Publishing service",
  session: "GitHub session",
  installation: "GitHub App installation",
  "contents-permission": "Contents permission",
  "user-push": "Your push access",
  "not-archived": "Repository not archived",
  "branch-exists": "Branch exists",
  "path-supported": "Supported path",
  "workflow-permission": "Workflow permission",
  "branch-rules": "Branch rules",
  "default-branch": "Default branch",
};
const RULE_TYPES = [
  "pull_request",
  "update",
  "required_status_checks",
  "required_signatures",
  "non_fast_forward",
];
const text = (value) => (typeof value === "string" ? value : "");
function reportTarget(raw, kind) {
  return {
    repository: text(raw.repository),
    branch: text(raw.branch),
    path: text(raw.path),
    ...(["asset", "workflow"].includes(kind) ? { kind } : {}),
  };
}
// facts: {configured, connected, allowWorkflows, target, installation, repository,
// branch, rules, reasons, unavailable}. `undefined` means "not known" (unknown);
// `null` means "known to be absent" (fail). `unavailable` marks every check
// unknown, for offline or unreachable publishing.
export function evaluatePreflight(facts = {}, { kind, now = Date.now } = {}) {
  facts = facts || {};
  const raw = facts.target || {};
  kind = kind ?? raw.kind;
  const t = reportTarget(raw, kind),
    repo = t.repository || "this repository",
    reasons = facts.reasons || {},
    checks = [],
    status = {};
  const add = (id, result, message) => {
    status[id] = result;
    checks.push({
      id,
      status: result,
      blocking: !ADVISORY_CHECKS.includes(id),
      message,
    });
  };
  const ids = PREFLIGHT_CHECKS.filter(
    (id) => id !== "workflow-permission" || kind === "workflow",
  );
  if (facts.unavailable) {
    for (const id of ids) add(id, "unknown", facts.unavailable);
    return report(t, facts, now, checks);
  }
  const needs = (dependency, id, why) =>
    status[dependency] === "pass" ? false : (add(id, "unknown", why), true);
  // service
  if (facts.configured === true)
    add("service", "pass", "Publishing service is configured.");
  else if (facts.configured === false)
    add(
      "service",
      "fail",
      "Publishing is not configured on this deployment. All local tools and downloads remain available.",
    );
  else
    add(
      "service",
      "unknown",
      reasons.service || "The publishing service could not be checked.",
    );
  // session
  if (!needs("service", "session", "Requires the publishing service.")) {
    if (facts.connected === true)
      add("session", "pass", "Connected to GitHub.");
    else if (facts.connected === false)
      add("session", "fail", "Connect GitHub to check write access.");
    else
      add(
        "session",
        "unknown",
        reasons.session || "The GitHub session could not be checked.",
      );
  }
  // installation
  if (!needs("session", "installation", "Requires a GitHub session.")) {
    if (facts.installation === null)
      add(
        "installation",
        "fail",
        `The GitHub App is not installed on ${repo}, or the repository is not shared with it. Install the app for this repository, then re-check access.`,
      );
    else if (facts.installation)
      add("installation", "pass", `The GitHub App is installed on ${repo}.`);
    else
      add(
        "installation",
        "unknown",
        reasons.installation ||
          "GitHub App installations could not be checked.",
      );
  }
  const installed = "Requires the GitHub App installation.";
  // contents-permission
  if (!needs("installation", "contents-permission", installed)) {
    const contents = facts.installation.permissions?.contents;
    if (contents === "write")
      add(
        "contents-permission",
        "pass",
        "The GitHub App grants Contents: read and write.",
      );
    else if (contents === "read")
      add(
        "contents-permission",
        "fail",
        "The GitHub App grants Contents: read only. Publishing needs Contents: read and write.",
      );
    else
      add(
        "contents-permission",
        "fail",
        "The GitHub App has no Contents permission. Publishing needs Contents: read and write.",
      );
  }
  // user-push and not-archived come from the author's own repository access.
  if (!needs("installation", "user-push", installed)) {
    if (facts.repository?.push === true)
      add("user-push", "pass", `Your GitHub account can push to ${repo}.`);
    else if (facts.repository)
      add(
        "user-push",
        "fail",
        `Your GitHub account cannot push to ${repo}. Ask an owner for write access.`,
      );
    else
      add(
        "user-push",
        "unknown",
        "Your repository access could not be checked.",
      );
  }
  if (!needs("installation", "not-archived", installed)) {
    if (facts.repository?.archived === true)
      add(
        "not-archived",
        "fail",
        `${repo} is archived on GitHub and cannot be written. Unarchive it on GitHub first.`,
      );
    else if (facts.repository)
      add("not-archived", "pass", `${repo} is not archived.`);
    else
      add(
        "not-archived",
        "unknown",
        "The repository archive state could not be checked.",
      );
  }
  // branch-exists
  if (!needs("installation", "branch-exists", installed)) {
    if (facts.branch === null)
      add(
        "branch-exists",
        "fail",
        `Branch ${t.branch || "(none)"} was not found in ${repo}. Choose an existing branch, load it, then use “Publish on a new branch instead” to create a new one.`,
      );
    else if (facts.branch)
      add("branch-exists", "pass", `Branch ${t.branch} exists.`);
    else
      add(
        "branch-exists",
        "unknown",
        reasons.branch || "The branch could not be checked.",
      );
  }
  // path-supported is pure validation and needs no network. Without a chosen
  // target there is nothing to validate yet.
  if (!facts.target)
    add("path-supported", "unknown", "Requires a repository, branch and path.");
  else
    try {
      validTarget({ ...raw, kind });
      add(
        "path-supported",
        "pass",
        `${t.path} is a supported ${kind === "workflow" ? "workflow" : kind === "asset" ? "asset" : "README"} path.`,
      );
    } catch (e) {
      add("path-supported", "fail", e.message);
    }
  // workflow-permission (workflow publishing only)
  if (
    ids.includes("workflow-permission") &&
    !needs("service", "workflow-permission", "Requires the publishing service.")
  ) {
    if (facts.allowWorkflows !== true)
      add(
        "workflow-permission",
        "fail",
        "Workflow writes are not enabled on this publishing server (ALLOW_WORKFLOW_WRITES). Download YAML remains available.",
      );
    else if (status.installation !== "pass")
      add("workflow-permission", "unknown", installed);
    else if (facts.installation.permissions?.workflows === "write")
      add(
        "workflow-permission",
        "pass",
        "Server opt-in is enabled and the GitHub App grants Workflows: write.",
      );
    else
      add(
        "workflow-permission",
        "fail",
        "The GitHub App lacks Workflows: write permission. Download YAML remains available.",
      );
  }
  // Advisory: branch rules never block; GitHub decides at write time.
  if (!needs("branch-exists", "branch-rules", "Requires an existing branch.")) {
    const types = Array.isArray(facts.rules)
      ? [
          ...new Set(
            facts.rules
              .map((rule) => rule?.type)
              .filter((type) => RULE_TYPES.includes(type)),
          ),
        ]
      : [];
    if (facts.branch.protected === true || types.length)
      add(
        "branch-rules",
        "warn",
        `Branch ${t.branch} has ${facts.branch.protected === true ? "branch protection" : ""}${facts.branch.protected === true && types.length ? " and " : ""}${types.length ? `rules (${types.join(", ")})` : ""}. GitHub may reject a direct commit; if it does, use “Publish on a new branch instead”.`,
      );
    else if (Array.isArray(facts.rules))
      add(
        "branch-rules",
        "pass",
        "No branch protection or blocking rulesets reported.",
      );
    else
      add(
        "branch-rules",
        "unknown",
        "Branch rules could not be read. GitHub decides at write time.",
      );
  }
  const defaultBranch = facts.repository?.defaultBranch;
  if (typeof defaultBranch !== "string" || !defaultBranch)
    add(
      "default-branch",
      "unknown",
      "The default branch could not be checked.",
    );
  else if (t.branch === defaultBranch)
    add(
      "default-branch",
      "warn",
      `You are committing directly to the default branch ${defaultBranch}. Consider “Publish on a new branch instead” for review.`,
    );
  else
    add(
      "default-branch",
      "pass",
      `Branch ${t.branch} is not the default branch.`,
    );
  return report(t, facts, now, checks);
}
function report(t, facts, now, checks) {
  return {
    version: 1,
    target: t,
    checkedAt: new Date(now()).toISOString(),
    verdict: checks.every((c) => !c.blocking || c.status === "pass")
      ? "writable"
      : "read-only",
    branchCommitSha:
      typeof facts.branch?.commitSha === "string"
        ? facts.branch.commitSha
        : null,
    defaultBranch:
      typeof facts.repository?.defaultBranch === "string"
        ? facts.repository.defaultBranch
        : null,
    checks,
  };
}
// First blocking check (optionally limited to `ids`) that is not `pass`.
export function blockingFailure(preflight, ids) {
  return (
    preflight?.checks?.find(
      (c) => c.blocking && c.status !== "pass" && (!ids || ids.includes(c.id)),
    ) || null
  );
}
// True when every named check is present and `pass`.
export function passes(preflight, ids) {
  return ids.every(
    (id) => preflight?.checks?.find((c) => c.id === id)?.status === "pass",
  );
}

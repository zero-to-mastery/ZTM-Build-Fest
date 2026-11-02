export const stateLabels = {
  missing: "Missing README",
  stub: "Stub README",
  minimal: "Minimal documentation",
  basic: "Basic README",
  detailed: "Detailed README",
  "documentation-heavy": "Documentation-heavy README",
};

export function activityStatus(repo, now = Date.now()) {
  if (repo.archived) return "Archived";
  const pushed = Date.parse(repo.pushed_at);
  if (!Number.isFinite(pushed)) return "Push activity unknown";
  const days = Math.max(0, Math.floor((now - pushed) / 86400000));
  return days <= 30
    ? "Active within the last 30 days"
    : `Last pushed ${days} days ago`;
}

export function repositoryUrl(repo) {
  return `https://github.com/${repo.full_name.split("/").map(encodeURIComponent).join("/")}`;
}

// The README as GitHub displays it, or "" when there is no README path.
export function readmeUrl(repo, readme) {
  return readme?.path
    ? `${repositoryUrl(repo)}/blob/${encodeURIComponent(repo.default_branch || "HEAD")}/${encodeURIComponent(readme.path)}`
    : "";
}

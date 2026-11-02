export function githubRepository(input) {
  if (
    typeof input !== "string" ||
    !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(input) ||
    /\/(?:\.|\.\.)$/.test(input)
  )
    throw new Error("Enter a GitHub repository as owner/repository.");
  return input.split("/").map(encodeURIComponent).join("/");
}
export function githubBadge(kind, c) {
  const repo = githubRepository(c.repository),
    base = `https://github.com/${repo}`;
  const paths = {
    stars: "stars",
    forks: "forks",
    issues: "issues",
    license: "license",
    release: "v/release",
  };
  if (kind === "workflow") {
    if (
      !c.workflow ||
      /[\x00-\x1f/#?\\]/.test(c.workflow) ||
      c.workflow.length > 200 ||
      [".", ".."].includes(c.workflow)
    )
      throw new Error(
        "Enter a workflow file or name, for example ci.yml (without a path).",
      );
    const query = {};
    if (c.branch) {
      if (/[\x00-\x1f]/.test(c.branch)) throw new Error("Invalid branch name.");
      query.branch = c.branch;
    }
    if (c.event) {
      if (!/^[a-z_]+$/.test(c.event))
        throw new Error(
          "Use a GitHub event name such as push or pull_request.",
        );
      query.event = c.event;
    }
    return {
      path: `github/actions/workflow/status/${repo}/${encodeURIComponent(c.workflow)}`,
      query,
      link: `${base}/actions/workflows/${encodeURIComponent(c.workflow)}`,
      alt: `${c.repository} ${c.workflow} workflow status`,
    };
  }
  if (!paths[kind]) throw new Error("Unknown GitHub badge type.");
  return {
    path: `github/${paths[kind]}/${repo}`,
    link: `${base}${{ stars: "/stargazers", forks: "/forks", issues: "/issues", release: "/releases", license: "" }[kind]}`,
    alt: `${c.repository} ${kind}`,
  };
}

// Browser acquisition policy. No credentials belong in this model.
const features = [
  "fullRepositoryEnumeration",
  "languageBreakdowns",
  "pinnedRepositories",
  "contributionDiscovery",
  "activity",
  "contributors",
  "commitActivity",
  "commitHistory",
];

export function createGitHubAccess({ authenticated = false } = {}) {
  const access = {};
  Object.defineProperties(access, {
    authenticated: {
      enumerable: true,
      get: () =>
        Boolean(
          typeof authenticated === "function" ? authenticated() : authenticated,
        ),
    },
    mode: {
      enumerable: true,
      get: () => (access.authenticated ? "authenticated" : "public"),
    },
    capabilities: {
      enumerable: true,
      get: () =>
        Object.fromEntries(
          features.map((feature) => [feature, access.authenticated]),
        ),
    },
  });
  return access;
}

export function requireGitHubCapability(access, feature) {
  if (access && !access.capabilities[feature])
    throw new Error(
      feature === "contributionDiscovery"
        ? "Sign in with GitHub to automatically discover repositories you contributed to, or add a public repository manually."
        : feature === "pinnedRepositories"
          ? "Pinned repositories require GitHub sign-in."
          : "Sign in with GitHub to load this data.",
    );
}

export const PUBLIC_MODE_MESSAGE =
  "Public mode · Showing up to 100 public repositories using primary languages and topics. Sign in for complete discovery, language breakdowns, pins, contributions, activity and history, or add another public repository manually.";

export function publicLimitMessage(reset) {
  return (
    "GitHub's public request allowance for this connection is nearly exhausted. Constellation stopped requesting data. Sign in with GitHub for full analysis, or try public exploration again after GitHub resets the limit." +
    (reset ? ` Reset: ${new Date(reset).toLocaleTimeString()}.` : "")
  );
}

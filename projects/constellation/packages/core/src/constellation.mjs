import { orderRecruiterProjects, prepareRecruiterScene, validateProjectRelationships, recruiterProjectLimit } from "./recruiter.mjs";
import { layoutScene } from "./layout-api.mjs";
import { accountSunMode } from "./account-sun.mjs";
import { validateSemanticOptions, semanticActive } from './semantic-studio.mjs';
import { createTimeline } from "./timeline.mjs";
import { createTemporalStack } from "./temporal-stack.mjs";
import { temporalStackOptions } from "./temporal-stack-model.mjs";
import {
  temporalGeometryMath,
  validateRingPlacements,
} from "./temporal-geometry.mjs";
import { createLayoutHost, validateLayoutReference } from "./layout-host.mjs";
import { normalizeMappings, mapRecord } from "./data-mappings.mjs";
import { createLayers } from "./scene-layers.mjs";
import { normalizeRecords, toGraphRecords } from "./data-pipeline.mjs";
import { applyTransforms, validateTransforms } from "./data-transforms.mjs";
import { renderSceneSVG } from "./renderer-svg.mjs";
import { historyYears } from "./history/historical-snapshot.mjs";
import { layoutRefinementOptions, refineStars } from "./layout-refinement.mjs";
import { scalingOptions } from "./scaling.mjs";
import { codingRhythmOptions } from "./coding-rhythm.mjs";
import {
  organizationEnabled,
  organizationOptions,
  organizationNodeMode,
  organizationModes,
  organizationLayouts,
} from "./organization/settings.mjs";
import { commitConstellation } from "./commit-constellation.mjs";
import { scopeRepositories } from "./organization/model.mjs";
import { organizationGraph } from "./organization/graph.mjs";
import { historyOptions } from "./history/settings.mjs";
import {
  referenceDate,
  historicalSnapshot,
} from "./history/historical-snapshot.mjs";
import { aggregateActivity } from "./activity.mjs";
import { deriveCodingRhythm } from "./coding-rhythm.mjs";
import { resolveSeed } from "./seeded-random.mjs";
import { starfieldOptions } from "./starfield.mjs";
import { activityOptions, activityForNode } from "./activity.mjs";
import { resolveTheme } from "./themes.mjs";
import { artifactLayouts } from "./artifact-layouts.mjs";
import {
  mappedColor,
  mappedGlow,
  mappingOptions,
  shapeFor,
} from "./visual-mapping.mjs";
import {
  filterRepositoryMetadata,
  compareRepositories,
} from "./repository-filters.mjs";
import { nodeRadius } from "./node-sizing.mjs";
import { exportSettings, profileDimensions } from "./export-image.mjs";
import { perspectiveOptions } from "./perspective.mjs";
import {
  ringAnimationOptions,
  floatingAnimationOptions,
} from "./ring-animation.mjs";
import {
  identityGeometry,
  identityPoints,
  projectNodes,
  rustAvailable,
} from "./engine.mjs";
import { createSceneEvidence } from "./evidence.mjs";
import { fitSceneViewport } from "./scene-framing.mjs";

export function username(value = "") {
  const name = value
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\/$/, "")
    .replace(/^@/, "");
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(name))
    throw new Error("Enter a GitHub username or profile URL.");
  return name;
}

export async function fetchRepositories(
  account,
  { token, signal, fetchImpl = fetch, repoSource = "all" } = {},
) {
  if (repoSource === "pinned")
    return fetchPinnedRepositories(account, { token, signal, fetchImpl });
  if (repoSource !== "all")
    throw new Error("repoSource must be all or pinned.");
  const name = username(account);
  const repositories = [];
  for (let page = 1; page <= 100; page++) {
    const response = await fetchImpl(
      `https://api.github.com/users/${name}/repos?type=owner&sort=full_name&per_page=100&page=${page}`,
      {
        signal: signal || AbortSignal.timeout(20000),
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (response.status === 404) throw new Error("GitHub account not found.");
    if (response.status === 403 || response.status === 429)
      throw new Error(
        "GitHub request limit reached. Try again later or use GITHUB_TOKEN in the generator.",
      );
    if (!response.ok)
      throw new Error(`GitHub request failed (${response.status}).`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("Unexpected GitHub response.");
    repositories.push(...batch.filter((repo) => repo.private !== true));
    if (batch.length < 100) return repositories;
  }
  throw new Error("Account exceeds the 10,000 repository limit.");
}

export async function fetchPinnedRepositories(
  account,
  { token, signal, fetchImpl = fetch } = {},
) {
  const name = username(account);
  if (!token)
    throw new Error(
      "Pinned repositories require a GitHub token. Use GH_TOKEN in the local server or the automatic GITHUB_TOKEN in Actions.",
    );
  const query = `query ConstellationPins($login: String!, $after: String) {
    repositoryOwner(login: $login) {
      ... on User { pinnedItems(first: 100, after: $after, types: [REPOSITORY]) { ...Pins } }
      ... on Organization { pinnedItems(first: 100, after: $after, types: [REPOSITORY]) { ...Pins } }
    }
  }
  fragment Pins on PinnableItemConnection {
    pageInfo { hasNextPage endCursor }
    nodes { ... on Repository {
      name nameWithOwner isPrivate isFork isArchived description homepageUrl createdAt updatedAt pushedAt forkCount issues(states: OPEN) { totalCount } stargazerCount primaryLanguage { name }
      repositoryTopics(first: 100) { nodes { topic { name } } }
    } }
  }`;
  const repositories = [];
  let after = null;
  for (let page = 0; page < 100; page++) {
    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      signal: signal || AbortSignal.timeout(20000),
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables: { login: name, after } }),
    });
    if (response.status === 401)
      throw new Error(
        "GitHub rejected the token used to load pinned repositories.",
      );
    if (response.status === 403 || response.status === 429)
      throw new Error(
        "GitHub request limit reached or token access denied while loading pinned repositories.",
      );
    if (!response.ok)
      throw new Error(
        `Could not load pinned repositories (${response.status}).`,
      );
    const body = await response.json();
    if (body.errors?.length)
      throw new Error(
        "GitHub could not load pinned repositories. Check the account name, token access, and GraphQL rate limit.",
      );
    if (body.data?.repositoryOwner === null)
      throw new Error("GitHub account not found.");
    const connection = body.data?.repositoryOwner?.pinnedItems;
    if (
      !Array.isArray(connection?.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    )
      throw new Error("Unexpected GitHub pinned repository response.");
    for (const repo of connection.nodes) {
      // Never include private pins even when the server token can read them.
      if (!repo || repo.isPrivate === true) continue;
      if (
        repo.isPrivate !== false ||
        typeof repo.name !== "string" ||
        !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repo.nameWithOwner || "") ||
        !Array.isArray(repo.repositoryTopics?.nodes)
      )
        throw new Error("Unexpected GitHub pinned repository response.");
      repositories.push({
        name: repo.name,
        full_name: repo.nameWithOwner,
        private: false,
        fork: repo.isFork,
        description: repo.description,
        homepage: repo.homepageUrl,
        archived: repo.isArchived,
        created_at: repo.createdAt,
        updated_at: repo.updatedAt,
        pushed_at: repo.pushedAt,
        forks_count: repo.forkCount,
        open_issues_count: repo.issues?.totalCount,
        stargazers_count: repo.stargazerCount,
        language: repo.primaryLanguage?.name || null,
        topics: repo.repositoryTopics.nodes.map((node) => node.topic.name),
        pinned: true,
        pin_order: repositories.length,
      });
    }
    if (!connection.pageInfo.hasNextPage) return repositories;
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== "string" || !cursor || cursor === after)
      throw new Error("Invalid GitHub pinned repository pagination.");
    after = cursor;
  }
  throw new Error("Pinned repository pagination exceeded its limit.");
}

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char],
  );

export function projectShowcaseEntry(repo, showcase = {}) {
  if (!repo || !repo.full_name) return null;
  const lookup = (id) =>
    showcase[id] ||
    Object.entries(showcase).find(
      ([key]) => key.toLowerCase() === id.toLowerCase(),
    )?.[1];
  if (
    repo.nodeKind &&
    repo.nodeKind !== "repository" &&
    Array.isArray(repo.members)
  ) {
    const entries = repo.members
      .map(lookup)
      .filter(
        (entry) =>
          entry &&
          ["featured", "supporting", "experimental", "historical"].includes(
            entry.role,
          ),
      );
    if (!entries.length) return null;
    const role = ["featured", "supporting", "experimental", "historical"].find(
      (value) => entries.some((entry) => entry.role === value),
    );
    return {
      role,
      priority:
        role === "featured"
          ? Math.min(
              ...entries
                .filter((entry) => entry.role === role)
                .map((entry) =>
                  Number.isInteger(entry.priority) ? entry.priority : 9999,
                ),
            )
          : null,
    };
  }
  const entry = lookup(repo.full_name) || lookup(repo.name) || null;
  if (!entry || (!entry.role && entry.priority === undefined)) return null;
  return {
    role: entry.role || null,
    priority: Number.isInteger(entry.priority) ? entry.priority : null,
  };
}

const showcaseOrder = {
  featured: 0,
  supporting: 1,
  experimental: 2,
  historical: 3,
};
function compareShowcase(a, b, showcase) {
  const left = projectShowcaseEntry(a, showcase),
    right = projectShowcaseEntry(b, showcase);
  const role =
    (showcaseOrder[left?.role] ?? 4) - (showcaseOrder[right?.role] ?? 4);
  if (role) return role;
  if (
    left?.role === "featured" &&
    right?.role === "featured" &&
    left.priority !== right.priority
  )
    return (left.priority ?? 9999) - (right.priority ?? 9999);
  return 0;
}

function organizeRingAnchors(stars, ringPoints, identity, options) {
  const mode = options.ringOrganization || "identity";
  if (!["importance", "activity"].includes(mode) || !ringPoints.length)
    return stars;
  if (
    mode === "activity" &&
    !Object.keys(options.activityData?.repositories || {}).length
  )
    return stars;
  const radii = Array.from({ length: 4 }, (_, ring) => identity[2 + ring * 22]);
  const slots = Array.from({ length: ringPoints.length / 3 }, (_, index) => {
    const x = ringPoints[index * 3] - 240,
      y = ringPoints[index * 3 + 1] - 240,
      radius = Math.hypot(x, y);
    const ring = radii.reduce(
      (best, value, candidate) =>
        Math.abs(radius - value) < Math.abs(radius - radii[best])
          ? candidate
          : best,
      0,
    );
    return { index, ring };
  });
  const ordered = [...stars].sort((a, b) => {
    if (mode === "activity") {
      const score = (star) =>
        (star.showcase?.role === "featured"
          ? 2
          : star.showcase?.role === "supporting"
            ? 1
            : 0) +
        (options.activityData?.repositories?.[star.repo.full_name]?.score || 0);
      return (
        score(b) - score(a) ||
        compareShowcase(a.repo, b.repo, options.projectShowcase) ||
        a.repo.full_name.localeCompare(b.repo.full_name)
      );
    }
    return (
      compareShowcase(a.repo, b.repo, options.projectShowcase) ||
      a.repo.full_name.localeCompare(b.repo.full_name)
    );
  });
  const assigned = new Array(slots.length),
    remaining = new Set(ordered);
  if (mode === "importance") {
    const roleForRing = [
      "featured",
      "supporting",
      "experimental",
      "historical",
    ];
    for (let ring = 0; ring < 4; ring++) {
      const ringSlots = slots.filter((slot) => slot.ring === ring);
      const matching = ordered.filter(
        (star) => star.showcase?.role === roleForRing[ring],
      );
      for (
        let index = 0;
        index < Math.min(ringSlots.length, matching.length);
        index++
      ) {
        assigned[ringSlots[index].index] = matching[index];
        remaining.delete(matching[index]);
      }
    }
  }
  const open = slots.filter((slot) => !assigned[slot.index]);
  const leftovers = ordered.filter((star) => remaining.has(star));
  for (let index = 0; index < open.length; index++)
    assigned[open[index].index] = leftovers[index];
  return assigned.filter(Boolean);
}

export function selectRepositoryPool(repositories, options = {}) {
  const repositoryCap =
    options.nodeCap === undefined ? 100 : scalingOptions(options).nodeCap;
  const historical =
    options.history?.mode === "historical" ||
    options.historicalYear !== undefined;
  const date = referenceDate(options, new Date().toISOString());
  if (historical) repositories = historicalSnapshot(repositories, date);
  const {
    maxRepos = 45,
    includeForks = true,
    includeRepos,
    repoSource = "all",
    sortBy = "stars",
  } = options;
  if (!["all", "pinned"].includes(repoSource))
    throw new Error("repoSource must be all or pinned.");
  if (!Number.isInteger(maxRepos) || maxRepos < 1 || maxRepos > repositoryCap)
    throw new Error(
      `maxRepos must be an integer between 1 and ${repositoryCap}.`,
    );
  let eligible = filterRepositoryMetadata(repositories, options, date).filter(
    (repo) =>
      repo.private !== true &&
      (repoSource !== "pinned" || repo.pinned === true) &&
      (includeForks || !repo.fork) &&
      (!includeRepos ||
        includeRepos.includes(repo.name) ||
        includeRepos.includes(repo.full_name)),
  );
  if (organizationEnabled(options)) {
    const focus = options.organizationUser?.toLowerCase(),
      records = options.organizationData?.records;
    // Contributor coverage is a layer on the selected project map, not a filter.
    const scoped = eligible;
    const relevant =
      focus && records
        ? scoped.filter((repo) =>
            records[repo.full_name]?.some(
              (person) => person.login?.toLowerCase() === focus,
            ),
          )
        : [];
    const prioritized = new Set(relevant.map((repo) => repo.full_name));
    return [
      ...scopeRepositories(relevant, options, 100),
      ...scopeRepositories(
        scoped.filter((repo) => !prioritized.has(repo.full_name)),
        options,
        100,
      ),
    ].slice(0, options.maxRepos ?? 100);
  }
  if (options.readmePresentation === "recruiter") return orderRecruiterProjects(
    eligible.filter(repo => !(options.hiddenNodes || []).includes(repo.full_name)), options,
  ).slice(0, Math.min(recruiterProjectLimit, maxRepos));
  const explicitRoles = Object.values(options.projectShowcase || {});
  if (
    options.readmePresentation === "featured-work" &&
    explicitRoles.some((entry) => entry?.role === "featured")
  ) {
    const curated = eligible.filter((repo) =>
      ["featured", "supporting"].includes(
        projectShowcaseEntry(repo, options.projectShowcase)?.role,
      ),
    );
    if (curated.length) eligible = curated;
  }
  const activity =
    options.readmePresentation === "current-focus"
      ? options.activityData?.repositories
      : null;
  return eligible
    .sort((a, b) => {
      if (options.readmePresentation === "project-journey") {
        const journeyRank = (repo) =>
          ({ featured: 0, historical: 0, supporting: 1, experimental: 2 })[
            projectShowcaseEntry(repo, options.projectShowcase)?.role
          ] ?? 3;
        const priority = journeyRank(a) - journeyRank(b);
        if (priority) return priority;
        const created =
          (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0);
        if (created) return created;
      }
      if (activity && Object.keys(activity).length) {
        const score = (repo) =>
          (projectShowcaseEntry(repo, options.projectShowcase)?.role ===
          "featured"
            ? 2
            : 0) + (activity[repo.full_name]?.score || 0);
        const difference = score(b) - score(a);
        if (difference) return difference;
      }
      return (
        compareShowcase(a, b, options.projectShowcase) ||
        (repoSource === "pinned"
          ? (a.pin_order || 0) - (b.pin_order || 0)
          : compareRepositories(a, b, sortBy))
      );
    })
    .slice(0, repoSource === "pinned" ? 100 : maxRepos);
}

export function selectRepositories(repositories, options = {}) {
  const { languages, topics, showOther = false } = options;
  for (const [key, value] of Object.entries({ languages, topics })) {
    if (
      value !== undefined &&
      value !== null &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    )
      throw new Error(`${key} must be an array of names or null for all.`);
  }
  return selectRepositoryPool(repositories, options).filter((repo) => {
    const detected = repositoryLanguages(repo);
    if (!showOther && !detected.length) return false;
    const matchesLanguage =
      languages == null ||
      detected.some((language) => languages.includes(language)) ||
      (showOther && !detected.length && languages.includes("Other"));
    const matchesTopic =
      topics == null ||
      (repo.topics || []).some((topic) => topics.includes(topic));
    return matchesLanguage && matchesTopic;
  });
}

export function sharedConnections(
  from,
  to,
  { languages, topics, connectionBasis = "languages" } = {},
) {
  const sharedLanguages =
    connectionBasis === "topics"
      ? []
      : repositoryLanguages(from).filter(
          (language) =>
            (languages == null || languages.includes(language)) &&
            repositoryLanguages(to).includes(language),
        );
  const sharedTopics =
    connectionBasis === "languages"
      ? []
      : [...new Set(from.topics || [])]
          .filter(
            (topic) =>
              (topics == null || topics.includes(topic)) &&
              (to.topics || []).includes(topic),
          )
          .sort();
  return {
    sharedLanguages,
    sharedTopics,
    shared: [...sharedLanguages, ...sharedTopics.map((topic) => `#${topic}`)],
  };
}

export function repositoryLanguages(repo) {
  // A fetched empty result means no detected code, not a failed lookup.
  return repo.languages
    ? Object.keys(repo.languages)
        .filter((key) => repo.languages[key] > 0)
        .sort()
    : repo.language
      ? [repo.language]
      : [];
}

export function graphNodes(repositories, options = {}) {
  const mode =
    options.readmePresentation === "technology-identity"
      ? "combined"
      : (options.nodeMode ?? "repositories");
  if (mode === "commits") return commitConstellation(options);
  if (organizationEnabled(options) || organizationModes.includes(mode)) {
    // Aggregate the same filtered scope, without the direct-node cap.
    const source = filterRepositoryMetadata(
      repositories,
      options,
      referenceDate(options, new Date().toISOString()),
    ).filter(
      (repo) =>
        repo.private !== true &&
        (options.includeForks !== false || !repo.fork) &&
        (options.repoSource !== "pinned" || repo.pinned) &&
        (!options.includeRepos ||
          options.includeRepos.includes(repo.name) ||
          options.includeRepos.includes(repo.full_name)),
    );
    const filtered = source.filter(
      (repo) => selectRepositories([repo], { ...options, maxRepos: 1 }).length,
    );
    return organizationGraph(
      filtered,
      selectRepositories(repositories, options),
      options,
    );
  }
  if (!["repositories", "languages", "topics", "combined"].includes(mode))
    throw new Error(
      "nodeMode must be repositories, languages, topics or combined.",
    );
  const repos = selectRepositories(repositories, options);
  if (mode === "repositories")
    return { nodes: repos, total: repos.length, repositoryCount: repos.length };
  const hasFeatured = Object.values(options.projectShowcase || {}).some(
    (entry) => entry?.role === "featured",
  );
  const requestedCap = options.nodeCap ?? (mode === "combined" ? 256 : 100);
  const projected = projectNodes({
    mode,
    cap: hasFeatured ? 2048 : options.nodeCap,
    repos: repos.map((repo) => ({
      id: repo.full_name,
      languages: (repositoryLanguages(repo).length
        ? repositoryLanguages(repo)
        : options.showOther
          ? ["Other"]
          : []
      ).filter(
        (value) =>
          options.languages == null || options.languages.includes(value),
      ),
      topics: (repo.topics || []).filter(
        (value) => options.topics == null || options.topics.includes(value),
      ),
    })),
  });
  let projectedNodes = projected.nodes;
  if (hasFeatured && projectedNodes.length > requestedCap) {
    const byId = new Map(repos.map((repo) => [repo.full_name, repo]));
    const roleRank = {
      featured: 0,
      supporting: 2,
      experimental: 4,
      historical: 5,
    };
    projectedNodes = projectedNodes
      .map((node, index) => {
        const members = node.kind === "repository" ? [node.id] : node.members;
        const featuredCount = members.filter(
          (id) =>
            projectShowcaseEntry(byId.get(id), options.projectShowcase)
              ?.role === "featured",
        ).length;
        const role =
          node.kind === "repository"
            ? projectShowcaseEntry(byId.get(node.id), options.projectShowcase)
                ?.role
            : null;
        const rank =
          node.kind === "repository"
            ? (roleRank[role] ?? 6)
            : featuredCount
              ? 1
              : 3;
        return { node, index, rank, featuredCount, membership: members.length };
      })
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          b.featuredCount - a.featuredCount ||
          b.membership - a.membership ||
          a.index - b.index,
      )
      .slice(0, requestedCap)
      .map((item) => item.node);
  }
  return {
    nodes: projectedNodes.map((node) => ({
      full_name: node.id,
      name: node.label,
      ...(node.kind === "repository"
        ? repos.find((repo) => repo.full_name === node.id)
        : {}),
      nodeKind: node.kind,
      members: node.members,
      stargazers_count:
        node.kind === "repository"
          ? repos.find((repo) => repo.full_name === node.id)
              ?.stargazers_count || 0
          : node.members.length,
    })),
    total: projected.total,
    repositoryCount: repos.length,
  };
}

export async function fetchRepositoryLanguages(
  repositories,
  {
    token,
    signal,
    fetchImpl = fetch,
    cache = new Map(),
    onProgress = () => {},
  } = {},
) {
  const publicRepos = repositories.filter((repo) => repo.private !== true);
  let next = 0,
    completed = 0,
    failure;
  const results = new Array(publicRepos.length);
  async function worker() {
    while (next < publicRepos.length && !failure) {
      const index = next++,
        repo = publicRepos[index];
      try {
        if (repo.languages) {
          results[index] = repo;
          onProgress(++completed, publicRepos.length);
          continue;
        }
        if (!cache.has(repo.full_name)) {
          const request = (async () => {
            const parts = repo.full_name.split("/");
            if (
              parts.length !== 2 ||
              !parts.every((part) => /^[a-z\d_.-]+$/i.test(part))
            )
              throw new Error("Invalid repository name.");
            const response = await fetchImpl(
              `https://api.github.com/repos/${parts.map(encodeURIComponent).join("/")}/languages`,
              {
                signal: signal || AbortSignal.timeout(20000),
                headers: {
                  Accept: "application/vnd.github+json",
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
              },
            );
            if (response.status === 403 || response.status === 429)
              throw new Error(
                "GitHub request limit reached while loading languages. Try later or use GITHUB_TOKEN with the generator.",
              );
            if (!response.ok)
              throw new Error(
                `Could not load languages for ${repo.full_name} (${response.status}).`,
              );
            const languages = await response.json();
            if (
              !languages ||
              Array.isArray(languages) ||
              typeof languages !== "object" ||
              Object.values(languages).some(
                (bytes) => !Number.isFinite(bytes) || bytes < 0,
              )
            )
              throw new Error("Unexpected GitHub language response.");
            return languages;
          })();
          cache.set(repo.full_name, request);
          request.catch(() => {
            if (cache.get(repo.full_name) === request)
              cache.delete(repo.full_name);
          });
        }
        results[index] = {
          ...repo,
          languages: await cache.get(repo.full_name),
        };
        onProgress(++completed, publicRepos.length);
      } catch (error) {
        failure = error;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(3, publicRepos.length) }, worker),
  );
  if (failure) throw failure;
  return results;
}
const hash = (value) => {
  let n = [...value].reduce(
    (n, char) => (Math.imul(n, 31) + char.charCodeAt(0)) >>> 0,
    7,
  );
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
};
export const themes = {
  midnight: {
    background: "#080e20",
    foreground: "#e6edff",
    accent: "#9ab9ff",
    line: "#3e537e",
    star: "#f6d99b",
  },
  light: {
    background: "#f7f8fc",
    foreground: "#18213a",
    accent: "#395bbe",
    line: "#aab6d3",
    star: "#966500",
  },
};

export function renderConstellation(
  account,
  repositories,
  options = {},
  runtime = {},
) {
  return renderSceneSVG(createScene(account, repositories, options, runtime));
}

export function createScene(
  account,
  repositories,
  options = {},
  { onDiagnostic, nodeRenderer, pipeline, signal, layoutHost } = {},
) {
  validateProjectRelationships(options.projectRelationships);
  if (options.readmePresentation === 'recruiter') options = {
    ...options, arrangement: 'solar-system', nodeMode: 'repositories', accountType: 'user',
    temporalStack: undefined, timeline: undefined, history: undefined, historicalYear: undefined, timeLapse: false,
    ringMeaning: 'identity', ringOrganization: 'identity', layoutEngine: undefined, layoutRefinement: { enabled: false, intensity: 0 },
    starPositions: {}, labelPositions: {}, labelOffsets: {}, perspective: { enabled: false },
    ringAnimation: { enabled: false }, floatingAnimation: { enabled: false },
  };
  accountSunMode(options.accountSun);
  validateSemanticOptions(options);
  if (options.temporalStack !== undefined)
    temporalStackOptions(options.temporalStack);
  if (options.temporalGeometry !== undefined)
    temporalGeometryMath.options(options.temporalGeometry);
  if (options.ringPlacements !== undefined)
    validateRingPlacements(options.ringPlacements);
  if (
    options.arrangement === "temporal-stack" ||
    options.temporalStack?.enabled
  )
    return createTemporalStack(account, repositories, options, {
      onDiagnostic,
      nodeRenderer,
      pipeline,
      signal,
      layoutHost,
    });
  if (options.timeline !== undefined)
    return createTimeline(account, repositories, options, options.timeline, {
      onDiagnostic,
      nodeRenderer,
      pipeline,
      signal,
      layoutHost,
    });
  signal?.throwIfAborted();
  const layers = createLayers(options.layers);
  validateTransforms(options.transforms);
  const mappings = normalizeMappings(options.mappings);
  validateLayoutReference(options);
  // Legacy inputs can repeat IDs in records later excluded by privacy, fork or
  // explicit repository filters. Check the resulting graph's identity instead.
  const normalized = (pipeline?.normalize || normalizeRecords)(repositories, {
    onDiagnostic,
    deferIdentityCheck: true,
    signal,
  });
  repositories = toGraphRecords(normalized.records);
  const scaling = scalingOptions(options);
  const refinement = layoutRefinementOptions(options.layoutRefinement);
  organizationOptions(options);
  const sourceHasRepositories = repositories.some(
    (repo) =>
      repo.private !== true &&
      (options.repoSource !== "pinned" || repo.pinned === true),
  );
  options = exportSettings(resolveTheme(options));
  const transparent =
    options.transparentTheme || options.exportProfile === "transparent";
  for (const key of ["starlightAnimate", "activityAnimate"])
    if (options[key] !== undefined && typeof options[key] !== "boolean")
      throw new Error(`${key} must be boolean.`);
  if (
    options.generatedAt !== undefined &&
    !Number.isFinite(Date.parse(options.generatedAt))
  )
    throw new Error("generatedAt must be a valid date.");
  const temporal = historyOptions(options);
  const hasHistory =
    temporal.history.mode !== "current" ||
    temporal.history.timeLapse.enabled ||
    [
      "contributionComet",
      "contributionOrbit",
      "languageEvolution",
      "stellarAges",
      "foreignGalaxies",
    ].some((key) => temporal[key].enabled);
  const clock = referenceDate(options, new Date().toISOString());
  options = { ...options, referenceDate: new Date(clock).toISOString() };
  if (temporal.history.timeLapse.enabled) {
    const settings = temporal.history.timeLapse;
    const resolved = { ...options, ...temporal };
    const years = historyYears(
      repositories,
      clock,
      temporal.history.maxHistoricalFrames,
    );
    const base = {
      ...resolved,
      history: {
        ...temporal.history,
        mode: "current",
        timeLapse: { ...settings, enabled: false },
      },
      timeLapse: false,
      historicalYear: undefined,
      generatedAt: new Date(clock).toISOString(),
      referenceDate: new Date(clock).toISOString(),
    };
    const latest = createScene(account, repositories, base, {
      onDiagnostic,
      nodeRenderer,
      pipeline,
      signal,
      layoutHost,
    });
    const frames =
      settings.mode === "crossfade" &&
      years.length > 1 &&
      options.animate !== false
        ? years.slice(0, -1).map((year) => ({
            year,
            scene: createScene(
              account,
              repositories,
              {
                ...base,
                history: { ...base.history, mode: "historical", year },
              },
              { onDiagnostic, nodeRenderer, pipeline, signal, layoutHost },
            ),
          }))
        : [];
    return JSON.parse(
      JSON.stringify({
        version: 1,
        kind: "time-lapse",
        metadata: latest.metadata,
        latest,
        frames,
        presentation: {
          account,
          repositories: repositories.filter((repo) => repo.private !== true),
          options: resolved,
          reference: clock,
        },
      }),
    );
  }
  if (temporal.history.mode === "historical") {
    repositories = historicalSnapshot(repositories, clock);
    options = {
      ...options,
      metricDate: options.referenceDate,
      activityMetricDate: options.referenceDate,
      activityData: options.historyData
        ? aggregateActivity(
            options.historyData.events,
            repositories,
            { ...options, activityMetricDate: options.referenceDate },
            options.referenceDate,
          )
        : undefined,
      codingRhythmData: options.historyData
        ? deriveCodingRhythm(
            options.historyData.events,
            options,
            options.referenceDate,
          )
        : undefined,
    };
  }
  // Privacy and fork exclusion cannot be bypassed by grouping or field mapping.
  const transformed = (pipeline?.transform || applyTransforms)(
    options.transforms?.length
      ? normalized.records
          .filter(
            (record) =>
              record.attributes.private !== true &&
              (options.includeForks !== false || !record.attributes.fork),
          )
          .map((record) =>
            temporal.history.mode !== "historical"
              ? record
              : {
                  ...record,
                  attributes: historicalSnapshot([record.attributes], clock)[0],
                },
          )
          .filter((record) => record.attributes)
      : normalized.records,
    options.transforms,
    { signal },
  );
  signal?.throwIfAborted();
  for (const stage of transformed.diagnostics)
    onDiagnostic?.({ code: "transform-applied", ...stage });
  if (options.transforms?.length)
    repositories = toGraphRecords(transformed.records);
  mappingOptions(options);
  const name = username(account);
  for (const id of Object.keys(options.projectShowcase || {})) {
    if (
      !repositories.some(
        (repo) =>
          repo.full_name?.toLowerCase() === id.toLowerCase() &&
          repo.private !== true,
      )
    )
      onDiagnostic?.({
        code: "showcase-repository-unavailable",
        repository: id,
      });
  }
  const seed = resolveSeed(name, options);
  const sky = starfieldOptions(options.starfield);
  const activitySettings = activityOptions(options);
  const rhythmSettings = codingRhythmOptions(options);
  const recent = (id) =>
    activitySettings.activityEffect === "off"
      ? null
      : activityForNode(id, options.activityData);
  nodeRadius({}, options.nodeSize || options.sizingMode, 0);
  const reference = clock;
  const generatedDate =
    options.generatedAt === undefined ? null : new Date(options.generatedAt);
  if (generatedDate && !Number.isFinite(generatedDate.getTime()))
    throw new Error("generatedAt must be a valid date.");
  const generatedLabel = generatedDate
    ? `Generated ${generatedDate.toISOString().slice(0, 19).replace("T", " ")} UTC`
    : "";
  const {
    theme = "auto",
    colors = {},
    animate = true,
    maxRepos = 45,
    includeForks = true,
    css = "",
    layout = "atlas",
    title,
    includeRepos,
    bridges = false,
    connectionDensity = "balanced",
    connectionBasis = "languages",
  } = options;
  if (!["languages", "topics", "both"].includes(connectionBasis))
    throw new Error("Connection basis must be languages, topics or both.");
  if (!["balanced", "all"].includes(connectionDensity))
    throw new Error("Connection density must be balanced or all.");
  if (!["atlas", "compact"].includes(layout))
    throw new Error("Layout must be atlas or compact.");
  if (title !== undefined && (typeof title !== "string" || title.length > 60))
    throw new Error("Title must be a string of up to 60 characters.");
  if (
    includeRepos !== undefined &&
    (!Array.isArray(includeRepos) ||
      includeRepos.some((value) => typeof value !== "string"))
  )
    throw new Error("includeRepos must be an array of repository names.");
  const compact = layout === "compact";
  const colorConnections = options.colorConnections ?? false;
  if (typeof colorConnections !== "boolean")
    throw new Error("colorConnections must be a boolean.");
  let nodeColors = options.nodeColors ?? {};
  if (
    typeof nodeColors !== "object" ||
    Array.isArray(nodeColors) ||
    Object.values(nodeColors).some(
      (color) => typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color),
    )
  )
    throw new Error("nodeColors must map node IDs to 6 digit hex colors.");
  const perspective = perspectiveOptions(options.perspective);
  const floatingAnimation = floatingAnimationOptions(options.floatingAnimation);
  const ringAnimation = ringAnimationOptions(options.ringAnimation);
  const ringRotation = options.ringRotation ?? 0;
  if (!Number.isFinite(ringRotation) || ringRotation < 0 || ringRotation > 360)
    throw new Error("ringRotation must be between 0 and 360 degrees.");
  const ringRotations = options.ringRotations ?? [
    ringRotation,
    ringRotation,
    ringRotation,
    ringRotation,
  ];
  if (
    !Array.isArray(ringRotations) ||
    ringRotations.length !== 4 ||
    ringRotations.some(
      (angle) => !Number.isFinite(angle) || angle < 0 || angle > 360,
    )
  )
    throw new Error(
      "ringRotations must contain four angles between 0 and 360 degrees.",
    );
  const { arrangement = "rings", identityRing = true } = options;
  if (
    ![
      "field",
      "orbital",
      "force",
      "rings",
      "profile",
      ...artifactLayouts,
      ...organizationLayouts,
    ].includes(arrangement)
  )
    throw new Error("Invalid arrangement.");
  if (typeof identityRing !== "boolean")
    throw new Error("identityRing must be a boolean.");
  const height = compact ? 280 : 560;
  const profile = profileDimensions(options.exportProfile, height);
  const labelPositions = options.labelPositions ?? {};
  const labelOffsets = options.labelOffsets ?? {};
  if (
    typeof labelOffsets !== "object" ||
    Array.isArray(labelOffsets) ||
    Object.values(labelOffsets).some(
      (position) =>
        !position ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y),
    )
  )
    throw new Error(
      "labelOffsets must map node IDs to finite x and y offsets.",
    );
  if (
    typeof labelPositions !== "object" ||
    Array.isArray(labelPositions) ||
    Object.values(labelPositions).some(
      (position) =>
        !position ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y),
    )
  )
    throw new Error(
      "labelPositions must map repository names to finite x and y coordinates.",
    );
  let starPositions = options.starPositions ?? {};
  if (
    typeof starPositions !== "object" ||
    Array.isArray(starPositions) ||
    Object.values(starPositions).some(
      (position) =>
        !position ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y),
    )
  )
    throw new Error(
      "starPositions must map repository names to finite x and y coordinates.",
    );
  if (theme !== "auto" && !themes[theme])
    throw new Error("Theme must be auto, midnight or light.");
  const repositoryCap = options.nodeCap === undefined ? 100 : scaling.nodeCap;
  if (!Number.isInteger(maxRepos) || maxRepos < 1 || maxRepos > repositoryCap)
    throw new Error(
      `maxRepos must be an integer between 1 and ${repositoryCap}.`,
    );
  const palette = { ...themes[theme === "auto" ? "light" : theme], ...colors };
  for (const [key, color] of Object.entries(palette)) {
    if (
      !Object.hasOwn(themes.midnight, key) ||
      !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)
    )
      throw new Error(
        "Colors must use known palette keys and 3 or 6 digit hex values.",
      );
  }
  // CSS is local, trusted configuration, but must never escape its XML text node.
  if (options.readmePresentation === "technology-identity")
    options = { ...options, nodeMode: "combined", connectionBasis: "both" };
  const graph = graphNodes(repositories, options);
  const repos = graph.nodes;
  const graphIds = new Set();
  for (const repo of repos) {
    if (graphIds.has(repo.full_name))
      throw new Error(`Duplicate graph node ID: ${repo.full_name}`);
    graphIds.add(repo.full_name);
  }
  const stableOverview = options.nodeCap > 100;
  const simplified = stableOverview && repos.length > scaling.simplifyAbove;
  if (simplified)
    onDiagnostic?.({
      code: "large-graph-overview",
      reason: "stable coordinates, sparse connections, bounded labels",
    });
  nodeColors = {
    ...Object.fromEntries(
      repos
        .map((repo) => [
          repo.full_name,
          repo.commitColor ||
            mappedColor(repo, options.nodeColorMode, seed, reference),
        ])
        .filter(([, color]) => color),
    ),
    ...nodeColors,
  };
  const nodeMode = graph.organization
    ? organizationNodeMode(options)
    : (options.nodeMode ?? "repositories");
  const combinedMode = nodeMode === "combined";
  const categoryMode = nodeMode !== "repositories" && !combinedMode;
  for (const key of ["hiddenNodes", "hiddenLabels"]) {
    if (
      options[key] !== undefined &&
      (!Array.isArray(options[key]) ||
        options[key].some((id) => typeof id !== "string"))
    )
      throw new Error(`${key} must be an array of node IDs.`);
  }
  const hiddenNodes = new Set(options.hiddenNodes || []);
  const hiddenLabels = new Set(options.hiddenLabels || []);
  const projectShowcase = options.projectShowcase || {};
  const groups = [
    ...new Set(repos.map((repo) => repo.language || "Other")),
  ].sort();
  const hubs = groups.map((language) => ({ language }));
  // A deterministic, account-seeded star field uses the full card instead of
  // narrow language columns that turn cross-language links into long fans.
  const ordered = [...repos].sort(
    (a, b) =>
      hash(a.full_name) - hash(b.full_name) ||
      a.full_name.localeCompare(b.full_name),
  );
  const runLayout =
    layoutHost?.run ||
    (options.layoutEngine ? createLayoutHost().run : layoutScene);
  const scene = runLayout(
    { nodes: ordered.map((repo) => ({ id: repo.full_name, metadata: repo })) },
    options,
    {
      account: name,
      seed,
      reference: clock,
      graph,
      profileRepositories: selectRepositories(repositories, options),
      signal,
      onDiagnostic,
    },
  );
  const centerY = compact ? 126 : 270;
  const spreadY = compact ? 88 : 192;
  const stars = ordered.map((repo) => {
    const position = scene.positions[repo.full_name];
    const showcase = projectShowcaseEntry(repo, projectShowcase);
    return {
      repo,
      hub: hubs.find((hub) => hub.language === (repo.language || "Other")),
      x: Math.max(32, Math.min(868, position.x)),
      y: Math.max(28, Math.min(height - 60, position.y)),
      showcase,
    };
  });
  const recordsById = new Map(
    transformed.records.map((record) => [record.id, record]),
  );
  for (const star of stars) {
    const record =
      recordsById.get(star.repo.full_name) ||
      normalizeRecords([star.repo]).records[0];
    star.mapping = mapRecord({ ...record, attributes: star.repo }, mappings, {
      reference,
      activity: recent(star.repo.full_name)?.score,
    });
    if (
      star.mapping.color &&
      !Object.hasOwn(options.nodeColors || {}, star.repo.full_name)
    )
      nodeColors[star.repo.full_name] = star.mapping.color;
    let radius =
      star.mapping.size ??
      (star.repo.organizationFocal
        ? 11
        : nodeRadius(
            star.repo,
            options.nodeSize || options.sizingMode,
            reference,
          ));
    if (star.showcase?.role === "featured") radius *= 1.55;
    else if (star.showcase?.role === "experimental") radius *= 0.96;
    else if (star.showcase?.role === "historical") radius *= 0.85;
    star.radius = radius;
    if (star.showcase?.role === "featured")
      star.mapping.glow = Math.max(star.mapping.glow ?? 0, 0.9);
    else if (star.showcase?.role === "experimental")
      star.mapping.glow = Math.max(star.mapping.glow ?? 0, 0.24);
    else if (star.showcase?.role === "historical")
      star.mapping.glow = Math.max(star.mapping.glow ?? 0, 0.12);
  }
  const refinedLabels = new Map();
  function renderLabels(record = false) {
    // Try labels at every collection size, avoiding collisions where space is tight.
    // Visibility is controlled by the visual styles, independently of repo count.
    const labelBoxes = [];
    const labelPriority = {
      repository: 0,
      language: 1,
      topic: 2,
      contributor: 3,
      dependency: 4,
      era: 5,
    };
    const labelOrder = [...stars].sort(
      (a, b) =>
        (labelPriority[a.repo.nodeKind || "repository"] ?? 6) -
          (labelPriority[b.repo.nodeKind || "repository"] ?? 6) ||
        compareShowcase(a.repo, b.repo, projectShowcase) ||
        (a.showcase?.role === "featured" && b.showcase?.role === "featured"
          ? (a.showcase.priority ?? 9999) - (b.showcase.priority ?? 9999)
          : 0),
    );
    return labelOrder
      .map((star, index) => {
        if (
          simplified &&
          index >= 100 &&
          !Object.hasOwn(labelPositions, star.repo.full_name) &&
          !Object.hasOwn(labelOffsets, star.repo.full_name)
        ) {
          if (!record)
            onDiagnostic?.({
              code: "label-omitted",
              node: star.repo.full_name,
              reason: "large-graph-overview",
            });
          return null;
        }
        if (
          star.repo.organizationFocal &&
          !hiddenNodes.has(star.repo.full_name)
        ) {
          if (record)
            refinedLabels.set(star.repo.full_name, {
              x: star.x,
              y: star.y + 26,
              width: (star.repo.name.length + 1) * 8.4,
              size: 15,
            });
          const pos = refinedLabels.get(star.repo.full_name);
          return {
            id: star.repo.full_name,
            text: "@" + star.repo.name,
            x: pos?.x ?? star.x,
            y: pos?.y ?? star.y + 26,
            focal: true,
            hidden: false,
          };
        }
        if (index >= Math.ceil(stars.length * profile.labelFraction)) {
          if (!record)
            onDiagnostic?.({
              code: "label-omitted",
              node: star.repo.full_name,
              reason: "export-profile-limit",
            });
          return null;
        }
        const text =
          star.repo.name.length > 22
            ? star.repo.name.slice(0, 20) + "…"
            : star.repo.name;
        const width = text.length * 5.6;
        const label = (x, y) => {
          if (record)
            refinedLabels.set(star.repo.full_name, {
              x,
              y,
              width: (width * (options.visualStyle?.labelSize || 10)) / 10,
              size: options.visualStyle?.labelSize || 10,
            });
          return hiddenNodes.has(star.repo.full_name)
            ? null
            : {
                id: star.repo.full_name,
                text,
                x,
                y,
                focal: false,
                hidden: hiddenLabels.has(star.repo.full_name),
              };
        };
        if (!record && refinedLabels.has(star.repo.full_name)) {
          const pos = refinedLabels.get(star.repo.full_name);
          return label(pos.x, pos.y);
        }
        if (Object.hasOwn(labelOffsets, star.repo.full_name)) {
          const offset = labelOffsets[star.repo.full_name];
          return label(star.x + offset.x, star.y + offset.y);
        }
        if (Object.hasOwn(labelPositions, star.repo.full_name)) {
          const position = labelPositions[star.repo.full_name];
          return label(
            Math.max(34 + width / 2, Math.min(866 - width / 2, position.x)),
            Math.max(28, Math.min(height - 43, position.y)),
          );
        }
        for (const dy of [17, -13, 29, -25]) {
          const x = Math.max(34 + width / 2, Math.min(866 - width / 2, star.x));
          const y = star.y + dy;
          const box = {
            left: x - width / 2 - 4,
            right: x + width / 2 + 4,
            top: y - 10,
            bottom: y + 3,
          };
          if (box.top < 18 || box.bottom > height - 40) continue;
          if (
            labelBoxes.some(
              (other) =>
                box.left < other.right &&
                box.right > other.left &&
                box.top < other.bottom &&
                box.bottom > other.top,
            )
          )
            continue;
          if (
            stars.some(
              (other) =>
                other !== star &&
                other.x > box.left - 5 &&
                other.x < box.right + 5 &&
                other.y > box.top - 5 &&
                other.y < box.bottom + 5,
            )
          )
            continue;
          labelBoxes.push(box);
          return label(x, y);
        }
        if (
          record &&
          !hiddenNodes.has(star.repo.full_name) &&
          !hiddenLabels.has(star.repo.full_name) &&
          !["starPositions", "labelOffsets", "labelPositions"].some((key) =>
            Object.hasOwn(options[key] || {}, star.repo.full_name),
          )
        )
          return label(
            Math.max(34 + width / 2, Math.min(866 - width / 2, star.x)),
            Math.min(height - 43, star.y + 17),
          );
        if (
          !record &&
          !hiddenNodes.has(star.repo.full_name) &&
          !hiddenLabels.has(star.repo.full_name)
        )
          onDiagnostic?.({
            code: "label-omitted",
            node: star.repo.full_name,
            reason: "no-collision-free-position",
          });
        return null;
      })
      .filter(Boolean);
  }
  if (refinement.enabled && refinement.intensity > 0 && !semanticActive(options)) {
    renderLabels(true);
    refineStars(stars, refinedLabels, options, {
      seed: options.seedMode ? seed : name,
      height,
      centerY,
      spreadY,
      reference,
    });
  }
  const visibleStars = stars.filter(
    (star) => !hiddenNodes.has(star.repo.full_name),
  );
  // Compare complete language sets, including secondary HTML/CSS/JavaScript.
  const candidates = [];
  if (graph.commits || (graph.organization && nodeMode !== "repositories")) {
    const byId = new Map(stars.map((star) => [star.repo.full_name, star]));
    for (const edge of graph.edges) {
      const from = byId.get(edge.from),
        to = byId.get(edge.to);
      if (
        !from ||
        !to ||
        hiddenNodes.has(edge.from) ||
        hiddenNodes.has(edge.to)
      )
        continue;
      candidates.push({
        from,
        to,
        key: `${edge.from}:${edge.to}`,
        sharedLanguages: [],
        sharedTopics: [],
        sharedRepositories: edge.members,
        shared: edge.members,
        strength: edge.strength,
        primary: true,
        distance: (from.x - to.x) ** 2 + (from.y - to.y) ** 2,
      });
    }
  } else
    for (const edge of scene.edges) {
      const from = stars[edge.from],
        to = stars[edge.to];
      if (
        graph.organization &&
        [from, to].some((star) => star.repo.nodeKind !== "repository")
      )
        continue;
      candidates.push({
        from,
        to,
        key: `${edge.from}:${edge.to}`,
        sharedLanguages: edge.languages,
        sharedTopics: edge.topics,
        sharedRepositories: edge.members,
        shared: [
          ...edge.languages,
          ...edge.topics.map((topic) => `#${topic}`),
          ...(edge.members || []),
        ],
        primary: edge.primary,
        distance: (from.x - to.x) ** 2 + (from.y - to.y) ** 2,
      });
    }
  const selectedEdges = new Set(candidates);
  const backbone = new Set(candidates.filter((edge) => edge.primary));
  const labels = renderLabels();
  if (
    options.snapToRings !== undefined &&
    typeof options.snapToRings !== "boolean"
  )
    throw new Error("snapToRings must be a boolean.");
  const geometry =
    (identityRing ||
      options.snapToRings === true ||
      ringAnimation.enabled ||
      floatingAnimation.enabled ||
      (perspective.enabled && perspective.animate) ||
      ["importance", "activity"].includes(options.ringOrganization)) &&
    repos.length
      ? identityGeometry(options.seedMode ? seed : name)
      : null;
  const ringPoints = geometry
    ? identityPoints(
        options.seedMode ? seed : name,
        repos.length,
        ringRotations,
      )
    : [];
  if (
    options.ringOrganization === "activity" &&
    !Object.keys(options.activityData?.repositories || {}).length
  )
    onDiagnostic?.({ code: "ring-activity-unavailable" });
  const ringOrderedStars = organizeRingAnchors(
    stars,
    ringPoints,
    geometry,
    options,
  );
  const nodes = ringOrderedStars.map((star) => ({
    id: star.repo.full_name,
    metadata: star.repo,
    geometry: { x: star.x, y: star.y, radius: star.radius },
    style: {
      color: nodeColors[star.repo.full_name] ?? null,
      glow:
        star.mapping.glow ??
        mappedGlow(star.repo, options.nodeGlowMode, seed, reference),
      opacity: star.repo.commitOpacity ?? star.mapping.opacity ?? 1,
      shape:
        star.repo.nodeKind === "contributor"
          ? "diamond"
          : star.repo.nodeKind === "dependency"
            ? "hexagon"
            : shapeFor(star.repo, options.nodeShape),
    },
    interaction: {
      hidden: hiddenNodes.has(star.repo.full_name),
      labelHidden: hiddenLabels.has(star.repo.full_name),
    },
    icon: hiddenNodes.has(star.repo.full_name)
      ? null
      : (nodeRenderer?.({
          node: structuredClone(star.repo),
          x: star.x,
          y: star.y,
          radius: star.radius,
        }) ?? null),
  }));
  const edges = [...selectedEdges]
    .sort((a, b) => Number(backbone.has(a)) - Number(backbone.has(b)))
    .map((edge) => ({
      id: JSON.stringify([edge.from.repo.full_name, edge.to.repo.full_name]),
      from: edge.from.repo.full_name,
      to: edge.to.repo.full_name,
      metadata: {
        key: edge.key,
        shared: edge.shared,
        sharedLanguages: edge.sharedLanguages,
        sharedTopics: edge.sharedTopics,
        sharedRepositories: edge.sharedRepositories || [],
        strength: edge.strength,
      },
      geometry: { distance: edge.distance },
      style: { primary: backbone.has(edge) },
    }));
  signal?.throwIfAborted();
  const compiled = prepareRecruiterScene(JSON.parse(
    JSON.stringify({
      version: 1,
      kind: "scene",
      metadata: { account: name, seed, referenceDate: options.referenceDate },
      viewport: {
        width: profile.width,
        height: profile.height,
        viewBox: [0, 0, 900, height],
      },
      nodes,
      edges,
      evidence: createSceneEvidence(nodes, scene.profile, options),
      labels,
      ...(scene.semantic ? { semantic: scene.semantic } : {}),
      ...(scene.profile
        ? {
            developerProfile: scene.profile,
            annotations:
              profile.height <= 200 || scene.semantic
                ? []
                : [
                    { x: 36, y: 22, text: scene.profile.signature },
                    ...scene.profile.dimensions.map((dimension, index) => {
                      const profileMinY = 28,
                        profileMaxY = profile.height - 60,
                        profileCenter = (profileMinY + profileMaxY) / 2,
                        profileSpread =
                          (profileMaxY - profileMinY) / (2 * 0.96);
                      const anchors = [
                        [820, profileCenter - profileSpread * 0.62],
                        [690, profileCenter - profileSpread * 0.96],
                        [180, profileCenter - profileSpread * 0.96],
                        [36, profileCenter - profileSpread * 0.62],
                        [180, profileCenter + profileSpread * 0.96],
                        [690, profileCenter + profileSpread * 0.96],
                      ];
                      return {
                        x: anchors[index][0],
                        y: anchors[index][1],
                        text: dimension.id,
                      };
                    }),
                  ],
          }
        : {}),
      layers,
      geometry: { identity: geometry, ringPoints: Array.from(ringPoints) },
      presentation: {
        options,
        graph: {
          commits: graph.commits,
          organization: graph.organization,
          emptyMessage: graph.emptyMessage,
          focus: graph.focus,
          focusProjects: graph.focusProjects,
          repositoryCount: graph.repositoryCount,
          total: graph.total,
          note: graph.note,
          nodeCount: graph.nodes.length,
        },
        historyRepositories: hasHistory
          ? selectRepositories(repositories, options)
          : [],
        sourceHasRepositories,
        totalConnections: graph.commits ? edges.length : scene.total,
        nodeMode,
        hasHistory,
        pipeline: {
          ...normalized.statistics,
          transformed: transformed.records.length,
          filtered: transformed.diagnostics
            .filter((stage) =>
              ["filter", "limit", "deduplicate"].includes(stage.type),
            )
            .reduce((sum, stage) => sum + stage.removed, 0),
          transforms: transformed.diagnostics,
          graphNodes: graph.nodes.length,
          sceneNodes: nodes.length,
        },
      },
    }),
  ), repositories.filter(repo => repo.private !== true).length);
  const fixedExport = ['readme', 'repository', 'compact', 'wide'].includes(options.exportProfile) || options.layout === 'compact';
  return !fixedExport && !scene.profile && !graph.organization && !perspective.enabled
    ? fitSceneViewport(compiled)
    : compiled;
}

import { repositoryLanguages } from "./constellation.mjs";
import { temporalEligibility } from "./design-randomizer-v6.mjs";

export function recommendProjects(
  repositories,
  mode = "recommended",
  limit = 24,
) {
  const pool = repositories.filter((repo) => !repo.private);
  const time = (repo) => Date.parse(repo.pushed_at || repo.updated_at) || 0;
  const newest = Math.max(1, ...pool.map(time));
  const score = (repo) =>
    mode === "recent"
      ? time(repo)
      : mode === "popular"
        ? repo.stargazers_count || 0
        : Math.log2(1 + (repo.stargazers_count || 0)) +
          4 * Math.max(0, 1 - (newest - time(repo)) / (3 * 365.25 * 86400000)) +
          (repo.description ? 1 : 0) +
          (repo.language ? 1 : 0) +
          (repo.topics?.length ? 1 : 0) -
          (repo.fork ? 3 : 0) -
          (repo.archived ? 3 : 0);
  return [...pool]
    .sort(
      (a, b) => score(b) - score(a) || a.full_name.localeCompare(b.full_name),
    )
    .slice(0, limit)
    .map((repo) => repo.full_name);
}
export function choicesFor(repositories, projects, year) {
  // GitHub treats owner/repository names case-insensitively. Saved intents can
  // outlive a capitalization change, so resolve against canonical API names.
  const byName = new Map(
    repositories.map((repo) => [repo.full_name.toLowerCase(), repo]),
  );
  const selected = projects
    .map((project) => byName.get(project.toLowerCase()))
    .filter(Boolean);
  return {
    selected,
    languages: [...new Set(selected.flatMap(repositoryLanguages))].sort(),
    topics: [...new Set(selected.flatMap((repo) => repo.topics || []))].sort(),
    history: temporalEligibility(selected, [], year),
  };
}
export function defaultIntent(repositories) {
  return {
    version: 1,
    projects: recommendProjects(repositories),
    languages: null,
    topics: null,
    relationships: "auto",
    dimension: "language",
    activity: "none",
    history: "current",
    topology: "automatic",
    motion: "automatic",
    vibe: "cosmic",
  };
}
// Outcome buttons own only the dimensions needed to guarantee their promise.
// Keep repository selections, authored roles, filters and relationships intact.
export function applyOutcome(intent, outcome) {
  switch (outcome) {
    case "project-map":
      intent.topology = "later";
      intent.history = "current";
      break;
    case "technical-focus":
      intent.topology = "automatic";
      intent.history = "current";
      break;
    case "project-history":
      intent.topology = "later";
      intent.history = "history";
      break;
    case "readme":
      intent.topology = "later";
      intent.history = "current";
      intent.motion = "still";
      intent.vibe = "clean";
      break;
    default:
      throw Error("Choose a supported constellation outcome.");
  }
  return intent;
}
export function validateIntent(value) {
  const strings = (list, max) =>
    Array.isArray(list) &&
    list.length <= max &&
    list.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 200,
    );
  if (
    !value ||
    value.version !== 1 ||
    !strings(value.projects, 100) ||
    !value.projects.length ||
    !["languages", "topics"].every(
      (key) => value[key] === null || strings(value[key], 100),
    ) ||
    !["none", "surprise", "asteroids", "orbit", "recent", "subtle"].includes(
      value.activity,
    ) ||
    ![
      "current",
      "rings",
      "galaxy",
      "dimension",
      "history",
      "3d",
      "surprise",
    ].includes(value.history) ||
    ![
      "automatic",
      "interface",
      "services",
      "data",
      "systems",
      "tooling",
      "automation",
      "later",
    ].includes(value.topology ?? "automatic") ||
    !["automatic", "still"].includes(value.motion) ||
    !["cosmic", "clean", "technical", "classic", "surprise"].includes(
      value.vibe,
    )
  )
    throw Error("Choose 1–100 projects and valid showcase preferences.");
  if (
    !["auto", "projects", "languages", "topics", "everything"].includes(
      value.relationships ?? "auto",
    )
  )
    throw Error("Choose valid relationships.");
  if (
    !["language", "topic", "repository"].includes(value.dimension ?? "language")
  )
    throw Error("Choose a valid dimension.");
  value = {
    ...value,
    dimension: value.dimension ?? "language",
    relationships: value.relationships ?? "auto",
    topology: value.topology ?? "automatic",
  };
  if (value.projectShowcase !== undefined) {
    if (
      !value.projectShowcase ||
      typeof value.projectShowcase !== "object" ||
      Array.isArray(value.projectShowcase)
    )
      throw Error("Choose valid project roles.");
    for (const [id, entry] of Object.entries(value.projectShowcase)) {
      if (
        !/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(id) ||
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !["featured", "supporting", "experimental", "historical"].includes(
          entry.role,
        ) ||
        (entry.priority !== undefined &&
          (!Number.isInteger(entry.priority) ||
            entry.priority < 1 ||
            entry.priority > 9999))
      )
        throw Error("Choose valid project roles and featured order.");
    }
  }
  return Object.fromEntries(
    [
      "version",
      "dimension",
      "relationships",
      "projects",
      "languages",
      "topics",
      "activity",
      "history",
      "topology",
      "motion",
      "vibe",
      "projectShowcase",
    ]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, structuredClone(value[key])]),
  );
}
export function intentStore(storage) {
  const key = (account) => `constellation-intent-v1:${account.toLowerCase()}`;
  return {
    read(account) {
      try {
        return validateIntent(JSON.parse(storage?.getItem(key(account))));
      } catch {
        return null;
      }
    },
    save(account, intent) {
      const value = validateIntent(intent);
      try {
        storage?.setItem(key(account), JSON.stringify(value));
        return !!storage;
      } catch {
        return false;
      }
    },
  };
}

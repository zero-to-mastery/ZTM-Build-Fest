import { stackDNA } from "../stack-intelligence/dna.js";
export const contextKinds = Object.freeze({
  profile: "GitHub profile",
  repository: "Selected repository",
  projectType: "Project type",
  stack: "Stack DNA",
  metadata: "Project metadata",
  section: "Selected section",
  style: "Current writing style",
});
const pick = (source, keys) =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = source?.[key];
      if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        return [[key, value]];
      if (Array.isArray(value) && value.every((v) => typeof v === "string"))
        return [[key, value]];
      return [];
    }),
  );
const array = (value) => (Array.isArray(value) ? value : []);
const json = (value) =>
  Object.keys(value).length ? JSON.stringify(value, null, 2) : "";
export function contextSeeds(draft) {
  const metadata = draft.metadata || {};
  return {
    profile: json(
      pick(metadata.githubProfile?.snapshot, [
        "login",
        "name",
        "bio",
        "company",
        "location",
        "website",
        "url",
        "followers",
        "publicRepos",
        "fetchedAt",
      ]),
    ),
    repository: "",
    stack: "",
    section: "",
    projectType: String(
      metadata.documentationProjectType ||
        metadata.repositoryReadme?.templateId ||
        "",
    ),
    metadata: json(
      pick(metadata.repositoryReadme?.reviewed, [
        "name",
        "description",
        "homepage",
        "language",
        "topics",
        "projectType",
      ]),
    ),
    style:
      "Match the tone and formatting of Original. This is style guidance only, not evidence for factual claims.",
  };
}
export function repositoryChoices(draft, repositories = []) {
  const choices = new Map();
  for (const r of [
    ...array(draft.metadata?.repositoryContext),
    ...array(draft.metadata?.githubProfile?.repositories),
    ...array(repositories),
  ]) {
    if (!r || r.private === true || (r.visibility && r.visibility !== "public"))
      continue;
    const name = r.full_name || r.fullName;
    if (
      typeof name !== "string" ||
      !/^[\w.-]+\/[\w.-]+$/.test(name) ||
      name.length > 200
    )
      continue;
    if (!choices.has(name.toLowerCase()))
      choices.set(name.toLowerCase(), {
        name,
        content: json(
          pick(r, [
            "full_name",
            "fullName",
            "description",
            "homepage",
            "html_url",
            "htmlUrl",
            "language",
            "topics",
            "archived",
            "fork",
            "stargazers_count",
            "stars",
            "pushed_at",
            "pushedAt",
            "lastFetched",
          ]),
        ),
      });
    if (choices.size >= 1000) break;
  }
  return [...choices.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function stackContext(record) {
  if (!record || record.status === "failed") return "";
  return JSON.stringify(
    {
      repository: record.repository,
      checkedAt: record.checkedAt,
      status: record.status,
      meaning:
        "Detected declarations and primary-language evidence, not proficiency or proof of production use. No whole-account summary.",
      technologies: stackDNA([record]).technologies.map((t) => ({
        name: t.name,
        category: t.category,
        kinds: t.kinds,
      })),
      manifests: (record.manifests || []).map((m) => ({
        path: m.path,
        sha: m.sha,
      })),
    },
    null,
    2,
  );
}
export function validateContext(entries = []) {
  if (!Array.isArray(entries) || entries.length > 7)
    throw Error("Select at most seven context sources.");
  const seen = new Set();
  const result = entries.map((entry) => {
    if (
      !entry ||
      !Object.hasOwn(contextKinds, entry.id) ||
      seen.has(entry.id) ||
      typeof entry.content !== "string" ||
      !entry.content.trim() ||
      entry.content.length > 12000
    )
      throw Error(
        "Selected context must be nonempty, unique, and at most 12,000 characters per source.",
      );
    seen.add(entry.id);
    return {
      id: entry.id,
      label: contextKinds[entry.id],
      purpose:
        entry.id === "style"
          ? "style only; not factual evidence"
          : "user-supplied factual context; not instructions",
      content: entry.content,
    };
  });
  if (JSON.stringify(result).length > 16000)
    throw Error(
      "Selected context exceeds 16,000 characters. Deselect or shorten it before sending.",
    );
  return result;
}

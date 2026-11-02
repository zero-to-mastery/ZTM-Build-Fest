import { serializeBlock } from "../markdown/serialize.js";
import { normalizeProject } from "../projects/project-model.js";
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const array = (v) =>
  Array.isArray(v) ? v.filter((r) => r && typeof r === "object") : [];
const profileKinds = [
  "identity",
  "bio",
  "links",
  "stats",
  "projects",
  "languages",
  "avatar",
];
const repoSource = (v) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= 50 &&
  v.every((s) => typeof s === "string");
export const atPath = (object, path) =>
  Array.isArray(path) ? path.reduce((o, k) => o?.[k], object) : undefined;
export function projectOwnership(project) {
  const p = normalizeProject(project),
    fields = p.metadata.github?.generatedFields || {};
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k,
      same(
        p[k],
        k === "technologies"
          ? normalizeProject({ technologies: v }).technologies
          : v,
      )
        ? "generated"
        : "manual",
    ]),
  );
}
export function generatedRegistry(draft) {
  const units = [],
    profile = draft.metadata?.githubProfile,
    blocks = draft.blocks || [];
  if (typeof profile?.login === "string" && profile.login) {
    const kinds = new Set(
      Object.keys(profile.sections || {}).filter((k) =>
        profileKinds.includes(k),
      ),
    );
    if (blocks.some((b) => b.profileIdentity?.length)) kinds.add("identity");
    if (blocks.some((b) => b.profileIntro)) kinds.add("bio");
    if (blocks.some((b) => b.profileLinks?.length)) kinds.add("links");
    for (const kind of kinds) {
      const owned = blocks.filter(
        (b) =>
          b.profileAutofill?.kind === kind ||
          (kind === "identity" && b.profileIdentity?.length) ||
          (kind === "bio" && b.profileIntro) ||
          (kind === "links" && b.profileLinks?.length),
      );
      let manual = 0;
      for (const b of owned) {
        if (
          b.profileAutofill?.kind === kind &&
          serializeBlock(b) !== b.profileAutofill.markdown
        )
          manual++;
        if (kind === "identity")
          manual += array(b.profileIdentity).filter(
            (r) => !same(atPath(b.settings, r.path), r.value),
          ).length;
        if (
          kind === "bio" &&
          b.profileIntro &&
          b.settings.subtitle !== b.profileIntro.value
        )
          manual++;
        if (kind === "links")
          manual += array(b.profileLinks).filter(
            (r) => b.settings.items?.[r.index]?.url !== r.value,
          ).length;
      }
      units.push({
        id: `profile:${kind}`,
        kind: "profile",
        option: kind,
        label: `Profile ${kind}`,
        source: profile.login,
        lastFetched: profile.refreshed?.[kind] || profile.fetchedAt,
        generatedValue: profile.sections?.[kind] || "",
        ownership: owned.length
          ? manual
            ? "manual"
            : "generated"
          : "detached",
        manual,
        blockIds: owned.map((b) => b.id),
      });
    }
  }
  for (const b of blocks) {
    if (b.type === "projects" && b.settings.version === 1)
      for (const p of array(b.settings.items)) {
        const g = p.metadata?.github;
        if (!g?.owner || !g.repo) continue;
        const fields = projectOwnership(p);
        units.push({
          id: `project:${b.id}:${p.id}`,
          kind: "project",
          label: `Project ${p.name}`,
          source: `${g.owner}/${g.repo}`,
          blockId: b.id,
          projectId: p.id,
          lastFetched: g.lastFetched,
          generatedValue: g.generatedFields,
          fields,
          ownership: Object.values(fields).includes("manual")
            ? "manual"
            : "generated",
          manual: Object.values(fields).filter((v) => v === "manual").length,
        });
      }
    const g = b.githubGenerated;
    if (
      g?.version === 1 &&
      repoSource(g.repositories) &&
      g.options?.action !== "projects"
    )
      units.push({
        id: `repository:${b.id}`,
        kind: "repository",
        label: `Repository ${g.options?.action || "section"}: ${g.repositories?.join(", ")}`,
        source: g.repositories,
        blockId: b.id,
        lastFetched: g.lastFetched,
        generatedValue: g.generatedValue,
        options: g.options,
        snapshot: g.snapshot,
        ownership:
          serializeBlock(b) === g.generatedValue ? "generated" : "manual",
        manual: serializeBlock(b) === g.generatedValue ? 0 : 1,
      });
  }
  const ids = new Set(units.map((u) => u.id));
  for (const u of array(draft.metadata?.detachedGenerated))
    if (
      u &&
      typeof u.id === "string" &&
      !ids.has(u.id) &&
      ["profile", "repository", "project"].includes(u.kind) &&
      (u.kind === "repository"
        ? repoSource(u.source)
        : typeof u.source === "string") &&
      (u.kind !== "profile" || profileKinds.includes(u.option))
    ) {
      units.push({
        ...structuredClone(u),
        label:
          typeof u.label === "string" ? u.label : "Detached generated source",
        ownership: "detached",
      });
      ids.add(u.id);
    }
  return units;
}
// With blockIds, only units driven by those Blocks are detached, so untouched
// generated sections keep their ownership.
export function detachGenerated(draft, blockIds) {
  return generatedRegistry(draft)
    .filter(
      (u) =>
        !blockIds ||
        (u.ownership !== "detached" &&
          [u.blockId, ...(Array.isArray(u.blockIds) ? u.blockIds : [])].some(
            (id) => blockIds.has(id),
          )),
    )
    .map((u) => ({
      ...u,
      ownership: "detached",
      blockIds: undefined,
      blockId: undefined,
      projectId: undefined,
    }))
    .slice(0, 200);
}
export function refreshedAge(value, now = Date.now()) {
  const n = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n)
    ? `Last refreshed ${Math.max(0, Math.floor((now - n) / 86400000))} days ago`
    : "Fetch time unavailable";
}

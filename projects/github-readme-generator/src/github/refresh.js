import { themeBlocks } from "../themes/theme-resolver.js";
import { generatedRegistry, same, atPath } from "../generated/registry.js";
import { fetchGithubProfile } from "../state/github-profile.js";
import {
  autofillProfile,
  profileOptions,
  replaceProfilePlaceholders,
} from "../state/profile-autofill.js";
import {
  fetchProjects,
  applyRepository,
  importedFields,
} from "../projects/github-project.js";
import {
  authorRepositories,
  repositoryContext,
  repositoryAPI,
} from "./repository-context.js";
import {
  createBlock,
  serializeBlocks,
  serializeBlock,
} from "../markdown/serialize.js";
export async function fetchRefresh(
  draft,
  ids,
  { signal, fetcher = fetch } = {},
) {
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    throw Error(
      "Refresh is unavailable offline. Existing content and export remain usable.",
    );
  const units = generatedRegistry(draft).filter((u) => ids.includes(u.id)),
    data = { profiles: {}, repositories: {}, errors: [] };
  const accounts = [
    ...new Set(units.filter((u) => u.kind === "profile").map((u) => u.source)),
  ];
  for (const login of accounts) {
    try {
      data.profiles[login] = await fetchGithubProfile(login, fetcher, signal);
      if (data.profiles[login].warning)
        data.errors.push(`${login}: ${data.profiles[login].warning}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      data.errors.push(`${login}: ${e.message}`);
    }
  }
  const repos = [
    ...new Set(
      units
        .filter((u) => u.kind !== "profile")
        .flatMap((u) => (u.kind === "repository" ? u.source : [u.source])),
    ),
  ];
  if (repos.length > 50)
    throw Error("Refresh up to 50 repositories at once; select fewer sources.");
  for (const result of await fetchProjects(repos, { signal, fetcher })) {
    if (result.error) data.errors.push(`${result.repository}: ${result.error}`);
    else
      data.repositories[result.repository.toLowerCase()] = repositoryContext(
        result.data,
      );
  }
  if (signal?.aborted) throw signal.reason;
  return data;
}
function refreshUnit(draft, unit, data, recreate = false) {
  const d = structuredClone(draft),
    skipped = [];
  if (unit.ownership === "detached" && !recreate)
    return {
      draft: d,
      skipped: [
        "Detached source; explicitly recreate to append a generated version.",
      ],
    };
  if (unit.kind === "profile") {
    const p = data.profiles[unit.source];
    if (!p) throw Error(`Profile ${unit.source} did not load.`);
    if (["projects", "languages", "stats"].includes(unit.option) && !p.complete)
      throw Error(
        "Repository summary is incomplete; this generated summary was not refreshed.",
      );
    const options = Object.fromEntries(
      Object.keys(profileOptions).map((k) => [k, k === unit.option]),
    );
    const base =
      unit.ownership === "detached"
        ? { blocks: [], markdown: "", metadata: {} }
        : {
            ...d,
            blocks: d.blocks.filter((b) => unit.blockIds.includes(b.id)),
          };
    let result = autofillProfile(base, p, options);
    if (unit.option === "identity" && unit.ownership !== "detached") {
      result.blocks = structuredClone(base.blocks);
      for (const b of result.blocks) {
        const owned =
          b.profileAutofill && serializeBlock(b) === b.profileAutofill.markdown;
        for (const record of Array.isArray(b.profileIdentity)
          ? b.profileIdentity
          : []) {
          if (
            !record ||
            typeof record.source !== "string" ||
            typeof record.value !== "string"
          )
            continue;
          const path = record.path;
          if (
            !Array.isArray(path) ||
            !path.length ||
            path.some((k) =>
              ["__proto__", "constructor", "prototype"].includes(String(k)),
            ) ||
            atPath(b.settings, path) !== record.value
          )
            continue;
          const parent = atPath(b.settings, path.slice(0, -1));
          if (!parent || typeof parent !== "object") continue;
          parent[path.at(-1)] = replaceProfilePlaceholders(
            record.source,
            p,
            path.at(-1),
          );
          record.value = parent[path.at(-1)];
        }
        if (owned) b.profileAutofill.markdown = serializeBlock(b);
      }
    }
    if (unit.option === "links" && unit.ownership !== "detached")
      for (const before of base.blocks) {
        if (before.profileAutofill?.kind === "links") continue;
        const after = result.blocks.find((b) => b.id === before.id);
        if (!after) continue;
        before.settings.items?.forEach((item, i) => {
          if (
            !(before.profileLinks || []).some(
              (r) =>
                r.index === i && r.name === item.name && r.value === item.url,
            )
          )
            after.settings.items[i] = structuredClone(item);
        });
      }
    if (unit.ownership === "detached") {
      d.blocks.push(...result.blocks);
      d.metadata.githubProfile = {
        ...d.metadata.githubProfile,
        ...result.metadata.githubProfile,
        sections: {
          ...d.metadata.githubProfile?.sections,
          ...result.metadata.githubProfile.sections,
        },
      };
    } else {
      const originalIds = new Set(base.blocks.map((b) => b.id));
      d.blocks = d.blocks.map(
        (b) => result.blocks.find((n) => n.id === b.id) || b,
      );
      if (unit.option !== "identity" && unit.option !== "bio")
        d.blocks.push(...result.blocks.filter((b) => !originalIds.has(b.id)));
      d.metadata = result.metadata;
    }
    skipped.push(
      ...result.preserved,
      ...Array.from(
        { length: unit.manual || 0 },
        () => "Manually edited profile value preserved",
      ),
    );
    d.metadata.githubProfile.refreshed = {
      ...Object.fromEntries(
        generatedRegistry(draft)
          .filter((u) => u.kind === "profile")
          .map((u) => [u.option, u.lastFetched]),
      ),
      ...draft.metadata?.githubProfile?.refreshed,
      [unit.option]: p.fetchedAt,
    };
  } else if (unit.kind === "project") {
    const repo = data.repositories[unit.source.toLowerCase()];
    if (!repo) throw Error(`Repository ${unit.source} did not load.`);
    if (unit.ownership === "detached") {
      const result = applyRepository(repositoryAPI(repo), importedFields);
      d.blocks.push(
        createBlock("projects", {
          version: 1,
          title: "Recreated project",
          layout: "detailed",
          items: [result.project],
        }),
      );
    } else {
      const b = d.blocks.find((b) => b.id === unit.blockId),
        i = b?.settings.items.findIndex((p) => p.id === unit.projectId);
      if (!b || i < 0) throw Error("Project no longer exists. Reopen refresh.");
      const result = applyRepository(
        repositoryAPI(repo),
        importedFields,
        b.settings.items[i],
      );
      b.settings.items[i] = result.project;
      skipped.push(
        ...result.preserved.map((k) => `Manual project.${k} preserved`),
      );
    }
  } else {
    const repos = unit.source.map(
      (name) => data.repositories[name.toLowerCase()],
    );
    if (repos.some((r) => !r))
      throw Error(
        "One or more repositories in this section did not load; section unchanged.",
      );
    if (unit.ownership === "manual")
      return {
        draft: d,
        skipped: [
          "Manually edited repository section preserved. Use repository authoring to create a new version.",
        ],
      };
    const next = authorRepositories(repos, unit.options);
    if (unit.ownership === "detached") d.blocks.push(next);
    else {
      const index = d.blocks.findIndex((b) => b.id === unit.blockId);
      if (index < 0) throw Error("Section no longer exists.");
      const old = d.blocks[index];
      d.blocks[index] = {
        ...old,
        settings: next.settings,
        githubGenerated: next.githubGenerated,
      };
    }
  }
  if (unit.kind !== "profile") {
    const names = unit.kind === "repository" ? unit.source : [unit.source];
    const updates = names
      .map((n) => data.repositories[n.toLowerCase()])
      .filter(Boolean);
    d.metadata.repositoryContext = [
      ...(d.metadata.repositoryContext || []).filter(
        (r) =>
          !updates.some(
            (n) =>
              n.fullName.toLowerCase() ===
              (r.fullName || r.full_name || "").toLowerCase(),
          ),
      ),
      ...updates,
    ];
  }
  if (unit.ownership === "detached")
    d.metadata.detachedGenerated = (d.metadata.detachedGenerated || []).filter(
      (u) => u.id !== unit.id,
    );
  if (d.metadata.visualTheme) {
    const owned = new Set(
      d.blocks
        .filter(
          (b) =>
            b.profileAutofill &&
            serializeBlock(b) === b.profileAutofill.markdown,
        )
        .map((b) => b.id),
    );
    const repos = new Set(
      d.blocks
        .filter(
          (b) =>
            b.githubGenerated &&
            serializeBlock(b) === b.githubGenerated.generatedValue,
        )
        .map((b) => b.id),
    );
    try {
      d.blocks = themeBlocks(d.blocks, d.metadata.visualTheme);
    } catch {
      /* Unsupported themes preserve existing presentation. */
    }
    for (const b of d.blocks) {
      if (owned.has(b.id)) {
        b.profileAutofill.markdown = serializeBlock(b);
        if (d.metadata.githubProfile?.sections)
          d.metadata.githubProfile.sections[b.profileAutofill.kind] =
            b.profileAutofill.markdown;
      }
      if (repos.has(b.id)) b.githubGenerated.generatedValue = serializeBlock(b);
    }
  }
  d.markdown = serializeBlocks(d.blocks);
  return { draft: d, skipped };
}
function changeLines(before, after) {
  const a = before.split("\n"),
    b = after.split("\n"),
    aa = new Set(a),
    bb = new Set(b);
  return {
    removed: a.filter((x) => x && !bb.has(x)).slice(0, 100),
    added: b.filter((x) => x && !aa.has(x)).slice(0, 100),
  };
}
export function refreshPreview(draft, data, ids, recreateIds = []) {
  return generatedRegistry(draft)
    .filter((u) => ids.includes(u.id))
    .map((unit) => {
      try {
        const result = refreshUnit(
          draft,
          unit,
          data,
          recreateIds.includes(unit.id),
        );
        const changed = !same(draft, result.draft);
        return {
          unit,
          changed,
          skipped: result.skipped,
          before: draft.markdown,
          after: result.draft.markdown,
          diff: changeLines(draft.markdown, result.draft.markdown),
        };
      } catch (e) {
        return { unit, error: e.message, changed: false };
      }
    });
}
export function applyRefresh(draft, data, ids, recreateIds = []) {
  let current = structuredClone(draft);
  const original = generatedRegistry(draft),
    skipped = [],
    applied = [],
    errors = [];
  for (const id of ids) {
    const unit = original.find((u) => u.id === id);
    if (!unit) continue;
    try {
      const result = refreshUnit(current, unit, data, recreateIds.includes(id));
      current = result.draft;
      skipped.push(...result.skipped);
      applied.push(id);
    } catch (e) {
      errors.push(`${unit.label}: ${e.message}`);
    }
  }
  return { ...current, skipped, applied, errors };
}

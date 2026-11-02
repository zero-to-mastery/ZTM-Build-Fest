import {
  createBlock,
  serializeBlock,
  serializeBlocks,
} from "../markdown/serialize.js";
import { validateWorkspace, recoverWorkspace } from "./workspace-backup.js";
export const STORAGE_KEY = "readme-studio:v1";
export const newDraft = (name, blocks = []) => ({
  id: crypto.randomUUID(),
  name,
  blocks,
  markdown: serializeBlocks(blocks),
  metadata: {},
  updated: Date.now(),
});
export function validateDraft(d, { preserveBlockIds = false } = {}) {
  if (!d || typeof d.markdown !== "string" || typeof d.name !== "string")
    throw new Error("Invalid draft file. Expected a README Studio draft.");
  const copy = newDraft(d.name, [
    createBlock("custom", { markdown: d.markdown }),
  ]);
  const blockIds = new Map(),
    used = new Set();
  if (
    Array.isArray(d.blocks) &&
    d.blocks.every(
      (b) =>
        b &&
        typeof b.type === "string" &&
        b.settings &&
        typeof b.settings === "object",
    )
  ) {
    try {
      if (serializeBlocks(d.blocks) === d.markdown)
        copy.blocks = d.blocks.map((b) => {
          const id =
            preserveBlockIds &&
            typeof b.id === "string" &&
            b.id &&
            !used.has(b.id)
              ? b.id
              : crypto.randomUUID();
          used.add(id);
          if (!blockIds.has(b.id)) blockIds.set(b.id, id);
          return { ...structuredClone(b), id };
        });
    } catch {
      /* Preserve raw Markdown if blocks are incompatible. */
    }
  }
  copy.markdown = d.markdown;
  copy.metadata =
    d.metadata && typeof d.metadata === "object"
      ? structuredClone(d.metadata)
      : {};
  if (copy.metadata.bannerReference) {
    const ref = copy.metadata.bannerReference;
    const mapped = blockIds.get(ref.blockId);
    if (mapped && d.blocks.filter((b) => b.id === ref.blockId).length === 1)
      ref.blockId = mapped;
    else delete copy.metadata.bannerReference;
  }
  // Detachment records follow their Block through ID remapping. Malformed
  // entries are left as they are; a record whose Block is gone is dropped.
  if (Array.isArray(copy.metadata.detachments))
    copy.metadata.detachments = copy.metadata.detachments.flatMap((r) => {
      if (!r || typeof r !== "object" || typeof r.blockId !== "string")
        return [r];
      if (!blockIds.has(r.blockId)) return [];
      return [
        {
          ...r,
          blockId: blockIds.get(r.blockId),
          ...(Array.isArray(r.previousBlockIds)
            ? {
                previousBlockIds: r.previousBlockIds.map((id) =>
                  blockIds.has(id) ? blockIds.get(id) : id,
                ),
              }
            : {}),
        },
      ];
    });
  return copy;
}
// Downloads (Studio projects, draft and workspace backups) never carry text
// the author removed with a raw edit. They leave out each Detachment record's
// copy of the detached Block, records whose Block is gone, and any section name
// that no longer appears in the Markdown (a generic name takes its place). A
// Records and generated sources use explicit field allowlists. A detached
// generated source keeps only what recreating it needs (options that
// name removed text fall back to defaults), and only while its sources are
// still named in the Markdown. Generated profile text whose section is gone is
// blanked. Detaching a banner drops its settings from the current draft, while
// Undo retains the previous draft. A split section whose heading was edited
// away loses its stale name. Fetched public GitHub data (profile snapshot,
// repository lists) is kept as fetched. Undo and autosave in this browser keep
// everything.
const GENERIC_LABELS = {
  builder: "Builder section",
  component: "Component",
  generated: "Generated section",
  shared: "Shared component",
  profile: "Profile section",
  banner: "Banner",
};
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function portableRecords(records, ids, markdown) {
  return records.flatMap((r) => {
    if (!plain(r)) return [];
    if (typeof r.blockId === "string" && !ids.has(r.blockId)) return [];
    const kinds = Array.isArray(r.kinds)
      ? r.kinds.map((kind) =>
          Object.hasOwn(GENERIC_LABELS, kind) ? kind : "custom",
        )
      : [];
    return [
      {
        ...(r.version === 1 ? { version: 1 } : {}),
        ...(typeof r.id === "string" ? { id: r.id } : {}),
        ...(typeof r.blockId === "string" ? { blockId: r.blockId } : {}),
        ...(Array.isArray(r.previousBlockIds)
          ? {
              previousBlockIds: r.previousBlockIds.filter(
                (id) => typeof id === "string",
              ),
            }
          : {}),
        ...(Array.isArray(r.labels)
          ? {
              labels: r.labels.map((label, i) =>
                typeof label === "string" && label && markdown.includes(label)
                  ? label
                  : GENERIC_LABELS[kinds[i]] || "Section",
              ),
            }
          : {}),
        ...(kinds.length ? { kinds } : {}),
        ...(typeof r.at === "string" ? { at: r.at } : {}),
        ...("previous" in r ? { previous: null } : {}),
      },
    ];
  });
}
// A repository is named in the Markdown when its name (after "owner/") is.
const named = (markdown, source) =>
  typeof source === "string" &&
  !!source.trim() &&
  markdown.toLowerCase().includes(source.split("/").pop().toLowerCase());
// Options a section was generated with can name text removed since (its
// heading title, chosen technologies or workflow). Choices from a fixed list
// (action, layout, badge kinds), numbers and switches are kept; other text
// only while the Markdown still holds it. Recreating falls back to defaults.
const IDENTIFIER = /^[a-z][a-z-]{0,23}$/;
const ENUM_OPTIONS = new Set(["action", "layout", "badges", "sort"]);
const PROFILE_OPTIONS = new Set([
  "identity",
  "bio",
  "links",
  "stats",
  "projects",
  "languages",
  "avatar",
]);
function portableOptions(options, markdown) {
  if (!plain(options)) return undefined;
  const lower = markdown.toLowerCase();
  const keep = (key, value) =>
    typeof value === "string" &&
    (ENUM_OPTIONS.has(key)
      ? IDENTIFIER.test(value)
      : !value || lower.includes(value.toLowerCase()));
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "number" || typeof value === "boolean")
      out[key] = value;
    else if (typeof value === "string") {
      if (keep(key, value)) out[key] = value;
    } else if (Array.isArray(value)) {
      const items = value.filter((x) => keep(key, x) && x);
      if (items.length) out[key] = items;
    }
  }
  return out;
}
// Generated profile text whose section is gone (no Block owns it and the
// Markdown no longer holds it) is blanked. The empty entry still tells
// GitHub Autofill not to add that section again.
function portableProfile(profile, blocks, markdown) {
  if (!plain(profile) || !plain(profile.sections)) return profile;
  const owned = new Set(
    blocks.map((b) => b?.profileAutofill?.kind).filter(Boolean),
  );
  return {
    ...profile,
    sections: Object.fromEntries(
      Object.entries(profile.sections).map(([kind, text]) => [
        kind,
        typeof text === "string" &&
        text &&
        !owned.has(kind) &&
        !markdown.includes(text)
          ? ""
          : text,
      ]),
    ),
  };
}
function portableGenerated(units, markdown, login) {
  return units.flatMap((u) => {
    if (!plain(u)) return [];
    if (
      typeof u.id !== "string" ||
      !["profile", "repository", "project"].includes(u.kind)
    )
      return [];
    const sources = Array.isArray(u.source) ? u.source : [u.source];
    const present =
      u.kind === "profile"
        ? typeof u.source === "string" &&
          (u.source === login || named(markdown, u.source))
        : sources.length > 0 && sources.every((x) => named(markdown, x));
    if (!present) return [];
    // The generated text, the fetched snapshot and the label (which names the
    // sources and project titles) can hold text removed since; recreating a
    // detached source fetches fresh data and needs none of them.
    const kept = portableOptions(u.options, markdown);
    return [
      {
        id: u.id,
        kind: u.kind,
        source: structuredClone(u.source),
        ownership: "detached",
        ...(u.kind === "profile" && PROFILE_OPTIONS.has(u.option)
          ? { option: u.option }
          : {}),
        ...(typeof u.lastFetched === "string"
          ? { lastFetched: u.lastFetched }
          : {}),
        ...(kept ? { options: kept } : {}),
        ...(typeof u.generatedValue === "string" &&
        u.generatedValue &&
        markdown.includes(u.generatedValue)
          ? { generatedValue: u.generatedValue }
          : {}),
        ...(typeof u.label === "string" && u.label && markdown.includes(u.label)
          ? { label: u.label }
          : {}),
      },
    ];
  });
}
function blockText(block) {
  try {
    return serializeBlock(block);
  } catch {
    return "";
  }
}
function portableBlocks(blocks) {
  return blocks.map((block) => {
    const title = block?.section?.title;
    if (
      !plain(block) ||
      block.type !== "custom" ||
      !plain(block.section) ||
      !(block.section.level > 0) ||
      typeof title !== "string" ||
      blockText(block).includes(title)
    )
      return block;
    const { section: _section, ...rest } = block;
    return rest;
  });
}
export function withoutDetachedCopies(draft) {
  if (!plain(draft)) return draft;
  const markdown = typeof draft.markdown === "string" ? draft.markdown : "";
  const metadata = plain(draft.metadata) ? { ...draft.metadata } : null;
  const copy = { ...draft };
  if (Array.isArray(draft.blocks)) copy.blocks = portableBlocks(draft.blocks);
  if (metadata) {
    if (Array.isArray(metadata.detachments))
      metadata.detachments = portableRecords(
        metadata.detachments,
        new Set((draft.blocks || []).map((b) => b?.id)),
        markdown,
      );
    if (Array.isArray(metadata.detachedGenerated))
      metadata.detachedGenerated = portableGenerated(
        metadata.detachedGenerated,
        markdown,
        metadata.githubProfile?.login,
      );
    if (plain(metadata.githubProfile))
      metadata.githubProfile = portableProfile(
        metadata.githubProfile,
        Array.isArray(draft.blocks) ? draft.blocks : [],
        markdown,
      );
    copy.metadata = metadata;
  }
  return copy;
}
export function readDrafts(storage = localStorage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    return validateWorkspace(JSON.parse(raw), { preserveIds: true });
  } catch (cause) {
    const error = new Error(
      "Saved workspace could not be read. The original storage is untouched. Download recovery data or restore a backup.",
    );
    error.raw = raw;
    error.recovered = recoverWorkspace(raw);
    error.cause = cause;
    throw error;
  }
}
export function saveDrafts(data, storage = localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...data, version: 1 }));
}

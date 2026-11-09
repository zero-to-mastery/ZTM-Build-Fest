import { createBlock, serializeBlocks } from "../markdown/serialize.js";
import { draftSnapshot } from "../state/import-plan.js";

export const emptyShared = () => ({ version: 1, items: [] });
export function validateShared(value = emptyShared()) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > 200
  )
    throw Error(
      "Invalid shared component library (version 1, up to 200 components).",
    );
  const ids = new Set();
  return {
    version: 1,
    items: value.items.map((item) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        item.id.length > 100 ||
        ids.has(item.id) ||
        typeof item.name !== "string" ||
        !item.name.trim() ||
        item.name.length > 120 ||
        typeof item.markdown !== "string" ||
        !item.markdown.trim() ||
        item.markdown.length > 100_000 ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1
      )
        throw Error(
          "Invalid shared component name, source, revision or duplicate ID.",
        );
      ids.add(item.id);
      return {
        id: item.id,
        name: item.name.trim(),
        markdown: item.markdown,
        revision: item.revision,
      };
    }),
  };
}
export function recoverShared(value) {
  const result = emptyShared();
  if (value?.version !== 1 || !Array.isArray(value.items)) return result;
  for (const item of value.items.slice(0, 200)) {
    try {
      const valid = validateShared({ version: 1, items: [item] }).items[0];
      if (!result.items.some((v) => v.id === valid.id))
        result.items.push(valid);
    } catch {
      /* Original recovery bytes remain available. */
    }
  }
  return result;
}
export function saveShared(library, { id, name, markdown }) {
  const next = validateShared(library);
  const old = next.items.find((item) => item.id === id);
  const item = {
    id: old?.id || crypto.randomUUID(),
    name,
    markdown,
    revision: old ? old.revision + (old.markdown !== markdown ? 1 : 0) : 1,
  };
  if (old) next.items[next.items.indexOf(old)] = item;
  else next.items.push(item);
  return validateShared(next);
}
export function mergeShared(current, incoming, drafts) {
  const library = validateShared(current),
    additions = validateShared(incoming),
    remap = new Map();
  const ids = new Set(library.items.map((item) => item.id));
  const names = new Set(library.items.map((item) => item.name.toLowerCase()));
  for (const item of additions.items) {
    const oldId = item.id;
    while (ids.has(item.id)) item.id = crypto.randomUUID();
    ids.add(item.id);
    remap.set(oldId, item.id);
    const name = item.name;
    let suffix = 2;
    while (names.has(item.name.toLowerCase()))
      item.name = `${name.slice(0, 110)} (${suffix++})`;
    names.add(item.name.toLowerCase());
    library.items.push(item);
  }
  // A source-only project may carry an unavailable definition. Never let a
  // coincidentally matching local ID silently attach it to an unrelated one.
  for (const draft of drafts)
    for (const block of draft.blocks) {
      if (!block.sharedComponent) continue;
      const id = remap.get(block.sharedComponent.componentId);
      if (id) block.sharedComponent.componentId = id;
      else delete block.sharedComponent;
    }
  return validateShared(library);
}
export function planShared(drafts, component, selectedIds, mode) {
  if (!["insert", "update"].includes(mode))
    throw Error("Choose insert or update.");
  const normalized = validateShared({ version: 1, items: [component] })
    .items[0];
  const entries = [],
    skipped = [];
  for (const draft of drafts.filter((d) => selectedIds.includes(d.id))) {
    if (serializeBlocks(draft.blocks) !== draft.markdown) {
      skipped.push({
        name: draft.name,
        reason: "Source and builder differ; source preserved.",
      });
      continue;
    }
    const blocks = structuredClone(draft.blocks);
    let changed = false,
      edited = 0;
    if (mode === "insert") {
      const block = createBlock("custom", { markdown: normalized.markdown });
      block.sourceContext = null;
      block.sharedComponent = {
        version: 1,
        componentId: normalized.id,
        revision: normalized.revision,
        source: normalized.markdown,
      };
      blocks.push(block);
      changed = true;
    } else {
      for (const block of blocks) {
        const ref = block.sharedComponent;
        if (!ref || ref.componentId !== normalized.id) continue;
        if (
          ref.version !== 1 ||
          block.type !== "custom" ||
          block.settings.markdown !== ref.source
        ) {
          edited++;
          continue;
        }
        if (ref.source === normalized.markdown) continue;
        block.settings.markdown = normalized.markdown;
        block.sharedComponent = {
          version: 1,
          componentId: normalized.id,
          revision: normalized.revision,
          source: normalized.markdown,
        };
        changed = true;
      }
    }
    if (edited)
      skipped.push({
        name: draft.name,
        reason: `${edited} locally edited copy/copies skipped.`,
      });
    if (changed)
      entries.push({
        id: draft.id,
        name: draft.name,
        snapshot: draftSnapshot(draft),
        before: draft.markdown,
        markdown: serializeBlocks(blocks),
        blocks,
      });
    else if (!edited)
      skipped.push({
        name: draft.name,
        reason: "No linked update needed (current, detached or not inserted).",
      });
  }
  return { component: normalized, mode, entries, skipped };
}
export function checkSharedPlan(plan, drafts, library) {
  const current = validateShared(library).items.find(
    (item) => item.id === plan.component.id,
  );
  if (JSON.stringify(current) !== JSON.stringify(plan.component))
    throw Error("Shared definition changed. Preview again.");
  if (!plan.entries.length) throw Error("No document changes to apply.");
  for (const entry of plan.entries) {
    const draft = drafts.find((d) => d.id === entry.id);
    if (!draft || draftSnapshot(draft) !== entry.snapshot)
      throw Error("A document changed. Preview again; nothing was applied.");
  }
}

// Keep the reviewed source/snapshots intact while narrowing the apply set.
export function selectSharedPlan(preview, selectedIds) {
  const ids = new Set(selectedIds);
  if ([...ids].some((id) => !preview.entries.some((entry) => entry.id === id)))
    throw Error("Only documents in this preview can be selected.");
  return {
    ...preview,
    entries: preview.entries.filter((entry) => ids.has(entry.id)),
  };
}

export const sharedStarters = {
  "Contributing footer":
    "## Contributing\n\nDescribe how to propose changes and where to find contribution guidelines.",
  "Testing stack":
    "## Testing\n\nList the shared testing tools and verified test commands here.",
  "Security section":
    "## Security\n\nDescribe your private vulnerability reporting channel. Do not post sensitive reports publicly.",
  "Sponsor/contact block":
    "## Support and contact\n\nAdd your public contact and optional sponsorship links here.",
  "Common badge row":
    "[![Documentation](https://img.shields.io/badge/docs-README-blue)](#readme)",
  "Organization/community links":
    "## Community\n\n- [Organization](https://github.com/your-organization)\n- Add your community guidelines and discussion links.",
};

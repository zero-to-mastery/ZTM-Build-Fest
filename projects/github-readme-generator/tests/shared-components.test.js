import { describe, it, expect } from "vitest";
import {
  emptyShared,
  validateShared,
  saveShared,
  planShared,
  selectSharedPlan,
  checkSharedPlan,
  recoverShared,
} from "../src/workspace/shared-components.js";
import { newDraft } from "../src/state/drafts.js";
import { createBlock, serializeBlocks } from "../src/markdown/serialize.js";
import {
  createBackup,
  validateWorkspace,
  restoreWorkspace,
} from "../src/state/workspace-backup.js";
import { Store } from "../src/state/store.js";
import "../src/components/shared-components.js";
const draft = (name = "A") =>
  newDraft(name, [
    createBlock("custom", { markdown: "\ufeff# Exact\r\nSource\r\n" }),
  ]);
const library = () =>
  saveShared(emptyShared(), {
    name: "Security",
    markdown: "## Security\nReport privately.",
  });
const linked = (d, item) => {
  const entry = planShared([d], item, [d.id], "insert").entries[0];
  return { ...d, markdown: entry.markdown, blocks: entry.blocks };
};
describe("reviewed shared documentation", () => {
  it("saving revisions never mutates definitions or documents in place", () => {
    const original = library(),
      d = linked(draft(), original.items[0]),
      before = structuredClone(d);
    const updated = saveShared(original, {
      ...original.items[0],
      markdown: "## Security\nNew channel.",
    });
    expect(original.items[0].revision).toBe(1);
    expect(updated.items[0].revision).toBe(2);
    expect(d).toEqual(before);
    expect(
      saveShared(updated, { ...updated.items[0], name: "Renamed" }).items[0]
        .revision,
    ).toBe(2);
  });
  it("previews exact multi-document insertions and updates without touching other blocks", () => {
    const lib = library(),
      a = draft(),
      b = draft("B");
    const plan = planShared([a, b], lib.items[0], [a.id, b.id], "insert");
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0].markdown).toBe(
      a.markdown + "\n\n" + lib.items[0].markdown,
    );
    expect(a.blocks).toHaveLength(1);
    const next = saveShared(lib, { ...lib.items[0], markdown: "Updated" });
    const copies = [linked(a, lib.items[0]), linked(b, lib.items[0])];
    const update = planShared(copies, next.items[0], [a.id], "update");
    expect(update.entries).toHaveLength(1);
    expect(update.entries[0].markdown).toBe(a.markdown + "\n\nUpdated");
    expect(copies[1].markdown).toContain("Report privately");
    expect(serializeBlocks(update.entries[0].blocks)).toBe(
      update.entries[0].markdown,
    );
  });
  it("rejects stale library or any stale document before application", () => {
    const lib = library(),
      a = draft(),
      b = draft("B");
    const plan = planShared([a, b], lib.items[0], [a.id, b.id], "insert");
    expect(() => checkSharedPlan(plan, [a, b], lib)).not.toThrow();
    b.markdown = "manual edit";
    expect(() => checkSharedPlan(plan, [a, b], lib)).toThrow(
      /document changed/,
    );
    expect(a.markdown).not.toContain("Security");
    const changed = saveShared(lib, { ...lib.items[0], markdown: "Different" });
    expect(() => checkSharedPlan(plan, [a], changed)).toThrow(
      /definition changed/,
    );
  });
  it("checks and applies only explicitly selected recipient snapshots", () => {
    const lib = library(),
      included = draft("Included"),
      excluded = draft("Excluded"),
      preview = planShared(
        [included, excluded],
        lib.items[0],
        [included.id, excluded.id],
        "insert",
      ),
      selected = selectSharedPlan(preview, [included.id]);
    expect(preview.entries).toHaveLength(2);
    expect(selected.entries.map((entry) => entry.id)).toEqual([included.id]);
    excluded.markdown = "# Excluded changed after preview";
    expect(() =>
      checkSharedPlan(selected, [included, excluded], lib),
    ).not.toThrow();
    expect(selected.entries[0].markdown).toContain("## Security");
    expect(excluded.markdown).toBe("# Excluded changed after preview");
    included.markdown = "# Included changed after preview";
    expect(() => checkSharedPlan(selected, [included, excluded], lib)).toThrow(
      /document changed/,
    );
  });
  it("skips local builder edits and detaches raw edits, while Undo restores the link", () => {
    const lib = library(),
      d = linked(draft(), lib.items[0]);
    d.blocks[1].settings.markdown = "Local variation";
    d.markdown = serializeBlocks(d.blocks);
    const component = { ...lib.items[0], revision: 2, markdown: "Upstream" };
    const plan = planShared([d], component, [d.id], "update");
    expect(plan.entries).toEqual([]);
    expect(plan.skipped[0].reason).toContain("locally edited");
    const store = new Store(linked(draft(), lib.items[0]));
    // Appending after the shared block keeps it linked; editing inside it
    // detaches it with a Detachment record.
    store.raw(store.draft.markdown + "\nMy note");
    expect(store.draft.blocks.some((b) => b.sharedComponent)).toBe(true);
    store.undo();
    store.raw(store.draft.markdown.replace("privately", "privately, please"));
    expect(store.draft.blocks.some((b) => b.sharedComponent)).toBe(false);
    expect(store.draft.metadata.detachments[0].kinds).toEqual(["shared"]);
    store.undo();
    expect(store.draft.blocks[1].sharedComponent.componentId).toBe(
      lib.items[0].id,
    );
    const single = new Store(
      newDraft("single", [linked(newDraft("empty"), lib.items[0]).blocks[0]]),
    );
    single.raw("Edited only shared block");
    expect(single.draft.blocks[0].sharedComponent).toBeUndefined();
  });
  it("round trips backup and remaps collisions only in incoming document links", () => {
    const lib = library(),
      d = linked(draft(), lib.items[0]);
    const data = {
      drafts: [d],
      active: d.id,
      settings: {},
      sharedComponents: lib,
    };
    const backup = validateWorkspace(createBackup(data));
    expect(backup.sharedComponents).toEqual(lib);
    const merged = restoreWorkspace(data, backup, "merge");
    expect(merged.sharedComponents.items).toHaveLength(2);
    const [first, second] = merged.sharedComponents.items;
    expect(first.id).not.toBe(second.id);
    expect(second.name).toBe("Security (2)");
    expect(merged.drafts[0].blocks[1].sharedComponent.componentId).toBe(
      first.id,
    );
    expect(merged.drafts[1].blocks[1].sharedComponent.componentId).toBe(
      second.id,
    );
    expect(merged.drafts.map((item) => item.markdown)).toEqual([
      d.markdown,
      d.markdown,
    ]);
  });
  it("validates/recover definitions and keeps malicious Markdown inert in review", () => {
    const lib = library();
    expect(() => validateShared({ ...lib, version: 99 })).toThrow();
    expect(() =>
      validateShared({ ...lib, items: [...lib.items, lib.items[0]] }),
    ).toThrow();
    expect(recoverShared({ ...lib, items: [null, ...lib.items] })).toEqual(lib);
    const d = draft(),
      el = document.createElement("shared-components");
    const malicious = saveShared(emptyShared(), {
      name: "<script>bad()</script>",
      markdown: '<script>bad()</script><img onerror="bad()">',
    });
    el.configure({ drafts: [d], active: d.id, sharedComponents: malicious });
    el.querySelector("[data-component]").value = malicious.items[0].id;
    el.select();
    el.preview("insert");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect(el.canApply()).toBe(false);
    el.querySelector("[data-approve]").checked = true;
    expect(el.canApply()).toBe(true);
    el.querySelector("[data-source]").dispatchEvent(new Event("input"));
    expect(el.canApply()).toBe(false);
  });
});

import { it, expect } from "vitest";
import {
  builtInComponents,
  componentCatalog,
} from "../src/components-library/registry.js";
import {
  componentSource,
  normalizeComponent,
  searchComponents,
} from "../src/components-library/model.js";
import {
  emptyComponents,
  validateComponents,
  favoriteComponent,
  usedComponent,
  recoverComponents,
} from "../src/components-library/storage.js";
import { insertion } from "../src/components-library/insertion.js";
import { newDraft } from "../src/state/drafts.js";
import { createBlock } from "../src/markdown/serialize.js";
import {
  validateWorkspace,
  restoreWorkspace,
} from "../src/state/workspace-backup.js";
const custom = () => ({
  version: 1,
  id: "mine",
  name: "Mine",
  category: "Utilities",
  description: "Exact",
  kind: "custom",
  template: "\ufeff# Raw\r\n{{body}}\n<script>example</script>",
  fields: [],
  tags: ["source"],
});
it("ships more than thirty inspectable starters and searches tags/categories", () => {
  expect(builtInComponents.length).toBeGreaterThan(30);
  for (const c of builtInComponents)
    expect(typeof componentSource(c)).toBe("string");
  expect(
    searchComponents(builtInComponents, { query: "terminal" }).length,
  ).toBeGreaterThanOrEqual(3);
  expect(
    searchComponents(builtInComponents, { category: "Contact" }).every(
      (c) => c.category === "Contact",
    ),
  ).toBe(true);
});
it("interpolates only declared fields with escaped text and validated URLs", () => {
  const c = builtInComponents.find((c) => c.id === "builtin:linked-image");
  const source = componentSource(c, {
    alt: '"><script>alert(1)</script>',
    image: "https://example.com/a.svg",
    url: "https://example.com",
  });
  expect(source).not.toContain("<script>");
  expect(source).toContain("&lt;script&gt;");
  expect(() => componentSource(c, { url: "javascript:alert(1)" })).toThrow();
});
it("preserves custom Markdown byte for byte including template-like text", () =>
  expect(componentSource(custom(), { body: "changed" })).toBe(
    custom().template,
  ));
it.each([
  { ...custom(), version: 9 },
  { ...custom(), category: "Other" },
  { ...custom(), name: "<script>" },
  { ...custom(), kind: "execute" },
])("rejects malformed component metadata", (c) =>
  expect(() => normalizeComponent(c)).toThrow(),
);
it("favorites and recents are unique and saved copies cannot mutate built-ins", () => {
  let l = favoriteComponent(emptyComponents(), builtInComponents[0].id);
  expect(
    searchComponents(builtInComponents, { view: "favorites", ...l }),
  ).toHaveLength(1);
  l = usedComponent(usedComponent(l, "first"), "first");
  expect(l.recents).toEqual(["first"]);
  const all = componentCatalog(l);
  all[0].name = "changed";
  expect(builtInComponents[0].name).not.toBe("changed");
});
it("resolves saved ID/name collisions and recovers valid snippets", () => {
  const l = validateComponents({
    ...emptyComponents(),
    snippets: [custom(), custom()],
  });
  expect(l.snippets[1].name).toBe("Mine (2)");
  expect(l.snippets[1].id).not.toBe(l.snippets[0].id);
  expect(
    recoverComponents({ ...emptyComponents(), snippets: [custom(), {}] })
      .snippets,
  ).toHaveLength(1);
});
it("inserts before/after/append and at cursor without overwriting selected source", () => {
  const d = newDraft("D", [
    createBlock("custom", { markdown: "ABC" }),
    createBlock("custom", { markdown: "DEF" }),
  ]);
  expect(
    insertion(d, "X", {
      position: "before",
      blockId: d.blocks[1].id,
    }).blocks.map((b) => b.settings.markdown),
  ).toEqual(["ABC", "X", "DEF"]);
  expect(
    insertion(d, "X", {
      position: "after",
      blockId: d.blocks[1].id,
    }).blocks.map((b) => b.settings.markdown),
  ).toEqual(["ABC", "DEF", "X"]);
  expect(insertion(d, "X", { position: "cursor", cursor: 1 }).markdown).toBe(
    "A\n\nX\n\nBC\n\nDEF",
  );
  expect(() =>
    insertion(d, "X", { position: "before", blockId: "missing" }),
  ).toThrow();
});
it("workspace backup/restore includes reusable snippets and preferences", () => {
  const d = newDraft("D", []),
    w = {
      version: 1,
      drafts: [d],
      settings: {},
      componentLibrary: { ...emptyComponents(), snippets: [custom()] },
    };
  expect(validateWorkspace(w).componentLibrary.snippets[0].template).toBe(
    custom().template,
  );
  expect(
    restoreWorkspace(w, w, "merge").componentLibrary.snippets,
  ).toHaveLength(2);
});

import { it, expect } from "vitest";
import {
  instanceFromDetail,
  instanceBlock,
  instanceSource,
  configuredPreset,
  synchronized,
  detachBlock,
} from "../src/component-instances/ownership.js";
import { componentHealth } from "../src/component-instances/health.js";
import { builtInComponents } from "../src/components-library/registry.js";
import {
  componentSource,
  normalizeComponent,
  searchComponents,
} from "../src/components-library/model.js";
import {
  exportPack,
  validatePack,
  importPack,
  packChoices,
} from "../src/snippets/pack-schema.js";
import { Store } from "../src/state/store.js";
import { newDraft, validateDraft } from "../src/state/drafts.js";
import { serializeBlock } from "../src/markdown/serialize.js";
import { themeBlocks } from "../src/themes/theme-resolver.js";
import { baseTheme } from "../src/themes/theme-model.js";
const heading = () =>
  instanceFromDetail({
    component: builtInComponents.find(
      (c) => c.id === "builtin:terminal-heading",
    ),
    values: { title: "Work" },
  });
it("keeps structured ownership out of ordinary README export", () => {
  const b = instanceBlock(heading());
  expect(serializeBlock(b)).toBe("## $ Work");
  expect(serializeBlock(b)).not.toContain("instance");
  expect(synchronized(b)).toBe(true);
  expect(themeBlocks([b], baseTheme)[0]).toEqual(b);
});
it("raw editing detaches safely and undo restores the independent component instance", () => {
  const b = instanceBlock(heading()),
    store = new Store(newDraft("D", [b]));
  store.raw("## Changed manually\r\n");
  expect(store.draft.blocks[0].type).toBe("custom");
  expect(store.draft.markdown).toBe("## Changed manually\r\n");
  expect(store.draft.blocks[0].settings).not.toHaveProperty("instance");
  store.undo();
  expect(store.draft.blocks[0].type).toBe("component");
  expect(synchronized(store.draft.blocks[0])).toBe(true);
});
it("keeps externally modified stored source and flags it for review", () => {
  const b = instanceBlock(heading());
  b.settings.markdown += "\n\nManual note";
  expect(synchronized(b)).toBe(false);
  expect(serializeBlock(b)).toContain("Manual note");
  expect(detachBlock(b).settings.markdown).toBe(b.settings.markdown);
  expect(validateDraft(newDraft("D", [b])).blocks[0].type).toBe("component");
});
it("configured field presets remain readable by prior pack readers", () => {
  const preset = configuredPreset(heading(), "My heading"),
    pack = exportPack({ name: "Presets" }, [preset]);
  const imported = importPack({}, JSON.stringify(pack)).componentLibrary
    .snippets[0];
  expect(componentSource(imported)).toBe("## $ Work");
  const older = { ...preset };
  delete older.preset;
  expect(componentSource(older)).toBe("## $ Work");
});
it("widget presets preserve helper settings and safe fallback markup", () => {
  const i = instanceFromDetail({
    widget: {
      version: 1,
      provider: "typing",
      embed: {
        image: "https://example.com/typing.svg",
        alt: "My typing header",
      },
      typing: {
        lines: "Hello\nWorld",
        size: 20,
        duration: 5000,
        font: "monospace",
        color: "123456",
        center: true,
      },
    },
  });
  const preset = configuredPreset(i, "My Typing Header");
  expect(
    validatePack(exportPack({ name: "Widgets" }, [preset])).snippets[0].preset
      .typing.lines,
  ).toBe("Hello\nWorld");
  expect(componentSource({ ...preset, preset: undefined })).toBe(
    instanceSource(i),
  );
});
it("badge row presets reopen with independent collections", () => {
  const i = instanceFromDetail({
    component: builtInComponents.find((c) => c.id === "builtin:technology-row"),
  });
  const copy = instanceBlock(i),
    another = instanceBlock(i);
  copy.settings.instance.component.preset.collection.badges[0].label = "Mine";
  expect(
    another.settings.instance.component.preset.collection.badges[0].label,
  ).not.toBe("Mine");
  expect(configuredPreset(i, "My frontend").preset.type).toBe("badges");
});
it("unknown preset metadata falls back to its exact raw Markdown", () => {
  const c = normalizeComponent({
    ...builtInComponents[0],
    template: "EXACT\r\n",
    preset: { version: 99, type: "future" },
  });
  expect(c.kind).toBe("custom");
  expect(componentSource(c)).toBe("EXACT\r\n");
  expect(instanceFromDetail({ component: c })).toBeNull();
});
it("rejects unsafe supported presets rather than treating them as executable config", () => {
  expect(() =>
    normalizeComponent({
      ...builtInComponents[0],
      preset: {
        version: 1,
        type: "widget",
        provider: "generic",
        embed: { image: "javascript:evil" },
      },
    }),
  ).toThrow();
  expect(() =>
    instanceFromDetail({
      component: builtInComponents[0],
      values: JSON.parse('{"__proto__":"bad"}'),
    }),
  ).toThrow();
});
it("pack choices retain supported presets and fall back to source for modified components", () => {
  const b = instanceBlock(heading());
  expect(packChoices({}, { blocks: [b] })[0].component.preset.type).toBe(
    "fields",
  );
  b.settings.markdown = "Manual";
  const fallback = packChoices({}, { blocks: [b] })[0].component;
  expect(fallback.kind).toBe("custom");
  expect(fallback.template).toBe("Manual");
});
it("component Health is advisory and ignores nested markup examples in code/comments", () => {
  const b = instanceBlock(heading());
  expect(
    componentHealth([b, b])
      .map((i) => i.message)
      .join(" "),
  ).toContain("Repeated component");
  b.settings.markdown =
    "```html\n<table><table></table></table>\n```\n<!-- <details><details> -->";
  expect(componentHealth([b])).toHaveLength(0);
  b.settings.markdown =
    "<details><summary>A</summary><details><summary>B</summary></details></details>";
  expect(
    componentHealth([b])
      .map((i) => i.message)
      .join(" "),
  ).toContain("Nested layout");
});
it("large catalogs search predictably with favorites and recent ordering", () => {
  const c = builtInComponents[0],
    items = Array.from({ length: 250 }, (_, i) => ({
      ...c,
      id: `saved-${i}`,
      name: `Snippet ${i}`,
      tags: ["terminal"],
    }));
  expect(
    searchComponents(items, { query: "terminal", favorites: ["saved-200"] })[0]
      .id,
  ).toBe("saved-200");
  expect(
    searchComponents(items, {
      view: "recent",
      recents: ["saved-9", "saved-2"],
    }).map((c) => c.id),
  ).toEqual(["saved-9", "saved-2"]);
});

it("sequential layout containers are not mistaken for nested layouts", () => {
  const b = instanceBlock(heading());
  b.settings.markdown =
    "<details><summary>A</summary></details>\n\n<details><summary>B</summary></details>";
  expect(componentHealth([b])).toHaveLength(0);
});

it("custom snippets ignore preset metadata and preserve exact source", () => {
  const c = normalizeComponent({
    ...builtInComponents.find((c) => c.id === "builtin:technology-row"),
    kind: "custom",
    template: "Exact {{raw}}\r\n",
  });
  expect(c).not.toHaveProperty("preset");
  expect(componentSource(c)).toBe("Exact {{raw}}\r\n");
  expect(instanceFromDetail({ component: c })).toBeNull();
});
it("imported controls and attribution require meaningful names", () => {
  const c = builtInComponents.find((c) => c.fields.length);
  expect(() =>
    normalizeComponent({ ...c, fields: [{ ...c.fields[0], label: "  " }] }),
  ).toThrow();
  expect(() =>
    normalizeComponent({
      ...c,
      attribution: { name: " ", url: "https://example.com" },
    }),
  ).toThrow();
});

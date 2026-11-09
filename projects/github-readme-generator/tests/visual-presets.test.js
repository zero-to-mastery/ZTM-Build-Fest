import { describe, it, expect } from "vitest";
import { baseTheme } from "../src/themes/theme-model.js";
import { builtInThemes } from "../src/themes/built-ins.js";
import { derive, explicitOverride } from "../src/themes/theme-resolver.js";
import { newBanner } from "../src/banners/banner-model.js";
import {
  emptyLibrary,
  bannerVisual,
  validateVisualLibrary,
  mergeVisualLibraries,
  recoverVisualLibrary,
  exportVisualEntry,
  readVisualFile,
  applyVisualPreset,
  updateBrandKit,
} from "../src/themes/visual-library.js";
import { newDraft, readDrafts } from "../src/state/drafts.js";
import {
  createBackup,
  validateWorkspace,
  restoreWorkspace,
} from "../src/state/workspace-backup.js";
import { createBlock } from "../src/markdown/serialize.js";
const themeEntry = () => ({
  id: "test-theme",
  name: "My theme",
  theme: structuredClone(baseTheme),
});
const library = () => ({
  ...emptyLibrary(),
  themes: [themeEntry()],
  banners: [{ id: "banner", name: "Wide", banner: bannerVisual(newBanner()) }],
  bundles: [
    {
      id: "bundle",
      name: "Bundle",
      theme: baseTheme,
      banner: bannerVisual(newBanner()),
      logo: {
        light: "assets/logo-light.svg",
        dark: "assets/logo-dark.svg",
        alt: "Acme logo",
      },
    },
  ],
});
const draft = () =>
  newDraft("Unchanged prose", [
    createBlock("custom", { markdown: "## Raw\r\n<script>example</script>" }),
    createBlock("about", { title: "About", body: "My work" }),
  ]);
describe("portable visual configuration", () => {
  it.each(["themes", "banners", "bundles"])(
    "round trips %s without hidden rendering payloads",
    (kind) => {
      const exported = exportVisualEntry(library()[kind][0], kind);
      const imported = readVisualFile(JSON.stringify(exported));
      expect(imported[kind][0].name).toBe(library()[kind][0].name);
      expect(imported[kind][0].theme).toEqual(library()[kind][0].theme);
      expect(imported[kind][0].banner).toEqual(library()[kind][0].banner);
    },
  );
  it("exports only visual banner configuration, never draft content or asset paths", () => {
    const value = bannerVisual({
      ...newBanner(),
      name: "SECRET NAME",
      title: "PRIVATE TITLE",
      subtitle: "PRIVATE",
      website: "private.example",
      filename: "private",
      assetDirectory: "private",
    });
    expect(JSON.stringify(value)).not.toMatch(/SECRET|PRIVATE|private/);
    expect(value.pattern).toBe("minimal");
    expect(value).not.toHaveProperty("_theme");
  });
  it("supports packs and deterministic collision names without overwriting", () => {
    const pack = readVisualFile({
      version: 1,
      type: "readme-studio-theme-pack",
      themes: [exportVisualEntry(themeEntry(), "themes")],
    });
    expect(pack.themes).toHaveLength(1);
    const merged = mergeVisualLibraries(library(), library());
    expect(merged.themes.map((t) => t.name)).toEqual([
      "My theme",
      "My theme (2)",
    ]);
    expect(
      new Set(
        [...merged.themes, ...merged.banners, ...merged.bundles].map(
          (t) => t.id,
        ),
      ).size,
    ).toBe(6);
    expect(merged.version).toBe(2);
    expect(merged.bundles.map((entry) => entry.logo)).toEqual([
      library().bundles[0].logo,
      library().bundles[0].logo,
    ]);
    expect(
      readVisualFile({
        version: 2,
        type: "readme-studio-visual-pack",
        library: merged,
      }),
    ).toEqual(merged);
  });
  it("exports portable brand kits and migrates legacy visual-preset files", () => {
    const exported = exportVisualEntry(library().bundles[0], "bundles");
    expect(exported.type).toBe("readme-studio-brand-kit");
    expect(exported).toEqual({
      version: 2,
      type: "readme-studio-brand-kit",
      name: "Bundle",
      theme: library().bundles[0].theme,
      banner: library().bundles[0].banner,
      logo: library().bundles[0].logo,
    });
    expect(readVisualFile(exported).bundles[0]).toEqual({
      ...library().bundles[0],
      id: expect.any(String),
    });
    const legacy = readVisualFile({
      ...exported,
      version: 1,
      type: "readme-studio-visual-preset",
    });
    expect(legacy.bundles[0]).toEqual({
      ...library().bundles[0],
      logo: undefined,
      id: expect.any(String),
    });
    const migratedPack = readVisualFile({
      version: 1,
      type: "readme-studio-visual-pack",
      library: {
        ...library(),
        version: 1,
      },
    });
    expect(migratedPack.version).toBe(2);
    expect(migratedPack.bundles[0]).not.toHaveProperty("logo");
  });
  it("edits reviewed brand-kit tokens without mutating the stored library", () => {
    const original = library();
    const updated = updateBrandKit(original, "bundle", {
      theme: {
        ...original.bundles[0].theme,
        palette: { ...original.bundles[0].theme.palette, accent: "123abc" },
      },
      banner: { ...original.bundles[0].banner, pattern: "grid" },
      logo: {
        light: "https://example.com/logo-light.svg",
        dark: "./logo-dark.svg",
        alt: "Edited logo",
      },
    });
    expect(updated.bundles[0].theme.palette.accent).toBe("123abc");
    expect(updated.bundles[0].banner.pattern).toBe("grid");
    expect(updated.bundles[0].logo.alt).toBe("Edited logo");
    expect(original.bundles[0].theme.palette.accent).not.toBe("123abc");
    expect(() => updateBrandKit(original, "missing", {})).toThrow(
      /no longer exists/i,
    );
  });
  it.each([
    { light: "javascript:alert(1)", dark: "", alt: "Logo" },
    { light: "https://user:pass@example.com/logo.svg", dark: "", alt: "Logo" },
    { light: "data:image/svg+xml,<svg/>", dark: "", alt: "Logo" },
    { light: "x".repeat(2049), dark: "", alt: "Logo" },
    { light: "logo.svg", dark: "", alt: "" },
    { light: "", dark: "", alt: "Logo" },
  ])("rejects unsafe or unbounded brand-kit logos", (logo) =>
    expect(() =>
      validateVisualLibrary({
        ...library(),
        bundles: [{ ...library().bundles[0], logo }],
      }),
    ).toThrow(),
  );
  it.each([
    { version: 2, type: "readme-studio-theme", ...themeEntry() },
    {
      version: 1,
      type: "readme-studio-theme",
      ...themeEntry(),
      css: "body {}",
    },
    {
      version: 1,
      type: "readme-studio-theme",
      ...themeEntry(),
      theme: {
        ...baseTheme,
        palette: { ...baseTheme.palette, accent: "red; color: white" },
      },
    },
    {
      version: 1,
      type: "readme-studio-theme",
      ...themeEntry(),
      name: "<script>alert(1)</script>",
    },
    {
      version: 1,
      type: "readme-studio-theme",
      ...themeEntry(),
      theme: { ...baseTheme, onclick: "alert(1)" },
    },
    { version: 1, type: "readme-studio-theme", name: "Incomplete", theme: {} },
    { version: 1, type: "other" },
    "{invalid",
  ])("rejects unsafe, malformed or future imports", (value) =>
    expect(() => readVisualFile(value)).toThrow(),
  );
  it("enforces pack size and recovers only valid entries", () => {
    expect(() =>
      validateVisualLibrary({
        ...emptyLibrary(),
        themes: Array.from({ length: 101 }, themeEntry),
      }),
    ).toThrow();
    const recovered = recoverVisualLibrary({
      ...library(),
      themes: [themeEntry(), { name: "broken" }],
    });
    expect(recovered.themes).toHaveLength(1);
    expect(recovered.banners).toHaveLength(1);
    expect(recoverVisualLibrary({ version: 99 })).toEqual(emptyLibrary());
  });
});
describe("visual inheritance and workspace recovery", () => {
  it("applies bundles to derived settings, preserves overrides and README content", () => {
    const original = draft();
    original.metadata = { bannerSettings: newBanner() };
    const banner = original.metadata.bannerSettings;
    banner.name = "Ada";
    banner.title = "Engineer";
    banner.pattern = "terminal";
    explicitOverride(banner, "pattern");
    banner.palette.accent = "abcdef";
    explicitOverride(banner.palette, "accent");
    const theme = builtInThemes.find((t) => t.id === "nord");
    const visual = { ...bannerVisual(newBanner(theme)), pattern: "grid" };
    const result = applyVisualPreset(original, { theme, banner: visual });
    expect(result.blocks[0]).toEqual(original.blocks[0]);
    expect(result.blocks[1].settings.body).toBe("My work");
    expect(result.metadata.bannerSettings.name).toBe("Ada");
    expect(result.metadata.bannerSettings.pattern).toBe("terminal");
    expect(result.metadata.bannerSettings.palette.accent).toBe("abcdef");
    expect(result.metadata.bannerSettings.palette.dark).toBe(
      theme.palette.backgroundDark,
    );
    const reset = applyVisualPreset(
      original,
      { theme, banner: visual },
      { reset: true },
    );
    expect(reset.metadata.bannerSettings.pattern).toBe("grid");
    expect(reset.metadata.bannerSettings.palette.accent).toBe(
      theme.palette.accent,
    );
    expect(reset.metadata.bannerSettings.title).toBe("Engineer");
    expect(reset.blocks[0]).toEqual(original.blocks[0]);
    expect(original.metadata.visualTheme).toBeUndefined();
  });
  it("retains ownership through mixed explicit and derived fields", () => {
    const object = derive({}, { a: 1, b: 2, c: 3 });
    object.a = 8;
    object.b = 9;
    derive(object, { a: 4, b: 5, c: 6 });
    expect(object._theme.overrides).toEqual(["a", "b"]);
    expect(object.c).toBe(6);
    derive(object, { a: 4, b: 5, c: 7 });
    expect(object.a).toBe(8);
    expect(object.c).toBe(7);
    expect(() =>
      derive({ _theme: { derived: "bad", overrides: 4 } }, { a: 1 }),
    ).not.toThrow();
  });
  it("backs up and restores libraries with draft-specific themes kept separate", () => {
    const d = draft(),
      w = {
        version: 1,
        drafts: [d],
        active: d.id,
        settings: { theme: "dark" },
        visualLibrary: library(),
      };
    const backup = createBackup(w);
    expect(validateWorkspace(backup).visualLibrary).toEqual(w.visualLibrary);
    const merged = restoreWorkspace(w, backup, "merge");
    expect(merged.visualLibrary.themes).toHaveLength(2);
    expect(merged.visualLibrary.bundles.map((entry) => entry.logo)).toEqual([
      w.visualLibrary.bundles[0].logo,
      w.visualLibrary.bundles[0].logo,
    ]);
    expect(merged.drafts).toHaveLength(2);
    expect(restoreWorkspace(w, backup, "replace").visualLibrary).toEqual(
      w.visualLibrary,
    );
    expect(
      validateWorkspace({ ...w, visualLibrary: undefined }).visualLibrary,
    ).toEqual(emptyLibrary());
  });
  it("never overwrites damaged libraries and offers readable recovery data", () => {
    const raw = JSON.stringify({
      version: 1,
      drafts: [draft()],
      settings: {},
      visualLibrary: {
        ...library(),
        themes: [themeEntry(), { name: "broken" }],
      },
    });
    let writes = 0;
    try {
      readDrafts({ getItem: () => raw, setItem: () => writes++ });
      throw Error("expected invalid storage");
    } catch (e) {
      expect(e.raw).toBe(raw);
      expect(e.message).toContain("original storage is untouched");
    }
    expect(writes).toBe(0);
  });
});

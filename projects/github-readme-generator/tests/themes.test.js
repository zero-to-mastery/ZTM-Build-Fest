import { describe, it, expect } from "vitest";
import { baseTheme, normalizeTheme } from "../src/themes/theme-model.js";
import { builtInThemes } from "../src/themes/built-ins.js";
import {
  themeBlocks,
  derive,
  badgeDefaults,
  explicitOverride,
} from "../src/themes/theme-resolver.js";
import { themeWarnings } from "../src/themes/contrast.js";
import { serializeBlocks } from "../src/markdown/serialize.js";
import { validateDraft } from "../src/state/drafts.js";
describe("Visual themes", () => {
  it("validates all built-ins without a CSS/runtime payload", () => {
    expect(builtInThemes).toHaveLength(9);
    for (const t of builtInThemes) expect(normalizeTheme(t)).toEqual(t);
    expect(
      normalizeTheme({ ...baseTheme, css: "body{display:none}" }),
    ).not.toHaveProperty("css");
  });
  it.each([
    { ...baseTheme, version: 8 },
    {
      ...baseTheme,
      palette: { ...baseTheme.palette, accent: "red;onclick=x" },
    },
    { ...baseTheme, name: "<script>" },
  ])("rejects unsafe or future data", (v) =>
    expect(() => normalizeTheme(v)).toThrow(),
  );
  it("preserves old explicit values and custom Markdown byte-for-byte", () => {
    const blocks = [
      {
        type: "custom",
        settings: { markdown: "## raw\r\n<script>example</script>" },
      },
      { type: "badge", settings: { label: "Explicit", color: "123456" } },
    ];
    const result = themeBlocks(blocks, baseTheme);
    expect(result[0]).toEqual(blocks[0]);
    expect(result[1].settings.color).toBe("123456");
    expect(blocks[1].settings._theme).toBeUndefined();
  });
  it("updates derived fields and preserves same-value explicit overrides", () => {
    const b = derive({ label: "Tool" }, badgeDefaults(baseTheme));
    explicitOverride(b, "color");
    const t = builtInThemes.find((t) => t.id === "nord");
    derive(b, badgeDefaults(t));
    expect(b.color).toBe(baseTheme.badges.lightBackground);
    expect(b.darkColor).toBe(t.badges.darkBackground);
    derive(b, badgeDefaults(t), { reset: true });
    expect(b.color).toBe(t.badges.lightBackground);
  });
  it("detects changed derived fields and preserves them", () => {
    const b = derive({}, badgeDefaults(baseTheme));
    b.color = "abcdef";
    derive(b, badgeDefaults(builtInThemes[2]));
    expect(b.color).toBe("abcdef");
    expect(b._theme.overrides).toContain("color");
  });
  it("round trips themed blocks without falling back to raw source", () => {
    const blocks = themeBlocks(
      [{ type: "about", settings: { title: "About", body: "Text" } }],
      builtInThemes.find((t) => t.id === "workshop"),
    );
    const markdown = serializeBlocks(blocks);
    expect(markdown).toContain("✦ About");
    expect(
      validateDraft({
        name: "Theme",
        blocks,
        markdown,
        metadata: { visualTheme: baseTheme },
      }).blocks[0].type,
    ).toBe("about");
  });
  it("gives advisory contrast warnings", () =>
    expect(
      themeWarnings({
        ...baseTheme,
        badges: { ...baseTheme.badges, lightBackground: "ffffff" },
      }).join(" "),
    ).toContain("1.0:1"));
});

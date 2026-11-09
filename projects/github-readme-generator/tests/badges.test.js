import { describe, it, expect } from "vitest";
import {
  buildStaticBadge,
  buildLinkedBadge,
  normalizeColor,
  encodeBadgeText,
} from "../src/badges/shields.js";
import { searchLogos, technologyBadge } from "../src/badges/badge-model.js";
describe("Badge Studio serialization", () => {
  it.each([
    "C++",
    "C#",
    "Node.js",
    "React Testing Library",
    "Rust + WASM",
    "CI/CD",
    "Hello World",
    "a-b_c",
    "日本語",
  ])("encodes %s safely", (s) => {
    const url = new URL(buildStaticBadge({ label: s, color: "#abc" }));
    expect(url.pathname).toBe(`/badge/${encodeBadgeText(s)}-abc`);
    expect(url.hash).toBe("");
  });
  it("supports all options and escapes markup", () => {
    const s = {
      label: "a-b_c",
      message: "ok",
      labelColor: "#123456",
      logoColor: "white",
      color: "red",
      style: "social",
      alt: "<bad> [x]",
      link: "https://example.com/a(b)",
    };
    expect(buildStaticBadge(s)).toContain("a--b__c-ok-red");
    expect(new URL(buildStaticBadge(s)).searchParams.get("labelColor")).toBe(
      "123456",
    );
    expect(buildLinkedBadge(s)).toContain("a%28b%29");
    expect(buildLinkedBadge(s, "html")).toContain("&lt;bad&gt;");
  });
  it("creates safe linked picture pairs", () => {
    const result = buildLinkedBadge({
      label: "React",
      color: "fff",
      darkColor: "000",
      link: "https://example.com",
      alt: 'React "logo"',
    });
    expect(result).toContain('media="(prefers-color-scheme: dark)"');
    expect(result).toContain("React &quot;logo&quot;");
    expect(() => buildLinkedBadge({ link: "javascript:alert(1)" })).toThrow();
    expect(() => buildStaticBadge({ logo: 'a" onerror="x' })).toThrow();
    expect(() => normalizeColor("red;script")).toThrow();
  });
  it.each([
    ["js", "JavaScript"],
    ["node", "Node.js"],
    ["postgres", "PostgreSQL"],
    ["wasm", "WebAssembly"],
  ])("finds alias %s", (q, n) =>
    expect(searchLogos(q).map((t) => t.name)).toContain(n),
  );
  it("suggests React defaults", () =>
    expect(technologyBadge(searchLogos("react")[0])).toMatchObject({
      logo: "react",
      color: "20232A",
      logoColor: "61DAFB",
    }));
});
import {
  validateCollection,
  validateCollections,
  collectionMarkdown,
  searchCollections,
  starterCollection,
} from "../src/badges/collections.js";
describe("badge collections", () => {
  it("validates versioned portable data and rejects malformed badges", () => {
    expect(() => validateCollection({ version: 2 })).toThrow();
    expect(() =>
      validateCollection({
        version: 1,
        type: "badge-collection",
        name: "X",
        badges: [{ label: "X", link: "javascript:bad" }],
      }),
    ).toThrow();
    expect(() =>
      validateCollection({
        version: 1,
        type: "badge-collection",
        name: "X",
        badges: [{ label: 123 }],
      }),
    ).toThrow();
  });
  it("imports independently, resolves collisions and searches aliases", () => {
    const c = starterCollection("Frontend");
    const saved = validateCollections({ version: 1, items: [c, c] });
    expect(saved.items[0].id).not.toBe(saved.items[1].id);
    expect(saved.items[1].name).toBe("Frontend (2)");
    expect(searchCollections(saved.items, "jsx")).toHaveLength(2);
    const imported = validateCollection(c);
    imported.badges[0].label = "Edited";
    expect(c.badges[0].label).not.toBe("Edited");
  });
  it.each(["plain", "centered", "pictures", "category"])(
    "exports %s output",
    (style) => {
      const c = { ...starterCollection("Frontend"), style };
      const output = collectionMarkdown(c);
      expect(output).toContain("img.shields.io");
      if (style === "pictures") expect(output).toContain("<picture>");
      if (style === "centered") expect(output).toContain('align="center"');
      if (style === "category") expect(output).toMatch(/^## Frontend/);
    },
  );
});

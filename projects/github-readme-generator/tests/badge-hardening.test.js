import { describe, it, expect } from "vitest";
import { contrastRatio, contrastWarnings } from "../src/badges/contrast.js";
import { normalizeColor, buildLinkedBadge } from "../src/badges/shields.js";
import {
  badgeWarnings,
  badgeIdentity,
  previewWidths,
} from "../src/badges/duplicates.js";
import { analyze } from "../src/markdown/compatibility.js";
import {
  validateCollections,
  starterCollection,
  recoverCollections,
} from "../src/badges/collections.js";
import {
  createBackup,
  restoreWorkspace,
  validateWorkspace,
} from "../src/state/workspace-backup.js";
import { readDrafts, newDraft } from "../src/state/drafts.js";
describe("badge guidance and safety", () => {
  it("estimates contrast with explicit limits", () => {
    expect(contrastRatio("white", "#000")).toBe(21);
    expect(contrastRatio("#fff", "white")).toBe(1);
    expect(contrastRatio("rebeccapurple", "white")).toBe(null);
    expect(
      contrastWarnings({ color: "fff", logo: "react", logoColor: "fff" }).join(
        " ",
      ),
    ).toContain("hard to read");
    expect(contrastWarnings({ color: "rebeccapurple" }).join(" ")).toContain(
      "cannot be estimated",
    );
  });
  it.each(["red;alert", "notacolor", "url(x)", "12345", "#zzzzzz"])(
    "rejects malformed color %s",
    (v) => expect(() => normalizeColor(v)).toThrow(),
  );
  it.each([
    "white",
    "brightgreen",
    "rebeccapurple",
    "#abc",
    "123456",
    "12345678",
  ])("supports color %s", (v) =>
    expect(normalizeColor(v)).toBe(v.replace(/^#/, "")),
  );
  it("invalid styles and dangerous image URLs cannot produce markup", () => {
    expect(() => buildLinkedBadge({ style: "invalid" })).toThrow();
    expect(() =>
      buildLinkedBadge({ lightUrl: "data:image/svg+xml,<svg onload=x>" }),
    ).toThrow();
    expect(() =>
      buildLinkedBadge({
        lightUrl: "https://img.shields.io/npm/v/react",
        color: "notacolor",
      }),
    ).toThrow();
  });
  it("finds canonical and semantic duplicates without removing content", () => {
    const images = [
      {
        url: "https://img.shields.io/badge/React-blue?logo=react&style=flat",
        alt: "badge",
      },
      {
        url: "https://img.shields.io/badge/React-blue?style=flat&logo=react",
        alt: "React",
      },
      {
        url: "https://img.shields.io/badge/React-red?logo=react",
        alt: "React",
      },
    ];
    const snapshot = JSON.stringify(images),
      warnings = badgeWarnings(images)
        .map((i) => i.message)
        .join(" ");
    expect(warnings).toMatch(/Repeated badge URL/);
    expect(warnings).toMatch(/Repeated technology/);
    expect(warnings).toMatch(/Semantically similar/);
    expect(warnings).toMatch(/meaningful/);
    expect(JSON.stringify(images)).toBe(snapshot);
    expect(badgeIdentity("not a URL")).toBe(null);
  });
  it("reports repeated metrics and builds", () => {
    const images = [
      "github/stars/o/r",
      "github/stars/o/another",
      "github/actions/workflow/status/o/r/ci.yml",
      "netlify/id",
    ].map((path) => ({
      url: `https://img.shields.io/${path}`,
      alt: "Build status",
    }));
    expect(
      badgeWarnings(images)
        .map((i) => i.message)
        .join(" "),
    ).toMatch(/GitHub statistic/);
    expect(
      badgeWarnings(images)
        .map((i) => i.message)
        .join(" "),
    ).toMatch(/Multiple build/);
  });
  it("Health ignores code and comments, but sees real rows and nearby duplicates", () => {
    const badge =
      "![React](https://img.shields.io/badge/React-blue?logo=react)";
    const hidden = `# Example\n\n\`\`\`md\n${Array(25).fill(badge).join(" ")}\n\`\`\`\n<!-- <img src="https://img.shields.io/badge/x-red"> -->\n&lt;img src="https://img.shields.io/badge/x-red"&gt;`;
    expect(
      analyze(hidden).issues.filter((i) => i.category.startsWith("Badge")),
    ).toHaveLength(0);
    const result = analyze(
      `# Profile\n\n## Frontend\n\nReact ${badge}\n\n${Array(25).fill(badge).join(" ")}`,
    )
      .issues.map((i) => i.message)
      .join(" ");
    expect(result).toContain("Long badge row");
    expect(result).toContain("Frontend");
    expect(result).toContain("nearby text");
    expect(result).toContain("badges in");
  });
  it("defines responsive preview widths", () =>
    expect(previewWidths).toEqual({ desktop: 900, narrow: 640, mobile: 320 }));
});
describe("collection recovery and backup", () => {
  const workspace = () => {
    const draft = newDraft("Test");
    return {
      version: 1,
      drafts: [draft],
      active: draft.id,
      settings: { theme: "light" },
      badgeCollections: { version: 1, items: [starterCollection("Frontend")] },
    };
  };
  it("round trips and merges collections with unique IDs and names", () => {
    const original = workspace(),
      backup = createBackup(original),
      merged = restoreWorkspace(original, backup, "merge");
    expect(merged.badgeCollections.items).toHaveLength(2);
    expect(new Set(merged.badgeCollections.items.map((c) => c.id)).size).toBe(
      2,
    );
    expect(merged.badgeCollections.items[1].name).toBe("Frontend (2)");
    expect(
      restoreWorkspace(original, backup, "replace").badgeCollections.items,
    ).toHaveLength(1);
    expect(validateWorkspace(backup).badgeCollections.items[0].badges).toEqual(
      original.badgeCollections.items[0].badges,
    );
  });
  it("recovers readable badges without overwriting malformed saved data", () => {
    const data = workspace();
    data.badgeCollections.items[0].badges.push({
      label: "Bad",
      link: "javascript:bad",
    });
    const raw = JSON.stringify(data),
      writes = [];
    try {
      readDrafts({
        getItem: () => raw,
        setItem: (...args) => writes.push(args),
      });
      throw new Error("expected recovery");
    } catch (e) {
      expect(e.raw).toBe(raw);
      expect(e.recovered.drafts).toHaveLength(1);
      expect(
        e.recovered.badgeCollections.items[0].badges.length,
      ).toBeGreaterThan(0);
      expect(
        e.recovered.badgeCollections.items[0].badges.some(
          (b) => b.label === "Bad",
        ),
      ).toBe(false);
    }
    expect(writes).toHaveLength(0);
  });
  it("rejects future schemas, with bounded recovery", () => {
    expect(() => validateCollections({ version: 99, items: [] })).toThrow();
    expect(recoverCollections({ version: 99, items: [] })).toEqual({
      version: 1,
      items: [],
    });
    const data = workspace();
    data.badgeCollections.version = 99;
    expect(() => validateWorkspace(data)).toThrow();
  });
  it("supports 150 badge collections without mutating inputs", () => {
    const c = starterCollection("Frontend"),
      original = c.badges[0];
    c.badges = Array.from({ length: 150 }, () => ({ ...original }));
    const result = validateCollections({ version: 1, items: [c] });
    expect(result.items[0].badges).toHaveLength(150);
    expect(
      badgeWarnings(
        result.items[0].badges.map((b) => ({
          url: `https://img.shields.io/badge/x-blue?logo=${b.logo}`,
          alt: b.alt,
        })),
      ).length,
    ).toBeGreaterThan(0);
  });
});

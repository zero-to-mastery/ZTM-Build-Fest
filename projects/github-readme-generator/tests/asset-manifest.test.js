import { describe, expect, it } from "vitest";
import {
  assetManifest,
  bannerAssetPackage,
  serializeAssetManifest,
} from "../src/assets/manifest.js";
import { newBanner } from "../src/banners/banner-model.js";

describe("deterministic asset manifests", () => {
  it("packages stable banner files, fingerprints and exact Markdown references", () => {
    const banner = {
        ...newBanner(),
        filename: "hero",
        assetDirectory: "docs/media",
      },
      first = bannerAssetPackage(banner),
      second = bannerAssetPackage(structuredClone(banner));

    expect(serializeAssetManifest(first.manifest)).toBe(
      serializeAssetManifest(second.manifest),
    );
    expect(first.files.map((file) => file.path)).toEqual([
      "docs/media/hero-light.svg",
      "docs/media/hero-dark.svg",
    ]);
    expect(first.manifest).toMatchObject({
      schemaVersion: 1,
      type: "readme-studio-asset-manifest",
      generator: { type: "banner", version: 1 },
    });
    expect(first.manifest.assets.map((asset) => asset.path)).toEqual([
      "docs/media/hero-dark.svg",
      "docs/media/hero-light.svg",
    ]);
    for (const asset of first.manifest.assets) {
      expect(asset.mediaType).toBe("image/svg+xml");
      expect(asset.bytes).toBeGreaterThan(0);
      expect(asset.fingerprint).toMatch(/^fnv1a32:[a-f0-9]{8}$/);
      expect(first.manifest.references.markdown).toContain(asset.path);
    }
    const serialized = serializeAssetManifest(first.manifest);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).not.toContain("createdAt");
    expect(serialized).not.toContain("<svg");
  });

  it("rejects collisions, unsafe paths and files missing from exported references", () => {
    const file = {
      path: "assets/hero.svg",
      content: "<svg></svg>",
      role: "banner-light",
    };
    expect(() =>
      assetManifest([file, { ...file, content: "different" }], {
        markdown: "![Hero](assets/hero.svg)",
      }),
    ).toThrow(/appears twice/i);
    expect(() =>
      assetManifest([{ ...file, path: "assets/../hero.svg" }], {
        markdown: "![Hero](assets/../hero.svg)",
      }),
    ).toThrow(/relative asset path/i);
    expect(
      bannerAssetPackage({
        ...newBanner(),
        assetDirectory: "docs/media.v2",
      }).files[0].path,
    ).toBe("docs/media.v2/banner-light.svg");
    expect(
      bannerAssetPackage({
        ...newBanner(),
        assetDirectory: "docs/profile media",
      }).files[0].path,
    ).toBe("docs/profile media/banner-light.svg");
    expect(() =>
      bannerAssetPackage({
        ...newBanner(),
        assetDirectory: "docs/.media",
      }),
    ).toThrow(/relative asset path/i);
    expect(() =>
      assetManifest([file], { markdown: "![Other](assets/other.svg)" }),
    ).toThrow(/not referenced/i);
    expect(() =>
      assetManifest([file], { markdown: "![Other](assets/hero.svg.backup)" }),
    ).toThrow(/not referenced/i);
  });

  it("normalizes only bounded primitive media types", () => {
    const file = {
        path: "assets/hero.svg",
        content: "<svg></svg>",
        role: "banner-light",
      },
      references = { markdown: "![Hero](assets/hero.svg)" };
    expect(assetManifest([file], references).assets[0].mediaType).toBe(
      "application/octet-stream",
    );
    expect(
      assetManifest([{ ...file, mediaType: "IMAGE/SVG+XML" }], references)
        .assets[0].mediaType,
    ).toBe("image/svg+xml");
    for (const mediaType of [
      { toJSON: () => `${Math.random()}` },
      "image",
      `image/${"x".repeat(65)}`,
    ])
      expect(() => assetManifest([{ ...file, mediaType }], references)).toThrow(
        /media type/i,
      );
  });
});

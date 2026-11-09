import { it, expect } from "vitest";
import {
  generatedAssets,
  validateGeneratedAsset,
  rewriteOwnedBanner,
  prepareAssetPlan,
} from "../src/publishing/assets.js";
import { assetPath } from "../src/publishing/asset-path.js";
import { newBanner } from "../src/banners/banner-model.js";
import { bannerMarkup } from "../src/banners/export.js";
import { createBlock, serializeBlocks } from "../src/markdown/serialize.js";
it("generates bounded safe pairs and rejects forged SVG payloads", () => {
  const files = generatedAssets(newBanner());
  expect(files).toHaveLength(2);
  expect(files[0].path).toBe("assets/readme/banner-light.svg");
  expect(files[0].bytes).toBeLessThan(250000);
  expect(validateGeneratedAsset(files[0]).content).toBe(files[0].content);
  expect(() =>
    validateGeneratedAsset({
      ...files[0],
      content: '<svg onload="alert(1)"/>',
    }),
  ).toThrow("exact Studio-generated");
});
it.each([
  "../x.svg",
  "/assets/x.svg",
  "assets/../x.svg",
  ".github/workflows/x.svg",
  ".env",
  "assets/.token.svg",
  "assets/a\\b.svg",
  "assets/%2e%2e/x.svg",
])("rejects unsafe asset path %s", (path) =>
  expect(() => assetPath(path)).toThrow(),
);
it("uses the same visible-directory rules for local packages and publishing", () => {
  const banner = { ...newBanner(), assetDirectory: "docs/media-v2" };
  expect(
    generatedAssets(banner, banner.assetDirectory).map((f) => f.path),
  ).toEqual([
    "docs/media-v2/banner-light.svg",
    "docs/media-v2/banner-dark.svg",
  ]);
  expect(generatedAssets(banner, "docs/media.v2")[0].path).toBe(
    "docs/media.v2/banner-light.svg",
  );
  expect(generatedAssets(banner, "docs/profile media")[0].path).toBe(
    "docs/profile media/banner-light.svg",
  );
  expect(generatedAssets(banner, "")[0].path).toBe("banner-light.svg");
});
it("rewrites only exact owned source and accounts for nested README paths", () => {
  const banner = newBanner(),
    source = bannerMarkup(banner),
    block = createBlock("custom", { markdown: source }),
    raw = createBlock("custom", {
      markdown: "![Keep](assets/banner-light.svg)",
    });
  const draft = {
    blocks: [block, raw],
    metadata: {
      bannerSettings: banner,
      bannerReference: { blockId: block.id, source },
    },
    markdown: serializeBlocks([block, raw]),
  };
  const result = rewriteOwnedBanner(draft, "assets/readme", "docs/README.md");
  expect(result.rewritten).toBe(true);
  expect(result.source).toContain("../assets/readme/banner-light.svg");
  expect(result.source).toContain("![Keep](assets/banner-light.svg)");
  expect(draft.markdown).not.toContain("../assets");
  const rootAssets = rewriteOwnedBanner(draft, "", "docs/README.md");
  expect(rootAssets.rewritten).toBe(true);
  expect(rootAssets.source).toContain('srcset="../banner-dark.svg"');
  expect(rootAssets.source).toContain('src="../banner-light.svg"');
  expect(rootAssets.source).not.toContain('alt="../');
  draft.blocks[0].settings.markdown += "manual";
  draft.markdown = serializeBlocks(draft.blocks);
  expect(rewriteOwnedBanner(draft, "assets/readme").rewritten).toBe(false);
});
it("plans new/changed/unchanged rows from each remote baseline", async () => {
  const files = generatedAssets(newBanner()),
    t = { repository: "octocat/octocat", branch: "main" },
    reads = [];
  const rows = await prepareAssetPlan(files, t, async (value) => {
    reads.push(value);
    return { sha: null, content: "" };
  });
  expect(rows.map((r) => r.status)).toEqual(["new", "new"]);
  expect(reads.map((r) => r.kind)).toEqual(["asset", "asset"]);
  const unchanged = await prepareAssetPlan([files[0]], t, async () => ({
    sha: "a",
    content: files[0].content,
  }));
  expect(unchanged[0].status).toBe("unchanged");
  const changed = await prepareAssetPlan([files[0]], t, async () => ({
    sha: "a",
    content: "previous SVG",
  }));
  expect(changed[0].status).toBe("changed");
});

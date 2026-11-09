import { bannerFiles, bannerMarkup } from "../banners/export.js";
import { normalizeBanner } from "../banners/banner-model.js";
import { sourceHash } from "../state/source-hash.js";
import { relativeAssetPath } from "./path.js";

export { relativeAssetPath } from "./path.js";

export const ASSET_MANIFEST_SCHEMA = 1,
  ASSET_MANIFEST_TYPE = "readme-studio-asset-manifest",
  MAX_MANIFEST_ASSETS = 32,
  MAX_MANIFEST_ASSET_BYTES = 250_000;

const encoder = new TextEncoder(),
  mediaTypePattern =
    /^[a-z][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownReferencesPath(markdown, path) {
  return new RegExp(
    `(?:\\]\\(|\\bsrc(?:set)?\\s*=\\s*["'])${escapeRegExp(path)}(?=["')])`,
  ).test(markdown);
}

export function assetManifest(
  files,
  references,
  generator = { type: "generated-assets", version: 1 },
) {
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > MAX_MANIFEST_ASSETS
  )
    throw new Error("An asset manifest needs 1 to 32 generated files.");
  if (
    typeof references?.markdown !== "string" ||
    encoder.encode(references.markdown).length > 100_000
  )
    throw new Error("Asset references need bounded Markdown.");
  if (
    typeof generator?.type !== "string" ||
    !/^[a-z][a-z0-9-]{0,39}$/.test(generator.type) ||
    !Number.isInteger(generator.version) ||
    generator.version < 1
  )
    throw new Error("Asset generator identity is invalid.");

  const paths = new Set(),
    assets = files.map((file) => {
      const path = relativeAssetPath(file?.path);
      if (paths.has(path))
        throw new Error(`${path} appears twice in one asset manifest.`);
      paths.add(path);
      if (
        typeof file.content !== "string" ||
        typeof file.role !== "string" ||
        !/^[a-z][a-z0-9-]{0,39}$/.test(file.role)
      )
        throw new Error("Generated asset content or role is invalid.");
      const bytes = encoder.encode(file.content).length;
      if (!bytes || bytes > MAX_MANIFEST_ASSET_BYTES)
        throw new Error("Generated assets must be from 1 byte to 250 KB.");
      if (!markdownReferencesPath(references.markdown, path))
        throw new Error(`${path} is not referenced by the exported Markdown.`);
      const mediaType = file.mediaType ?? "application/octet-stream";
      if (
        typeof mediaType !== "string" ||
        !mediaTypePattern.test(mediaType.toLowerCase())
      )
        throw new Error("Generated asset media type is invalid.");
      return {
        path,
        role: file.role,
        mediaType: mediaType.toLowerCase(),
        bytes,
        fingerprint: sourceHash(file.content),
      };
    });
  assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schemaVersion: ASSET_MANIFEST_SCHEMA,
    type: ASSET_MANIFEST_TYPE,
    generator: { type: generator.type, version: generator.version },
    assets,
    references: { markdown: references.markdown },
  };
}

export function serializeAssetManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function bannerAssetPackage(raw, directory = raw?.assetDirectory) {
  const banner = normalizeBanner({ ...raw, assetDirectory: directory }),
    prefix = banner.assetDirectory.replace(/\/+$/, ""),
    markdown = bannerMarkup(banner),
    files = bannerFiles(banner).map((file) => {
      const path = relativeAssetPath(
        `${prefix ? `${prefix}/` : ""}${file.name}`,
      );
      return {
        ...file,
        path,
        content: file.source,
        mediaType: "image/svg+xml",
        role: `banner-${file.mode}`,
      };
    }),
    manifest = assetManifest(
      files,
      { markdown },
      { type: "banner", version: 1 },
    );
  return {
    banner,
    files,
    manifest,
    manifestSource: serializeAssetManifest(manifest),
  };
}

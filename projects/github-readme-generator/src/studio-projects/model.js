import { portableData } from "../state/portable-data.js";
export { portableData } from "../state/portable-data.js";
import { version as appVersion } from "../../package.json";
import {
  newDraft,
  validateDraft,
  withoutDetachedCopies,
} from "../state/drafts.js";
import { createBlock, serializeBlocks } from "../markdown/serialize.js";
import { workspaceSettings } from "../state/workspace-backup.js";
import { validateComponents } from "../components-library/storage.js";
import { validateCollections } from "../badges/collections.js";
import { validateVisualLibrary } from "../themes/visual-library.js";
import { bannerFiles } from "../banners/export.js";
import { safeFilename } from "../state/download.js";
import { sourceHash } from "../state/source-hash.js";
import { validateLocalization } from "../localization/metadata.js";
export { sourceHash } from "../state/source-hash.js";

export const PROJECT_SCHEMA = 1,
  PROJECT_LIMIT = 10_000_000;
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const metadataKeys = [
  "workspaceDocument",
  "visualTheme",
  "bannerSettings",
  "bannerReference",
  "githubProfile",
  "repository",
  "repositoryContext",
  "importSource",
  "importHistory",
  "detachedGenerated",
  "detachments",
  "dismissedSuggestions",
  "publishing",
  "studioProject",
];
const metadata = (v) =>
  Object.fromEntries(
    metadataKeys
      .filter((k) => Object.hasOwn(v || {}, k))
      .map((k) => [k, portableData(v[k])]),
  );
const validatedMetadata = (value) => {
  const clean = metadata(value);
  const document = clean.workspaceDocument;
  if (document && Object.hasOwn(document, "localization"))
    document.localization = validateLocalization(document.localization);
  return clean;
};
function assetsFor(meta) {
  return meta.bannerSettings
    ? bannerFiles(meta.bannerSettings).map((f) => ({
        id: f.name,
        type: "generated-banner",
        filename: f.name,
        hash: sourceHash(f.source),
        source: f.source,
      }))
    : [];
}
function libraries(value) {
  if (!object(value)) throw Error("Invalid embedded libraries.");
  return {
    badgeCollections: validateCollections(value.badgeCollections),
    visualLibrary: validateVisualLibrary(value.visualLibrary),
    componentLibrary: validateComponents(value.componentLibrary),
  };
}
export function createProject(
  draft,
  settings = {},
  embedded,
  now = new Date().toISOString(),
) {
  const portable = withoutDetachedCopies(draft);
  const meta = validatedMetadata(portable.metadata),
    createdAt = meta.studioProject?.createdAt || now;
  meta.studioProject = { createdAt };
  const project = {
    schemaVersion: PROJECT_SCHEMA,
    type: "readme-studio-project",
    appVersion,
    name: draft.name,
    createdAt,
    updatedAt: now,
    document: {
      markdown: draft.markdown,
      blocks: portableData(portable.blocks),
      metadata: meta,
    },
    settings: workspaceSettings(settings),
    assets: assetsFor(meta),
  };
  if (embedded) project.libraries = libraries(portableData(embedded));
  const raw = JSON.stringify(project, null, 2);
  if (new TextEncoder().encode(raw).length > PROJECT_LIMIT)
    throw Error(
      "Studio projects are limited to 10 MB. Export README separately or omit reusable libraries.",
    );
  return project;
}
// Sequential migration registry; version 0 represents the explicit legacy
// single-draft adapter, not an assertion that old releases had project schemas.
export const migrations = new Map([
  [
    0,
    (value) => ({ ...value, schemaVersion: 1, type: "readme-studio-project" }),
  ],
]);
export function migrateProject(input) {
  let value = structuredClone(input);
  if (value?.schemaVersion === undefined && typeof value?.markdown === "string")
    value = {
      schemaVersion: 0,
      name:
        typeof value.name === "string" ? value.name : "Imported legacy draft",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      appVersion: "legacy",
      document: {
        markdown: value.markdown,
        blocks: value.blocks,
        metadata: value.metadata || {},
      },
      settings: {},
      assets: [],
    };
  if (
    !object(value) ||
    !Number.isInteger(value.schemaVersion) ||
    value.schemaVersion < 0 ||
    value.schemaVersion > PROJECT_SCHEMA
  )
    throw Error(
      "Unsupported project schema. Open Markdown only or cancel; the original file is unchanged.",
    );
  while (value.schemaVersion < PROJECT_SCHEMA) {
    const next = migrations.get(value.schemaVersion);
    if (!next) throw Error("No safe migration is available.");
    const source = value.document?.markdown;
    const previous = value.schemaVersion;
    value = next(value);
    if (
      value.schemaVersion !== previous + 1 ||
      value.document?.markdown !== source
    )
      throw Error(
        "Migration refused: source preservation could not be verified.",
      );
  }
  return value;
}
export function recoverProjectSource(value) {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).length > PROJECT_LIMIT) return null;
    try {
      return recoverProjectSource(JSON.parse(value));
    } catch {
      const match = value.match(/"markdown"\s*:\s*("(?:[^"\\]|\\.)*")/);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch {}
      }
      return null;
    }
  }
  return typeof value?.document?.markdown === "string"
    ? value.document.markdown
    : typeof value?.markdown === "string"
      ? value.markdown
      : null;
}
export function inspectProject(raw) {
  if (
    typeof raw === "string" &&
    new TextEncoder().encode(raw).length > PROJECT_LIMIT
  )
    throw Error("Studio projects are limited to 10 MB. The file is unchanged.");
  const source = recoverProjectSource(raw);
  let original, value;
  try {
    original = typeof raw === "string" ? JSON.parse(raw) : raw;
    value = migrateProject(original);
    if (
      value.type !== "readme-studio-project" ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 200 ||
      typeof value.document?.markdown !== "string"
    )
      throw Error("Project identity or README source is malformed.");
    if (
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !Number.isFinite(Date.parse(value.updatedAt))
    )
      throw Error("Project dates are invalid.");
    const d = value.document;
    if (
      !Array.isArray(d.blocks) ||
      d.blocks.length > 2000 ||
      serializeBlocks(d.blocks) !== d.markdown
    )
      throw Error("Builder metadata does not exactly reproduce the README.");
    const clean = validatedMetadata(d.metadata),
      expected = assetsFor(clean);
    if (!Array.isArray(value.assets) || value.assets.length > 32)
      throw Error("Invalid asset manifest.");
    const assetIds = new Set(),
      filenames = new Set();
    for (const asset of value.assets) {
      const generated = expected.find((a) => a.filename === asset.filename);
      if (
        !generated ||
        typeof asset.id !== "string" ||
        !asset.id ||
        assetIds.has(asset.id) ||
        filenames.has(asset.filename) ||
        asset.type !== "generated-banner" ||
        asset.source !== generated.source ||
        asset.hash !== sourceHash(asset.source)
      )
        throw Error("An embedded asset is unsupported or corrupted.");
      assetIds.add(asset.id);
      filenames.add(asset.filename);
    }
    const ids = d.blocks.map((b) => b.id);
    if (
      ids.some((id) => typeof id !== "string" || !id || id.length > 100) ||
      new Set(ids).size !== ids.length
    )
      throw Error("Builder block identifiers are invalid or duplicated.");
    const draft = validateDraft(
      {
        name: value.name,
        markdown: d.markdown,
        blocks: portableData(d.blocks),
        metadata: clean,
      },
      { preserveBlockIds: true },
    );
    if (serializeBlocks(draft.blocks) !== source)
      throw Error("Structured recovery was unsafe.");
    const embedded =
      value.libraries === undefined
        ? undefined
        : libraries(portableData(value.libraries));
    draft.metadata.studioProject = { createdAt: value.createdAt };
    return {
      mode: "project",
      schemaVersion: 1,
      name: value.name,
      draft,
      settings: workspaceSettings(value.settings),
      assets: structuredClone(value.assets),
      libraries: embedded,
      createdAt: value.createdAt,
      source,
      warning: "",
    };
  } catch (error) {
    if (source === null)
      throw Error(
        "Could not recover README text from this file. The file and local drafts are unchanged.",
      );
    const name =
      "Recovered " +
      (typeof original?.name === "string"
        ? original.name.slice(0, 160)
        : "README");
    const draft = newDraft(name, [createBlock("custom", { markdown: source })]);
    draft.markdown = source;
    return {
      mode: "recovery",
      schemaVersion: original?.schemaVersion ?? "legacy/unknown",
      name,
      draft,
      source,
      assets: [],
      warning: `${error.message} README source can still be opened as a new custom draft.`,
    };
  }
}
export function projectFilename(name) {
  return safeFilename(name).slice(0, 90) + ".readme-studio.json";
}

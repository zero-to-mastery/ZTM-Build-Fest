import { validateBatch, recoverBatch } from "../workspace/batch-review.js";
import {
  validateSnapshots,
  recoverSnapshots,
  mergeSnapshots,
  WORKSPACE_RETENTION,
} from "../workspace/evidence-snapshots.js";
import {
  validateShared,
  recoverShared,
  mergeShared,
} from "../workspace/shared-components.js";
import { portableData } from "./portable-data.js";
import {
  validateComponents,
  mergeComponents,
  recoverComponents,
} from "../components-library/storage.js";
import {
  validateVisualLibrary,
  mergeVisualLibraries,
  recoverVisualLibrary,
} from "../themes/visual-library.js";
import {
  validateCollections,
  recoverCollections,
} from "../badges/collections.js";
import { validateDraft, withoutDetachedCopies } from "./drafts.js";
import { validateActivity } from "../workspace/commands.js";
import { validateGuide, recoverGuide } from "../workspace/guide.js";
import { validateLocalization } from "../localization/metadata.js";
import { validateLocalizationGraph } from "../localization/graph.js";
import {
  validateWorksets,
  mergeWorksets,
  recoverWorksets,
} from "../workspace/repository-worksets.js";
export const BACKUP_LIMIT = 50_000_000;
export const workspaceSettings = (s = {}) => ({
  pane: ["build", "markdown", "preview", "health"].includes(s?.pane)
    ? s.pane
    : "build",
  collapsed: s?.collapsed === true,
  editorFont: ["13", "15", "18"].includes(String(s?.editorFont))
    ? String(s.editorFont)
    : "13",
  reduceMotion: s?.reduceMotion === true,
  closedGroups: Array.isArray(s?.closedGroups)
    ? [
        ...new Set(
          s.closedGroups.filter((g) =>
            ["Create", "Design", "Review", "GitHub", "Save"].includes(g),
          ),
        ),
      ]
    : [],
  theme: s?.theme === "dark" ? "dark" : "light",
  preview: ["1012", "760", "640", "375"].includes(String(s?.preview))
    ? String(s.preview)
    : "1012",
  ...(["dark", "light"].includes(s?.previewTheme)
    ? { previewTheme: s.previewTheme }
    : {}),
});
export function uniqueName(name, existing) {
  const names = new Set(existing.map((d) => d.name));
  const base = name.trim() || "Untitled";
  let result = base,
    i = 2;
  while (names.has(result)) result = `${base} (${i++})`;
  return result;
}
export function validateWorkspace(data, { preserveIds = false } = {}) {
  if (!data || data.version !== 1)
    throw new Error(
      "Unsupported workspace backup version. Use the original app version to export its drafts.",
    );
  if (
    !Array.isArray(data.drafts) ||
    !data.drafts.length ||
    data.drafts.length > 500
  )
    throw new Error("Workspace backup must contain between 1 and 500 drafts.");
  const ids = new Set(),
    documentIds = new Map(),
    drafts = [];
  let active;
  for (const original of data.drafts) {
    const d = validateDraft(original, { preserveBlockIds: preserveIds });
    const workspaceDocument = d.metadata?.workspaceDocument;
    if (workspaceDocument && Object.hasOwn(workspaceDocument, "localization"))
      workspaceDocument.localization = validateLocalization(
        workspaceDocument.localization,
      );
    d.name = uniqueName(d.name, drafts);
    if (
      preserveIds &&
      typeof original.id === "string" &&
      original.id &&
      !ids.has(original.id)
    )
      d.id = original.id;
    ids.add(d.id);
    if (typeof original.id === "string" && !documentIds.has(original.id))
      documentIds.set(original.id, d.id);
    drafts.push(d);
    if (!active && original.id === data.active) active = d.id;
  }
  for (const draft of drafts) {
    const localization = draft.metadata?.workspaceDocument?.localization;
    if (
      typeof localization?.sourceDocumentId === "string" &&
      documentIds.has(localization.sourceDocumentId)
    )
      localization.sourceDocumentId = documentIds.get(
        localization.sourceDocumentId,
      );
  }
  validateLocalizationGraph(drafts);
  return {
    version: 1,
    drafts,
    active: active || drafts[0].id,
    settings: workspaceSettings(data.settings),
    activity: validateActivity(data.activity),
    guide: validateGuide(data.guide),
    repositoryWorksets: validateWorksets(data.repositoryWorksets),
    badgeCollections: validateCollections(data.badgeCollections),
    visualLibrary: validateVisualLibrary(data.visualLibrary),
    componentLibrary: validateComponents(data.componentLibrary),
    sharedComponents: validateShared(data.sharedComponents),
    reviewBatch: validateBatch(data.reviewBatch, documentIds),
    evidenceSnapshots: validateSnapshots(data.evidenceSnapshots, documentIds),
    ...(typeof data.createdAt === "string"
      ? { createdAt: data.createdAt }
      : {}),
  };
}
export function createBackup(data) {
  return {
    ...portableData({
      ...data,
      ...(Array.isArray(data?.drafts)
        ? { drafts: data.drafts.map(withoutDetachedCopies) }
        : {}),
    }),
    version: 1,
    createdAt: new Date().toISOString(),
  };
}
// The notification after a restore. A merge always names the draft it opened
// (the backup's own active draft), also when some incoming evidence snapshots
// did not fit the workspace limit and stay only in the backup file.
export function restoreNotice({ mode, opened, notRestored = 0 }) {
  return [
    "Workspace backup restored.",
    mode === "merge" &&
      `Opened ${opened}; your other drafts are still under Current draft.`,
    notRestored > 0 &&
      `Local evidence snapshots were kept; ${notRestored} incoming evidence snapshot(s) did not fit the ${WORKSPACE_RETENTION}-snapshot workspace limit and remain only in the backup file.`,
  ]
    .filter(Boolean)
    .join(" ");
}
export function restoreWorkspace(current, backup, mode) {
  const incoming = validateWorkspace(backup);
  if (mode === "replace") return incoming;
  if (mode !== "merge") throw new Error("Choose replace or merge.");
  const sharedComponents = mergeShared(
    current.sharedComponents,
    incoming.sharedComponents,
    incoming.drafts,
  );
  const drafts = structuredClone(current.drafts);
  for (const d of incoming.drafts) {
    d.name = uniqueName(d.name, drafts);
    drafts.push(d);
  }
  if (drafts.length > 500)
    throw new Error(
      "Merged workspace exceeds the 500 draft limit. Export smaller backups first.",
    );
  // A merge opens the backup's own active draft: restoring is how an author
  // gets back to that work, and their other drafts stay under Current draft.
  const result = {
    ...current,
    drafts,
    active: incoming.active,
    sharedComponents,
    repositoryWorksets: mergeWorksets(
      current.repositoryWorksets,
      incoming.repositoryWorksets,
    ),
    evidenceSnapshots: mergeSnapshots(
      current.evidenceSnapshots,
      incoming.evidenceSnapshots,
    ).snapshots,
    componentLibrary: mergeComponents(
      current.componentLibrary,
      incoming.componentLibrary,
    ),
    visualLibrary: mergeVisualLibraries(
      current.visualLibrary,
      incoming.visualLibrary,
    ),
    badgeCollections: validateCollections({
      version: 1,
      items: [
        ...(current.badgeCollections?.items || []),
        ...incoming.badgeCollections.items,
      ],
    }),
  };
  validateLocalizationGraph(result.drafts);
  return result;
}
export function recoverWorkspace(raw) {
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.drafts)) return null;
    const drafts = [];
    for (const d of data.drafts) {
      try {
        const draft = validateDraft({
          ...d,
          name: typeof d?.name === "string" ? d.name : "Recovered draft",
        });
        // Keep the stored ID so recovered snapshots can follow their document.
        if (typeof d.id === "string" && d.id) draft.id = d.id;
        const document = draft.metadata?.workspaceDocument;
        if (document && Object.hasOwn(document, "localization")) {
          try {
            document.localization = validateLocalization(document.localization);
          } catch {
            delete document.localization;
          }
        }
        drafts.push(draft);
      } catch {
        /* Keep unreadable originals in the recovery download. */
      }
    }
    if (!drafts.length) return null;
    // Recovery favors readable Markdown. Keep the original raw download as
    // evidence, then rebuild optional mappings oldest-first so an unrelated
    // later mapping is never discarded for an earlier conflict.
    const localizations = drafts.map(
      (draft) => draft.metadata?.workspaceDocument?.localization,
    );
    for (const draft of drafts)
      if (draft.metadata?.workspaceDocument)
        delete draft.metadata.workspaceDocument.localization;
    localizations.forEach((localization, index) => {
      if (!localization) return;
      drafts[index].metadata.workspaceDocument.localization = localization;
      try {
        validateLocalizationGraph(drafts);
      } catch {
        delete drafts[index].metadata.workspaceDocument.localization;
      }
    });
    return validateWorkspace({
      ...data,
      drafts,
      badgeCollections: recoverCollections(data.badgeCollections),
      visualLibrary: recoverVisualLibrary(data.visualLibrary),
      componentLibrary: recoverComponents(data.componentLibrary),
      sharedComponents: recoverShared(data.sharedComponents),
      reviewBatch: recoverBatch(data.reviewBatch),
      guide: recoverGuide(data.guide),
      repositoryWorksets: recoverWorksets(data.repositoryWorksets),
      evidenceSnapshots: recoverSnapshots(
        data.evidenceSnapshots,
        new Map(drafts.map((d) => [d.id, d.id])),
      ),
    });
  } catch {
    return null;
  }
}

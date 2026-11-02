import { target } from "../publishing/validation.js";
import { sourceHash } from "../state/source-hash.js";
import { targetIdentity } from "./documents.js";

// Evidence Snapshots are machine-local workspace state (ADR 0001): included in
// workspace backup/recovery, never in portable projects or README exports.
// They record revisions (SHAs), never third-party file content.
export const SNAPSHOT_VERSION = 1,
  DOCUMENT_RETENTION = 5,
  WORKSPACE_RETENTION = 100,
  ENTRY_LIMIT = 60,
  LINK_LIMIT = 40;
export const entryKinds = ["readme", "manifest", "lockfile", "linked"],
  entryStatuses = ["captured", "missing", "failed"],
  treeStates = ["complete", "truncated", "failed"],
  checkStatuses = ["unchanged", "changed", "added", "removed", "unknown"];
const SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/,
  ID = /^[\w-]{1,64}$/,
  HASH = /^fnv1a32:[a-f\d]{8}$/;
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (v, max) =>
  typeof v === "string" && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);

export function evidencePath(value) {
  if (
    !text(value, 400) ||
    !value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("Invalid evidence file path.");
  return value;
}
// Resolves a relative URL path against a directory (an array of segments),
// segment by segment rather than with URL against a synthetic origin, so a
// path that climbs above the repository root throws OUTSIDE_ROOT instead of
// being clamped onto a root file. Undecodable segments throw URIError.
export const OUTSIDE_ROOT = Symbol("outside repository root");
export function resolveRelativePath(raw, directory = []) {
  const segments = raw.startsWith("/") ? [] : [...directory];
  for (const encoded of raw.split("/")) {
    const part = decodeURIComponent(encoded);
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!segments.length) throw OUTSIDE_ROOT;
      segments.pop();
    } else segments.push(part);
  }
  return evidencePath(segments.join("/"));
}
function validateEntry(entry) {
  if (
    !object(entry) ||
    !entryKinds.includes(entry.kind) ||
    !entryStatuses.includes(entry.status)
  )
    throw Error("Invalid evidence file entry.");
  const clean = {
    path: evidencePath(entry.path),
    kind: entry.kind,
    status: entry.status,
  };
  if (entry.status === "captured") {
    if (
      !SHA.test(entry.sha) ||
      !["file", "directory", "submodule"].includes(entry.type)
    )
      throw Error("Captured evidence needs a Git object revision.");
    clean.type = entry.type;
    clean.sha = entry.sha;
  } else if (entry.sha !== undefined || entry.type !== undefined)
    throw Error("Only captured evidence has a revision.");
  if (entry.note !== undefined) {
    if (entry.status !== "failed" || !text(entry.note, 300))
      throw Error("Invalid evidence note.");
    clean.note = entry.note;
  }
  return clean;
}
export function validateSnapshot(value) {
  if (
    !object(value) ||
    !ID.test(value.id) ||
    !text(value.documentId, 200) ||
    !value.documentId ||
    !text(value.capturedAt, 40) ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    !SHA.test(value.head) ||
    !treeStates.includes(value.tree) ||
    !HASH.test(value.sourceHash) ||
    typeof value.baseline !== "boolean" ||
    !Array.isArray(value.entries) ||
    !value.entries.length ||
    value.entries.length > ENTRY_LIMIT ||
    !Array.isArray(value.notes ?? []) ||
    (value.notes ?? []).length > 5 ||
    !(value.notes ?? []).every((note) => text(note, 300))
  )
    throw Error("Invalid evidence snapshot.");
  const destination = target(value.target);
  const entries = value.entries.map(validateEntry);
  const paths = new Set(entries.map((entry) => entry.path));
  const readmes = entries.filter((entry) => entry.kind === "readme");
  if (
    paths.size !== entries.length ||
    readmes.length !== 1 ||
    readmes[0].path !== destination.path
  )
    throw Error("Evidence snapshot needs one README entry for its target.");
  return {
    id: value.id,
    documentId: value.documentId,
    target: {
      repository: destination.repository,
      branch: destination.branch,
      path: destination.path,
    },
    capturedAt: value.capturedAt,
    head: value.head,
    tree: value.tree,
    sourceHash: value.sourceHash,
    baseline: value.baseline,
    entries,
    notes: [...(value.notes ?? [])],
  };
}
const empty = () => ({ version: SNAPSHOT_VERSION, items: [] });
const remap = (items, ids) =>
  ids
    ? items.flatMap((item) =>
        ids.has(item.documentId)
          ? [{ ...item, documentId: ids.get(item.documentId) }]
          : [],
      )
    : items;
function checkItems(items) {
  const ids = new Set(),
    baselines = new Set();
  for (const item of items) {
    if (ids.has(item.id)) throw Error("Duplicate evidence snapshot.");
    ids.add(item.id);
    if (item.baseline && baselines.has(item.documentId))
      throw Error("A document can have only one Baseline.");
    if (item.baseline) baselines.add(item.documentId);
  }
  if (items.length > WORKSPACE_RETENTION)
    throw Error(
      `Evidence snapshots are limited to ${WORKSPACE_RETENTION} per workspace.`,
    );
  return { version: SNAPSHOT_VERSION, items };
}
// `ids` maps stored document IDs to the IDs they have after workspace
// validation (restore regenerates IDs). Snapshots of absent documents are
// dropped; they can no longer describe any document.
export function validateSnapshots(value, ids = null) {
  if (value == null) return empty();
  if (
    !object(value) ||
    value.version !== SNAPSHOT_VERSION ||
    !Array.isArray(value.items) ||
    value.items.length > WORKSPACE_RETENTION
  )
    throw Error(
      "Unsupported or damaged evidence snapshots. Use the app version that saved them.",
    );
  return checkItems(remap(value.items.map(validateSnapshot), ids));
}
// Salvages individually valid snapshots from damaged storage. Never throws.
export function recoverSnapshots(value, ids = null) {
  if (!object(value) || !Array.isArray(value.items)) return empty();
  const items = [],
    seen = new Set(),
    baselines = new Set();
  for (const raw of value.items.slice(0, WORKSPACE_RETENTION * 2)) {
    try {
      const item = validateSnapshot(raw);
      if (seen.has(item.id)) continue;
      if (item.baseline && baselines.has(item.documentId))
        item.baseline = false;
      seen.add(item.id);
      if (item.baseline) baselines.add(item.documentId);
      items.push(item);
    } catch {
      /* The damaged original stays in the recovery download. */
    }
  }
  // Retention throws when more Baselines remain than the workspace holds; a
  // recovery must not fail on that, so the oldest excess Baselines are left
  // in the recovery download instead.
  let baselineCount = 0;
  const bounded = remap(items, ids)
    .sort(newest)
    .filter((item) => !item.baseline || ++baselineCount <= WORKSPACE_RETENTION);
  try {
    return retainSnapshots(bounded).snapshots;
  } catch {
    return empty();
  }
}

const newest = (a, b) =>
  Date.parse(b.capturedAt) - Date.parse(a.capturedAt) ||
  b.id.localeCompare(a.id);
// Retention keeps each document's Baseline plus its newest snapshots, then
// enforces the workspace cap by evicting the oldest non-Baseline snapshots.
// `keep` names a snapshot that must survive (a fresh capture): it counts as
// its document's newest even when other snapshots carry later timestamps,
// and capture is refused rather than silently dropping it.
export function retainSnapshots(items, keep = null) {
  const kept = [],
    evicted = [],
    counts = new Map();
  const order = (a, b) => (b.id === keep) - (a.id === keep) || newest(a, b);
  for (const item of [...items].sort(order)) {
    const count = counts.get(item.documentId) || 0;
    if (!item.baseline && count >= DOCUMENT_RETENTION) evicted.push(item);
    else {
      kept.push(item);
      if (!item.baseline) counts.set(item.documentId, count + 1);
    }
  }
  while (kept.length > WORKSPACE_RETENTION) {
    const index = kept.findLastIndex(
      (item) => !item.baseline && item.id !== keep,
    );
    if (index === -1)
      throw Error(
        `Every one of the ${WORKSPACE_RETENTION} retained snapshots is a Baseline. Unpin or delete one first.`,
      );
    evicted.push(...kept.splice(index, 1));
  }
  return { snapshots: checkItems(kept), evicted };
}
export function createSnapshot({
  documentId,
  target: destination,
  source,
  evidence,
  now = Date.now(),
  id = crypto.randomUUID(),
}) {
  return validateSnapshot({
    id,
    documentId,
    target: destination,
    capturedAt: new Date(now).toISOString(),
    head: evidence.head,
    tree: evidence.tree,
    sourceHash: sourceHash(source),
    baseline: false,
    entries: evidence.entries,
    notes: evidence.notes,
  });
}
export function addSnapshot(snapshots, snapshot) {
  const current = validateSnapshots(snapshots),
    item = validateSnapshot(snapshot);
  return retainSnapshots([...current.items, item], item.id);
}
export function documentSnapshots(snapshots, documentId) {
  return (snapshots?.items || [])
    .filter((item) => item.documentId === documentId)
    .sort(newest);
}
// A snapshot whose repository, branch or path no longer matches the
// document's current target cannot serve as a Baseline for comparison.
export function differentTarget(snapshot, destination) {
  return (
    !destination ||
    targetIdentity(snapshot.target) !== targetIdentity(destination)
  );
}
function update(snapshots, id, change) {
  const current = validateSnapshots(snapshots);
  const item = current.items.find((entry) => entry.id === id);
  if (!item) throw Error("That evidence snapshot no longer exists.");
  return checkItems(change(current.items, item));
}
export function pinBaseline(snapshots, id, destination) {
  return update(snapshots, id, (items, item) => {
    if (differentTarget(item, destination))
      throw Error(
        "This snapshot has a different target from the document, so it cannot be the Baseline.",
      );
    return items.map((entry) =>
      entry.documentId === item.documentId
        ? { ...entry, baseline: entry.id === id }
        : entry,
    );
  });
}
export function unpinBaseline(snapshots, id) {
  return update(snapshots, id, (items) =>
    items.map((entry) =>
      entry.id === id ? { ...entry, baseline: false } : entry,
    ),
  );
}
export function deleteSnapshot(snapshots, id) {
  return update(snapshots, id, (items) =>
    items.filter((entry) => entry.id !== id),
  );
}
export function forgetDocument(snapshots, documentId) {
  return checkItems(
    validateSnapshots(snapshots).items.filter(
      (item) => item.documentId !== documentId,
    ),
  );
}
// Local snapshots win: they are never evicted by a merge, incoming IDs are
// renamed and a local Baseline stays. Incoming snapshots fill the remaining
// workspace capacity (Baselines first, then newest); the rest are not
// restored and stay in the backup file. `dropped` counts them.
export function mergeSnapshots(current, incoming) {
  const items = validateSnapshots(current).items;
  const ids = new Set(items.map((item) => item.id)),
    baselines = new Set(
      items.filter((item) => item.baseline).map((item) => item.documentId),
    );
  const candidates = validateSnapshots(incoming)
    .items.map((item) => ({
      ...item,
      id: ids.has(item.id) ? crypto.randomUUID() : item.id,
      baseline: item.baseline && !baselines.has(item.documentId),
    }))
    .sort((a, b) => b.baseline - a.baseline || newest(a, b));
  const room = Math.max(0, WORKSPACE_RETENTION - items.length),
    perDocument = new Map(),
    added = [];
  for (const item of items)
    if (!item.baseline)
      perDocument.set(
        item.documentId,
        (perDocument.get(item.documentId) || 0) + 1,
      );
  let dropped = 0;
  for (const item of candidates) {
    const count = perDocument.get(item.documentId) || 0;
    if (added.length >= room || (!item.baseline && count >= DOCUMENT_RETENTION))
      dropped++;
    else {
      added.push(item);
      if (!item.baseline) perDocument.set(item.documentId, count + 1);
    }
  }
  return { snapshots: checkItems([...items, ...added]), dropped };
}
export function snapshotSummary(snapshot, source) {
  const count = (status) =>
    snapshot.entries.filter((entry) => entry.status === status).length;
  return {
    captured: count("captured"),
    missing: count("missing"),
    failed: count("failed"),
    partial: snapshot.entries.some((entry) => entry.status !== "captured"),
    readme: snapshot.entries.find((entry) => entry.kind === "readme"),
    sourceEdited:
      typeof source === "string"
        ? sourceHash(source) !== snapshot.sourceHash
        : null,
  };
}

// A Change check compares a snapshot with freshly read evidence. It saves
// nothing. Anything that could not be read on either side is `unknown`, never
// drift; absence only counts when that side's repository tree was complete.
export function compareEvidence(snapshot, current) {
  const before = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const after = new Map(current.entries.map((entry) => [entry.path, entry]));
  const state = (entry, tree) =>
    entry
      ? entry.status === "failed"
        ? "unknown"
        : entry.status === "missing"
          ? "absent"
          : "present"
      : tree === "complete"
        ? "absent"
        : "unknown";
  const entries = [...new Set([...before.keys(), ...after.keys()])].map(
    (path) => {
      const old = before.get(path),
        now = after.get(path);
      const a = state(old, snapshot.tree),
        b = state(now, current.tree);
      const status =
        a === "unknown" || b === "unknown"
          ? "unknown"
          : a === "present" && b === "present"
            ? old.sha === now.sha
              ? "unchanged"
              : "changed"
            : a === "present"
              ? "removed"
              : b === "present"
                ? "added"
                : "unchanged";
      return {
        path,
        kind: (old || now).kind,
        status,
        before: old?.sha || "",
        after: now?.sha || "",
        note: now?.note || old?.note || "",
      };
    },
  );
  const order = { readme: 0, manifest: 1, lockfile: 2, linked: 3 };
  entries.sort(
    (a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path),
  );
  return {
    head: { before: snapshot.head, after: current.head },
    headChanged: snapshot.head !== current.head,
    entries,
    counts: Object.fromEntries(
      checkStatuses.map((status) => [
        status,
        entries.filter((entry) => entry.status === status).length,
      ]),
    ),
    notes: current.notes || [],
  };
}

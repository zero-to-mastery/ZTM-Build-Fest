import { AuditError } from "../repository-audit/github.js";
import { githubRepository } from "../badges/providers/github.js";
import { manifests } from "../stack-intelligence/manifests.js";
import { isRelativeUrl } from "../markdown/resolve-urls.js";
import { sourceUrls } from "./health.js";
import { driftFiles, READ_LIMIT } from "../workspace/drift-check.js";
import {
  resolveRelativePath,
  OUTSIDE_ROOT,
  LINK_LIMIT,
} from "../workspace/evidence-snapshots.js";

// Recognised root Evidence files: the Stack Intelligence manifest registry
// plus common lockfiles. Only revisions are recorded; content is never read.
export const lockfiles = Object.freeze([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
]);
export const recognisedFiles = Object.freeze([
  ...manifests.map((m) => ({ path: m.path, kind: "manifest" })),
  ...lockfiles.map((path) => ({ path, kind: "lockfile" })),
]);
const SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/;
const types = { blob: "file", tree: "directory", commit: "submodule" };

// Repository paths the document's own Source links to by relative URL,
// resolved against its README path. Read-only; the Source is not changed.
// Links that climb above the repository root or cannot be decoded are
// reported, never clamped onto a root file (see `resolveRelativePath`).
export function linkedPaths(markdown, readmePath) {
  const directory = readmePath.split("/").slice(0, -1);
  const paths = [];
  let skipped = 0,
    outside = 0,
    undecodable = 0;
  for (const { value } of sourceUrls(markdown)) {
    if (!isRelativeUrl(value) || /[\x00-\x1f\x7f\\]/.test(value)) continue;
    // Query- or fragment-only links point at the README itself.
    const raw = value.trim().split(/[?#]/)[0];
    if (!raw) continue;
    let path;
    try {
      path = resolveRelativePath(raw, directory);
    } catch (error) {
      if (error === OUTSIDE_ROOT) outside++;
      else if (error instanceof URIError) undecodable++;
      continue;
    }
    if (path === readmePath || paths.includes(path)) continue;
    if (paths.length >= LINK_LIMIT) skipped++;
    else paths.push(path);
  }
  const notes = [];
  if (skipped)
    notes.push(
      `Only the first ${LINK_LIMIT} relative links were recorded; ${skipped} more were not.`,
    );
  if (outside)
    notes.push(
      `${outside} relative link(s) point above the repository root and were not recorded.`,
    );
  if (undecodable)
    notes.push(
      `${undecodable} relative link(s) could not be decoded (for example a literal "%") and were not recorded.`,
    );
  return { paths, notes };
}

// Reads the branch head and one recursive tree listing. Failure to read the
// head throws (nothing to record). A failed or truncated tree still yields a
// result: `tree` says how far the listing can be trusted, and paths not in
// `listing` are only confirmed absent when `tree` is "complete".
export async function readTree({ client, target, signal }) {
  const base = "/repos/" + githubRepository(target.repository);
  const { data: commits } = await client.request(
    `${base}/commits?sha=${encodeURIComponent(target.branch)}&per_page=1`,
    signal,
  );
  const head = Array.isArray(commits) ? commits[0] : null;
  if (!SHA.test(head?.sha) || !SHA.test(head?.commit?.tree?.sha))
    throw new AuditError(
      "response",
      "GitHub returned no readable branch head for this target.",
    );
  const result = {
    base,
    head: head.sha,
    tree: "complete",
    listing: new Map(),
    notes: [],
  };
  try {
    const { data } = await client.request(
      `${base}/git/trees/${head.commit.tree.sha}?recursive=1`,
      signal,
    );
    if (!Array.isArray(data?.tree))
      throw new AuditError("response", "Unreadable repository tree.");
    for (const item of data.tree)
      if (
        typeof item?.path === "string" &&
        types[item.type] &&
        SHA.test(item.sha)
      )
        result.listing.set(item.path, item);
    if (data.truncated === true) {
      result.tree = "truncated";
      result.notes.push(
        "GitHub truncated the repository tree; files not listed are unknown.",
      );
    }
  } catch (error) {
    signal?.throwIfAborted();
    result.tree = "failed";
    result.notes.push(
      `Repository tree could not be read: ${String(error.message).slice(0, 200)}`,
    );
    result.listing = new Map();
  }
  return result;
}

export async function readEvidence({
  client,
  target,
  linked = [],
  notes = [],
  signal,
}) {
  const read = await readTree({ client, target, signal });
  const result = {
    head: read.head,
    tree: read.tree,
    entries: [],
    notes: [...notes, ...read.notes],
  };
  const listing = read.listing;
  const record = (path, kind, optional = false) => {
    const item = listing.get(path);
    if (item)
      return result.entries.push({
        path,
        kind,
        status: "captured",
        type: types[item.type],
        sha: item.sha,
      });
    if (optional) return;
    if (result.tree === "complete")
      return result.entries.push({ path, kind, status: "missing" });
    result.entries.push({
      path,
      kind,
      status: "failed",
      note:
        result.tree === "truncated"
          ? "Not in the truncated tree listing."
          : "Repository tree unavailable.",
    });
  };
  record(target.path, "readme");
  for (const file of recognisedFiles)
    if (file.path !== target.path) record(file.path, file.kind, true);
  for (const path of linked)
    if (!result.entries.some((entry) => entry.path === path))
      record(path, "linked");
  signal?.throwIfAborted();
  return result;
}

// Reads one regular file's text by its blob revision from the tree, so every
// read describes the same commit. Bounded by READ_LIMIT; symbolic links,
// submodules, binary and non-UTF-8 content are refused. The text is returned
// to the caller only; nothing here stores it.
async function readBlob(client, base, item, signal) {
  if (item.type !== "blob" || item.mode === "120000")
    throw Error("Not a regular file.");
  if (Number(item.size) > READ_LIMIT)
    throw Error("Larger than the 256 KB read limit.");
  const { data } = await client.request(
    `${base}/git/blobs/${item.sha}`,
    signal,
  );
  if (
    data?.encoding !== "base64" ||
    typeof data.content !== "string" ||
    !Number.isSafeInteger(data.size) ||
    data.size < 0 ||
    data.size > READ_LIMIT ||
    data.content.length > READ_LIMIT * 2
  )
    throw Error("GitHub returned unreadable or oversized file content.");
  let bytes;
  try {
    bytes = Uint8Array.from(atob(data.content.replace(/\s/g, "")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw Error("GitHub returned unreadable file content.");
  }
  if (bytes.length !== data.size) throw Error("Incomplete file content.");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw Error("Not UTF-8 text.");
  }
}

// Evidence for a Drift check: the tree plus the bounded set of files whose
// content the plan's claims need (see `driftFiles`). A file that cannot be
// read is recorded as failed, so its claims stay unknown. A rate limit or
// denied request stops further reads; the remaining files are failed too.
export async function readDriftEvidence({ client, target, plan, signal }) {
  const read = await readTree({ client, target, signal });
  const files = new Map();
  const wanted = driftFiles(plan, read);
  let stopped = "";
  for (const path of wanted.paths) {
    signal?.throwIfAborted();
    if (stopped) {
      files.set(path, { status: "failed", note: stopped });
      continue;
    }
    try {
      const text = await readBlob(
        client,
        read.base,
        read.listing.get(path),
        signal,
      );
      files.set(path, { status: "read", text });
    } catch (error) {
      signal?.throwIfAborted();
      files.set(path, {
        status: "failed",
        note: String(error.message).slice(0, 200),
      });
      if (["rate-limit", "forbidden"].includes(error.kind))
        stopped = `Not read: ${String(error.message).slice(0, 200)}`;
    }
  }
  signal?.throwIfAborted();
  return {
    head: read.head,
    tree: read.tree,
    listing: read.listing,
    files,
    notes: [...read.notes, ...wanted.notes],
  };
}

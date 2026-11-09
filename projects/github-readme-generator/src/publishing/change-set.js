import { target, publishableContent, commitMessage } from "./validation.js";
import { publishDiff } from "./diff.js";
// Change sets (ADR epic69-02): the reviewed list of file writes one publish
// makes, identified by Git blob SHAs. Shared by the browser and the server, so
// it imports nothing from the DOM. The manifest holds no content; callers keep
// prepared content alongside it in memory. Nothing here is ever persisted.
export const CHANGE_SET_UNSUPPORTED =
  "This browser cannot compute Git blob SHAs (Web Crypto is unavailable, for example outside HTTPS), so no change set can be approved. Publishing stays in Read-only mode; Download remains available.";
const encoder = new TextEncoder();
const SHA = /^[a-f0-9]{40,64}$/;
// Execution order: assets first, the README or workflow last.
const ORDER = { asset: 0, readme: 1, workflow: 1 };
export const changeSetsSupported = () =>
  typeof globalThis.crypto?.subtle?.digest === "function";
async function digest(algorithm, bytes) {
  if (!changeSetsSupported()) throw new Error(CHANGE_SET_UNSUPPORTED);
  const hash = await globalThis.crypto.subtle.digest(algorithm, bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
// The SHA GitHub reports for a file: SHA-1 of `blob <bytes>\0<content>`.
export async function gitBlobSha(content) {
  const body = encoder.encode(content),
    header = encoder.encode(`blob ${body.length}\0`),
    bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  return digest("SHA-1", bytes);
}
export const shortChangeSetId = (id) => String(id).slice(0, 8);
// +/- lines for review only (changed-region counts, like the source diff). A
// create adds every line; without the remote text an update is not counted.
function lineCounts(action, before, content) {
  if (action === "unchanged") return { added: 0, removed: 0 };
  if (action === "create")
    return {
      added: content
        ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0)
        : 0,
      removed: 0,
    };
  if (typeof before !== "string") return { added: null, removed: null };
  const { added, removed } = publishDiff(before, content);
  return { added, removed };
}
// A UTF-8 byte order mark is invisible in a diff, so an update that adds or
// removes one says so. Null when unchanged, unknown or not an update.
const BOM = "\uFEFF";
export function byteOrderMarkChange(action, before, content) {
  if (action !== "update" || typeof before !== "string") return null;
  const had = before.startsWith(BOM),
    has = content.startsWith(BOM);
  return had === has ? null : had ? "removed" : "added";
}
// Entries that make a Contents write (everything except `unchanged`).
export const fileWrites = (changeSet) =>
  changeSet.entries.filter((entry) => entry.action !== "unchanged");
// The publishing request target for one entry; README entries carry no kind.
export function entryTarget(changeSet, entry) {
  return {
    repository: changeSet.target.repository,
    branch: changeSet.target.branch,
    path: entry.path,
    ...(entry.kind === "readme" ? {} : { kind: entry.kind }),
  };
}
// files: [{path, kind: "readme"|"asset"|"workflow", baseSha|null, content,
// baseContent?, fields?}]. `baseContent` (the remote text, BOM included) only
// feeds the review-only line counts and BOM note; `fields` are extra request
// fields (banner settings, workflow config) the server needs to validate a
// write. Neither is stored in the manifest, and neither changes its id.
export async function buildChangeSet({
  target: value,
  baseCommitSha = null,
  message,
  files,
}) {
  const { repository, branch } = target({
    repository: value?.repository,
    branch: value?.branch,
    path: "README.md",
  });
  if (baseCommitSha !== null && !SHA.test(baseCommitSha || ""))
    throw new Error("Reload the remote branch before building a change set.");
  if (!Array.isArray(files) || !files.length)
    throw new Error("A change set needs at least one file.");
  const reviewedMessage = commitMessage(message),
    paths = new Set(),
    entries = [];
  for (const file of [...files].sort(
    (a, b) => (ORDER[a?.kind] ?? 2) - (ORDER[b?.kind] ?? 2),
  )) {
    if (!(file?.kind in ORDER))
      throw new Error("Unsupported file kind in change set.");
    const { path } = target({
      repository,
      branch,
      path: file.path,
      ...(file.kind === "readme" ? {} : { kind: file.kind }),
    });
    if (paths.has(path))
      throw new Error(`${path} appears twice in one change set.`);
    paths.add(path);
    if (file.baseSha !== null && !SHA.test(file.baseSha || ""))
      throw new Error("Reload the remote SHA before publishing.");
    const content = publishableContent(file.content),
      resultSha = await gitBlobSha(content),
      action =
        file.baseSha === null
          ? "create"
          : resultSha === file.baseSha
            ? "unchanged"
            : "update";
    entries.push(
      Object.freeze({
        path,
        kind: file.kind,
        action,
        baseSha: file.baseSha,
        resultSha,
        bytes: encoder.encode(content).length,
        ...lineCounts(action, file.baseContent, content),
        bom: byteOrderMarkChange(action, file.baseContent, content),
      }),
    );
  }
  // Canonical JSON: fixed positions, no diff counts. Any change to the target,
  // base commit, message, order or a File change gives a different id.
  const canonical = JSON.stringify([
    1,
    repository,
    branch,
    baseCommitSha,
    reviewedMessage,
    entries.map((e) => [
      e.path,
      e.kind,
      e.action,
      e.baseSha,
      e.resultSha,
      e.bytes,
    ]),
  ]);
  return Object.freeze({
    version: 1,
    id: await digest("SHA-256", encoder.encode(canonical)),
    target: Object.freeze({ repository, branch }),
    baseCommitSha,
    message: reviewedMessage,
    entries: Object.freeze(entries),
  });
}
// The in-memory content for executeChangeSet, keyed by path.
export function changeSetContents(files) {
  return new Map(
    files.map((file) => [
      file.path,
      { content: file.content, fields: file.fields || {} },
    ]),
  );
}
// read(target) returns the current remote file ({sha} with null when absent).
// Only per-file SHA drift makes a Change set stale: a moved branch head alone
// does not, because each Contents write commits on top of the head.
export async function verifyChangeSet(changeSet, read) {
  const stale = [],
    remotes = {};
  for (const entry of changeSet.entries) {
    const remote = await read(entryTarget(changeSet, entry));
    remotes[entry.path] = remote;
    if ((remote?.sha ?? null) !== entry.baseSha) stale.push(entry.path);
  }
  return { stale, remotes };
}
// Writes the approved Change set one file at a time, in entry order, and stops
// at the first failure: later entries are "not attempted". Each request names
// its Base SHA (null for a create), Result SHA and the Change set id, so the
// server can refuse anything other than the reviewed content.
export async function executeChangeSet(
  changeSet,
  contents,
  request,
  { beforeWrite, afterWrite, onlyPaths, expectedBranchSha = null } = {},
) {
  for (const entry of fileWrites(changeSet)) {
    const file = contents.get(entry.path);
    if (
      typeof file?.content !== "string" ||
      (await gitBlobSha(file.content)) !== entry.resultSha
    )
      throw new Error(
        `Prepared content for ${entry.path} no longer matches the reviewed change set. Nothing was written; review it again.`,
      );
  }
  let nextExpectedBranchSha = expectedBranchSha;
  const results = [],
    row = (entry, status, extra = {}) => ({
      path: entry.path,
      kind: entry.kind,
      action: entry.action,
      status,
      ...extra,
    });
  for (const [index, entry] of changeSet.entries.entries()) {
    if (entry.action === "unchanged") {
      results.push(row(entry, "no write"));
      continue;
    }
    if (onlyPaths && !onlyPaths.has(entry.path)) {
      results.push(row(entry, "already written"));
      continue;
    }
    const file = contents.get(entry.path);
    let started = false,
      result;
    try {
      await beforeWrite?.(entry);
      started = true;
      result = await request("commit", {
        ...file.fields,
        ...entryTarget(changeSet, entry),
        sha: entry.baseSha,
        resultSha: entry.resultSha,
        changeSetId: changeSet.id,
        content: file.content,
        message: changeSet.message,
        confirmed: true,
        ...(nextExpectedBranchSha
          ? { expectedBranchSha: nextExpectedBranchSha }
          : {}),
      });
    } catch (error) {
      if (started)
        try {
          await afterWrite?.(entry, error.ambiguous ? "unknown" : "failed");
        } catch (journalError) {
          journalError.ambiguous = true;
          error = journalError;
        }
      const status = error.ambiguous ? "unknown" : "failed";
      results.push(row(entry, status, { error: error.message }));
      for (const rest of changeSet.entries.slice(index + 1))
        results.push(
          row(rest, rest.action === "unchanged" ? "no write" : "not attempted"),
        );
      return { complete: false, results, failure: { entry, error } };
    }
    if (nextExpectedBranchSha && result?.commitSha)
      nextExpectedBranchSha = result.commitSha;
    try {
      await afterWrite?.(entry, "written", result);
    } catch (error) {
      // GitHub answered, but the durable outcome could not be recorded. Stop
      // and reconcile instead of allowing another request from this state.
      error.ambiguous = true;
      error.recoveryReason = "journal";
      results.push(row(entry, "unknown", { error: error.message }));
      for (const rest of changeSet.entries.slice(index + 1))
        results.push(
          row(rest, rest.action === "unchanged" ? "no write" : "not attempted"),
        );
      return { complete: false, results, failure: { entry, error } };
    }
    results.push(
      row(entry, "written", { commitSha: result?.commitSha, result }),
    );
  }
  return { complete: true, results };
}

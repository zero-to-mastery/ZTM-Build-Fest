import { target } from "./validation.js";

export const PUBLISH_JOURNAL_KEY = "readme-studio-publish-journal-v1";
const SHA = /^[a-f0-9]{40,64}$/;
const ID = /^[a-f0-9]{64}$/;
const STATUSES = new Set([
  "not-attempted",
  "pending",
  "unknown",
  "failed",
  "not-written",
  "written",
  "diverged",
  "no-write",
]);

const malformed = () =>
  new Error(
    "The Publish journal is malformed. Original recovery data was preserved; download it before clearing the journal.",
  );

function checked(value) {
  if (
    value?.version !== 1 ||
    !ID.test(value.changeSetId || "") ||
    !Number.isFinite(value.createdAt) ||
    !Array.isArray(value.entries) ||
    !value.entries.length ||
    value.entries.length > 100
  )
    throw malformed();
  let recoveredTarget;
  try {
    recoveredTarget = target({ ...value.target, path: "README.md" });
  } catch {
    throw malformed();
  }
  const paths = new Set();
  const entries = value.entries.map((entry) => {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      paths.has(entry.path) ||
      !["readme", "asset", "workflow"].includes(entry.kind) ||
      !["create", "update", "unchanged"].includes(entry.action) ||
      (entry.baseSha !== null && !SHA.test(entry.baseSha || "")) ||
      !/^[a-f0-9]{40}$/.test(entry.resultSha || "") ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !STATUSES.has(entry.status) ||
      (entry.commitSha != null && !SHA.test(entry.commitSha))
    )
      throw malformed();
    paths.add(entry.path);
    return {
      path: entry.path,
      kind: entry.kind,
      action: entry.action,
      baseSha: entry.baseSha,
      resultSha: entry.resultSha,
      bytes: entry.bytes,
      status: entry.status === "pending" ? "unknown" : entry.status,
      ...(entry.commitSha ? { commitSha: entry.commitSha } : {}),
    };
  });
  return {
    version: 1,
    changeSetId: value.changeSetId,
    target: {
      repository: recoveredTarget.repository,
      branch: recoveredTarget.branch,
    },
    baseCommitSha:
      value.baseCommitSha === null || SHA.test(value.baseCommitSha || "")
        ? value.baseCommitSha
        : null,
    createdAt: value.createdAt,
    entries,
  };
}

function save(journal, storage) {
  try {
    storage.setItem(PUBLISH_JOURNAL_KEY, JSON.stringify(journal));
  } catch {
    throw new Error(
      "Publishing recovery could not be saved locally. Nothing was written; free browser storage before publishing.",
    );
  }
  return journal;
}

export function rawPublishJournal(storage = localStorage) {
  try {
    return storage.getItem(PUBLISH_JOURNAL_KEY);
  } catch {
    throw new Error(
      "The Publish journal cannot be read. Publishing is blocked.",
    );
  }
}

export function readPublishJournal(storage = localStorage) {
  const raw = rawPublishJournal(storage);
  if (raw === null) return null;
  try {
    return checked(JSON.parse(raw));
  } catch (error) {
    if (error.message.includes("malformed")) throw error;
    throw malformed();
  }
}

export function startPublishJournal(
  changeSet,
  storage = localStorage,
  now = Date.now,
) {
  // Refuse to overwrite malformed recovery data.
  if (readPublishJournal(storage))
    throw new Error(
      "An earlier Publish journal is still unsettled. Reconcile it with GitHub or clear its settled result before starting another write.",
    );
  const journal = checked({
    version: 1,
    changeSetId: changeSet.id,
    target: changeSet.target,
    baseCommitSha: changeSet.baseCommitSha,
    createdAt: now(),
    entries: changeSet.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      action: entry.action,
      baseSha: entry.baseSha,
      resultSha: entry.resultSha,
      bytes: entry.bytes,
      status: entry.action === "unchanged" ? "no-write" : "not-attempted",
    })),
  });
  return save(journal, storage);
}

export function updatePublishJournal(
  changeSetId,
  path,
  status,
  extra = {},
  storage = localStorage,
) {
  const journal = readPublishJournal(storage);
  if (!journal || journal.changeSetId !== changeSetId)
    throw new Error("The Publish journal no longer matches this change set.");
  if (!STATUSES.has(status))
    throw new Error("Invalid Publish journal outcome.");
  const entry = journal.entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error("The Publish journal has no matching file.");
  entry.status = status;
  delete entry.commitSha;
  if (extra.commitSha && SHA.test(extra.commitSha))
    entry.commitSha = extra.commitSha;
  return save(journal, storage);
}

export function reconcilePublishJournal(journal, remotes) {
  const next = structuredClone(checked(journal));
  for (const entry of next.entries) {
    if (entry.action === "unchanged") {
      entry.status = "no-write";
      continue;
    }
    const remote = remotes[entry.path],
      sha = remote?.sha ?? null;
    delete entry.commitSha;
    if (sha === entry.resultSha) {
      entry.status = "written";
      if (SHA.test(remote?.commitSha || "")) entry.commitSha = remote.commitSha;
    } else if (sha === entry.baseSha) entry.status = "not-written";
    else entry.status = "diverged";
  }
  return next;
}

export function savePublishJournal(journal, storage = localStorage) {
  return save(checked(journal), storage);
}

export function clearPublishJournal(storage = localStorage) {
  try {
    storage.removeItem(PUBLISH_JOURNAL_KEY);
  } catch {
    throw new Error("The Publish journal could not be cleared.");
  }
}

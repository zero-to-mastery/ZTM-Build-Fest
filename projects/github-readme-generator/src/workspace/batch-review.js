import { target } from "../publishing/validation.js";
import { targetIdentity } from "./documents.js";
import { documentTarget } from "./documents.js";
import { sourceHash } from "../state/source-hash.js";

const JOURNAL_LIMIT = 500;
const states = ["pending", "reviewed", "skipped"];
const timestamp = (value) =>
  typeof value === "string" &&
  value.length <= 64 &&
  Number.isFinite(Date.parse(value));

function checkpoint(value, documentIds) {
  if (value == null) return null;
  if (
    value.version !== 1 ||
    typeof value.documentId !== "string" ||
    !value.documentId ||
    value.documentId.length > 200 ||
    typeof value.sourceHash !== "string" ||
    !/^fnv1a32:[0-9a-f]{8}$/.test(value.sourceHash) ||
    typeof value.targetIdentity !== "string" ||
    value.targetIdentity.length > 500 ||
    !timestamp(value.at)
  )
    throw Error("Invalid batch checkpoint.");
  return {
    version: 1,
    documentId: documentIds?.get(value.documentId) || value.documentId,
    sourceHash: value.sourceHash,
    targetIdentity: value.targetIdentity,
    at: value.at,
  };
}

function journalEntry(value, identities, documentIds) {
  if (
    !value ||
    !["opened", ...states].includes(value.action) ||
    !Number.isInteger(value.index) ||
    value.index < 0 ||
    value.index >= identities.length ||
    !timestamp(value.at)
  )
    throw Error("Invalid batch journal entry.");
  if (value.action !== "opened")
    return { action: value.action, index: value.index, at: value.at };
  const saved = checkpoint({ version: 1, ...value }, documentIds);
  if (saved.targetIdentity !== identities[value.index])
    throw Error("Invalid batch journal target.");
  const { version: _version, ...entry } = saved;
  return { action: "opened", index: value.index, ...entry };
}

export function validateBatch(value, documentIds) {
  if (value == null) return null;
  if (
    ![1, 2].includes(value.version) ||
    !Array.isArray(value.items) ||
    !value.items.length ||
    value.items.length > 200 ||
    !Number.isInteger(value.current) ||
    value.current < 0 ||
    value.current >= value.items.length
  )
    throw Error("Invalid review batch. Choose up to 200 repositories.");
  if (value.version === 2 && !Array.isArray(value.journal))
    throw Error("Invalid review batch journal.");
  const ids = new Set();
  const identities = [];
  const items = value.items.map((item) => {
    const destination = target(item);
    const identity = targetIdentity(destination);
    if (ids.has(identity) || !states.includes(item.state))
      throw Error("Invalid or duplicate batch item.");
    ids.add(identity);
    identities.push(identity);
    const saved = checkpoint(item.checkpoint, documentIds);
    if (saved && saved.targetIdentity !== identity)
      throw Error("Invalid batch checkpoint target.");
    return {
      ...destination,
      state: item.state,
      ...(saved ? { checkpoint: saved } : {}),
    };
  });
  return {
    version: 2,
    current: value.current,
    items,
    journal: Array.isArray(value.journal)
      ? value.journal
          .slice(-JOURNAL_LIMIT)
          .map((entry) => journalEntry(entry, identities, documentIds))
      : [],
  };
}
export function createBatch(repositories) {
  const unique = [
    ...new Map(
      repositories.map((repo) => [repo.full_name.toLowerCase(), repo]),
    ).values(),
  ];
  return validateBatch({
    version: 2,
    current: 0,
    journal: [],
    items: unique.map((repo) => ({
      repository: repo.full_name,
      branch: repo.default_branch,
      path: "README.md",
      state: "pending",
    })),
  });
}
export function nextBatchIndex(batch) {
  return batch.items.findIndex((item) => item.state === "pending");
}
export function decideBatch(
  batch,
  index,
  state,
  at = new Date().toISOString(),
) {
  const next = validateBatch(batch);
  if (!next.items[index] || !states.includes(state))
    throw Error("Choose a valid batch decision.");
  next.items[index].state = state;
  next.journal = [...next.journal, { action: state, index, at }].slice(
    -JOURNAL_LIMIT,
  );
  return next;
}

export function recordBatchOpen(
  batch,
  index,
  draft,
  at = new Date().toISOString(),
) {
  const next = validateBatch(batch);
  if (!next.items[index] || !draft || typeof draft.markdown !== "string")
    throw Error("Choose a valid opened batch document.");
  const saved = {
    version: 1,
    documentId: draft.id,
    sourceHash: sourceHash(draft.markdown),
    targetIdentity: targetIdentity(documentTarget(draft)),
    at,
  };
  if (
    !saved.documentId ||
    saved.targetIdentity !== targetIdentity(next.items[index])
  )
    throw Error("Opened document does not match this batch item.");
  next.items[index].checkpoint = saved;
  next.journal = [...next.journal, { action: "opened", index, ...saved }]
    .slice(-JOURNAL_LIMIT)
    .map(({ version: _version, ...entry }) => entry);
  return next;
}

export function reviewBatchRecovery(batch, drafts) {
  const value = validateBatch(batch);
  return {
    items: value.items.map((item) => {
      if (!item.checkpoint) return { status: "not-opened" };
      const draft = drafts.find(
        (candidate) => candidate.id === item.checkpoint.documentId,
      );
      if (!draft) return { status: "missing" };
      if (
        targetIdentity(documentTarget(draft)) !== item.checkpoint.targetIdentity
      )
        return { status: "target-changed", documentId: draft.id };
      return {
        status:
          sourceHash(draft.markdown) === item.checkpoint.sourceHash
            ? "current"
            : "changed",
        documentId: draft.id,
      };
    }),
  };
}
export function recoverBatch(value) {
  try {
    return validateBatch(value);
  } catch {
    return null;
  }
}

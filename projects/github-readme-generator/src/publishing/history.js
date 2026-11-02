import { target } from "./validation.js";
const KEY = "readme-studio-publishing-v1";
export function readPublishingHistory(storage = localStorage) {
  let value;
  try {
    const raw = storage.getItem(KEY);
    value = raw
      ? JSON.parse(raw)
      : { version: 1, entries: [], checkpoint: null };
  } catch {
    throw new Error(
      "Publishing history cannot be read. Existing data was preserved. Download your draft before repairing browser storage.",
    );
  }
  if (
    value?.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 50 ||
    value.entries.some(
      (e) =>
        !e ||
        typeof e.commitSha !== "string" ||
        !/^[a-f0-9]{40,64}$/.test(e.commitSha) ||
        !Number.isFinite(e.timestamp),
    ) ||
    (value.checkpoint &&
      (typeof value.checkpoint.source !== "string" ||
        typeof value.checkpoint.draftId !== "string"))
  )
    throw new Error(
      "Publishing history is malformed. Original storage was preserved.",
    );
  try {
    return {
      version: 1,
      entries: value.entries.map((e) => ({
        ...target(e),
        commitSha: e.commitSha,
        previousCommitSha: /^[a-f0-9]{40,64}$/.test(e.previousCommitSha || "")
          ? e.previousCommitSha
          : null,
        timestamp: e.timestamp,
        ...(e.reconciled === true ? { reconciled: true } : {}),
      })),
      checkpoint: value.checkpoint
        ? {
            draftId: value.checkpoint.draftId,
            source: value.checkpoint.source,
            timestamp: Number.isFinite(value.checkpoint.timestamp)
              ? value.checkpoint.timestamp
              : 0,
          }
        : null,
    };
  } catch {
    throw new Error(
      "Publishing history has an invalid target. Original storage was preserved.",
    );
  }
}
function save(value, storage) {
  try {
    storage.setItem(KEY, JSON.stringify(value));
  } catch {
    throw new Error(
      "Publishing recovery could not be saved locally. Download your draft and free storage before publishing.",
    );
  }
}
export function savePublishCheckpoint(draftId, source, storage = localStorage) {
  const value = readPublishingHistory(storage);
  value.checkpoint = { draftId, source, timestamp: Date.now() };
  save(value, storage);
}
export function recordPublish(
  result,
  previousCommitSha,
  storage = localStorage,
) {
  const value = readPublishingHistory(storage);
  if (!/^[a-f0-9]{40,64}$/.test(result.commitSha))
    throw new Error("Invalid published commit identifier.");
  value.entries.unshift({
    ...target(result),
    commitSha: result.commitSha,
    previousCommitSha: /^[a-f0-9]{40,64}$/.test(previousCommitSha || "")
      ? previousCommitSha
      : null,
    timestamp: Date.now(),
    ...(result.reconciled === true ? { reconciled: true } : {}),
  });
  value.entries = value.entries.slice(0, 50);
  save(value, storage);
  return value;
}

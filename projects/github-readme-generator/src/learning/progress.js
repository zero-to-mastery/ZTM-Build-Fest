export const LEARNING_PROGRESS_KEY = "readme-studio-learning-progress-v1";
const TYPE = new Set(["profile", "cli", "library", "api", "game"]),
  ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const invalid = () =>
  new Error(
    "Learning progress is unreadable. The existing record was preserved; download a workspace backup before clearing browser data.",
  );
export function validateLearningProgress(value) {
  if (value == null) return { version: 1, documents: [] };
  if (
    value.version !== 1 ||
    !Array.isArray(value.documents) ||
    value.documents.length > 50
  )
    throw invalid();
  const seen = new Set();
  return {
    version: 1,
    documents: value.documents.map((row) => {
      const key = `${row?.documentId}:${row?.type}`;
      const allowed = TYPE.has(row?.type)
        ? new Set(checklist(row.type).map((item) => item.id))
        : new Set();
      if (
        !row ||
        typeof row.documentId !== "string" ||
        !ID.test(row.documentId) ||
        seen.has(key) ||
        !TYPE.has(row.type) ||
        !Array.isArray(row.completed) ||
        row.completed.length > 20 ||
        row.completed.some((id) => !ID.test(id) || !allowed.has(id)) ||
        new Set(row.completed).size !== row.completed.length ||
        !Number.isFinite(row.updatedAt)
      )
        throw invalid();
      seen.add(key);
      return {
        documentId: row.documentId,
        type: row.type,
        completed: [...row.completed],
        updatedAt: row.updatedAt,
      };
    }),
  };
}
export function readLearningProgress(storage = localStorage) {
  let raw;
  try {
    raw = storage.getItem(LEARNING_PROGRESS_KEY);
  } catch {
    throw invalid();
  }
  if (raw === null) return validateLearningProgress(null);
  try {
    return validateLearningProgress(JSON.parse(raw));
  } catch (error) {
    if (error.message.includes("unreadable")) throw error;
    throw invalid();
  }
}
export function progressFor(value, documentId, type) {
  const row = validateLearningProgress(value).documents.find(
    (candidate) =>
      candidate.documentId === documentId && candidate.type === type,
  );
  return row ? [...row.completed] : [];
}
export function saveChecklistProgress(
  documentId,
  type,
  completed,
  storage = localStorage,
  now = Date.now,
) {
  const current = readLearningProgress(storage),
    documents = current.documents.filter(
      (row) => !(row.documentId === documentId && row.type === type),
    ),
    next = validateLearningProgress({
      version: 1,
      documents: [
        ...documents,
        { documentId, type, completed: [...completed], updatedAt: now() },
      ].slice(-50),
    });
  try {
    storage.setItem(LEARNING_PROGRESS_KEY, JSON.stringify(next));
  } catch {
    throw new Error(
      "Checklist progress could not be saved. The previous record is unchanged; export the checklist now if needed.",
    );
  }
  return next;
}
import { checklist } from "./model.js";

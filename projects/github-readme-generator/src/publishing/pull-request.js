import { target } from "./validation.js";

export const PULL_REQUEST_JOURNAL_KEY = "readme-studio-pull-request-journal-v1";
const SHA = /^[a-f0-9]{40,64}$/;

const malformed = () =>
  new Error(
    "The pull request recovery journal is malformed. Preserve it before clearing recovery data.",
  );

export function pullRequestInput(value) {
  const repository = target({
    repository: value?.repository,
    branch: value?.head,
    path: "README.md",
  }).repository;
  target({ repository, branch: value?.base, path: "README.md" });
  if (value.head === value.base)
    throw new Error("Choose different head and base branches.");
  if (!SHA.test(value.headSha || "") || !SHA.test(value.baseSha || ""))
    throw new Error("Reload the exact head and base SHAs before continuing.");
  if (
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 256 ||
    /[\x00-\x1f\x7f]/.test(value.title)
  )
    throw new Error("Enter a pull request title of 1–256 characters.");
  if (
    typeof value.body !== "string" ||
    new TextEncoder().encode(value.body).length > 65_536
  )
    throw new Error("Pull request notes must be 65 KB or less.");
  if (value.confirmed !== true)
    throw new Error("Review and confirm this exact draft pull request first.");
  return {
    repository,
    head: value.head,
    base: value.base,
    headSha: value.headSha,
    baseSha: value.baseSha,
    title: value.title.trim(),
    body: value.body,
    confirmed: true,
  };
}

function checked(value) {
  if (
    value?.version !== 1 ||
    !Number.isFinite(value.createdAt) ||
    !["pending", "unknown", "created"].includes(value.status)
  )
    throw malformed();
  if (
    value.body === undefined &&
    (!Number.isSafeInteger(value.bodyBytes) ||
      value.bodyBytes < 0 ||
      value.bodyBytes > 65_536)
  )
    throw malformed();
  const input = pullRequestInput({
    ...value,
    body:
      typeof value.body === "string" ? value.body : " ".repeat(value.bodyBytes),
    confirmed: true,
  });
  if (
    value.status === "created" &&
    (!Number.isSafeInteger(value.number) ||
      value.number < 1 ||
      typeof value.url !== "string" ||
      !value.url.startsWith("https://github.com/"))
  )
    throw malformed();
  return {
    version: 1,
    repository: input.repository,
    head: input.head,
    base: input.base,
    headSha: input.headSha,
    baseSha: input.baseSha,
    title: input.title,
    bodyBytes: value.bodyBytes ?? new TextEncoder().encode(input.body).length,
    createdAt: value.createdAt,
    status: value.status === "pending" ? "unknown" : value.status,
    ...(value.status === "created"
      ? { number: value.number, url: value.url }
      : {}),
  };
}

function save(value, storage) {
  try {
    storage.setItem(PULL_REQUEST_JOURNAL_KEY, JSON.stringify(value));
  } catch {
    throw new Error(
      "Pull request recovery could not be saved locally. Nothing was sent; free browser storage first.",
    );
  }
  return value;
}

export function readPullRequestJournal(storage = localStorage) {
  const raw = rawPullRequestJournal(storage);
  if (raw === null) return null;
  try {
    return checked(JSON.parse(raw));
  } catch (error) {
    if (error.message.includes("malformed")) throw error;
    throw malformed();
  }
}

export function rawPullRequestJournal(storage = localStorage) {
  try {
    return storage.getItem(PULL_REQUEST_JOURNAL_KEY);
  } catch {
    throw new Error(
      "The pull request recovery journal cannot be read. Remote PR creation is blocked.",
    );
  }
}

export function startPullRequestJournal(
  input,
  storage = localStorage,
  now = Date.now,
) {
  if (readPullRequestJournal(storage))
    throw new Error(
      "An earlier pull request operation is unsettled. Reconcile it before creating another PR.",
    );
  const checkedInput = pullRequestInput(input);
  return save(
    checked({
      version: 1,
      ...checkedInput,
      createdAt: now(),
      status: "pending",
    }),
    storage,
  );
}

export function completePullRequestJournal(
  journal,
  result,
  storage = localStorage,
) {
  return save(
    checked({
      ...journal,
      status: "created",
      number: result.number,
      url: result.url,
      body: "".padEnd(journal.bodyBytes),
    }),
    storage,
  );
}

export function clearPullRequestJournal(storage = localStorage) {
  try {
    storage.removeItem(PULL_REQUEST_JOURNAL_KEY);
  } catch {
    throw new Error("The pull request recovery journal could not be cleared.");
  }
}

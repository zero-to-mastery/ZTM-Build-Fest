import { documentTarget } from "./documents.js";

export const WORKSET_VERSION = 1;
export const WORKSET_LIMIT = 50;
export const WORKSET_REPOSITORY_LIMIT = 100;

const repositoryPattern =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;

const identifier = () => crypto.randomUUID();

export const emptyWorksets = () => ({ version: WORKSET_VERSION, items: [] });

export function normalizeRepository(value) {
  const repository = String(value || "").trim();
  if (
    !repositoryPattern.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  )
    throw Error("Use a repository in owner/name format.");
  return repository.toLowerCase();
}

function uniqueName(value, existing) {
  const base = String(value || "")
    .trim()
    .slice(0, 80);
  if (!base) throw Error("Name this repository workset.");
  const names = new Set(existing.map((item) => item.name.toLowerCase()));
  let name = base;
  let suffix = 2;
  while (names.has(name.toLowerCase())) {
    const ending = ` (${suffix++})`;
    name = `${base.slice(0, 80 - ending.length)}${ending}`;
  }
  return name;
}

function validItem(value, existing, preserveIds) {
  if (!value || typeof value !== "object") throw Error("Invalid workset.");
  const repositories = [
    ...new Set(
      (Array.isArray(value.repositories) ? value.repositories : []).map(
        normalizeRepository,
      ),
    ),
  ];
  if (!repositories.length)
    throw Error("A repository workset must contain at least one repository.");
  if (repositories.length > WORKSET_REPOSITORY_LIMIT)
    throw Error(
      `A repository workset can contain at most ${WORKSET_REPOSITORY_LIMIT} repositories.`,
    );
  return {
    id:
      preserveIds &&
      typeof value.id === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/.test(value.id)
        ? value.id
        : identifier(),
    name: uniqueName(value.name, existing),
    repositories,
  };
}

export function validateWorksets(value, { preserveIds = true } = {}) {
  if (value == null) return emptyWorksets();
  if (value.version !== WORKSET_VERSION || !Array.isArray(value.items))
    throw Error("Unsupported repository workset version.");
  if (value.items.length > WORKSET_LIMIT)
    throw Error(`A workspace can contain at most ${WORKSET_LIMIT} worksets.`);
  const items = [];
  const ids = new Set();
  for (const candidate of value.items) {
    const item = validItem(candidate, items, preserveIds);
    if (ids.has(item.id)) item.id = identifier();
    ids.add(item.id);
    items.push(item);
  }
  return { version: WORKSET_VERSION, items };
}

export function recoverWorksets(value) {
  if (
    !value ||
    value.version !== WORKSET_VERSION ||
    !Array.isArray(value.items)
  )
    return emptyWorksets();
  const items = [];
  const ids = new Set();
  for (const candidate of value.items.slice(0, WORKSET_LIMIT)) {
    try {
      const item = validItem(candidate, items, true);
      if (ids.has(item.id)) item.id = identifier();
      ids.add(item.id);
      items.push(item);
    } catch {
      // The original workspace bytes remain available in the recovery file.
    }
  }
  return { version: WORKSET_VERSION, items };
}

export function saveWorkset(library, value) {
  const current = validateWorksets(library);
  if (current.items.length >= WORKSET_LIMIT)
    throw Error(`A workspace can contain at most ${WORKSET_LIMIT} worksets.`);
  return {
    version: WORKSET_VERSION,
    items: [...current.items, validItem(value, current.items, false)],
  };
}

export function removeWorkset(library, id) {
  const current = validateWorksets(library);
  return {
    ...current,
    items: current.items.filter((item) => item.id !== id),
  };
}

export function repositoryIndex(drafts) {
  const result = new Map();
  for (const draft of drafts || []) {
    const target = documentTarget(draft);
    if (!target) continue;
    const repository = normalizeRepository(target.repository);
    if (!result.has(repository)) result.set(repository, []);
    result.get(repository).push(draft);
  }
  return result;
}

export function resolveWorkset(workset, drafts) {
  const index = repositoryIndex(drafts);
  return workset.repositories.map((repository) => ({
    repository,
    documents: index.get(repository) || [],
  }));
}

export function createWorksetPack(library, ids) {
  const current = validateWorksets(library);
  const selected = ids
    ? current.items.filter((item) => ids.includes(item.id))
    : current.items;
  if (!selected.length) throw Error("Choose at least one workset to export.");
  return {
    kind: "readme-studio-repository-worksets",
    version: WORKSET_VERSION,
    createdAt: new Date().toISOString(),
    worksets: selected.map(({ name, repositories }) => ({
      name,
      repositories: [...repositories],
    })),
  };
}

export function validateWorksetPack(value) {
  if (!value || value.kind !== "readme-studio-repository-worksets")
    throw Error("This is not a README Studio repository workset file.");
  let worksets;
  if (value.version === 0 && Array.isArray(value.sets)) {
    worksets = value.sets.map((item) => ({
      name: item?.title,
      repositories: item?.repos,
    }));
  } else if (
    value.version === WORKSET_VERSION &&
    Array.isArray(value.worksets)
  ) {
    worksets = value.worksets;
  } else throw Error("Unsupported repository workset file version.");
  return validateWorksets(
    { version: WORKSET_VERSION, items: worksets },
    { preserveIds: false },
  );
}

export function importWorksets(current, pack) {
  const local = validateWorksets(current);
  const incoming = validateWorksetPack(pack);
  if (local.items.length + incoming.items.length > WORKSET_LIMIT)
    throw Error(`Import would exceed the ${WORKSET_LIMIT}-workset limit.`);
  const items = [...local.items];
  for (const candidate of incoming.items)
    items.push(validItem(candidate, items, false));
  return { version: WORKSET_VERSION, items };
}

export function mergeWorksets(current, incoming) {
  const local = validateWorksets(current);
  const other = validateWorksets(incoming);
  if (local.items.length + other.items.length > WORKSET_LIMIT)
    throw Error(`Merged workspace exceeds the ${WORKSET_LIMIT}-workset limit.`);
  const items = [...local.items];
  for (const candidate of other.items)
    items.push(validItem(candidate, items, false));
  return { version: WORKSET_VERSION, items };
}

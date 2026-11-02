import { target } from "../publishing/validation.js";

export function documentTarget(draft) {
  const metadata = draft.metadata || {};
  const source = metadata.importSource;
  const candidate =
    metadata.workspaceDocument &&
    Object.hasOwn(metadata.workspaceDocument, "target")
      ? metadata.workspaceDocument.target
      : (metadata.publishing?.readme ??
        (source?.owner && source?.repository
          ? {
              repository: `${source.owner}/${source.repository}`,
              branch: source.ref,
              path: source.readmePath || "README.md",
            }
          : null));
  try {
    return candidate ? target(candidate) : null;
  } catch {
    return null;
  }
}
export function documentGroup(draft) {
  const kind = draft.metadata?.workspaceDocument?.kind;
  if (["profile", "repository", "local"].includes(kind)) return kind;
  const destination = documentTarget(draft);
  if (!destination) return "local";
  const [owner, repository] = destination.repository.toLowerCase().split("/");
  return owner === repository ? "profile" : "repository";
}
export function targetIdentity(value) {
  if (!value) return "";
  return JSON.stringify([
    value.repository.toLowerCase(),
    value.branch,
    value.path,
  ]);
}
export function findDocument(drafts, destination) {
  const identity = targetIdentity(destination);
  return identity
    ? drafts.find((draft) => targetIdentity(documentTarget(draft)) === identity)
    : undefined;
}
export function documentSettings(kind, destination, localization = null) {
  if (!["profile", "repository", "local"].includes(kind))
    throw Error("Choose a document group.");
  return {
    version: 1,
    kind,
    target: kind === "local" ? null : target(destination),
    ...(localization ? { localization: structuredClone(localization) } : {}),
  };
}
export const documentGroups = {
  profile: "Profile",
  repository: "Repositories",
  local: "Local documents",
};

// Histories are tab-session state, never project exports. Bound total retained
// history across inactive documents as well as each Store's existing limits.
export class DocumentHistories {
  constructor(limit = 32_000_000) {
    this.limit = limit;
    this.items = new Map();
  }
  remember(store) {
    this.items.delete(store.draft.id);
    this.items.set(store.draft.id, {
      markdown: store.draft.markdown,
      past: store.past,
      future: store.future,
    });
    let bytes = 0;
    for (const [id, item] of [...this.items].reverse()) {
      bytes +=
        item.markdown.length * 2 +
        [...item.past, ...item.future].reduce(
          (sum, draft) => sum + store.historySize(draft),
          0,
        );
      if (bytes > this.limit) this.items.delete(id);
    }
  }
  restore(store, drafts) {
    const ids = new Set(drafts.map((draft) => draft.id));
    for (const id of this.items.keys()) if (!ids.has(id)) this.items.delete(id);
    const item = this.items.get(store.draft.id);
    this.items.delete(store.draft.id);
    if (item?.markdown !== store.draft.markdown) return;
    store.past = item.past;
    store.future = item.future;
    store.trimHistory();
  }
}

import { documentTarget, targetIdentity } from "../workspace/documents.js";
import { localizationFor, validateLocalization } from "./metadata.js";

export function validateLocalizationGraph(drafts) {
  const targets = new Map();
  const editions = new Set();
  for (const draft of drafts) {
    const raw = draft?.metadata?.workspaceDocument?.localization;
    const localization = raw === undefined ? null : validateLocalization(raw);
    // Earlier schema-1 releases allowed ordinary documents to share a target.
    // Preserve those pairs, but a localized edition must be unique against
    // every document so it cannot publish over an existing target.
    const target = targetIdentity(documentTarget(draft));
    if (target) {
      const localized = !!localization;
      if (targets.has(target) && (targets.get(target) || localized))
        throw Error(
          "Two localized documents use the same repository, branch and path.",
        );
      targets.set(target, targets.get(target) || false || localized);
    }
    if (!localization?.sourceDocumentId) continue;
    const edition = `${localization.sourceDocumentId}\0${localization.locale}`;
    if (editions.has(edition))
      throw Error("A source document has two editions for the same language.");
    editions.add(edition);
    const source = drafts.find(
      (candidate) => candidate.id === localization.sourceDocumentId,
    );
    // A standalone project may retain an unresolved workspace link. It is an
    // explicit unavailable state until the author reconnects a source.
    if (source && localizationFor(source)?.sourceDocumentId)
      throw Error(
        "A translation cannot use another translation as its source edition.",
      );
  }
  return drafts;
}

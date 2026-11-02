import { detectSections, normalizeHeading } from "../markdown/sections.js";
import { sourceDigest } from "../state/source-digest.js";
import { documentTarget, targetIdentity } from "../workspace/documents.js";
import {
  languages,
  localizationFor,
  validateLocalization,
} from "./metadata.js";
export {
  languages,
  localizationFor,
  validateLocalization,
  validateSourceSnapshot,
} from "./metadata.js";
const languageIds = new Set(languages.map(([id]) => id));
export const LOCALIZATION_SOURCE_LIMIT = 1_000_000;

export function sourceSnapshot(source) {
  const exact = String(source);
  if (new TextEncoder().encode(exact).length > LOCALIZATION_SOURCE_LIMIT)
    throw Error(
      "Language revision tracking is limited to 1 MB of UTF-8 Markdown.",
    );
  const sections = detectSections(exact, {
    levels: [1, 2, 3, 4, 5, 6],
  });
  const identities = sections.map((section) =>
    sourceDigest(
      section.level === 0
        ? "preamble"
        : `${section.level}\0${normalizeHeading(section.title) || "untitled"}`,
    ),
  );
  const counts = new Map();
  for (const identity of identities)
    counts.set(identity, (counts.get(identity) || 0) + 1);
  return {
    version: 1,
    revision: sourceDigest(exact),
    truncated: sections.length > 100,
    sections: sections.slice(0, 100).map((section, order) => ({
      identity: identities[order],
      level: section.level,
      order,
      hash: sourceDigest(section.source),
      ambiguous: counts.get(identities[order]) > 1,
    })),
  };
}

export function localizationSettings(
  locale,
  sourceDraft = null,
  ownSource = "",
) {
  if (!languageIds.has(locale)) throw Error("Choose a supported language.");
  if (localizationFor(sourceDraft)?.sourceDocumentId)
    throw Error("Choose a source edition, not another translation.");
  return {
    version: 1,
    locale,
    sourceDocumentId: sourceDraft?.id || null,
    source: sourceSnapshot(sourceDraft?.markdown ?? ownSource),
  };
}

export function localizationCollision(drafts, activeId, settings) {
  const identity = targetIdentity(settings.target);
  if (
    identity &&
    drafts.some(
      (draft) =>
        draft.id !== activeId &&
        targetIdentity(documentTarget(draft)) === identity,
    )
  )
    return "Another workspace document already uses this repository, branch and path.";
  const localization = settings.localization;
  if (
    localization?.sourceDocumentId &&
    drafts.some(
      (draft) =>
        draft.id !== activeId &&
        localizationFor(draft)?.sourceDocumentId === activeId,
    )
  )
    return "A source edition with linked translations cannot become a translation.";
  if (!localization?.sourceDocumentId) return "";
  const duplicate = drafts.some((draft) => {
    if (draft.id === activeId) return false;
    const other = localizationFor(draft);
    return (
      other?.locale === localization.locale &&
      other.sourceDocumentId === localization.sourceDocumentId
    );
  });
  return duplicate
    ? "That source document already has an edition for this language."
    : "";
}

export function translationReview(sourceDraft, translationDraft) {
  const localization = validateLocalization(
    translationDraft?.metadata?.workspaceDocument?.localization,
  );
  if (!localization?.sourceDocumentId)
    throw Error("Choose a source document for this language edition.");
  if (localization.sourceDocumentId !== sourceDraft?.id)
    throw Error("The linked source document is unavailable.");
  if (localizationFor(sourceDraft)?.sourceDocumentId)
    throw Error(
      "The linked document is itself a translation. Choose a source edition.",
    );
  const previous = localization.source;
  const current = sourceSnapshot(sourceDraft.markdown);
  const currentTitles = detectSections(String(sourceDraft.markdown), {
    levels: [1, 2, 3, 4, 5, 6],
  })
    .slice(0, 100)
    .map((section) =>
      section.level === 0 ? "Preamble" : section.title.slice(0, 200),
    );
  const previousById = new Map();
  const currentById = new Map();
  for (const item of previous.sections) {
    const items = previousById.get(item.identity) || [];
    items.push(item);
    previousById.set(item.identity, items);
  }
  for (const item of current.sections) {
    const items = currentById.get(item.identity) || [];
    items.push(item);
    currentById.set(item.identity, items);
  }
  const identities = [
    ...new Set([...previousById.keys(), ...currentById.keys()]),
  ];
  const findings = identities.flatMap((identity) => {
    const before = previousById.get(identity) || [];
    const after = currentById.get(identity) || [];
    if (
      before.length > 1 ||
      after.length > 1 ||
      before[0]?.ambiguous ||
      after[0]?.ambiguous
    )
      return [
        {
          identity,
          title: after[0]
            ? currentTitles[after[0].order]
            : "Previously reviewed section",
          status: "unknown",
          reason:
            "Repeated or missing section identity prevents a safe automatic match.",
        },
      ];
    if (before.length === 0)
      return [
        {
          identity,
          title: currentTitles[after[0].order],
          status: "added",
          reason: "Added after the last translation review.",
        },
      ];
    if (after.length === 0)
      return [
        {
          identity,
          title: `Removed source section ${before[0].order + 1}`,
          status: "removed",
          reason: "Removed after the last translation review.",
        },
      ];
    if (before[0].hash !== after[0].hash)
      return [
        {
          identity,
          title: currentTitles[after[0].order],
          status: "changed",
          reason:
            "Exact source bytes changed after the last translation review.",
        },
      ];
    if (before[0].order !== after[0].order)
      return [
        {
          identity,
          title: currentTitles[after[0].order],
          status: "reordered",
          reason: "The unchanged section moved in source order.",
        },
      ];
    return [
      {
        identity,
        title: currentTitles[after[0].order],
        status: "unchanged",
        reason: "Exact section bytes and order match the reviewed revision.",
      },
    ];
  });
  if (previous.truncated || current.truncated)
    findings.push({
      identity: "truncated",
      title: "Additional sections",
      status: "unknown",
      reason: "Only the first 100 sections are compared.",
    });
  return {
    previousRevision: previous.revision,
    currentRevision: current.revision,
    changed: previous.revision !== current.revision,
    findings,
    nextLocalization: { ...localization, source: current },
  };
}

export function languageAwareness(locale, source) {
  if (!languageIds.has(locale)) throw Error("Choose a supported language.");
  const snapshot = sourceSnapshot(source);
  const headings = snapshot.sections.filter((section) => section.level > 0);
  const ambiguous = headings.some((heading) => heading.ambiguous);
  return {
    locale,
    structural: [
      {
        label: "Document headings",
        status: headings.length ? "observed" : "not-detected",
        detail: headings.length
          ? `${headings.length} rendered heading${headings.length === 1 ? "" : "s"} observed.`
          : "No rendered heading was detected.",
      },
      {
        label: "Unique section identity",
        status: ambiguous ? "unknown" : "observed",
        detail: ambiguous
          ? "Repeated normalized headings make section identity ambiguous."
          : "No repeated normalized heading identity was detected.",
      },
    ],
    languageSensitive:
      locale === "en"
        ? {
            status: "available",
            detail:
              "English wording heuristics are available in README Health, but remain advisory.",
          }
        : {
            status: "unknown",
            detail:
              "English wording and conventional-section heuristics are Unknown for this language. Structural, link, media and source checks remain available.",
          },
  };
}

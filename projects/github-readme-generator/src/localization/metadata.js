export const languages = [
  ["en", "English"],
  ["es", "Spanish · Español"],
  ["fr", "French · Français"],
  ["de", "German · Deutsch"],
  ["pt-BR", "Portuguese (Brazil) · Português"],
  ["ja", "Japanese · 日本語"],
  ["zh-CN", "Chinese (Simplified) · 简体中文"],
  ["ko", "Korean · 한국어"],
];

const languageIds = new Set(languages.map(([id]) => id));
const HASH = /^sha256:[a-f\d]{64}$/;
const text = (value, max) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value);

export function validateSourceSnapshot(value) {
  if (
    !value ||
    value.version !== 1 ||
    !HASH.test(value.revision) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.sections) ||
    value.sections.length > 100
  )
    throw Error("Localized source revision is unreadable.");
  const sections = value.sections.map((section, order) => {
    if (
      !section ||
      !HASH.test(section.identity) ||
      !Number.isInteger(section.level) ||
      section.level < 0 ||
      section.level > 6 ||
      section.order !== order ||
      !HASH.test(section.hash) ||
      typeof section.ambiguous !== "boolean"
    )
      throw Error("Localized source revision is unreadable.");
    return {
      identity: section.identity,
      level: section.level,
      order,
      hash: section.hash,
      ambiguous: section.ambiguous,
    };
  });
  return {
    version: 1,
    revision: value.revision,
    truncated: value.truncated,
    sections,
  };
}

export function validateLocalization(value) {
  if (!value) return null;
  if (
    value.version !== 1 ||
    !languageIds.has(value.locale) ||
    !(value.sourceDocumentId === null || text(value.sourceDocumentId, 200))
  )
    throw Error("Localized document settings are unreadable.");
  return {
    version: 1,
    locale: value.locale,
    sourceDocumentId: value.sourceDocumentId,
    source: validateSourceSnapshot(value.source),
  };
}

export function localizationFor(draft) {
  try {
    return validateLocalization(
      draft?.metadata?.workspaceDocument?.localization,
    );
  } catch {
    return null;
  }
}

import { validateContext } from "./context.js";

const STOP_WORDS = new Set(
  "a an and are as at be been but by can for from has have if in into is it its may more of on only or our than that the their then these this those to use used using was we were will with without you your".split(
    " ",
  ),
);
const CONTEXT_LABELS = Object.freeze({
  profile: "Profile facts",
  metadata: "Project metadata",
  projectType: "Project type",
  repository: "Repository facts",
  stack: "Repository stack evidence",
  section: "README section",
});
export const MAX_CLAIM_FINDINGS = 25;
const MAX_TERMS_PER_FINDING = 8;

function terms(value) {
  return [
    ...String(value)
      .toLocaleLowerCase()
      .matchAll(
        /https?:\/\/[^\s)\]}]+|\b\d[\d,.]*\b|[\p{L}\p{N}][\p{L}\p{N}_+.#/-]*/gu,
      ),
  ]
    .map(([term]) => term.replace(/[.,;:!?]+$/, ""))
    .filter(
      (term) =>
        /^https?:/.test(term) ||
        /^\d/.test(term) ||
        (term.length >= 4 && !STOP_WORDS.has(term)),
    );
}

function statements(markdown) {
  return String(markdown)
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^\s*(?:[-*+] |#{1,6} |\d+[.)] )/, "").trim())
    .filter(Boolean);
}

function normalized(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function maskHtmlDeletions(value) {
  const source = String(value);
  const opening = /<\s*(?:del|s)\b/i.exec(source);
  return opening ? source.slice(0, opening.index) : source;
}

function activeEvidence(value) {
  const source = maskHtmlDeletions(value);
  const tilde = source.indexOf("~");
  return tilde < 0 ? source : source.slice(0, tilde);
}

export function reviewClaims(proposed, input) {
  const context = validateContext(input.context || []).filter(
    (entry) => entry.id !== "style",
  );
  const sources = [
    ...(input.original?.trim()
      ? [{ label: "Original", content: input.original }]
      : []),
    ...(input.notes?.trim() ? [{ label: "Notes", content: input.notes }] : []),
    ...context.map((entry) => ({
      label: CONTEXT_LABELS[entry.id] || entry.id,
      content: entry.content,
    })),
  ];
  const evidenceTerms = new Set(
    terms(sources.map((s) => s.content).join("\n")),
  );
  const evidenceStatements = new Set(
    sources.flatMap((source) =>
      statements(activeEvidence(source.content)).map((text) =>
        normalized(text),
      ),
    ),
  );
  const unsupported = [];
  let unsupportedCount = 0;
  for (const text of statements(proposed)) {
    const statement = normalized(text);
    if (statement && evidenceStatements.has(statement)) continue;
    const claimTerms = [...new Set(terms(text))];
    const novel = claimTerms.filter((term) => !evidenceTerms.has(term));
    unsupportedCount++;
    if (unsupported.length < MAX_CLAIM_FINDINGS)
      unsupported.push({
        text,
        terms: novel.slice(0, MAX_TERMS_PER_FINDING),
        reason: novel.length
          ? `unmatched terms: ${novel.slice(0, MAX_TERMS_PER_FINDING).join(", ")}${novel.length > MAX_TERMS_PER_FINDING ? "…" : ""}`
          : "statement is not present in any single approved source",
      });
  }
  return {
    evidence: sources.map((source) => source.label),
    unsupported,
    unsupportedCount,
    omitted: unsupportedCount - unsupported.length,
  };
}

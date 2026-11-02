// The exact term lookup of the atlas query file (ADR 0170, ADR 0171), the same
// algorithm as `openblog_core::atlas_query::normalize_term` and checked against
// the same fixtures (tests/fixtures/atlas-lookup.json) by both sides.
//
// A term is the text split on Unicode White_Space, joined with one space and
// lowercased. That is all: no normalization form (so a composed and a
// decomposed spelling are different terms), no case folding beyond the default
// lowercase conversion, no stemming, no translation, no fuzzy matching. The
// White_Space set is written out because JavaScript's `\s` differs from it: it
// leaves out U+0085 and adds U+FEFF.
//
// Pure functions of their arguments: nothing here reads a page, fetches or
// stores anything.

/** The Unicode White_Space property, as code points. */
export const WHITE_SPACE = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** A term as `/atlas-query.json` indexes it. */
export function normalizeTerm(text) {
  return String(text ?? "")
    .split(WHITE_SPACE)
    .filter((word) => word !== "")
    .join(" ")
    .toLowerCase();
}

const indexes = new WeakMap();

function indexOf(query) {
  let index = indexes.get(query);
  if (!index) {
    index = {
      terms: new Map((Array.isArray(query?.terms) ? query.terms : []).map((t) => [t.term, t.entries])),
      entries: new Map((Array.isArray(query?.entries) ? query.entries : []).map((e) => [e.id, e])),
    };
    indexes.set(query, index);
  }
  return index;
}

/**
 * Every entry whose label or alias is this text once normalized, in id order.
 * Two entries sharing a term are both returned: nothing chooses between them.
 */
export function lookupTerm(query, text) {
  if (!query || typeof query !== "object") return [];
  const index = indexOf(query);
  return (index.terms.get(normalizeTerm(text)) || []).map((id) => index.entries.get(id)).filter(Boolean);
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The entry id a concept link's destination names (ADR 0172), or null: `atlas:` and a lowercase
 * slug of at most 64 bytes, the same rule as `openblog_core::concept_links::entry_id`, checked
 * against tests/fixtures/concept-links.json. The author writes `[label](atlas:the-id)`.
 */
export function conceptEntryId(destination) {
  const text = String(destination ?? "");
  if (!text.startsWith("atlas:")) return null;
  const id = text.slice("atlas:".length);
  return id.length <= 64 && ID.test(id) ? id : null;
}

// The atlas term lookup is one algorithm in two languages (ADR 0171): these tests read the same
// fixtures as crates/openblog-core/tests/atlas_query.rs, including the cases where JavaScript's own
// `\s` and Unicode White_Space disagree (U+0085, U+FEFF) and where composed and decomposed text
// must stay different.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { conceptEntryId, lookupTerm, normalizeTerm } from "../../web/components/atlas-terms.js";

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/atlas-lookup.json", import.meta.url), "utf8"));

test("normalizeTerm agrees with the shared fixtures", () => {
  assert.ok(fixtures.normalize.length >= 15);
  for (const { name, input, expected } of fixtures.normalize) {
    assert.equal(normalizeTerm(input), expected, name);
  }
});

test("lookupTerm finds exactly what the fixtures say, over a query file built from the same entries", () => {
  const entries = fixtures.lookup.entries.map((e) => ({ id: e.id, label: e.label }));
  const byTerm = new Map();
  for (const e of fixtures.lookup.entries) {
    for (const text of [e.label, ...(e.aliases || [])]) {
      const term = normalizeTerm(text);
      if (!byTerm.has(term)) byTerm.set(term, new Set());
      byTerm.get(term).add(e.id);
    }
  }
  const query = {
    entries,
    terms: [...byTerm].map(([term, ids]) => ({ term, entries: [...ids].sort() })),
  };
  for (const { query: text, ids } of fixtures.lookup.cases) {
    assert.deepEqual(lookupTerm(query, text).map((e) => e.id), ids, JSON.stringify(text));
  }
  assert.deepEqual(lookupTerm(null, "x"), []);
  assert.deepEqual(lookupTerm({}, "x"), []);
});

test("the white space set is Unicode White_Space, written out", () => {
  // JavaScript's \s would split on U+FEFF and keep U+0085 whole; the lookup must do neither.
  assert.equal(/\s/u.test("\u0085"), false);
  assert.equal(/\s/u.test("\ufeff"), true);
  assert.equal(normalizeTerm("a\u0085b"), "a b");
  assert.equal(normalizeTerm("a\ufeffb"), "a\ufeffb");
});

// The concept link syntax (ADR 0172, #73): the same destination cases the Rust build resolves.
const concepts = JSON.parse(readFileSync(new URL("../fixtures/concept-links.json", import.meta.url), "utf8"));

test("conceptEntryId agrees with the shared concept link fixtures", () => {
  assert.ok(concepts.destinations.length >= 10);
  for (const { name, destination, id } of concepts.destinations) {
    assert.equal(conceptEntryId(destination), id, name);
  }
  assert.equal(conceptEntryId(undefined), null);
});

test("a term looked up in prose and a concept id are different things", () => {
  // Writing a label never links it: only an explicit atlas: destination does.
  assert.equal(conceptEntryId("Plato"), null);
  assert.equal(conceptEntryId(normalizeTerm("Plato")), null);
});

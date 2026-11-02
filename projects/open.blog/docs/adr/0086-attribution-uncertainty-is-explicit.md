# ADR 0086: Attribution uncertainty and anonymity are explicit

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#52](https://github.com/journey-to-code-org/open.blog/issues/52)
- Parent story: [#22](https://github.com/journey-to-code-org/open.blog/issues/22)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0009](0009-research-source-library-identity.md),
  [ADR 0054](0054-attributed-evidence-based-relationships.md)
- Contract: [Research source library format](../specs/research-source-library.md)

## Context

Many sources a writer compares do not say who made them. Some works are anonymous; others are
transmitted under a name scholars doubt or dispute, and a manuscript's scribe is often unknown.
ADR 0009 records creators as plain names with a role, so "Aristotle, author" could not be told
apart from "attributed to Aristotle, disputed", and a work with no creators could mean either
"anonymous" or "not filled in yet". The Knowledge Atlas (ADR 0054) already refuses to infer or
rank scholarly positions; the source library should not imply certainty it does not have.

## Decision

- A creator may carry **`attribution`**: `stated` (the source names this person), `attributed`
  (tradition or scholarship assigns the name), `uncertain` (the author is unsure), or `disputed`
  (scholars disagree), and an optional one-line **`note`**, such as who disputes it. An absent
  value says nothing either way and stays absent; nothing is inferred or rewritten.
- A work, edition, translation, or witness may be **`anonymous`**: the source names no maker
  for it. A reference cannot be. An anonymous record may still list names that tradition or
  scholarship assigns, but a creator in the record's maker role (author of a work, editor of an
  edition, translator of a translation, scribe of a witness) whose attribution is stated or
  unqualified contradicts it and is refused as `conflicting-attribution`. Other roles, such as
  the named editor of an anonymous work's edition, are no contradiction.
- Interpreters of an interpretation (ADR 0087) use the same certainty values and the same
  anonymity rule.
- These are the author's records. No value is a finding, no code chooses between attributions,
  and none of them is published by this decision; `public_reference` still lists only names and
  roles.

## Consequences

- "Anonymous", "not recorded", and "disputed" are three distinguishable states, so comparison
  and publication can attribute honestly without inventing an author.
- A library that never uses these fields is unchanged.
- BibTeX cannot express any of this and reports it as a loss; CSL JSON carries it inside the
  open.blog creator envelope.

## Domain language

**Attribution certainty** and **Anonymous source** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

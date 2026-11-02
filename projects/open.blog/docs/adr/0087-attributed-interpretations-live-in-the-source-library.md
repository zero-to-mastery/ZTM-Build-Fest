# ADR 0087: Attributed interpretations live beside the library's records

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#52](https://github.com/journey-to-code-org/open.blog/issues/52)
- Parent story: [#22](https://github.com/journey-to-code-org/open.blog/issues/22)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0003](0003-contributor-identity-and-orcid-provenance.md),
  [ADR 0009](0009-research-source-library-identity.md),
  [ADR 0010](0010-private-source-library-storage.md),
  [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0042](0042-citation-keys-are-source-identifiers.md),
  [ADR 0056](0056-one-lock-order-and-cross-store-research-guards.md)
- Contract: [Research source library format](../specs/research-source-library.md)

## Context

A writer comparing versions also compares interpretations: their own rendering of a line, a
scholar's reading of a passage, an anonymous gloss in a manuscript. Each needs provenance: who
made it and from which exact text and place. A published translation is already a library
`translation` record with descriptive creators, but a rendering of one passage is not a
published version and must not become one. Story #22 requires translators and interpreters to be
attributed; issue #52 requires attribution to reuse contributor identity without turning credits
into citations. Contributor credits (ADR 0003) say who made a post; library creators are
descriptive names and may never name a contributor (ADR 0009). B7.1 (#88) will later add
evidence, audience levels, and AI provenance to scholarly interpretations.

## Decision

- **Where.** Interpretations are a top-level `interpretations` array in the source library file,
  beside `sources`. They share its version, revision, lock, atomic write, 4 MiB limit, and
  all-or-nothing validation, and reading them needs no new store or lock. An absent or empty
  array is written as no field, so existing libraries are unchanged.
- **What.** An interpretation has a stable `id` (a slug distinct from every source identifier,
  so a citation key can never name one), a `kind` of `rendering` (a translation of one located
  place into another language) or `reading` (what a place means), a `source`, notebook
  `locators` (up to eight), a `language`, the `text`, `interpreters`, and optionally
  `anonymous`, `rights` (ADR 0085), and a one-line `uncertainty`. Unknown fields are kept at
  every level.
- **Provenance names an exact text.** `source` must be an edition, translation, or witness; a
  reading may also be of a work. A reference is refused (point at its version and give the place
  as locators), and so is a rendering of a work, which has no text of its own. Pages cannot
  address a work and folios need a witness, as for passages. A rendering needs a language and at
  least one locator. A rendering made from a translation names that translation, so an indirect
  translation is visible as such.
- **Attribution reuses contributor identity.** Each interpreter is exactly one of
  `{ "contributor": key }`, a key that must exist in the site's contributor registry, or
  `{ "name": text }` for anyone else, with an optional attribution certainty (ADR 0086). An
  interpretation with no interpreters must be marked `anonymous`. Naming a contributor here is
  attribution only: it creates no credit sidecar entry, and a contributor key is never a valid
  `source`. `interpreters[*].contributor` is the one place in the library file where the
  `contributor` field name is allowed; `credit`, `credits`, and `contributors` stay refused at
  any depth, and source records still may not name contributors.
- **Guards.** A source an interpretation uses cannot be removed (`still-used`, naming the
  interpretation ids). A contributor an interpretation names cannot be removed from the registry
  in Admin; the check reads the library under its lock and holds the lock until the registry is
  written, and an unreadable library blocks such removals but not other registry edits.
  Creating or updating an interpretation reads the registry again under the library lock, so a
  contributor removed while the change waited is never named. Refusals name ids, never
  interpretation text.
- **Private by default.** Interpretations are never sources, never cited, never part of a
  bibliography export, and no build reads them: a build parses the library with its
  interpretations kept raw and unvalidated, so a problem in one (such as an interpreter whose
  contributor was later removed by hand) never fails a build that cites a source or publishes
  claim evidence. Admin, every store change, and `openblog check` validate them in full, and
  `openblog check` counts them.
  Store functions create, update, and remove one interpretation under the library revision;
  Admin endpoints and controls arrive with the comparison workspace (#54), and publication only
  through the projection #55 will define. (Amended 2026-10-26: the comparison workspace reads
  interpretations but does not edit them; their Admin endpoints and controls moved to B7.2,
  authoring interpretations in Admin Studio, [#89](https://github.com/journey-to-code-org/open.blog/issues/89).)
  (Amended by [ADR 0092](0092-publish-approved-comparisons-as-one-rights-gated-projection.md):
  a build that publishes comparisons still reads the library with its interpretations raw,
  validates in full only the interpretations approved comparisons name, refusing the build
  with the id of one that fails, and publishes an interpretation's text only inside an
  approved comparison, through the rights gate. Any other interpretation stays unvalidated and
  never stops a build.)

## Consequences

- One file holds the versions and the interpretations made from them, so an interpretation can
  never point at a version a concurrent change removed.
- `interpretations` was an unknown library-level field name before; ADR 0084 lists every field
  name story #22 promotes. An older open.blog keeps the array as an unknown field, but refuses a
  library whose interpretations name a contributor, because its credit guard sees the
  `contributor` key. That is a refusal, not data loss. An older release whose library it can
  read does not know interpretations use sources and contributors, so it lets the author remove
  a source an interpretation uses or a contributor one names; this release then reports the
  unresolved `interpretations[n].source` or interpreter until the interpretation is changed
  (see the downgrade hazards in ADR 0084). Builds are unaffected because they never validate
  interpretations.
- A contributor registry entry referenced by an interpretation must be edited, not removed,
  until the interpretation changes.
- B7.1 can extend interpretations with evidence, levels, and AI provenance as new optional
  fields without changing their identity or attribution.

## Domain language

**Interpretation**, **Rendering**, **Reading**, and **Interpreter** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

# ADR 0084: Deepen library versions with lineage, witness identity, and volumes

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#52](https://github.com/journey-to-code-org/open.blog/issues/52)
- Parent story: [#22](https://github.com/journey-to-code-org/open.blog/issues/22)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0009](0009-research-source-library-identity.md),
  [ADR 0010](0010-private-source-library-storage.md),
  [ADR 0012](0012-source-library-interchange.md)
- Contract: [Research source library format](../specs/research-source-library.md)

## Context

Comparing editions, translations, and interpretations (#22) needs every passage to name the
exact version it comes from. ADR 0009 already keeps works, editions, translations, witnesses,
and references apart, links them with `of`, and records which text a translation was made from
with `basedOn`. Three gaps remained: an edition could not say which earlier edition it revises,
a manuscript had no structured identity beyond its title, and a page in a multi-volume edition
was ambiguous because pages restart in every volume. Later tasks (#53 alignment, #54 the
comparison workspace, #55 publication, and #193 version diagnostics) build on whatever this
model can express.

## Decision

The library format stays at version 1. Every change is an optional, additive field, so every
existing library reads, validates, and writes back byte for byte as before, and an older
open.blog keeps the new fields verbatim as unknown fields.

- **No new kinds.** A translation stays a `translation`: it is never an edition or a work, and
  an edition of a translation (`of` the translation) realizes the translation, not the work.
  `SourceLibrary::realization_chain` follows `of` from a record to its work and keeps every
  record's own kind, so a chain can be shown as reference → edition → translation → work.
- **`revises`** (edition only) names the earlier edition this one revises. The target must be an
  edition of the same text (the same `of`), and a chain of revisions may not loop. A revision of
  a translation is a new edition `of` that translation; a new translation is its own record.
  Revisions count as dependents, so a revised edition cannot be removed while a revision points
  at it.
- **`repository` and `shelfmark`** (witness only) identify one held copy. Two witnesses with the
  same repository and shelfmark are refused as a duplicate. CSL's `archive` and
  `archive_location` stay preserved CSL description and are never read as witness identity,
  because CSL uses them for where any item is kept, not for a manuscript.
- **`volumes`** (edition or witness) is the number of volumes, a whole number from 1 to 10,000.
  A reference location gains an optional **`volume`**. A `page` or `folio` location on a record
  with more than one volume must name its volume, and a numeric volume beyond the declared count
  is refused. Canonical, line, section, chapter, and timestamp locations do not depend on the
  volume. Notebook and citation locators already express volumes as the `x-csl-volume`
  extension kind, so no new locator kind is added.
- **Interchange.** CSL JSON export carries each new field in its own `custom["openblog-*"]` key
  and an import restores it, so an export still imports back unchanged. BibTeX reports each one
  in `losses`.
- **Admin.** The existing source form keeps fields it does not edit, so editing a record in
  Admin never drops them. An edited creator keeps its attribution, note, and unknown fields, and
  an edited reference location keeps its volume and unknown fields; a reference to a record in
  several volumes shows a Volume field. Other controls arrive with the comparison workspace
  (#54). (Amended 2026-10-26: the comparison workspace shipped without them; Admin controls for
  the remaining version-model fields moved to B7.2, authoring interpretations in Admin Studio,
  [#89](https://github.com/journey-to-code-org/open.blog/issues/89).)

## Consequences

- Version-specific facts (pages, volumes, folios, revisions) attach only to the version they
  belong to, and are checked offline as structure; nothing claims a revision is better or that a
  shelfmark is current.
- Story #22 promotes these previously unknown field names to defined fields: on a record
  `revises`, `repository`, `shelfmark`, `volumes`, `anonymous`, and `rights` (ADR 0085, 0086);
  on a location `volume`; on a creator `attribution` and `note` (ADR 0086); and at the library
  level `interpretations` (ADR 0087). Libraries that relied on unknown fields with these names
  and a different shape now get a field-scoped diagnostic instead of silent preservation. ADR
  0009 reserved this possibility; renaming the field resolves it.
- **Downgrade hazards.** An older open.blog keeps every promoted field verbatim as an unknown
  field when it reads and writes the library, but it does not know what they mean, so editing
  with it can leave a library this release refuses until repaired:
  - it does not count `revises` as a dependency, so it lets the author remove an edition that a
    revision names, leaving an unresolved `revises`;
  - it does not know interpretations name sources, so it lets the author remove a source an
    interpretation uses, leaving an unresolved `interpretations[n].source`, and it lets the
    registry drop a contributor an interpretation names;
  - its Admin source form rebuilds an edited reference location as `{ scheme, value }` and an
    edited creator as `{ name, role }`, dropping the location's `volume` (a page in a
    multi-volume record then needs its volume again) and the creator's `attribution` and
    `note`, which can make an anonymous record contradict itself.
  Each is reported field by field when this release reads the library again; nothing is
  silently rewritten.
- None of these fields are public. `public_reference` remains an allowlist, so a build that cites
  a source publishes none of them until a later projection (#55) decides otherwise.

## Domain language

**Revision**, **Witness identity**, **Volume**, and **Realization chain** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

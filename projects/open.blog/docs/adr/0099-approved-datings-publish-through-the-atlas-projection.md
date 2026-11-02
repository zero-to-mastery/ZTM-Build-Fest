# ADR 0099: Approved datings publish through the atlas projection, attributed, cited and side by side

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#59](https://github.com/journey-to-code-org/open.blog/issues/59)
- Parent story: [#23](https://github.com/journey-to-code-org/open.blog/issues/23)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0093](0093-uncertain-dates-are-attributed-datings-at-their-stated-precision.md),
  [ADR 0094](0094-temporal-relationships-are-relative-datings-never-inferred.md),
  [ADR 0095](0095-atlas-version-2-supersedes-bounds-and-keeps-datings-private.md),
  [ADR 0096](0096-the-chronology-index-orders-every-dating-for-display-only.md)
- Amends: [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md) (the
  projection carries datings, and `/atlas/` and entry pages show them),
  [ADR 0095](0095-atlas-version-2-supersedes-bounds-and-keeps-datings-private.md) ("nothing
  publishes datings yet" ends here)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#publication)

## Context

ADR 0095 kept every dating private until this slice and said it must add datings to
`PublicAtlas` field by field. Sites that publish their atlas lost the years their approved entries
showed from `bounds`, and `build`, `check` and Admin warn about each such entry. A published date
names real people and is easily read as fact, so it must carry who dates it, on what evidence,
how firmly and with what doubt, at exactly the precision stated, and two parties' datings of the
same birth must both be shown. B3.1 (#72) will build public queries and components on
`atlas.json`, so the data has to be reusable without parsing pages.

## Decision

- **Only projected datings, copied by an allowlist.** `PublicAtlas::project` copies the datings
  `Atlas::projected_datings` returns (approved, cited, no notebook passage, owner published, a
  relative dating's other entry approved) into `PublicDating`: `id`, `owner` and `ownerType`
  (`entry` or `relationship`), `aspect`, `date`, `text`, `placement`, `startYear` and `endYear`,
  `assertedBy` (the public party), `confidence`, `evidence` (source and public locators) and
  `note`. `date` is its own public type with exactly one form (`at`, `from`/`to`,
  `notBefore`/`notAfter`, `unknown`, or `relative` with `order`, `entry` and `aspect`), and each
  point keeps only `year`, `month`, `day`, `decade`, `century`, `circa` and `calendar`. Unknown
  fields at every level, visibility, the unsourced flag and passage ids have no place in these
  types. The projection re-checks that every dating dates a published item and points only at a
  published entry, and refuses (naming the dating id) otherwise. The sources a dating cites or is
  attributed to join `sources`.
- **The dating's note is published.** It is the author's statement of doubt and reckoning, the
  dating's equivalent of a relationship's `uncertainty`, which is already public. Hiding it would
  publish a date without its uncertainty.
- **Words and numbers both.** `text` is the core's reading of the stated value with BCE written
  out ("between c. 428 BCE and 427 BCE", "the 380s BCE", "4th century BCE", "19 Aug 14 CE
  (julian)", "unknown"); a relative dating reads "after the composition of Phaedo" with the other
  entry's published label. `placement` (`dated`, `relative`, `unknown`) and the first and last year
  an absolute dating covers (absent for an open end) let a component lay datings out without
  reimplementing precision or the missing year 0. Nothing is converted, rounded or widened.
- **One order, nothing chosen.** `datings` is in `chronology::chronological` order (the
  chronology index's display order), so the artifact never depends on file order. Competing
  datings are all present. There is no preferred, merged or consensus field, and prompts from
  the chronology index are never published.
- **Entry pages.** An entry with projected datings, or with relative datings of other items
  pointing at it, gets a Dates section before its relationships: one heading per dated aspect in
  display order (`#atlas-dates-<aspect>`), "N competing datings, side by side. None is preferred"
  or "1 dating; no competing dating is published", and each dating (`#atlas-d-<id>`) with the
  date as stated, "Dated by", confidence worded as how firmly the dating party holds it,
  "Evidence" as cited references with locators, and its note. A relationship's own datings appear
  under "When it held" in its item; they date it and are never evidence for it.
- **Byte for byte without datings.** `datings` is left out of `atlas.json` when empty, and an
  entry with nothing to show has no Dates section, so a site whose atlas has no projected datings
  (private ones included) builds exactly as before. `formatVersion` stays 1: the key is additive
  and optional.
- **The warning narrows by itself.** `entries_with_unpublished_datings` already names only
  approved entries none of whose datings is projected. Its wording, in `build`, `check` and the
  Admin `unpublished-datings` notice, now says that "only cited, approved datings of published
  items, relative only to approved entries, are published", that years from version 1 `bounds`
  became private, unsourced datings, and that "`openblog check` gives each dating's reason",
  without pointing at a later release.
- **Leak corpus.** Sentinels in every dating field prove that approved fields reach only the
  atlas pages and `atlas.json`, that unknown fields, private datings, datings of unpublished
  items, datings relative to private entries and passage-cited datings reach nothing, and that
  withdrawing an entry withdraws its datings and the relative datings pointing at it.

## Consequences

- Published entries can show their years again once a dating is cited and approved; an uncited
  date still never appears.
- B3.1 can read datings from `atlas.json` with their order, placement and years and cannot reach a
  dating the projection left out.
- A site that publishes datings reveals the sources they cite, as a relationship does.

## Domain language

**Published dating** is defined in [`CONTEXT.md`](../../CONTEXT.md).

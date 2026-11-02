# ADR 0095: Atlas version 2 supersedes `bounds` with datings that stay private until approved

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#56](https://github.com/journey-to-code-org/open.blog/issues/56)
- Parent story: [#23](https://github.com/journey-to-code-org/open.blog/issues/23)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0053](0053-knowledge-atlas-entries-keep-their-kind.md),
  [ADR 0055](0055-private-knowledge-atlas-storage.md),
  [ADR 0057](0057-accessible-atlas-authoring-and-a-text-first-explorer.md),
  [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0093](0093-uncertain-dates-are-attributed-datings-at-their-stated-precision.md),
  [ADR 0094](0094-temporal-relationships-are-relative-datings-never-inferred.md)
- Amends: [ADR 0053](0053-knowledge-atlas-entries-keep-their-kind.md) (`bounds` is replaced),
  [ADR 0057](0057-accessible-atlas-authoring-and-a-text-first-explorer.md) (the entry form no
  longer edits years), [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md)
  (the projection no longer carries `bounds`)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#chronology)

## Context

ADR 0053 said the chronology contract would supersede `bounds` with a version bump rather than
overload it. Existing atlases hold `bounds` on entries, Admin edits them as two year fields,
and the projection publishes them for approved entries. `bounds` records neither who dated the
entry nor on what evidence, so carrying it into public output as a dating would present an
unsourced author note as a sourced claim.

## Decision

- **Version 2.** The atlas is `"version": 2`. Entries and relationships may carry `dates`, and
  `bounds` is refused in version 2 with a message saying it was replaced. A newer version is
  refused as before.
- **Version 1 is upgraded in memory, never in place by reading.** A version 1 file is read and
  validated as if it were version 2 after this upgrade, and the next accepted change writes it
  as version 2; reading, `check`, a refused or stale change, and a build never touch the file,
  and the revision is still the stored bytes'. Each entry's `bounds` with a year becomes one
  dating `<entry id>-span` (the first unused of `-span`, `-span-2`, ...; shortened to fit 64
  bytes) of aspect `span`, `{"from": {"year": F}, "to": {"year": U}}` with exactly the stored
  years and either end left open as it was, attributed to the author, `"unsourced": true`,
  `tentative` and `private`. Unknown fields inside `bounds` are kept under `boundsExtra` on that
  dating, or on the entry when `bounds` stated no year; an empty `bounds` disappears. Invalid
  `bounds` are reported with version 1's rules and field names. A version 1 item that already
  has a field named `dates` (or an entry that has `boundsExtra` and needs it) is refused rather
  than misread, so the author renames it first.
- **Private by default; approval as the atlas projection does it.** A dating's `visibility` is
  `private` unless `approved`, which is the author's consent for that dating only. An approved
  dating must cite evidence and carry no notebook passage. `Atlas::is_dating_projected` allows
  it only when its owner is published (an approved entry, or a relationship `is_projected`
  allows) and, for a relative dating, the entry it points at is approved, so an approved dating
  never drags a private entry into public output. When one of them is private the dating stays
  private and `Atlas::notices` reports a non-blocking `private-endpoint` notice naming ids
  only; withdrawing an entry or relationship withdraws its datings, and approving it restores
  them, with no other edit. `Atlas::projected_datings` lists what may be copied.
- **Nothing publishes datings yet.** Publishing them is the chronology publication slice (#59),
  which must add them to `PublicAtlas` field by field (amended by
  [ADR 0099](0099-approved-datings-publish-through-the-atlas-projection.md), which does). Until then `PublicAtlas` and the atlas
  pages carry no dates. This withdraws the year line that approved entries showed from `bounds`:
  a migrated span is an unsourced draft, which cannot be approved, and publishing it would show
  an uncited date as a claim. This is the conservative and reversible choice: the data is kept,
  and citing and approving the dating makes it eligible again.
- **Admin carries datings through.** The entry form no longer edits years. It says how many
  datings an entry has and that they are kept unchanged on save, and the payload carries
  `dates` and every unknown field over. Datings are edited in the atlas file until the Admin
  chronology slice (#58); a diagnostic about a dating focuses that note.
- **Never public otherwise.** The private atlas file, its guards and its hosted durability are
  unchanged. Leak regressions seed an approved dating with sentinels in its id, note, party and
  an unknown field and prove none reaches the built site, `atlas.json`, feeds, search,
  `llms.txt` or exports.

## Consequences

- Older open.blog releases refuse a version 2 atlas as written by a newer release, as designed;
  an author who downgrades must restore a version 1 copy.
- A site that published approved entries' years stops showing them until #59 publishes cited,
  approved datings. Rather than vanish silently, `build` and `check` warn while the atlas is
  published, naming each approved entry none of whose datings may be published and how many it
  holds, and Admin lists an `unpublished-datings` notice for each.
- `check` and Admin read a version 1 atlas without change, so upgrading is an ordinary edit
  with the usual revision check.

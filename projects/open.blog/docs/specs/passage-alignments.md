# Passage alignments format

Private alignments of corresponding places across editions, translations, witnesses, and
interpretations, owned by `openblog_core::alignment` and stored in
`.openblog/private/research/alignments.json`. Decisions:
[ADR 0088](../adr/0088-passage-alignments-record-correspondence-never-equivalence.md) and
[ADR 0089](../adr/0089-alignments-take-their-lock-after-claims-and-guard-what-they-use.md). The
file never reaches a public page, feed, export, or search index, and nothing in it can mark an
alignment public.

An alignment records where its author reads places as corresponding. It does not say they mean
the same thing, and no version is treated as authoritative.

```json
{
  "version": 1,
  "alignments": [
    { "id": "cave-opening", "label": "Opening of the cave image", "correspondence": "partial",
      "members": [
        { "source": "burnet-1902", "passage": "p-burnet-514a",
          "normalized": { "text": "μετὰ ταῦτα", "note": "Accents composed" } },
        { "source": "republic-grube-reeve", "passage": "p-grube-186" },
        { "source": "republic-grube-reeve", "passage": "p-grube-187",
          "note": "The translator splits one sentence in two" },
        { "interpretation": "cave-514a-ada" },
        { "source": "paris-gr-1807", "absent": true, "note": "Folio 12 is lost" }
      ],
      "rationale": "Both translations render 514a.", "confidence": "plausible",
      "recordedBy": { "kind": "author" },
      "evidence": [{ "source": "republic-slings-2003",
                     "locators": [{ "kind": "canonical", "value": "514a" }] }],
      "visibility": "private" }
  ]
}
```

Alignment order and member order are preserved and never sorted. Unknown fields are kept at
every level, but may not reuse a defined field's name. The canonical form writes defaults
(`correspondence`, `confidence`, `recordedBy`, `visibility`) explicitly and omits `absent:
false`. No text is trimmed or Unicode-normalized.

## Alignments

| Field | Rule |
| --- | --- |
| `id` | Required slug, at most 64 bytes, unique among alignments. |
| `label` | Optional one-line private label, at most 200 characters. |
| `correspondence` | `corresponding` (default), `partial`, or `divergent`. There is no "equivalent". |
| `members` | Two to 32 members relating at least two distinct versions or interpretations, at least one of them present. |
| `rationale` | Optional, at most 4,000 characters; line breaks allowed. |
| `confidence` | `tentative` (default), `plausible`, or `strong`: a label on the author's reading. |
| `uncertainty` | Optional, at most 2,000 characters. |
| `recordedBy` | `{ "kind": "author" }` (default), `{ "kind": "source", "source": id }`, or `{ "kind": "named", "name": text }`. |
| `evidence` | Up to 20 `{ "source", "locators"?, "passage"? }`, as in the Knowledge Atlas. |
| `visibility` | `private` (the default) or `approved`: the author's consent to publish it as a comparison ([ADR 0092](../adr/0092-publish-approved-comparisons-as-one-rights-gated-projection.md)). |
| `publishNormalized` | Optional `true`: publish members' normalizations, labelled, beside wording that is itself published. Written only when true. |

## Members

Each member is exactly one of:

- **A place in a version.** `source` is an edition, translation, or witness (never a work or a
  reference). It needs `locators` (up to eight notebook locators, as in the notebook) or a
  notebook `passage` quoted from that same source, or both. Pages cannot address a work and
  folios need a witness. Locators beside a passage record where the author found the place when
  aligning it.
- **An interpretation.** `interpretation` names an interpretation in the source library
  (ADR 0087). It carries no source, locators, passage, or `absent`, because the interpretation
  names its own.
- **An absence.** `source` with `absent: true` records that the version lacks the passage. It
  has no locators, passage, or normalization, and the same version may not also be present in
  the alignment.

Any member may have a one-line `note`. A member with a passage or interpretation may have
`normalized: { "text", "note"? }`: the author's normalization of the original wording, at most
20,000 characters with line breaks allowed and control or bidirectional override characters
refused. The original wording is always the passage's excerpt or the interpretation's text.

A member repeated in one alignment (the same source, interpretation, passage, locators, and
absence) is refused. One place may appear in several alignments.

## Diagnostics and notices

Diagnostics have a stable kebab-case `code`, `collection` (`alignments`), the alignment's
`index` and `id`, a `field` path such as `members[1].locators[0].kind`, and a `message` that
never repeats authored text. Codes specific to alignments: `wrong-source-kind`,
`unknown-interpretation`, `duplicate-member`, `conflicting-member`, `missing-counterpart`,
`missing-locator`, `missing-original`, and `unknown-alignment`.

Notices never block a change: `stale-locator` (a member's locators differ from those of the
passage it names, which may have been re-located since it was aligned) and `archived-member` (a
member rests on an archived source or passage). `openblog check` prints them.

## Storage, guards, and Admin API

The file obeys the claims file's storage rules: revision-checked changes, atomic rename, a lock
beside it (`alignments.json.lock`), 4 MiB, and damaged files reported and never replaced. Locks
are taken in the order atlas, claims, alignments, notebook, library. A source, interpretation,
or passage an alignment uses cannot be removed, and a notebook or library change that would make
a valid alignments file invalid is refused.

`GET /admin/api/research/alignments` returns `file`, `revision`, `stored`, `alignments`,
`notices`, `notice` (the statement above), and `publication` (see [Publication](#publication)),
and, read under the same snapshot for the
comparison workspace ([ADR 0090](../adr/0090-the-comparison-workspace-reads-one-snapshot-and-identifies-every-place.md)):
`sources` (every library record, each version with `rightsStatus` `{ status, label, declared,
note?, license? }` and every record with its `chain` of the records it realizes), `passages`
(notebook passages with their exact excerpts), `interpretations` (each interpreter with a
`display` name, a contributor's registry name or the stated name, and the interpretation's
`rightsStatus`), and `correspondences` (each value with its "The author reads…" label). Every
change returns the same view. `POST` creates and `PUT` updates one alignment
sent as `{ "revision", "alignment" }`; `DELETE` sends `{ "revision", "id" }` and returns the
`removed` alignment. Bodies are limited to 256 KiB. A stale revision returns `409` with
`conflict`, the latest `revision`, and the stored `current` alignment; invalid input returns `422`
with `diagnostics`. Neither writes anything.

## Comparison workspace

Admin Studio's **Compare** view (under Research, beside Notebook and Atlas) reads the view above
and shows one alignment at a time: a column per version or interpretation in the author's member
order, side by side or as a single-column ordered list, collapsing to one column on narrow
screens in the same order. Every place names its version, maker (editor, translator, scribe, or
interpreters, with attribution certainty), and locator in visible text; original wording is shown
exactly with its `lang` and a direction from its language tag (`dir="auto"` without one);
normalizations appear only on request, labelled and under the original; absent members say so in
words. Copy and download take only the places the author selects, with their rights statements,
and ask for confirmation when a selected version's rights are unchecked or reserved
([ADR 0091](../adr/0091-copying-from-a-comparison-takes-only-selected-places-with-their-rights.md)).
Nothing is stored in the browser.

## Publication

With `"comparisons": {"publish": true}` in `openblog.json`, a full build publishes every
`approved` alignment as a comparison ([ADR 0092](../adr/0092-publish-approved-comparisons-as-one-rights-gated-projection.md)):
`/comparisons/`, a page per comparison at `/comparisons/<id>/`, and `/comparisons.json`
(`{"format": "openblog-comparison-projection", "formatVersion": 1, "notice", "comparisons",
"sources"}`). While the switch is off, no build reads the alignments file.

Each published place is identified by its version (the public reference, kind, language,
`makers` with each one's role and attribution certainty, and `anonymous` when the author records
it so) or its interpretation (kind and interpreters with theirs), its locators, and its version's
rights statement. Attribution notes stay private. Its original wording is published exactly, with `lang` and `dir`, only when the
author states the version's or interpretation's rights as `permission`, `openLicense`,
`publicDomain`, or `ownWork`, and only when it is at most 1,000 characters; otherwise the place
says why its wording is not shown (`withheld`: `rights` or `length`). Normalizations are
published only with `publishNormalized` and beside shown wording. Notes on places, rights notes,
notebook passage ids, interpretation uncertainty notes, unknown fields and unapproved alignments
are never published. Rights statements are the author's declarations, not legal judgements.

A damaged alignments file, library or notebook refuses a full build and `check` while
publication is on, naming the file; an Admin save is never stopped by it. Of the library's
interpretations, the build validates only those an approved alignment names, and an invalid one
refuses it, naming its id; any other interpretation, even an invalid one, never stops a build. A build without an
alignments file (CI, a static host) publishes empty comparisons and warns. While publication is
on, `comparisons` is a reserved path and every Admin alignments change rebuilds the site and
returns `build`, as does saving or archiving a library source or a notebook passage that an
approved comparison uses (and a source import while any comparison is published), so a version
whose rights become reserved or unknown, or a reworded passage, never leaves a page quoting the
old wording. The alignments view also returns `publication` (`publish`, `url`,
`maxExcerptChars`, and `places`: per alignment, one of `shown`, `withheld-rights`,
`withheld-length`, `unquoted` or `absent` per member) so the author can see what a page would
show before approving.

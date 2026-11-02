# Research source library format

Version 1 of the private source library contract defined by
[ADR 0009](../adr/0009-research-source-library-identity.md). It is implemented by
`openblog_core::source_library` and stored as described in
[ADR 0010](../adr/0010-private-source-library-storage.md). A build reads it only when a post
that opts in to citations cites something, and then publishes only the cited references' public
description ([ADR 0048](../adr/0048-citations-publish-through-the-one-publication-projection.md));
a site whose posts cite nothing never reads it. `openblog check` validates it, and Admin Studio
editing arrives with issue
[#34](https://github.com/journey-to-code-org/open.blog/issues/34).

## Document

```json
{
  "version": 1,
  "sources": [
    { "id": "plato-republic", "kind": "work", "title": "Πολιτεία", "language": "grc",
      "creators": [{ "name": "Plato", "role": "author" }] },
    { "id": "republic-slings-2003", "kind": "edition", "of": "plato-republic",
      "title": "Platonis Rempublicam", "issued": "2003",
      "identifiers": [{ "scheme": "isbn", "value": "978-0-19-924849-0" }] },
    { "id": "republic-bloom", "kind": "translation", "of": "plato-republic",
      "basedOn": "republic-slings-2003", "language": "en", "title": "The Republic of Plato" },
    { "id": "paris-gr-1807", "kind": "witness", "of": "plato-republic",
      "title": "Paris, Bibliothèque nationale de France, gr. 1807" },
    { "id": "cave-allegory", "kind": "reference", "of": "republic-slings-2003",
      "location": { "scheme": "canonical", "value": "514a–520a" } }
  ]
}
```

Record order is preserved. Any field not listed below is kept verbatim, including inside
creators, identifiers, and locations, but an unknown field may not reuse the name of a
defined field at the same level. An empty `creators` or `identifiers` array carries no
data and is written back as an absent field.

## Fields

| Field | Applies to | Rule |
| --- | --- | --- |
| `id` | every record | Required. Lowercase ASCII slug, at most 64 bytes, unique across all kinds. An upsert never changes an existing record's kind; the library does not remember removed ids, so reusing one is the caller's responsibility. |
| `kind` | every record | Required. `work`, `edition`, `translation`, `witness`, or `reference`. |
| `title` | every record | Required except on a reference. |
| `of` | all but work | Required. Edition → work or translation. Translation → work. Witness → work, edition, or translation. Reference → work, edition, translation, or witness. |
| `basedOn` | translation | Optional edition, witness, or translation the translation was made from; it must belong to the same work and must not lead back to the translation. |
| `language` | every record | Language tag such as `en` or `grc`. Required on a translation. |
| `issued` | every record | Authored date text, kept as written. |
| `creators` | every record | `{ "name", "role"?, "attribution"?, "note"? }`, where role is `author`, `editor`, `translator`, `compiler`, `scribe`, or `other`, and attribution is `stated`, `attributed`, `uncertain`, or `disputed`. Descriptive only; never a contributor reference. |
| `identifiers` | every record | `{ "scheme", "value" }`. `doi`, `isbn`, `issn`, and `url` are checked offline; other schemes need a lowercase slug name. Values must not start or end with whitespace. |
| `archived` | every record | Optional `true`. Hides the record from everyday lists and keeps it in place; records that point at it still resolve. `false` is written as an absent field. |
| `location` | reference | `{ "scheme", "value", "volume"? }` with scheme `page`, `folio`, `line`, `section`, `chapter`, `canonical`, or `timestamp`. Pages cannot point at a work; folios need a witness; timestamps are seconds or `h:mm:ss`. A page or folio in a record with more than one volume needs `volume`, and a numeric volume must be within the declared count. |
| `revises` | edition | Optional earlier edition of the same text (the same `of`) that this edition revises. Revisions may not loop. ([ADR 0084](../adr/0084-version-lineage-witness-identity-and-volumes.md)) |
| `repository`, `shelfmark` | witness | Optional text identifying one held copy. No two witnesses share both. CSL `archive` and `archive_location` are never read as these. |
| `volumes` | edition, witness | Optional whole number of volumes, 1 to 10,000. |
| `rights` | edition, translation, witness | Optional `{ "status", "note"?, "license"? }`: the author's own declaration, never a legal determination. Status is `unknown`, `rightsReserved`, `permission`, `openLicense`, `publicDomain`, or `ownWork`; `license` only with `openLicense`. A version without one reads as `unknown`, and nothing inherits a status. ([ADR 0085](../adr/0085-rights-are-the-authors-declaration-per-version.md)) |
| `anonymous` | all but reference | Optional `true`: the source names no maker. A creator in the record's maker role (author, editor, translator, or scribe for a work, edition, translation, or witness) whose attribution is stated or absent contradicts it (`conflicting-attribution`). ([ADR 0086](../adr/0086-attribution-uncertainty-is-explicit.md)) |

`credit`, `credits`, `contributor`, and `contributors` are rejected as field names at any
depth of a record, including inside creators, identifiers, locations, rights, and unknown
fields, and beside `sources` at the library level. A `.credits.json` sidecar is rejected as a
library. The one exception is an interpreter's `contributor` key below.

## Interpretations

An optional top-level `interpretations` array holds attributed renderings and readings of
places in the library's versions ([ADR 0087](../adr/0087-attributed-interpretations-live-in-the-source-library.md)).
They are private research: never sources, never cited, never exported as bibliography, and
never read by a build: a build parses the library without validating them, so a problem in an
interpretation never fails a build. An empty array is written as an absent field.

```json
"interpretations": [
  { "id": "cave-514a-mine", "kind": "rendering", "source": "republic-slings-2003",
    "locators": [{ "kind": "canonical", "value": "514a" }], "language": "en",
    "text": "Next, compare our nature in its education and its lack of it to this.",
    "interpreters": [{ "contributor": "ada" }], "rights": { "status": "ownWork" } }
]
```

| Field | Rule |
| --- | --- |
| `id` | Required slug, unique among interpretations and distinct from every source identifier. |
| `kind` | Required. `rendering` (a translation of one place) or `reading` (what it means). Neither is a library `translation`. |
| `source` | Required. An edition, translation, or witness; a reading may also name a work. Never a reference, a contributor, or another interpretation. |
| `locators` | Up to eight notebook locators (`kind`, `value`, `to`?). Required on a rendering. Pages cannot address a work; folios need a witness. |
| `language` | Language tag. Required on a rendering. |
| `text` | Required, at most 20,000 characters; line breaks allowed, other control characters and bidirectional overrides refused. Stored exactly as written. |
| `interpreters` | Up to sixteen, each exactly one of `{ "contributor": key }` (must exist in the contributor registry) or `{ "name": text }`, with optional `attribution`. Required unless `anonymous`. |
| `anonymous` | Optional `true`. An interpreter with a stated or absent attribution contradicts it. |
| `rights` | Optional rights declaration, as on a version. |
| `uncertainty` | Optional one-line note. |

A source an interpretation uses cannot be removed (`still-used`), and Admin refuses to remove a
contributor an interpretation names. Sources and interpretations that a
[passage alignment](passage-alignments.md) uses cannot be removed either. Interpretation diagnostics have no `index` or `sourceId`;
their `field` path starts with `interpretations[n]`.

## Limits and diagnostics

A library may be at most 4 MiB, measured both on the text that is read and on its
canonical written form, so every library that parses can be written back, read again, and
shrunk. It may hold at most 10,000 records and 10,000 interpretations; text fields are
limited to 1,000 characters without control characters. A version other than 1 is refused without being
reinterpreted.

Each diagnostic has a stable kebab-case `code`, the record's zero-based `index` and
`sourceId` when it belongs to one, a `field` path such as `identifiers[0]` or
`location.scheme`, and a `message`. All problems are reported together, and a record that
already failed is not reported again through records that point at it.

## Storage

The library is stored at `.openblog/private/research/sources.json`, which new projects
ignore in Git. No existing component of that path may be a symlink or junction. Builds never
read it, and nothing inside `.openblog/` is copied into a build or feeds its asset version
even when `paths.static` or `paths.themes` contains it.

Every read returns a **library revision**, the lowercase hexadecimal SHA-256 of the stored
bytes (or of the canonical empty library while no file exists). Create, update, and remove
each name the revision they were based on; any other revision, including one changed by a
hand edit, is a conflict and nothing is written, not even the private directories of a
library that is not stored yet. Create refuses an identifier in use (`duplicate-id`, scoped
to the existing source), and update refuses one that is not (`unknown-source`, scoped to the
requested identifier).

Changes hold `sources.json.lock` beside the library, write the canonical form to a new
`sources.json.<process>-<time>.tmp` file, flush it, and rename it over the library, so the
stored file is always either the previous or the next complete library. Temporary files
left by an interrupted write are ignored and removed by the next successful write. A lock
left by a crashed process blocks changes until it is removed; reads never wait for it.

A leading UTF-8 byte-order mark, as some editors save, is ignored when reading; the
revision still covers the stored bytes, and the next change writes the canonical form
without it. A stored file that is malformed, not UTF-8, larger than 4 MiB, invalid, or of a
newer version is reported with the diagnostics above and is never overwritten. Lookups by id,
kind, and dependent record are derived in memory from the file and never stored.

## Admin API

Admin manages the library through authenticated, CSRF-protected endpoints; see
[ADR 0011](../adr/0011-admin-source-library-management.md). `GET /admin/api/sources`
returns `file`, `revision`, `stored`, and `sources`. `POST` creates and `PUT` updates one
record sent as `{ "revision", "source" }`; `POST /admin/api/sources/archive` sends
`{ "revision", "id", "archived" }` and changes only that field. Bodies are limited to
256 KiB. A stale revision returns `409` with `conflict`, the latest `revision`, and the
newer stored `current` record; an invalid or unknown record returns `422` with
source-scoped `diagnostics`. Neither writes anything.

## Interchange

CSL JSON import and CSL JSON / BibTeX export; see
[ADR 0012](../adr/0012-source-library-interchange.md). `POST /admin/api/sources/import`
sends `{ "revision", "content", "apply" }` (at most 3 MiB). With `apply: false` it returns
a `plan` and writes nothing: `counts`, and per item the `action` (`create`, `update`,
`unchanged`, `conflict`), `changes`, `kept`, `unsupported` (item fields the library does
not store, with reasons), `diagnostics`, and `duplicateOf`. With `apply: true` it applies a
plan with no conflicts as one revision-checked atomic change, or returns `422` with the
plan and source-scoped diagnostics and writes nothing. Import limits are 2 MiB and 5,000
items.

| CSL JSON | Library |
| --- | --- |
| `id` | `id`: lowercase ASCII slug, or `csl-` plus 16 hex digits of a digest when there is none |
| `title`, `language` | `title`, `language` |
| `author`, `editor`, `translator` | `creators` with that role; family, given, particles, and suffix kept beside the display name |
| `issued` | `issued` text: `date-parts` as `2003`, `1968-05`, `1810-03-07`, or `2003/2005`; `literal` and `raw` verbatim |
| `DOI`, `ISBN`, `ISSN`, `URL`, `PMID`, `PMCID` | `identifiers` (several ISBNs or ISSNs are separated by `, `) |
| `container-title`, `publisher`, `edition`, `volume`, `page`, and similar text or numbers | `csl` field, verbatim |
| `custom["openblog-*"]` | kind, `of`, `basedOn`, `location`, `archived`, `anonymous`, `revises`, `repository`, `shelfmark`, `volumes`, `rights`, unknown fields, and full creator and identifier lists |
| `note`, `abstract`, `annote`, `keyword` | never imported |
| anything else | reported as unsupported |

A matching id merges rather than replaces: stated title, language, date, relationships,
location, and archived flag are replaced; creators and identifiers are added when missing;
a matching creator's attribution and note are filled in when the library has none, and a
different attribution or note is a `conflicting-attribution` conflict; unknown fields are
overlaid; everything else is kept. An import never changes a kind and
never removes anything. A shared DOI, ISBN, ISSN, PMID, or PMCID under a different id, or
two items with one id, is a conflict.

`GET /admin/api/sources/export?format=csl-json|bibtex` returns `content`, `filename`,
`revision`, `count`, and `losses`. Both are deterministic for a library revision. CSL JSON
keeps every record (`custom` holds what CSL cannot express); interpretations are private
research, not bibliography, and are not exported. BibTeX is keyed by source id and
lists in `losses`, per source and field, what an entry omits.

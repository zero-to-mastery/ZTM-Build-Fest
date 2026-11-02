# ADR 0012: Exchange sources as CSL JSON and BibTeX, with a preview before any write

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#35](https://github.com/journey-to-code-org/open.blog/issues/35)
- Parent story: [#17](https://github.com/journey-to-code-org/open.blog/issues/17)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0009](0009-research-source-library-identity.md),
  [ADR 0010](0010-private-source-library-storage.md), and
  [ADR 0011](0011-admin-source-library-management.md)
- Contract: [Research source library format](../specs/research-source-library.md)

## Context

Authors keep bibliographies in tools such as Zotero. Moving them into the source library by
hand is slow, and a careless importer could overwrite richer open.blog metadata (an edition's
work, a reference's location, unknown fields), invent identities, or smuggle private notes
into a file that is later shared. CSL JSON is the common exchange format for reference
managers; BibTeX is the most widely read bibliography file. Neither can express editions,
translations, witnesses, or locations.

## Decision

- **CSL JSON in, CSL JSON and BibTeX out.** `openblog_core::source_interchange` reads CSL
  JSON (an array of items) and writes CSL JSON 1.0.2 or BibTeX. BibTeX import, live Zotero
  sync, style rendering, and online identifier lookup are out of scope.
- **Preview first.** `plan_csl_import` is pure: it reports, item by item, `create`,
  `update`, `unchanged`, or `conflict`, the fields an update changes, the existing fields it
  leaves alone (`kept`), and every item field the library does not store (`unsupported`,
  with a reason). Only `ImportPlan::apply` builds a changed library, and only when no item
  conflicts and the whole result validates as one library, so items may refer to each other
  in any order. Admin previews with `POST /admin/api/sources/import` and `apply: false`;
  `apply: true` rebuilds the plan from the library as stored under the lock, so a plan can
  never describe a stale library.
- **Failures are all-or-nothing and scoped.** A conflicting item carries diagnostics naming
  its source id and field; any conflict refuses the whole apply, and a stale revision is a
  `409`. A refused import writes nothing, not even private directories.
- **Stable identity.** The source id is the lowercase ASCII slug of the CSL `id`. An id with
  no usable slug (non-ASCII, empty after slugging, too long) becomes `csl-` plus 16 hex
  digits of its BLAKE2b digest, so distinct ids never collapse and the same file always maps
  to the same ids. Two items mapping to one id are both conflicts. An item with no matching
  id that shares a DOI, ISBN, ISSN, PMID, or PMCID with another record is a conflict naming
  the record it duplicates, so a library never gains two records for one published thing.
- **Merging never discards.** An item replaces only the title, language, issued date,
  relationships, location, and archived flag it states. Creators and identifiers are
  unioned (a creator matches by name, and an unset role matches any), unknown fields are
  overlaid key by key, and everything the item does not state stays as stored. An import
  cannot change a record's kind. Importing the same file twice therefore yields `unchanged`
  for every item and leaves the stored bytes identical. An import never removes a source,
  creator, or identifier; removal stays an explicit Admin action.
- **Mapping.** CSL names become creators (`author`, `editor`, `translator`); a structured
  name keeps its parts beside the display name so export rebuilds it. `date-parts` become
  authored text (`2003`, `1968-05`, `2003/2005`) and `literal`/`raw` dates are kept verbatim.
  `DOI`, `ISBN`, `ISSN`, `URL`, `PMID`, and `PMCID` become identifiers. Variables with no
  library field (type, container title, publisher, edition, volume, and similar) are kept
  as text under the record's `csl` field. The generic `document` type is the export
  default and is not stored. A plain CSL item imports as a work.
- **Lossless open.blog round trip.** CSL JSON allows a `custom` object, so export writes
  everything CSL cannot express there under `openblog-*` keys: kind, `of`, `basedOn`,
  location, archived, unknown fields, and full creator and identifier lists. On import the
  full lists are used only when they still agree with the item's standard name and
  identifier fields; if someone edited those elsewhere, the standard fields win and the
  disagreement is reported. Exporting a library and importing it back is a no-op, and
  importing it into an empty library restores every record.
- **Private notes never cross.** `note`, `abstract`, `annote`, and `keyword` are reported as
  unsupported and never stored, so a private reading note cannot reach an export. Credit
  fields smuggled through `openblog-extra` are refused like in any other record, and an
  unknown field cannot shadow a defined one. The same rules cover `openblog-extra` and its
  `csl` bag: note fields are dropped and reported, and every kept value must be plain text or
  a number.
- **A matched item is validated as the stored record with its stated fields applied.** An
  item that names an existing id may state only what it changes; it is not checked as a
  complete record of the default kind. Identifiers an update adds go through the same
  shared-identifier check as creates (and are visible to later items in the file), so a
  library never gains two records for one DOI, ISBN, ISSN, PMID, or PMCID.
- **Deterministic exports.** Exports list records in library order with sorted keys and a
  trailing newline, so the same revision always exports the same bytes. CSL export loses
  nothing. BibTeX uses the source id as the cite key, escapes every special character (a brace is
  written as `	extbraceleft{}` or `	extbraceright{}`, which BibTeX does not count), keeps
  braces balanced, and returns a `losses` list per source for what it omits: kind,
  relationships, locations, the archived flag, annotated or unknown identifier schemes,
  roles BibTeX has no field for, days, and non-year dates. `GET
  /admin/api/sources/export?format=csl-json|bibtex` returns the content, the library
  revision, and those losses; Admin downloads it and states the losses.
- **Hostile input.** Imports are limited to 2 MiB and 5,000 items before and after parsing
  (the Admin request limit is 3 MiB for the JSON envelope). Text is length- and
  control-character-checked, URL identifiers must be absolute HTTP(S) without credentials,
  ids can only become slugs, so traversal strings are inert, and all text reaches the page as
  text. Deeply nested JSON is rejected by the parser's recursion limit.
- **Privacy.** The library stays private. An export is an explicit, authenticated,
  author-initiated download of the author's own data, not a publication artifact, and
  builds never read the library (amended by [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md):
  a build reads it only when a post that opts in to citations cites something, and publishes
  only the cited references' public description, never this export).

## Consequences

- An author can move a Zotero library in once, see exactly what is kept and dropped, and
  re-run the import safely as their reference manager changes.
- Items edited in a reference manager can add and change data but cannot remove a creator or
  identifier; that is deliberate and avoids silent loss.
- An all-or-nothing apply makes one bad item block the batch; the preview names it, and
  removing or fixing it is a one-line change to the file.
- Identifier order and the `document` default type are not preserved when an item is edited
  outside open.blog; neither carries meaning.

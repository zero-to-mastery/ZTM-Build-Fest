# ADR 0148: Source review prompts about identifiers, versions, quotation locations and citation consistency

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#193](https://github.com/journey-to-code-org/open.blog/issues/193)
- Parent story: [#189](https://github.com/journey-to-code-org/open.blog/issues/189)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0045](0045-citation-locators-reuse-notebook-locators.md),
  [ADR 0050](0050-offline-citation-checks-and-portable-bibliography-exports.md),
  [ADR 0084](0084-version-lineage-witness-identity-and-volumes.md),
  [ADR 0146](0146-one-research-completeness-contract-with-one-owner-per-check.md),
  [ADR 0147](0147-acknowledgements-never-resolve-a-finding-and-go-stale-when-it-changes.md)
- Coordinates with: [#194](https://github.com/journey-to-code-org/open.blog/issues/194),
  [#195](https://github.com/journey-to-code-org/open.blog/issues/195)

## Context

ADR 0146 reserved a `source-review` validator with four checks (identifier compatibility,
version identity, quotation location and citation consistency) for the gaps no existing check
covers. The library already refuses malformed DOIs, ISBNs, ISSNs and URLs, a page on a work, a
folio outside a witness, and a reference location without its volume (ADR 0084), and citation
review already reports unknown keys, a cited PMID's form, thin references and located citations
(ADR 0050). Nothing reported two records with one identifier, a page in a multi-volume edition
cited or captured with no volume, a translation or witness whose record does not say which one
it is, a quotation with no location, or a post that cites one source under two records or mixes
versions of one work. Issue #193 asks for these without asserting that a quotation is accurate,
without destructive normalization, and without inventing any detail.

## Decision

- **One validator, two entry points.** `openblog_core::source_review` owns the four checks.
  `review_post(path, markdown, body_line, library)` reviews the citations of a post that opts in
  to citations (ADR 0043), reading the library only when the post cites something, as citation
  review does. `review_library(library, notebook)` reviews the source library and the notebook
  passages. Both return `SourceReviewFinding`s, which the contract maps in with
  `CompletenessFinding::from_source_review`.
- **The codes.** Every code is advisory: nothing is refused on it, whatever its outcome.

  | Check | Code | Category | Outcome | Scope | Condition |
  | --- | --- | --- | --- | --- | --- |
  | identifier-compatibility | `identifier-conflict` | identifier | potential | source | one record has two different values of `doi`, `pmid` or `pmcid` |
  | identifier-compatibility | `identifier-shared` | identifier | needs-review | source | two records have the same `doi`, `isbn`, `pmid` or `pmcid`; the later record is scoped and every earlier one related |
  | identifier-compatibility | `identifier-on-work` | identifier | needs-review | source | a work whose editions, translations or witnesses are recorded carries an ISBN |
  | version-identity | `volume-missing` | locator | detected | post or passage | a page or folio in a version recorded in more than one volume names no `x-csl-volume` |
  | version-identity | `volume-unknown` | locator | detected | post or passage | an `x-csl-volume` the version does not have, or that differs from the volume the cited reference records |
  | version-identity | `translator-missing` | version | potential | source | a translation names no creator with the role `translator` and is not anonymous |
  | version-identity | `witness-unidentified` | version | potential | source | a witness has no repository or no shelfmark |
  | version-identity | `version-unspecified` | version | needs-review | post | a quotation cites a work whose versions are recorded |
  | quotation-location | `quotation-locator-missing` | locator | potential | post | a quotation's citation gives no location |
  | quotation-location | `quotation-location-broad` | locator | needs-review | post | a quotation's citation gives only a chapter or section |
  | quotation-location | `passage-locator-missing` | locator | potential | passage | a notebook passage records no location |
  | citation-consistency | `citation-same-identifier` | citation | potential | post | a post cites two records with the same identifier |
  | citation-consistency | `citation-versions-mixed` | citation | needs-review | post | a post cites several versions of one work, or the work and a version |

  The volume codes are detected because the gap is structural: the version says its pages
  restart and the citation names no volume. They stay advisory so that a new check never refuses
  an existing published post.
- **What a quotation is.** A citation inside a block quotation, a citation that directly
  follows a block quotation (after blank space or a dash), or a citation directly after quoted
  words in straight, curly, low-high or guillemet marks, with emphasis allowed around them. A
  GitHub-style alert (`> [!NOTE]`) is a callout, not a quotation. A notebook passage is a
  quotation by definition. A location is required of a quotation: `page`, `folio`, `line`,
  `canonical`, `timestamp` and extension kinds are narrow enough; `chapter` and `section` alone
  are prompted as broad; an `x-csl-volume` alone is no location; and a reference record that
  gives its own location locates the quotation. Nothing compares the quoted words with any text,
  and the messages say that open.blog checks only that a location is given. An inline quotation is identified by its quoted span alone, from the opening mark to the closing mark, so other prose on the line and rewrapping keep an acknowledgement current.
- **Identifiers are compared, never rewritten.** Two identifiers meet through a comparison key:
  a DOI in any form `normalize_doi_url` accepts, case-folded; an ISBN-10 as its ISBN-13; a PMCID
  with its prefix upper-cased. The record keeps what was written. ISSN names a serial that many
  records share and other schemes are free-form author data, so neither is compared. A
  reference and a record on its realization chain may share an ISBN (a chapter carries its
  book's ISBN), and so may two records that read the same version or share any other
  non-reference ancestor (two chapters of one edition), so those pairs are not reported; a shared DOI always is. When two records disagree,
  the finding is scoped to one and relates the other; neither is changed or merged.
- **Versions follow the A6 model.** The version a citation reads is the first edition,
  translation or witness on its realization chain, and the work is the record of kind work at
  its end. A version's `volumes` and a reference's own location `volume` decide the volume
  codes, and `x-csl-volume` is the locator kind that names a volume (ADR 0084). Two references
  into one edition read the same version, so citing both is not mixed.
- **Nothing is invented and nothing private is said.** No finding fills in, suggests or looks up
  a value. Imported records are reviewed like any other: a finding names the record and field,
  and the import plan remains the record of what the import changed. Messages name ids,
  schemes, field positions, locator kinds and counts, never a title, excerpt, note, quoted
  words or identifier value. Each finding's position-free `facts` (cited keys and locators,
  comparison keys, ids, volume counts and the quotation's own text) feed its fingerprint
  (ADR 0147) and are never serialized. Archived records and passages are left out of the
  library review; whatever still rests on them is reported by the checks that read it.
- **Where it shows.** The site load reviews each opted-in post with the library it already
  reads for citations, so `openblog check` and `openblog build` print the post findings beside
  the evidence findings, as `source review <outcome>: <place>: <message> Repair: <repair>
  [<code>]`. `openblog check` also reviews the stored library and notebook and prints one
  summary that counts each outcome apart. Nothing is written into the static build. Admin and
  the unified readiness report arrive with #194.

## Consequences

- Works without DOIs, posts that do not opt in to citations, and legacy research posts are
  unaffected: no identifier is required and no new finding appears for them.
- Every condition keeps exactly one owner: a malformed identifier stays the library's, a cited
  PMID's form and an unknown key citation review's, a claim link without a location claim
  review's, and an alignment member's locators the alignments file's.
- Inserting text above a quotation moves its findings and keeps their fingerprints, so an
  acknowledgement survives; changing the cited locators, the volume count or the quoted words
  makes it stale.
- Network lookups remain a possible, separate and explicitly labelled author action; none is
  part of this review.

## Domain language

**Source review**, **Quotation** and **Identifier comparison key** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

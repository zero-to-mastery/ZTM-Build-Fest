# ADR 0050: Check citations offline in four separate classes and export cited references from the publication projection

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#43](https://github.com/journey-to-code-org/open.blog/issues/43)
- Parent story: [#19](https://github.com/journey-to-code-org/open.blog/issues/19)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0002](0002-research-profile-and-evidence-capability.md),
  [ADR 0012](0012-source-library-interchange.md),
  [ADR 0044](0044-what-a-citation-makes-public.md),
  [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md),
  [ADR 0049](0049-built-in-citation-styles-locales-and-accessible-notes.md)
- Contract: [Citation format](../specs/citations.md)

## Context

A published citation already refuses the post when it cannot be read or resolved, but an author
also needs to know when a cited reference is too thin for readers to find, and must not be told
that a tool has confirmed what only a person can confirm. Readers and authors also want the
cited references in the formats reference managers read. Issue #92 gives every public
representation one publication projection; a feature must not grow a second model of what a
post publishes. Network lookups would make checks slow, non-deterministic and dependent on a
hosted service.

## Decision

- **Four classes, kept apart.** `openblog_core::citation_review` reviews each post that opts in
  to citations and reports `EvidenceFinding`s, the type Evidence Studio and the CLI already show:

  | Class | Codes | Outcome | Meaning |
  | --- | --- | --- | --- |
  | Syntax | `citation-syntax` | detected | a `[@...]` the scanner cannot read |
  | Resolution | `citation-unresolved`, `citation-identifier-unpublished` | detected, potential | a key with no source or a locator that does not fit it; a PMID or PMCID in a form readers cannot follow, which the note and exports leave out |
  | Completeness | `citation-reference-incomplete` | potential | a cited reference without a detail its kind usually has, named by field |
  | Location review | `citation-location-review` | needs-review | the citations that give a location, one finding per post |

  Completeness reads only explicit authored data: a title for every reference; a creator for a
  work, edition or translation; a date for an edition, a translation or any item with a CSL
  type; a container title for contained CSL types (journal articles, chapters, entries, papers,
  blog posts); a publisher for books, reports, theses and editions without a type; a web address
  for web pages and posts. A missing detail is reported, never filled in.
- **Nothing claims truth or relevance.** Findings name keys, fields and lines. They never say a
  source is true, relevant, authoritative or supports a claim, and the location class says
  plainly that open.blog checked only the locator's form and fit, and that a person must check
  that the passage is there. Messages never repeat a malformed identifier's value, notebook
  text or other records.
- **Offline only.** Every check is deterministic and reads only the post and the source library.
  No identifier or link is looked up online. `openblog check` states this on its own line when
  posts publish citations, and Evidence Studio shows it beside the counts. Network resolution,
  if it is ever added, will be a separate, explicit author action whose results are labelled as
  such; it is not part of builds, checks or previews.
- **Where findings appear.** In the site load, so `openblog check`, `openblog build` and the Admin
  preview all show the same findings for the post. For a post the load publishes, syntax and
  resolution problems still refuse the post (ADR 0049); the findings matter most for drafts,
  whose citations stay text with a warning, and for completeness and location review, which
  never block. Posts that do not opt in get no citation findings, so existing articles, recipes,
  research and contributor output are unchanged.
- **Exports come from the publication projection.** A published post carries a
  `CitationSummary`: its style, locale, counts and the `PublicReference` of each cited reference
  in order of first citation (ADR 0044). `export_cited_csl_json` and `export_cited_bibtex` write
  only that description, through the same writers and escaping as the library exports of
  ADR 0012, but with no `custom` envelope: no relationships, locations, archived flags, unknown
  fields, notes or private identifier schemes. A malformed PMID or PMCID is not exported. Every
  detail the format cannot carry (an edition's kind, a role with no name variable, extra
  single-valued identifiers, CSL variables BibTeX lacks, non-year dates) is reported as an
  omission per source. The same references always export the same bytes.
- **Where exports are offered.** `openblog export <slug> --format csl-json|bibtex` previews by
  default, prints each omission, and writes only with `--out <path> --write`, atomically and
  never over an existing file; `--json` prints a versioned manifest with the omissions. Admin's
  preview response carries both exports for the previewed post, built from that preview's
  published references, and Evidence Studio downloads them with the omissions stated. Neither
  changes the post, the library or browser data. A post that publishes no citations has
  nothing to export, and says so. Exports are not written into the static build.

## Consequences

- An author sees, separately, what blocks publication, what readers may struggle to find, and
  what only they can verify.
- A cited-reference export can never hold more than the post's notes show, because both read the
  same references.
- The completeness rules are a fixed table; adding a CSL type or a field is one entry, covered
  by the tests. They are guidance, so a source that genuinely has no date or creator simply
  keeps its potential finding.
- Static per-post bibliography files, network resolution and style-accurate CSL rendering remain
  possible later and additive.

## Domain language

**Citation check** and **Bibliography export** are defined in [`CONTEXT.md`](../../CONTEXT.md).

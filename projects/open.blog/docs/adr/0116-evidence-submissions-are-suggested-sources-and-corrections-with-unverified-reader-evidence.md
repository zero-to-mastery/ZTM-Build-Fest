# ADR 0116: An evidence submission is a suggested source or correction with unverified evidence the reader names by the site's public ids

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#208](https://github.com/journey-to-code-org/open.blog/issues/208)
- Parent story: [#199](https://github.com/journey-to-code-org/open.blog/issues/199)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0068](0068-claims-and-evidence-links-record-the-authors-reading.md),
  [ADR 0075](0075-publish-approved-claim-evidence-in-the-post-with-public-revision-notes.md),
  [ADR 0077](0077-targets-resolve-as-current-reanchored-or-stale.md),
  [ADR 0078](0078-feedback-provenance-records-the-revision-seen-and-consent.md),
  [ADR 0079](0079-typed-scholarly-feedback-kinds-and-one-submission-format.md)
- Coordinates with: [#211](https://github.com/journey-to-code-org/open.blog/issues/211) (RD12,
  participation and moderation policy), [#217](https://github.com/journey-to-code-org/open.blog/issues/217)
  (RD6.2 submission and review), [#218](https://github.com/journey-to-code-org/open.blog/issues/218)
  (RD6.3 published outcomes), [ADR 0117](0117-only-the-authors-correction-decision-labels-a-correction.md)
- Amended by: [ADR 0118](0118-evidence-and-correction-decisions-are-taken-opt-in-and-decided-in-the-inbox.md)
  (the form, the hosted transport and storage)
- Contract: `openblog_core::evidence_submission`, fixtures in
  `tests/fixtures/evidence-corrections.json` (`submissions`)

## Context

RD6 lets a reader offer a source or challenge a citation or a sentence, and lets readers and
editors tell a proposed source, a challenged citation, a possible error, an accepted correction, a
declined suggestion and an unresolved question apart (#208). B5 already has the two reader intents
this needs, `source-suggestion` (with a required link) and `correction-suggestion` (with optional
suggested wording and an optional link), and ADR 0079 says a kind that needs fields the record
lacks raises the format `version`. What B5 cannot say is which of the author's published claims,
evidence links or citations a submission is about, or which source the site already publishes the
reader is pointing at. Claims and evidence links have stable ids (A4, ADR 0068) and sources have
stable source identifiers and locators (A1, A3). The roadmap (#92) allows no second comment system
and no popularity-based truth signals; reader text, URLs and identity claims are untrusted; and a
reader's guess at an id must never confirm that something private exists.

## Decision

- **An evidence submission is B5 feedback of an evidence kind.** The evidence kinds are exactly
  `source-suggestion` and `correction-suggestion` (`EVIDENCE_KINDS`), the same ids as in B5 and in
  RD12's participation registry. A `question` and an `alternative-interpretation` are never
  evidence submissions, carry no evidence block and take no correction decision. No new kind is
  added, so every per-site and per-post mode, quota, moderation state and fallback already defined
  for those two kinds applies unchanged.
- **The evidence block is the reader's statement, in format version 2.** A submission may carry
  `evidence`, an object of these optional members (at least one):

  | Member | Meaning | Shape |
  | --- | --- | --- |
  | `claim` | the published claim the submission is about | claim id |
  | `evidenceLink` | the published evidence link on that claim the reader questions (needs `claim`) | link id |
  | `citation` | a source the post cites that the reader questions | source identifier |
  | `source` | a source the site publishes that the reader offers as evidence | source identifier |
  | `locators` | where in `source` the reader looked (needs `source`), at most 8 | notebook locator kinds, values of 1 to 64 characters on one line |
  | `stance` | how the reader says the evidence they offer bears on the target | `supports`, `contradicts` or `contextualizes` (A4's relation ids) |

  Ids are lowercase slugs of at most 64 bytes, the shape of A4 and source-library ids. A `stance`
  needs offered evidence (`source` or B5's `details.sourceUrl`). Unknown members are refused, so a
  vote, score, count, rank, "verified" flag or anything about the reader cannot ride along. The
  block is reader text: it is never an A4 evidence link, a citation, a Source Library record or a
  research note, it is never copied into any of them, and its stance is never the author's
  relation.
- **Version 1 stays B5's, byte for byte.** A submission or record without evidence is version 1
  and is written exactly as B5 writes it; one with evidence is version 2 (`{version: 2, …B5's
  fields…, evidence}`), which B5's readers refuse as `unsupportedVersion`. A version 1 document
  with `evidence` and a version 2 document without it are refused, so each submission has one
  canonical form. The received record is B5's `{version, kind, body, details, provenance}` with
  `evidence` beside it; provenance and reader attribution are ADR 0078's, unchanged.
- **One check order.** Size, JSON, version, every B5 rule in B5's order, the kind is an evidence
  kind, then the block (shape, id shapes, link needs claim, locators need source, locator count,
  each locator, stance value, stance needs evidence, not empty). Errors carry
  `EvidenceErrorCode` and, for a B5 rule, B5's own code; messages name fields and never repeat what
  the reader wrote. B5's source-link rule is unchanged: a suggested source still needs
  `details.sourceUrl`.
- **References resolve against public output only.** `PublishedReferences` is built from what a
  post publishes, its claim evidence projection (ADR 0075) and the sources its citations publish,
  never from the private claims file or Source Library. Each id the reader named reads as
  `published` or `notPublished`, and "not published" never says whether it is mistyped, withdrawn
  or private. The `claim`, `evidenceLink` and `citation` are checked against the post. The offered
  `source` is checked against `SitePublishedSources`, the sources published anywhere on the site
  (every post's claim-evidence and bibliography sources), because a suggested source is usually new
  to the post it is offered on. A reference that is no longer published is a stale claim or
  citation target, shown as such, exactly as a stale passage target is (ADR 0077); nothing is
  retargeted. An unpublished `source` is shown as not published but never makes the item stale.
- **Nothing is evaluated.** The software checks shape and publication, never whether evidence is
  good, whether a source says what the reader says, or how many readers agree. Identical
  submissions are separate items; nothing aggregates them.
- **Scope of this task.** Pure Rust types, validation and fixtures. No endpoint, form, storage
  column, migration or page changes here: #217 carries version 2 through the hosted function, its
  JavaScript validator (reading the same fixtures) and the Admin review, and #218 publishes
  outcomes.

## Considered options

- **A new kind (`evidence-submission`).** Rejected: B5's two kinds already name the reader's intent,
  and a third would split one intent across two kinds and need a new registry row, mode and form
  choice for no gain.
- **Add `evidence` to version 1.** Rejected: ADR 0079 promises older readers refuse fields they do
  not know, and a version 1 reader silently accepting a richer document would break that promise.
- **Let readers name private ids or quote from the notebook.** Rejected: a reader can only know
  public identities, and resolving against private data would let a guess confirm private
  research.
- **Let reader stance count towards a claim's evidence.** Rejected: it would turn submissions into
  votes. Only the author's decision (ADR 0117) and the author's own evidence link change anything.

## Consequences

- Moderators and authors can tell a proposed source, a challenged citation and a possible error
  apart before any decision (ADR 0117's standing), from the kind and block alone.
- #217 adds version 2 to `web/components/passage-feedback.js` and the hosted function against the
  `submissions` fixtures, and stores the block with the row; storage only checks the kind id's
  shape (ADR 0080), so no kind migration is needed. Until then hosted transport refuses version 2,
  which is the safe default.
- RD12 merged without renumbering anything: the kinds, their rules and their modes are its own
  `source-suggestion` and `correction-suggestion` rows.

## Domain language

**Evidence submission**, **Evidence block** and **Published references** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

# ADR 0123: The research review before publication adapts today's findings to the completeness contract

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#62](https://github.com/journey-to-code-org/open.blog/issues/62)
- Parent story: [#24](https://github.com/journey-to-code-org/open.blog/issues/24)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0002](0002-research-profile-and-evidence-capability.md),
  [ADR 0049](0049-built-in-citation-styles-locales-and-accessible-notes.md),
  [ADR 0050](0050-offline-citation-checks-and-portable-bibliography-exports.md),
  [ADR 0074](0074-evidence-gaps-are-prompts-in-the-shared-finding-contract.md),
  [ADR 0092](0092-publish-approved-comparisons-as-one-rights-gated-projection.md),
  [ADR 0097](0097-chronology-prompts-are-structural-and-never-verdicts.md),
  [ADR 0121](0121-workspace-panels-keep-unsaved-changes-while-another-panel-opens.md),
  [ADR 0122](0122-the-draft-side-research-panel-inserts-only-checked-and-published-research.md)
- Coordinates with: the research-completeness contract of RW9 (ADR 0146 and ADR 0147 on
  `story/rw9-research-completeness`, still being revised) and
  [#194](https://github.com/journey-to-code-org/open.blog/issues/194), which exposes one
  readiness report and depends on this review

## Context

An author publishes a post by choosing Published or Scheduled and saving. Until now nothing
gathered what the research checks say about that post first: Evidence Studio shows the
research-profile and citation findings and the claims, but the atlas, chronology, alignment and
claims-file notices, the comparison projection's withheld wording and the integrity of the
private files the build reads live in other panels or only in `openblog check`. #62 asks for one
review before publication that groups those outcomes, links each to its object and repair, lets
warnings be acknowledged without calling them resolved, and claims nothing about truth or
fitness.

RW9 is defining one research-completeness contract for exactly this (the finding shape, a matrix
of validators, checks, categories, outcomes and gates, acknowledgements and their fingerprint),
and #194 will build its readiness report on it and on this review. That branch is unmerged and
still changing, so this review cannot import it, and building a second, different contract
would make #194 a migration.

## Decision

- **When it runs.** Saving a post whose status moves to Published or Scheduled (from a draft, a
  new post, or a scheduled post being published now) first opens the review, when the post is on
  the Research profile or publishes citations: the posts Evidence Studio is active for. Saving an
  already published post again, and every other post, works exactly as before, with no request.
  Evidence Studio also has **Review research before publishing**, which shows the same review
  without publishing anything.
- **One read-only route.** `POST /admin/api/research/review` takes the editor's unsaved fields
  and body, as a preview does, and loads the site with them through the preview's own loader. The
  post is read as a draft, so a citation the build would refuse once it is published is listed as
  a finding instead of stopping the review. It returns `applies: false` with no findings for a
  post outside the capability. It never saves the post, writes a research file, or publishes.
- **What it gathers, each from its owner.** This post's research-profile and citation findings
  from the draft's site load; this post's claim findings from `claim_review::review_claims`
  against the saved drafts, as Evidence Studio and `openblog check` give them; while the site
  publishes claim evidence, the claims file's notices about this post's claims. For every context
  link in the draft (ADR 0122), the new `context-link` check below, and for each linked page the
  next build publishes, the atlas notices and chronology prompts about that entry and the
  comparison's withheld places and alignment notices. And for each private file the build that
  publishes the post reads (the library and notebook whenever any research projection publishes,
  the atlas, the alignments and the claims file while theirs does), whatever stops the build
  from reading it, through the build's own loaders.
- **Failures are scoped to their file.** The library and notebook are read first. When one
  cannot be read, its own diagnostics (or one `file-unreadable` finding) are the findings, and
  the parts that depend on it are listed under `notReviewed` instead of blaming the atlas, claims
  or alignments file. A claims file that cannot be read while claim evidence is not published is
  `notReviewed`, never a finding. Nothing is repaired or replaced.
- **Only refusals block.** A finding blocks publication exactly when its gate is not advisory:
  `refuses-when-published` (citation syntax and resolution, which the build refuses for a
  published post) and `refuses` (an integrity or privacy failure of a file the build reads,
  which it refuses). Every `potential` and `needs-review` finding, and every notice, is advisory.
  The review lists the blocking findings first under "Must be fixed before publishing", then the
  advisory ones under Detected, Potential and Needs review. **Publish** (or **Schedule**) is
  disabled while anything blocks, with the reason in words (`aria-describedby`).
- **The contract's shape, through a thin adapter.** `openblog_core::publication_review` maps
  today's per-validator output into RW9's `CompletenessFinding` shape under the same names and
  JSON fields: `validator`, `check`, `code`, `category`, `outcome`, `gate`, `scope` (object, id,
  index, path, line, column, field), `related`, `message`, `repair`, and per review `fingerprint`
  and `acknowledgement`, with `counts` of each outcome (`found`, `acknowledged`) and
  `unmatchedAcknowledgements`. The tables are ADR 0146's matrix. The order is ADR 0146's total
  order; exact duplicates collapse. The review adds only `groups` (the positions of the findings
  in each group, in the order above), `applies`, `post`, `firstBodyLine`, `notReviewed` and the
  acknowledgements file's revision. There is no score, total, pass, ready or resolved field.

  | Today's output | Converter | Contract mapping |
  | --- | --- | --- |
  | `EvidenceFinding` (research profile, citations, claims) | `from_evidence` | ADR 0146's evidence rows; a claim finding is scoped to its claim, a link finding to its link with the claim related |
  | `AtlasDiagnostic` notices and errors (atlas, claims, alignments) | `from_atlas_diagnostic` | notices to the file's projection or places check, advisory; errors to its integrity check, `refuses` |
  | `ChronologyPrompt` | `from_chronology_prompt` | `chronology-consistency`, needs-review, advisory, every dating related |
  | `PublicComparison` withheld places | `from_comparison` | `withheld-rights` and `withheld-length` under `comparison-rights`, advisory |
  | `SourceDiagnostic`, `NoteDiagnostic` | `from_source_diagnostic`, `from_note_diagnostic` | `library-integrity`, `notebook-integrity`, `refuses` |
  | an unreadable file the build reads | `unreadable` | `file-unreadable` (adapter code) under the file's integrity check, `refuses` |
  | a context link to an unpublished page | `from_context_link` | `context-link-unpublished` under `context-link`, owned by `publication-context` |

- **One new check, proposed to the contract.** `context_links::review_context_links` owns
  `context-link`: whether each link to `/atlas/<id>/` or `/comparisons/<id>/` names a page the
  next build publishes (the site publishes those pages, the id exists, it is approved, and for a
  comparison `PublicComparison::project` accepts it). Its finding is scoped to the post at the
  link's line, relates the entry or alignment, is `detected`, category `public-boundary`, and
  advisory: the address is the author's own text, so a missing page is a gap, not a leak. Its
  fact is the address.
- **Rows this review adds to the matrix.** The contract keeps these; #194 must add them to
  ADR 0146's matrix when it replaces the converters, rather than drop or rename them, so
  acknowledgements stored in the meantime keep their keys:

  | Kind | Added | Owner and mapping |
  | --- | --- | --- |
  | validator | `publication-context` (`Validator::PublicationContext`) | `context_links::review_context_links` |
  | check | `context-link` (`Check::ContextLink`) | owned by `publication-context` |
  | code | `context-link-unpublished` | `context-link`, `public-boundary`, `detected`, advisory; fact: the address |
  | code | `file-unreadable` | the unreadable file's integrity check (`library-integrity`, `notebook-integrity`, `atlas-integrity`, `claims-integrity`, `alignments-integrity`), `integrity`, `detected`, `refuses`; no facts |

- **What #194 swaps.** #194 replaces the converters with `research_completeness`'s and the
  review with `CompletenessReport`, keeping `groups`, the route and the rows above. The
  validators state RW9's position-free facts (`EvidenceFinding::facts`, `AtlasDiagnostic::facts`
  and `ChronologyPrompt::facts`, set with `with_facts` exactly as RW9 sets them per code: a
  footnote's name, a DOI or licence as written, a citation's code and key, a claim's linked
  evidence, a notice's ids, a dating's id, aspect and stated date), and the converters pass them
  through, so a fingerprint here equals the contract's for the same finding and no stored
  acknowledgement goes stale at the swap. Two findings that share a key without an id or field
  (two unresolved footnotes on one post) are told apart by their facts, so acknowledging one
  never acknowledges the other.
- **Every item links to its object and repair.** A finding on the post goes to its line in the
  Markdown source (switching the view to Markdown without changing the saved writing-mode
  preference) or to its front matter field; a claim or evidence link opens it in Evidence Studio;
  a source, atlas entry, atlas relationship or comparison opens by its own address in the research
  workspace (Sources now opens a source by id, `#/research/sources/<id>`, and the Knowledge Atlas a
  relationship, focused, by `#/research/atlas/relationships/<id>`), keeping the unsaved draft
  (ADR 0121); a file-level finding opens its panel. Going anywhere closes the review without
  saving.
- **Accessible and keyboard operable.** The review is a modal `dialog` named by its heading and
  described by the sentence that says these are prompts, never verdicts. Focus starts on the
  heading and returns to Save; Escape keeps editing. Each group is a labelled section with a
  list; counts and acknowledgement results are announced in a polite status region; a refused
  acknowledgement is an alert on that finding alone. Acknowledge is a toggle with `aria-pressed`
  and a stable name. It reflows at 320 pixels and adds no motion.
- **Author-only.** The review is private Admin output behind the session, CSRF token and
  deny-by-default router. Messages are the validators' own, naming ids, fields and stated
  values; no statement, note, excerpt, label or rights note is included. Nothing reaches a
  public page, feed, export or log.

## Consequences

- Publishing a research post shows, in one place, what every research check says about it, and
  only a deterministic integrity or privacy failure can stop it.
- A post that is not a research or cited post is unaffected, and an Admin without the research
  capability never sees the review.
- #194's readiness report can present the same groups from the contract without changing the
  route or the Admin.
- The review runs the site load a preview runs, so it costs about one preview.

## Domain language

**Research review before publication**, **Blocking finding** and **Context link check** are
defined in [`CONTEXT.md`](../../CONTEXT.md).

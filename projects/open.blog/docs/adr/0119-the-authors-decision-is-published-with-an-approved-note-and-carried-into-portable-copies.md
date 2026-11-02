# ADR 0119: The author's decision is published with an approved note, read against the post as it is now, and carried into portable copies

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#218](https://github.com/journey-to-code-org/open.blog/issues/218)
- Parent story: [#199](https://github.com/journey-to-code-org/open.blog/issues/199)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0075](0075-publish-approved-claim-evidence-in-the-post-with-public-revision-notes.md),
  [ADR 0083](0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md),
  [ADR 0116](0116-evidence-submissions-are-suggested-sources-and-corrections-with-unverified-reader-evidence.md),
  [ADR 0117](0117-only-the-authors-correction-decision-labels-a-correction.md),
  [ADR 0118](0118-evidence-and-correction-decisions-are-taken-opt-in-and-decided-in-the-inbox.md)
- Amends: ADR 0083 (the file's version and what a portable copy carries) and ADR 0118 (the limits
  and fallbacks listed under "Amendments" below)
- Coordinates with: [#92](https://github.com/journey-to-code-org/open.blog/issues/92) (portable
  publishing)

## Context

ADR 0117 said a decision is public only beside a reader's note that is itself public, and left the
copying to #218. #218's acceptance criteria are that pending, rejected and private submissions never
render, that a correction names the revision it affects and the change it made, and that portable
copies keep the outcome, the evidence links and the canonical discussion URL. The site must keep
building without the hosted service, so what is published has to live in the versioned file ADR 0083
already uses, and a portable copy must say what the canonical page says without a script.

## Decision

- **The decision travels with the note, in the same file.** `reader-feedback.json` items may carry a
  `decision` (`feedback_publication::PublishedDecision`): the outcome id, `extent`, `declineReason`,
  the author's `rationale`, the post's `evidenceRevisions` item as written, the `claimEvidence` link
  `{claim, link}`, the day decided and how many decisions it superseded. It holds nothing about who
  decided, no passage check, no item id another decision pointed to (`addressedBy`) and nothing the
  reader wrote; unknown fields are refused, so none can be added by hand. The file is read with the
  rules the policy applied (`DecisionContent::checked`), so a decision that could not have been
  recorded cannot be published.
- **When it is copied.** Admin copies the decision in force (`PublishedDecision::in_force`, which is
  none for a decision about earlier words) when a note is approved and published, and again when the
  author records a decision on a note that is already on its post (`publish_decision_outcome`), which
  rebuilds the site and says so in the status line. Recording a decision never publishes a note: an
  item that is not in the file is left alone, and an item that is rejected, removed or withdrawn
  leaves the file with its decision. A hosted service that stores no decisions publishes none.
- **Versioning keeps legacy files byte for byte.** A file with no decision is written as version 1,
  exactly as before; one holding a decision is version 2 (`READER_FEEDBACK_OUTCOMES_VERSION`). A
  reader accepts 1 and 2, refuses a decision in a version 1 file and refuses anything newer.
- **The page reads the decision against the post as it is now** (`PublicOutcome`, computed by
  `project`). The outcome is a static `div` inside the note's article with a heading naming the
  decision, its day and a sentence in the author's voice (a correction "and changed the post"; a
  clarification "which does not say it was in error"; evidence added "without changing the claim's
  words"; declined with the author's ground; already addressed), then:
  - **the affected revision**: the passage revision the reader saw, and that the passage has been
    revised since when it has;
  - **the resulting change**: the revision note, with its claim number while the post publishes that
    claim, linked to the post's own "Revision notes" heading only while the post still publishes that
    note (`PostEvidence::revisions_fragment`); a note the author removed stays as the author's
    recorded words, unlinked;
  - **the evidence the author recorded**, as a link to the claim's heading labelled by its relation
    and source, only while the post still publishes that claim and link; otherwise one sentence says
    the recorded evidence is not published on this page, naming nothing (the wording is neutral on
    purpose: a CI build lacks the git-ignored claims file, so it cannot tell a withdrawn link from a
    link it cannot read);
  - the author's rationale, escaped, paragraph by paragraph.
- **A suggestion nobody decided is unresolved**, never settled: "Unresolved: not yet decided by the
  author", with the sentence that it is a reader's suggestion and not a settled correction. This
  appears only on a site that takes evidence (`engagement.evidence`), so every other site's page is
  as before; a decision in the file always shows. Questions and other readings have no outcome. The
  heading names the state, and an unresolved outcome has a dashed rule instead of a solid one, so
  nothing relies on colour.
- **Portable copies keep the outcome, not the note.** A post whose published notes have an outcome
  adds a section, "Reader suggestions and the author's decisions", to its portable HTML, Markdown and
  text (and so to full-content feeds and portable exports): per note, what kind it is and where it is
  about, "From a reader" or the name the reader agreed to show, the day received, the same outcome
  words, the revision note and evidence link as absolute links to the canonical page, the rationale
  as text, and a link to the note's place on the canonical page, the canonical discussion. The
  reader's own words, quotation and suggested wording stay on the canonical page, as ADR 0083 had
  it; the existing "Questions and corrections" link remains. Every value is escaped (Markdown
  escapes inline text and blocks nothing from opening). The portable semantic facts include each
  outcome, its revision note, its rationale, its evidence link and its discussion link, so a copy
  that lost any of them is refused like any other lossy copy.
- **What does not carry them.** `llms.txt`, `llms-full.txt` and the search index keep reading only
  the post's own text, so neither a note nor an outcome reaches them. Nothing pending, rejected,
  removed, withdrawn or private is in the file, so nothing of it can render, and the decision log,
  who decided, passage checks, evidence of unpublished items and reader identity stay in the hosted
  service and the private audit record.
- **No hosted schema change.** Everything here is the versioned file and the build. The additive,
  opt-in schema of ADR 0118 and its rollback are unchanged.

## Amendments to ADR 0118

- **A decision names the text it was read on.** The request carries `itemRevision`, the revision of
  the reader's text the author read. Admin answers `409` with the item as it is now when a
  clarification has raised it since, and the hosted function answers `stale` (not `malformed`) when
  the decision's revision differs from the stored one, so a decision is never recorded about words
  the author did not read. A hosted refusal because the item closed or awaits a clarification
  between the two reads is also `409` with a re-read item. A revision note or claim evidence link is
  refused when the item's post is unknown, and the post file and claims are read and checked under
  the content lock, which is released before the hosted call.
- **A stored block always fits the store.** `evidenceTooLarge` bounds the block's canonical size,
  counted as Postgres writes it as `jsonb` text (a space after every `:` and `,`), at 4096 octets in
  both readers, so every block the validators accept satisfies the SQL check and a replay claim or
  quota is never spent on a row that cannot be stored.
- **Evidence off still moderates.** A version 2 row read without its evidence column is the version
  1 record it also is: the function emits version 1 and the Rust reader tolerates a version 2 record
  without a block (a block in a version 1 record is still refused).
- **Rolling back the inbox removes the decision function** that reads the columns it drops.

## Considered options

- **Publish from the hosted log at build time.** Rejected: a build must not need the hosted service,
  and the log holds who decided.
- **Show every pending decision beside an unpublished note.** Rejected in ADR 0117 and kept: it would
  reveal a submission the reader withdrew or moderation kept back.
- **Put the reader's words in portable copies.** Rejected: ADR 0083 keeps notes on the canonical page,
  where moderation and reporting live; the outcome and the link say what is needed elsewhere.
- **Call every undecided suggestion unresolved on every site.** Rejected: sites that never took
  evidence would change without choosing to.

## Consequences

- A reader can see, in context, what the author decided about a published suggestion, the revision it
  was about, the change it led to and the evidence recorded, without mistaking a pending claim for a
  settled fact, and a feed reader or export gets the same words with links back.
- A version 2 file is refused by an older open.blog, which names the file; remove the decisions or
  upgrade.
- The portable section grows a post's portable copy by the outcome text only.

## Domain language

**Published outcome** and **Unresolved suggestion** are defined in [`CONTEXT.md`](../../CONTEXT.md).

## Amendments after review

- **A public decision names only what the post publishes.** The claims file is private and the
  published decision is public, so a decision is refused (`claimEvidenceNotPublished`) unless its
  claim and evidence link are approved and published (`ClaimSet::is_projected`) on the item's post,
  the decision form lists only such links, and the link is checked again when the decision is
  copied into `reader-feedback.json` (on approval, on "Publish on the post" and when a decision is
  recorded). A link that is not publishable then is omitted from the published decision and a
  private id is never copied; an accepted-as-evidence outcome without a link is still a valid
  published decision, and the page says the evidence is not published on this page.
- **The conservative choice for rendering.** The published decision carries only the claim and link
  ids, not the claim's statement or the source text, so the page still needs the claims file to
  render the link and shows the neutral sentence without it. Copying public text into the file was
  rejected: it would make a second copy that can drift from the claims file.
- **Recovery carries the decision, and a difference is repairable.** "Publish on the post" reads
  the item through the inbox, which carries decisions. The inbox flags a published note whose
  decision is not the one in force (`decisionPublished`) and offers "Update the published
  decision", which republishes only the decision. An outcome is written only for a note readers see
  now: approved at its current text.
- A decision takes the build lock before the content lock, as other writers do, and releases both
  before the hosted call.

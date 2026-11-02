# ADR 0137: An approved author response is published under its reflection in the one public file, and shown only where the one rule says so

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#224](https://github.com/journey-to-code-org/open.blog/issues/224)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0128](0128-only-the-bound-contributor-who-wrote-a-section-may-answer-as-its-author.md),
  [ADR 0130](0130-attributed-perspectives-store-the-responder-publish-nothing-by-themselves-and-leave-static-reading-whole.md),
  [ADR 0132](0132-an-author-response-is-one-more-row-of-the-existing-feedback-table-stored-through-one-admin-route-behind-one-flag.md),
  [ADR 0134](0134-answers-are-moderated-in-the-one-inbox-under-a-shown-parent-and-never-approved-by-their-own-author.md)

## Context

#223 let an author write an answer and a coordinator approve it, but nothing showed it. Pages are
static: ordinary reading, CI builds and a site that left its hosted service must work without it, and
the site's repository may be public. RD10 solved this for reflections with a versioned public file
that Admin writes and the build reads (ADR 0115); an answer follows the same pattern.

## Decision

- **An answer is an `answer` on its reflection's record in `third-perspectives.json`.** It is not a
  second file, because an answer never outlives or contradicts its reflection (ADR 0134) and one
  record leaves nothing to keep in step. It holds only public fields: the hosted row's id (the handle
  an abuse report names and Admin takes off by), the contributor registry key, the name the section
  was published under, the text, and the days received and approved. Never the participant, the Admin
  account, a moderator, a reason or a time of day. The file is read strictly: an unknown field, a
  contributor other than the one the reflection's section is credited to, an `answer` on a reflection
  about the whole work or a heading, a repeated id or a malformed value refuses the build, naming the
  item and never what it holds.
- **The file is version 2 only while it holds an answer.** Without one it is written as version 1,
  byte for byte as before, so a site that never turns answers on, or whose answers are all taken
  off, keeps the file it had. A version 1 file that carries an `answer` is refused (an older reader
  would have ignored it and shown a reflection without the answer its author gave); a version above
  2 is refused as before.
- **Shown only where the one rule says so.** `project_post` hands the record to
  `attributed_perspective::response_shown` with the facts the file implies (approved, retained), so
  the answer shows only when it is public in its kind's published mode, its reflection is public in
  its own, and the stored responder is the contributor the reflection's section is credited to. A
  post that hides or switches off `author-response` shows no answer and the projection is exactly what
  it was before answers; hiding the reflection's kind hides the answer with it. The author's name on
  the page is the section's author as published now, and the name it was answered under only when
  that section has gone.
- **Admin writes it, with the reflection.** Approving an answer, after the parent and responder
  checks of ADR 0128, publishes it under its reflection (publishing the reflection first if it is
  not on the file), under the content lock, and then rebuilds. Rejecting, removing, deleting a
  closed answer or reopening it takes it off its reflection and leaves the reflection; the author's
  withdrawal takes it off; removing the reflection takes its answer with it. A reflection published
  again keeps its answer.
- **Withdrawal and take-off follow RD10's banner pattern.** The card of an answer says whether it is
  on the post (`published`) and whether the hosted copy may be shown now (`mayBeShown`), with one
  button for the site Admin to publish an approved answer that is not on the post or take off one
  that may not be shown (`POST engagement/author-responses/publish` and `/unpublish`, re-checked
  against the hosted copy and, for a publish, its parent). The audit of the published file
  (`GET engagement/third-perspectives/published`) adds `answersMustComeOff`, and the inbox shows on
  every tab a banner counting the answers that must come off, with one take-off button each, apart
  from the reflections' own, and says the reflection stays.
- **No hosted schema change.** The function stores and moderates answers as before (ADR 0132) and
  publishes nothing. There is no new SQL and so no rollback file. To roll the feature back, remove
  `OPENBLOG_AUTHOR_RESPONSES_ENABLED` and set `author-response` to `hidden`: pages show no answers,
  and `third-perspectives.json` can be left alone (or its `answer` fields removed and its version set
  to 1).
- **At most one answer is shown per reflection, and the static file is what guarantees it.** The
  function refuses to approve an answer while another answer to the same reflection is approved
  (`409 alreadyAnswered`), but that check is check-then-act and not transactional: two approvals
  racing can both pass it. The public file is the backstop. It holds one `answer` per reflection,
  and Admin refuses to publish a different answer onto a reflection that already shows one (the
  author's earlier answer is taken off first), so a page never shows two.

## Considered options

- **A second file for answers.** Rejected: two files can disagree about whether an answer's reflection
  is published.
- **Always write version 2.** Rejected: it would change the committed file of every site that
  publishes reflections, for nothing.
- **Reading answers from the hosted service at build time.** Rejected: pages must build without it
  (ADR 0081).

## Consequences

An answer is as public as its reflection and no more: taking the reflection off the page, hiding its
kind or withdrawing the answer removes it from the next build, though copies already published (the
site's history, feeds and the repository's history) may remain, which is what Admin says.

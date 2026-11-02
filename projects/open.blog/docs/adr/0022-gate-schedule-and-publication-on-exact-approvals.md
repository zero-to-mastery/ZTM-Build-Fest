# ADR 0022: Schedule and publish only on exact approvals, as one all-or-nothing operation

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#168](https://github.com/journey-to-code-org/open.blog/issues/168)
- Parent story: [#147](https://github.com/journey-to-code-org/open.blog/issues/147)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0014](0014-record-level-authorization-and-publish-gate.md) put the publish grant behind
`SharedPublication::authorize` and said publishing needs approval. [ADR 0020](0020-approval-snapshots-bound-to-exact-content.md)
defined approvals bound to exact content and `ApprovalSet::evaluate`, and
[ADR 0021](0021-combined-review-preview.md) let an author read the piece before approving. Nothing
yet approved, scheduled or published, and the existing scheduler publishes any post whose date has
come, so a scheduled Post written into content would skip any later check.
[ADR 0018](0018-reveal-policy-readiness-and-comparison.md) fixed that a publication has one author
set, the participants the maintainer added.

## Decision

- Four routes, all deny-by-default and all through `SharedPublication::authorize`:
  `POST collaboration/approve` and `approve/withdraw` (the author's own draft grant and
  `ApproveContribution` on themselves), `schedule` and `publish` (`authorize_publish`, plus the
  `Schedule` grant for scheduling). A requester without the grant, an unknown publication and a
  removed account all get the same `404`. Only a requester who holds the publish grant is told
  that approvals are missing, and then only as display names, never prose, revisions or digests.
- `assembly::assemble` is pure. It builds the Post only when `ApprovalSet::evaluate` says every
  required author approved the content as it is now, using the same `with_subject` that approvals
  are bound through, so the token a preview hands out and the gate cannot drift apart. It reads the
  latest revision of each active author's draft: exactly the revisions the approvals cover.
- The Post is `posts/<publication id>.md` with a credit sidecar. The path is opaque and the same
  on every retry. Sections follow participant order, separated by a rule. Credit follows written
  sections (an author who wrote nothing has no credit, ADR 0015), through the existing credit
  model. The only collaboration data in the Post is the public attribution of ADR 0008.
- Co-author prose is untrusted by the site owner. Native pages pass authored HTML and link
  addresses through, so a section with raw HTML or an active address (`javascript:`, `data:`) is
  refused with a message that quotes nothing, rather than altered, because the approval is for the
  exact text. Markup shown as code is fine.
- The safety check runs on the exact joined body the site will render, with the site's own parser
  options, never on sections alone, because Markdown can act across the section rule. Besides raw
  HTML and active addresses it refuses heading attributes beyond an id and classes (`{onclick=...}`),
  and refuses the whole piece when the joined parse differs from the sections parsed one by one and
  joined by a rule (an open fence, a reference definition or a footnote in one section reaching
  another). So the Post renders as the concatenation of what each author previewed and approved,
  and one author cannot change how another's section reads. The check does not know the site's
  smart punctuation setting, so it must hold under both.
- Publishing is one unit under the Admin content lock: assemble, check the site would build it,
  write the Post and credits, record the outcome, rebuild. Any failure restores the files and the
  outcome and rebuilds, so content, collaboration state and public output are unchanged. The
  outcome (`published`) lives in private storage beside drafts and approvals, written with a
  compare-and-swap so a concurrent change is a conflict, not an overwrite. A retry of a published
  reflection succeeds and writes nothing. If an earlier attempt wrote the files and then stopped,
  a retry recognises its own file (even with the original date) and finishes; a different file in
  that place is never overwritten.
- Refusals never repeat prose. Site-build problems quote the authors' text, which the publisher
  may not be entitled to read, so they are replaced by one fixed sentence.
- Scheduling does not write content. It checks the same gate now (an unapproved or unbuildable
  piece is never held), then stores only the time and the requesting account in private storage.
  When the time comes the scheduler runs the same publish operation, re-checking the approvals
  against the content as it is and the requesting account's grant, so an edit, a removal or a
  withdrawn approval after scheduling holds the reflection back, privately, with nothing public.
  It publishes when the approvals are whole again. Scheduling again changes the time; a null time
  cancels. Published reflections cannot be scheduled, approved or withdrawn again.
- Routes that change the author set or the prose (saving a draft, removing or changing a member,
  accepting an invitation) call `ApprovalSet::reconcile` in the same transaction, so removing and
  restoring an author, or reverting an edit, cannot revive consent given earlier. Validity is also
  recomputed on every read, so a failed reconcile still fails closed.
- Approving needs the `seen` token, issued only for a complete preview (ADR 0021). An author who
  cannot yet read every section therefore cannot approve unseen content. An author who holds only
  the Editor role can draft but not approve; under `allAuthors` that blocks publishing until the
  maintainer gives them the Contributor role.

## Consequences

- Stale or missing approval, a non-grant holder, unsafe prose, a colliding file and a failing
  build all end with nothing written. The approval policy has no route yet, so every publication
  uses `allAuthors` and `ownSections`.
- The Admin screens for approving, scheduling and publishing, and the portable and feed
  projections of the resulting Post, are separate work (#169 and later).

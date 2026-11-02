# ADR 0021: The combined review preview shows only what the reader may read, at exact revisions

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#167](https://github.com/journey-to-code-org/open.blog/issues/167)
- Parent story: [#147](https://github.com/journey-to-code-org/open.blog/issues/147)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

Before an author approves ([ADR 0020](0020-approval-snapshots-bound-to-exact-content.md)) they need
to read the combined piece, each author's approval state, and whether the approvals still count.
[ADR 0016](0016-private-contribution-revisions-and-mutual-reveal.md) and
[ADR 0018](0018-reveal-policy-readiness-and-comparison.md) decide who may read which revision, so
the preview must not widen that, and it must not look like a published page.

## Decision

- The preview is a pure read (`preview::build`). It writes no draft, approval, content or output,
  so any failure leaves them unchanged. A route serves it through the same `EditDraft` check as the
  other draft routes: only a current author (a participant the maintainer added who holds the draft
  grant) can open it. A reader, a coordinator who is not an author, a removed member, a stranger
  and an unknown publication all get the same not-found.
- Sections follow participant order and each author appears once. A section is rendered only
  when `DraftSet::view` lets the requester read the author's *latest* revision: their own, or one
  revealed to them that is still the latest. An older revealed revision, a newer unmarked one, a
  withdrawn draft, an unshared draft and an author who wrote nothing all produce the same
  placeholder, with no revision number, digest or prose. The preview therefore never shows a piece
  that differs from what an approval or the final assembly would cover, and it is no oracle for
  whether a draft exists.
- The requester sees every active author's approval state: approved, awaiting, or stale (an
  approval is stored but its binding no longer matches the content, frame or policy), and whether
  the policy requires it. Authors need this to coordinate; it holds no prose. Stale is derived with
  `ApprovalSet::state`, never stored.
- The piece is `complete` only when every section that exists is shown, and `ready` only when it
  is complete and `ApprovalSet::evaluate` passes. An author who has written nothing has no section
  and does not block completeness, so the others can still review and approve, and under
  `contributingAuthors` the piece can be ready without them (ADR 0020). The approval token
  (`seen`) is issued only for a complete piece, so nobody approves content they were not shown.
  Per-section output stays identical for "wrote nothing" and "not shared", but the piece-level
  `complete` now reflects whether a section exists. That gives away little: the reveal routes
  already tell authors whether others offered a revision. A non-writer sees no one else's prose
  under the reveal rules, since they have nothing to offer, so their own preview stays incomplete;
  whether such an author may approve unseen content is left to the approval step (#168).
- Prose is rendered by the production Markdown renderer with the site's own options
  (`SiteConfig::render_options`, which `Site::load` also uses): smart punctuation, heading
  anchors, embeds and the code runner follow `openblog.json`, so the preview's HTML for a section
  equals the post pipeline's for the same Markdown. A test renders the same source through
  `load_post` and compares. Images, embeds and the runner are neutralised only by the document
  policy below, not by changing the render options. Each section renders on its own, so
  broken syntax in one cannot bleed into the next. Source attribution is the approved public
  subset only (ADR 0008). Credits are out of scope for the preview: it lists authors for approval but does
  not show the byline or Work credit the published piece will carry. Credits come from the final
  assembly, so they move to the publication story (#168). This changes the scope of #167 and
  needs the maintainer's confirmation on the issue.
- The document cannot be mistaken for a published page and cannot run or fetch anything: it opens
  with a "Preview, not published" notice, is marked noindex and no-referrer, and carries a policy
  of `default-src 'none'` (no scripts, frames, forms, images, fonts or network). Images and
  embeds are not loaded, because another author's remote image would tell them when you read it.
  Admin serves it from its own address with that policy and shows it in a frame with an empty
  `sandbox`, so hostile raw HTML, `javascript:` links and tracking pixels do nothing, and it works
  without JavaScript. The summary JSON carries no prose.
- Approvals are read from private storage (`approvals/<id>.json`, absent means none). A file that
  exists but cannot be read is an error, never an empty or approved set. Writing approvals is not
  part of this decision.

## Consequences

- Authors review the whole piece only once it is entirely shared with them; until then they see
  their own section and placeholders, which matches the sharing rules.
- Hostile raw HTML still renders as production does inside the document; the containment is the
  policy and the sandbox, not sanitising, because the final output is the production renderer's.
- Heading ids may repeat between sections of the preview, since sections render separately.

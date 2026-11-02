# ADR 0114: The Third Perspective form is one progressive region with explicit consent and a copy or contact fallback

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#221](https://github.com/journey-to-code-org/open.blog/issues/221)
- Parent story: [#201](https://github.com/journey-to-code-org/open.blog/issues/201)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0061](0061-citation-previews-are-a-progressive-non-modal-component.md),
  [ADR 0082](0082-passage-feedback-forms-are-one-progressive-region-over-the-build-passage-text.md),
  [ADR 0109](0109-third-perspectives-are-reader-reflections-with-optional-prompts-and-four-distinct-stages.md),
  [ADR 0113](0113-third-perspectives-are-one-feedback-row-submitted-through-the-one-route-with-a-receipt.md)

## Context

Readers need a way to offer a reflection that keeps reading intact: without JavaScript, without a
hosted service, offline, at 320px and 400% zoom, under the strict content security policy, with
a keyboard and a screen reader. The consent a Third Perspective carries (ADR 0110) must be given,
never assumed, and no part of the form may look like a rating or a vote.

## Decision

- **Where it appears.** Only a post where `effective_mode(.., ThirdPerspective)` is `open`
  (`participation.kinds`, the post's own mode, a hosted transport) gains the region
  `<section id="ob-third-perspective">`, headed "Offer a Third Perspective", after passage
  feedback and before comments, plus the passage data element (shared with passage feedback, once)
  and the component's module script. Locked and hidden posts, sites that leave the kind off,
  feeds and portable copies are unchanged; the region is outside the article. (Amended by
  [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md):
  a post that shows or offers Third Perspectives now adds one labelled link to its canonical page
  in portable copies and feeds.)
- **The static region is the no-JavaScript path.** It says what a reflection is, that it is shown
  only as a reader's, only as the reader agrees and never with scores or votes, and how to write
  to the author instead (`engagement.feedbackContact`, linked): which section, whether it may be
  published, whether the name may be shown and whether they may be asked to clarify, and the
  passage revision, printed in the region.
- **The form** (`<ob-third-perspective>`, `web/components/ob-third-perspective.js`, embedded in
  `EMBEDDED_WEB` with `third-perspective.js` and loaded with the site's `?v=` asset version)
  replaces only the static paragraph with native controls in one column: a radio group for the
  whole work or one section (a select of heading titles), a radio group of the optional prompts
  with "No prompt" chosen and each prompt's question as its description, the reflection, a
  required "May it be published?" radio group with nothing chosen, an optional name with an
  unchecked "Show my name" box, and an unchecked "You may ask me to clarify it". All state is in
  private fields, so nothing shadows an `HTMLElement` property; every string is set as text; it
  uses no inline script or style and talks only to the configured endpoint, without credentials.
- **Consent is explicit.** Sending without choosing about publication is an error on that group.
  Choosing "No" sends nothing: the reflection is offered as text to copy, marked "Not for
  publication", to send privately. A shown name needs a name. The values sent are exactly the
  reader's choices, checked by the shared validator before anything leaves the page.
- **Hosted only with receipts.** The form sends to `/feedback` only when the page says the service
  issues receipts (`receipts`); otherwise its button reads "Prepare to send to the author" and it
  goes straight to the copy path. Success says it is published only if a moderator approves it,
  clears only the reflection, moves focus to the thank-you, and shows the receipt once with the
  clarification consent already given; the receipt tools are offered in the region.
- **Failure keeps the prose.** Offline, a network failure, a timeout, `429` and `5xx` show the
  reason, a "Try again" button that sends the same reflection, the copy (`thirdPerspectiveCopyText`,
  ending with the record line the author can enter) and the contact link; `404`/`unavailable` and
  a closed post offer the copy without a retry; `409 duplicate` says it is already waiting; a
  field the service refuses is marked on that field. Nothing the reader wrote is cleared by a
  failure, and nothing is stored in the browser.
- **Announcements and focus** follow ADR 0082: the first problem is marked (`aria-invalid` and
  its error added to the description), written to the form's `role="alert"`, and focused; pending
  is `aria-busy` with an `aria-disabled` "Sending…" button and a polite status outside the form,
  and a second submit waits.

## Considered options

- **A checkbox for publication.** Rejected: an unchecked box reads as "no" and a checked default
  as consent nobody gave; a required radio group makes the reader say which.
- **Sending a reflection the reader did not agree to publish.** Rejected: a Third Perspective is
  offered for publication (ADR 0110); a private thought goes to the author by the reader's own
  channel, and the copy makes that easy.
- **Reusing `<ob-passage-feedback>`.** Rejected: quotations, kinds and selection belong to passage
  feedback; a reflection is about the whole work or a section and has its own consent.

## Consequences

- Readers always have a way to offer a reflection: the form, the copy, or the static text.
- #222 can place approved responses before the region on the canonical page without changing it.

## Domain language

**Third Perspective region** is defined in [`CONTEXT.md`](../../CONTEXT.md).

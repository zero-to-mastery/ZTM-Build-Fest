# ADR 0082: Passage feedback forms are one progressive region per open post, over the passage text the build publishes

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#82](https://github.com/journey-to-code-org/open.blog/issues/82)
- Parent story: [#29](https://github.com/journey-to-code-org/open.blog/issues/29)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0076](0076-passage-targets-are-section-anchors-with-quoted-context.md),
  [ADR 0079](0079-typed-scholarly-feedback-kinds-and-one-submission-format.md),
  [ADR 0081](0081-hosted-feedback-transport-is-opt-in-and-reuses-the-engagement-seam.md),
  [ADR 0061](0061-citation-previews-are-a-progressive-non-modal-component.md)
- Coordinates with: [#124](https://github.com/journey-to-code-org/open.blog/issues/124) (P6.2
  canonical-only fallbacks), [#83](https://github.com/journey-to-code-org/open.blog/issues/83)
  (moderation), [#84](https://github.com/journey-to-code-org/open.blog/issues/84) (annotations)

## Context

ADR 0076 decided that the build, not the browser, owns a post's passage text, and that pages would
publish it only behind the feedback opt-in. ADR 0079 fixed the kinds and the one submission format,
and ADR 0081 the hosted route. Readers now need a way to use them: pick a passage, say what kind of
note it is and write it, with or without JavaScript, with or without a working service, at 320px and
under the strict content security policy Admin serves pages with. Pages of sites that do not opt in
must not change.

## Decision

- **Where it appears.** Only the page of an *open* post on a site with hosted engagement, an
  endpoint and `engagement.feedback` carries the feature; locked and hidden posts have none, as the
  hosted function refuses them (ADR 0081). Such a page gains exactly three things: the passage data
  element and the component's module script in the head, and one feedback region after the post's
  navigation (`<section id="ob-feedback">`, headed "Questions and corrections"). Every other page,
  feed and portable output is byte-for-byte unchanged, which a build test compares file by file.
- **Passage data.** `<script type="application/json" id="ob-passages">` holds
  `{version: 1, work, revision, sections: [{index, anchor?, title?, text, digest}]}`, built from
  `PassageDocument::of_post`. `title` is the heading's own title, taken in order for an anchor that
  repeats, and only labels the form's section choices. The JSON is escaped (`<`, `>`, `&`, U+2028,
  U+2029) so no text can end the element. The browser checks every field; a malformed or newer
  document leaves the static region as it is, never shifting section indexes.
- **The static region is the no-JavaScript path.** It says what readers can send, that the author
  reviews everything, and how to send a note without the form: name the section by its link, quote
  the words and give the passage revision, printed in the region. An optional
  `engagement.feedbackContact` (a plain `mailto:` address without a query, or an `https:` page
  without credentials, validated when the configuration loads) is linked there. Nothing else about
  the author is published.
- **The form** (`<ob-passage-feedback>`, `web/components/ob-passage-feedback.js`) replaces only the
  "needs JavaScript" paragraph with native, labelled controls in one column: a fieldset radio group
  for the passage (the whole post, a section chosen from a select of heading titles, or the words
  the reader selected), the kind (a select with a short hint for each), the note, a source link
  (required only for a suggested source), suggested wording (only for a suggested correction), and an
  optional name with an unchecked box to show it if the author publishes the note. All state is in
  private class fields, so nothing can shadow an `HTMLElement` property (the lesson of ADR 0061).
- **Selections map onto the build's text.** On `selectionchange` the component reads the selection
  only to name its section (the last heading in the prose with a section anchor before it, told
  apart by order when anchors repeat) and to estimate where it starts. The selected string is
  normalized and searched for in that section's published text; the quotation, its context and its
  start come from that text through `createQuoteTarget`. Words found more than once are chosen by
  the estimate and refused when it cannot decide; words that are not passage text (a note marker,
  code, an embed, text across sections) are refused with an explanation. Nothing is guessed, and the
  article is never changed, marked or hidden. A usable selection shows a button beside it, placed by
  CSS custom properties, which chooses the words and moves focus to that choice; the last usable
  quotation is kept when the selection is lost.
- **Validation and announcements.** A submission goes through `readFeedbackSubmissionJson`, the
  same rules as the build and the function. The first problem is marked on its control
  (`aria-invalid` and an error description), written to the form's `role="alert"` region, and given
  focus. Pending is explicit: the form is `aria-busy`, the button reads "Sending…" and is
  `aria-disabled` (still focusable), a second submit waits, and a polite status line outside the
  form says what is happening. Success clears the note fields, keeps the name, and moves focus to a
  thank-you message that says nothing is published without the author's approval.
- **Failure falls back to copy and send.** Offline, a network failure or timeout, `404` or
  `unavailable`, `429` and any other failure show the reason and the note as plain text in a
  read-only text box (`feedbackCopyText`), a Copy button (the clipboard, or the text selected for
  the reader to copy) and the contact link, with a `mailto:` subject and, when the link stays short,
  the note as its body. Focus moves to the explanation. A post that became `closed` says so and
  offers no copy; a field the service refuses is marked on that field. Nothing the reader wrote is
  cleared by a failure, and nothing is stored in the browser.
- **Requests.** The form talks only to the configured endpoint's `/feedback` route, without
  credentials; it loads nothing else, uses no inline script or style, and runs under the strict
  policy of ADR 0061 with that endpoint allowed by `connect-src`.

## Consequences

- A reader always has a way to send a passage-specific note: the form, the copy, or the static
  instructions; reading never depends on any of them.
- Pages that offer feedback carry their passage text a second time, as data; for the posts this is
  meant for that is small, and it buys exact agreement with the build (ADR 0076).
- Annotations (#84) can read the same data element; publishing approved feedback (#83) is a build
  projection and needs nothing from the form.
- Portable copies still carry no form. A labelled canonical link to the feedback region, like the
  discussion link, can be added under P6.2 when approved feedback is published.

## Domain language

**Passage data** and **Feedback region** are defined in [`CONTEXT.md`](../../CONTEXT.md).

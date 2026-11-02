# ADR 0115: Approved Third Perspectives publish from a versioned public file, readers see their status by receipt, and portable copies only link to them

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#222](https://github.com/journey-to-code-org/open.blog/issues/222)
- Parent story: [#201](https://github.com/journey-to-code-org/open.blog/issues/201)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0083](0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md),
  [ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md),
  [ADR 0107](0107-reader-receipts-deletion-requests-and-anonymous-abuse-reports.md),
  [ADR 0111](0111-third-perspective-lifecycle-and-its-one-public-projection.md),
  [ADR 0113](0113-third-perspectives-are-one-feedback-row-submitted-through-the-one-route-with-a-receipt.md),
  [ADR 0114](0114-the-third-perspective-form-is-one-progressive-region-with-explicit-consent.md)
- Coordinates with: [#92](https://github.com/journey-to-code-org/open.blog/issues/92)
  (canonical-only interaction), [#214](https://github.com/journey-to-code-org/open.blog/issues/214)
  (featured reflections)

## Context

#221 stores Third Perspectives as hosted rows and lets moderators approve them at the consent
they saw, but nothing showed an approved reflection anywhere. Pages are static: ordinary reading,
CI builds and a site that leaves its hosted service must work without it (ADR 0081), and a site's
repository may be public. Readers need to know whether a reflection they sent is waiting,
published or not, without anyone else learning anything, and readers of a portable copy or a feed
need to know where participation happens without the copy carrying reader words or a dead form.

## Decision

- **A versioned public file.** On approval, Admin writes the approved reflection's public parts
  to `third-perspectives.json` in the content folder (`perspective_publication`), beside B5's
  `reader-feedback.json` and under the same content lock, then rebuilds. A record holds exactly
  what the one projection (ADR 0111) reads: `id`, `post` (the source path), `work`, `revision`
  and `target` as the reader saw them, the optional `category`, the `body`, the days `received`
  and `approved`, and `name` only while both the approved and the current consent show it and it
  matches no credited name. The file is read strictly (unknown fields, a quotation target, a
  newer version or a repeated id are refused, naming the item and never its contents); a file
  that cannot be read refuses `build` and `check`, as for `reader-feedback.json`.
  `PublishedPerspective::from_hosted` writes a record only while `approved_response` returns one
  for the hosted copy, so a pending, clarification, rejected, removed, withdrawn or purged copy,
  or one whose consent no longer allows publication, is never written.
- **One projection on the page.** `project_post` re-applies the same projection code
  (`third_perspective::project`, shared with `SubmittedCopy::approved_response`) against the post
  as it is published now: RD12's `published_mode` for the kind decides, so a site without its
  transport keeps showing what was approved (as `locked`) while a post or site that hides the kind
  shows nothing; a name that now matches a credit, including look-alike spellings, is withheld; a
  section's standing is resolved against the current text; and a record whose `work` is no longer
  the post's address is not shown and is a build warning.
- **The canonical section.** `<section id="ob-third-perspectives">`, headed "Third Perspectives",
  after the authors' text and passage feedback and before the Third Perspective region, lists each
  as an `<article>` headed "Third Perspective from a reader" or "… from Mina, a reader", with what
  it is about (linking a current section), the prompt label, the day received, a note when the
  reader read an earlier version, and the text as escaped paragraphs. It needs no script. Each
  carries RD12's progressive abuse report form while reports are open; the hosted id it names is
  carried beside the projection (`PublicPerspective`), not inside it, as published notes and
  comments already expose theirs. Nothing is counted, ranked or ordered by anything but the day
  received.
- **Admin keeps the file in step.** Approving publishes; removing, a deletion request, or upholding
  a report against a Third Perspective takes it off. The inbox says for each card whether it is
  published and whether the hosted copy may be shown now (`mayBeShown`); when they disagree the
  site Admin of the work gets one button (`POST engagement/third-perspectives/publish` or
  `/unpublish`, re-checked against the hosted copy). A reader's withdrawal by receipt reaches the
  static page only through that button, as for published notes (ADR 0107). The inbox checks every
  id in the published file against the hosted copy on each load (`GET
  engagement/third-perspectives/published`) and shows, on every tab, a banner counting the
  published reflections that must come off, each with its own take-off button, and another for
  those whose state cannot be told; the card says so too.
- **Status by receipt only.** A reader sees their reflection's state only through RD12's receipt:
  waiting for review (never "published"), asked to clarify, approved and shown as a reader's
  reflection, approved but not shown, not published (rejected, removed or expired), or withdrawn.
  The function's `published` flag for this kind is true only while the row is approved at its
  current revision, not waiting on a clarification of it, under an approved consent record that
  agreed to publication while the consent in effect still does, and its kind is not hidden. Where
  the function does not read the consent column (the flag is off or rolled back) that is unknown:
  the receipt says it cannot tell, Admin says the state is unknown rather than "must come off",
  and abuse reports fall back to plain approval at the current text. Lookup is by the receipt's digest
  alone: a guessed or malformed receipt and a request naming an id get the same `404
  unknownReceipt`, the hourly receipt quota applies, and the answer holds no id, private name,
  consent record, digest, moderator or reason beyond a clarification request's. The same
  consent check gates abuse reports on this kind.
- **Portable copies, feeds and `llms` files link, never copy.** A post that shows Third
  Perspectives, or offers the form for them, carries the `third-perspectives` capability (a
  planned contract owned by story #201 with #222 as its portability gate). Portable HTML and
  Markdown and the feeds built from them add the labelled note "Third Perspectives: see it on the
  original article" linking the section of reflections on the canonical page (`#ob-third-perspectives`),
  or, with nothing approved yet, "take part on the original article" linking the form
  (`#ob-third-perspective`), and `llms-full.txt` adds one line with the
  canonical address; none carries a reflection, a name, an id or the form. A locked post with
  nothing approved, a hidden post and a site that leaves the kind off are byte-for-byte
  unchanged. This updates ADR 0114's statement that feeds and portable copies of an open post
  are unchanged: they now gain that one link.
- **Without the hosted service** the canonical page still shows what was approved, the region's
  static text remains the copy-and-contact path, and nothing points at a form that cannot work.

## Considered options

- **Fetch approved reflections from the hosted function at view time.** Rejected: static reading,
  CI builds and portable output would need the service, a no-JavaScript reader would see nothing,
  and a public read route would be a new enumerable surface.
- **Store the submitted copy in the content folder and project at build time.** Rejected: a
  repository may be public, and the copy holds the private name, the consent history and the
  receipt's digest.
- **Write Third Perspectives into `reader-feedback.json`.** Rejected: ADR 0113 keeps that file to
  B5's kinds, whose records carry an author response and passage details a reflection has no
  part in.
- **Copy reflections into portable copies with their attribution.** Rejected: P6.2 keeps reader
  participation canonical-only, and a copy could not follow a later withdrawal.

## Consequences

- A withdrawal, or a reader hiding their name after approval, reaches the live page after the
  site Admin takes the shown action and the site is rebuilt and deployed; the receipt says the
  author has been shown that it must come off.
- Withdrawal deletes the hosted copy of the text and name, and the receipt says only that. A
  reflection already published has been in the site's history, feeds and the repository's history,
  possibly public and copied; no step here can recall those, so the withdrawal text and the
  consent form say that copies already published may remain, and that a published name becomes
  part of the site's public record.
- Rolling the hosted opt-in back first means emptying `third-perspectives.json` (or hiding the
  kind), because without the consent column the hosted state of an approved reflection is unknown.
- Featured reflections (#214) can select from records in this file without a new store.

## Domain language

**Published Third Perspective** is defined in [`CONTEXT.md`](../../CONTEXT.md).

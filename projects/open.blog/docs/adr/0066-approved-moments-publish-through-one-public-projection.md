# ADR 0066: Approved moments publish in the Post through one public projection

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#177](https://github.com/journey-to-code-org/open.blog/issues/177)
- Parent story: [#149](https://github.com/journey-to-code-org/open.blog/issues/149)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Builds on: [ADR 0023](0023-shared-reflections-publish-through-the-ordinary-post-pipeline.md),
  [ADR 0026](0026-publishing-approved-synthesis-in-the-post.md),
  [ADR 0062](0062-media-moments-locate-attributed-quotations-and-observations.md),
  [ADR 0063](0063-media-moments-stay-private-until-revealed-and-bind-into-approval.md),
  [ADR 0065](0065-precise-quotation-attribution-and-rights-guidance.md)

## Context

Moments proposed for a piece bind into its approval (ADR 0063), and the gate refuses one that no
longer fits its source, but the published Post carried none of them. ADR 0023 settles that a shared
reflection has no projection of its own: every output derives from the Post the gate writes. A moment
also holds things that must never be public: the quotation's rights status, rights note and
provenance, the participant id, the moment id, its intent and the seals. Media can disappear or
refuse to play, so what is published must not depend on any player.

## Decision

- **One public projection.** `published_moment::PublicMoment` is built field by field from a moment
  and the record: the location (the source's title and kind and the location in words, such as "The
  Art of Noticing (Video), at 1:02"), who noted it (the owner's display name, because the observation
  is their words), the quotation's text and language with the one attribution line of ADR 0065 (which
  names the speaker), the observation, and the moment link. It has no field for rights, rights note,
  provenance, ids, intent or seals, so no renderer can publish them; nothing serializes a `Moment` or
  a `Quotation`. The rights note stays unpublished, as ADR 0065 chose; no licence is shown publicly.
- **Which moments.** Every moment proposed for the piece, in the set's order, which is the order the
  approval binding covers. The gate has already required every author's approval of exactly those
  moments, including each owner's, and refused unresolved ones (ADR 0063), so private, edited-since
  and newly proposed moments have no path in. A moment whose owner or source cannot be credited makes
  the piece `Invalid` rather than silently dropping something approved.
- **Where.** `assemble` appends the moments last, after a section break, under the `##`-level heading
  "Moments in the sources" (`#moments-in-the-sources`, each moment `#moments-in-the-sources-<n>`,
  counting in publication order and carrying no internal id). The authors' sections, the arrangement
  and the conversation are byte for byte what they were, and the explicit description is still drawn
  from the sections only. A piece with no moment proposed for it, including one with only private
  moments, publishes byte for byte as before. The anchors are reserved like the conversation's: a
  section or item heading that claims one refuses the piece as `ReservedSectionAnchor`.
- **Resilient by construction.** No embed, player, frame or script is ever written. Each moment
  shows its source's title, kind and location as text, then its link: for YouTube a link that starts
  at the moment (`t=<seconds>s`), for any other provider the original link unchanged, and for a source
  with no safe address (missing, not HTTP(S), carrying credentials, or one the build would refuse) no
  link at all, so the location stays text. A deleted, blocked or unsupported video therefore loses
  nothing a reader needs. Timestamps read the way people say them (`62` reads `1:02`, `3725` reads
  `1:02:05`), which also changes the location shown in Admin and the preview.
- **Accessible semantics.** A labelled `section` region, an `h2` and one `h3` per moment, "Noted by"
  with the author's name, the quotation as a `figure` holding a `blockquote` with the quotation's
  `lang` and its attribution as the `figcaption`, and a link whose text names the source and time.
  Quotation lines are kept with `<br>`. It reads in order without CSS or JavaScript; the stylesheet only
  softens the caption and prints link addresses.
- **Untrusted values fail safely.** Titles, names, quotations and attributions are escaped text in the
  frame (the characters that open Markdown links, emphasis and code as character references too). An
  observation is the owner's Markdown, already held to ADR 0062's rules; at the gate it must also parse
  the same alone as in the Post (no reference definition another part would use, no fence left open)
  and its links must be ones the build publishes, or the piece is refused as `UnsafeMoment` with the
  approved text unaltered. The gate also reads the written block back and refuses if it does not read
  back exactly. A refusal names no moment.

## Consequences

- RSS, JSON Feed, portable HTML, `llms-full.txt` and destination plans carry the moments because they
  are body content; summary-only feeds carry none. The site search index and word count read the
  page text, which has the observations but not the frame's quotations and captions.
- The leak test seeds a sentinel in the rights note and every private field (participant ids, admin
  users, moment ids, private moments, rights and provenance tags and labels, guidance, seal and
  binding digests) and scans the page and every generated file, both feeds, portable HTML, Markdown
  and text, `llms.txt`, `llms-full.txt`, the search index, the sitemap and every destination plan.
- Failure leaves canonical content and public output unchanged: assembly refuses before anything is
  written (ADR 0022).
- Showing a licence publicly, per rights status, remains a later decision.

## Domain language

**Published moment** and **Moment link** are defined in [`CONTEXT.md`](../../CONTEXT.md).

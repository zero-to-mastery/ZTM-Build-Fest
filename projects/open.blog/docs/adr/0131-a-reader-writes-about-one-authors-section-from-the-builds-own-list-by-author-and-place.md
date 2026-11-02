# ADR 0131: A reader writes about one author's section from the build's own list, by author and place

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#223](https://github.com/journey-to-code-org/open.blog/issues/223)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0114](0114-the-third-perspective-form-is-one-progressive-region-with-explicit-consent.md),
  [ADR 0126](0126-an-attributed-section-is-an-ordinary-section-target-with-a-reserved-anchor-and-a-digest.md),
  [ADR 0127](0127-an-attributed-target-resolves-by-author-and-text-and-is-stale-rather-than-retargeted.md),
  [ADR 0130](0130-attributed-perspectives-store-the-responder-publish-nothing-by-themselves-and-leave-static-reading-whole.md)

## Context

ADR 0126 defines the target of a reflection about one author's section, but nothing let a reader
choose one: the form lists heading sections, and a turn has no heading. The choice must name the
author and the place among that author's sections (never a side of the page), come from content the
build computed, work without any private record, and leave every page that does not use it exactly
as it was.

## Decision

- **The build lists the author sections in the Third Perspective region.** Where the post's
  `author-response` kind is not hidden (the one switch of this feature) and the post's body is an
  arranged reflection whose committed credits pair with it (ADR 0126), the region gains one
  `<script type="application/json" id="ob-attributed-sections">` element:
  `{version: 1, work, sections: [{anchor, contributor, nth, author, excerpt, digest}]}`, in reading
  order, escaped like the passage data. `excerpt` is at most 60 characters of the section's
  normalized text, cut at a word with an ellipsis, only to tell sections apart in a list; it is
  never part of a target. The region's no-JavaScript text gains one sentence saying to name a
  section by its author and place, such as "MINA, section 1". A post that attributes nothing (no
  sidecar, unpaired credits, not an arrangement), or where answers are hidden, gets neither: its
  region is byte for byte what ADR 0114 wrote (a test holds the exact text), and feeds, portable
  copies and `llms` files never carry the list.
- **The form offers it as a third choice, "One author's section", beside the whole work and a
  heading section.** The list is read only if every entry is exactly what the build writes (the
  anchor must be the reserved anchor of its contributor and place, the digest 32 hex digits, the
  work this page's); otherwise the form is as before. Each option reads "AUTHOR, section N:
  “first words…”" as text. Choosing one sends the ordinary section target of ADR 0126 (`kind:
  "section"`, the anchor, the digest), checked by the same shared validator; the copy a reader can
  send by hand says "One author's section: by {contributor}, section N" in words and keeps the
  exact target on its record line.
- **The reserved anchor space is checked wherever a target is read.** `PerspectiveTarget` refuses a
  section anchor starting `ob-by-` unless it is exactly an attributed anchor with its digest: in the
  build (`attributed_check` in every read of a target: a submission, a stored row, the published
  file) and in the browser and hosted function (`readAttributedTarget` in
  `web/components/third-perspective.js`). Both are held to the same fixture cases
  (`tests/fixtures/third-perspective-submissions.json`: uppercase contributor, leading zero, a place
  of four digits, an empty contributor, a doubled hyphen, the bare prefix, a missing digest).
- **Section commentary is a Third Perspective.** It keeps RD10's consent, receipt, quota, replay
  bound and moderation unchanged; nothing about it is a vote, a score or a side.

## Consequences

A reader can write about one author's section on a published shared reflection with or without
JavaScript, and with or without the hosted service (the copy path). The reader never needs a
private record; neither does the build. Anchors on the page itself, and a link from a reflection to
its section, are #224's.

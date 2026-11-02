# ADR 0100: The public timeline is a progressive ordered list, and relative datings are trails

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#59](https://github.com/journey-to-code-org/open.blog/issues/59)
- Parent story: [#23](https://github.com/journey-to-code-org/open.blog/issues/23)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0061](0061-citation-previews-are-a-progressive-non-modal-component.md),
  [ADR 0094](0094-temporal-relationships-are-relative-datings-never-inferred.md),
  [ADR 0096](0096-the-chronology-index-orders-every-dating-for-display-only.md),
  [ADR 0098](0098-chronology-is-authored-and-explored-in-admin-as-text.md),
  [ADR 0099](0099-approved-datings-publish-through-the-atlas-projection.md)
- Amends: [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md) (`/atlas/`
  carries the timeline, and its index page may load one component)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#publication)

## Context

Issue #59 asks for opt-in static chronology lists with a progressively enhanced timeline and
attributed relationship trails, keeping uncertainty and no-JavaScript navigation, with print and
reduced motion usable and an enhancement that hides no citation or doubt. ADR 0098 chose lists
and words over a drawing for Admin for the same reasons: a bar chart flattens competing datings,
open ends and relative or unknown dates, and is hard to read without sight or a pointer. ADR
0096 forbids neighbours or contemporaries, so a trail cannot be computed from dates.

## Decision

- **Where it lives.** The timeline is a section of `/atlas/` (`#atlas-timeline`), after the
  entries by kind, present only when the projection has datings; a line under the lede links to
  it. Entry ids are slugs that could be `timeline`, so a page under `/atlas/` would collide; the
  index page avoids a new reserved path, a new sitemap entry and a new page for sites without
  datings.
- **Static first: the complete ordered chronology.** Dated aspects (one item's datings of one
  aspect, `PublicAtlas::dated_aspects`) are listed in the chronology's one order inside an
  ordered list of periods: the century in which each aspect's earliest absolute dating begins,
  with BCE written out ("5th century BCE", `#atlas-period-bce-5`), and "No earliest year stated
  (open start)" first. Each row names what is dated ("Birth of Plato", linked to the entry's
  aspect), says how many competing datings it has, and lists every one in full: the date as
  stated, who dates it, confidence, cited evidence with locators, and note. Aspects with no
  absolute dating are listed apart under "Not placed in time". A note says the order is for
  reading only and never means that one thing caused or influenced another. There is no canvas,
  SVG or bar, and nothing animates.
- **Trails are asserted steps, followed one at a time.** A relative dating is shown as a sentence
  whose other end links to that entry's datings ("after the composition of Phaedo"). The other
  entry's page lists, under "Dated relative to this entry", every published relative dating of
  another item that points at it, each attributed and cited, with a link back to the dating in
  full. The timeline lists all relative datings again under "Relative chronology", each with its
  party, confidence and a link to its evidence. Together with the relationship sections, every
  step of a trail is something a named party recorded on cited evidence; nothing chains steps,
  infers a transitive order, or links entries because their dates are close.
- **One component, loaded only where it has a timeline.** `web/components/ob-atlas-timeline.js`
  defines `<ob-atlas-timeline>`, which wraps the static section. Only `/atlas/` loads it, and only
  when it has a timeline; every other page is unchanged. It adds one labelled toolbar: "Show"
  (every aspect, or one aspect the timeline lists), "Only aspects with competing datings", a
  "Period" select with a "Go to period" button that moves focus to the period's heading, and a
  `role="status"` line stating what is shown and every filter in force. A filter shows or hides a
  whole dated aspect and never one of its datings, and never the evidence, confidence or note of
  a dating that is shown; the relative chronology stays complete. Periods left empty are hidden
  and cannot be chosen.
- **Within the policy and the B1 idioms.** The module is embedded with the other components,
  copied into every site's assets, versioned with `?v=` like every asset URL, and runs under
  `script-src 'self'; style-src 'self'`: it reads only the page's markup, writes only text, uses
  the `hidden` attribute rather than inline style, fetches and stores nothing, keeps its state in
  private fields so no property shadows an `HTMLElement` built-in, and detaches every listener
  through one `AbortController` on disconnection, enhancing once on reconnection.
- **Print and motion.** Print shows the whole timeline, filtered rows included, and leaves the
  toolbar out; a dating is not split across pages. The timeline adds no transition or animation,
  and going to a period moves focus without smooth scrolling.
- **Layout.** Competing datings sit side by side in columns where there is room and stack on
  narrow screens; long unbroken labels wrap, so neither the timeline nor the entry list scrolls
  sideways at 320 CSS pixels.

## Consequences

- Readers get the complete chronology, its uncertainty and its citations without JavaScript, and
  can narrow it with JavaScript without losing either.
- A future visual layer would have to render the same rows and pass the same keyboard,
  screen-reader, print and no-JavaScript tests.
- A very large atlas makes `/atlas/` long; splitting it would need a path outside the entry id
  space and is left to the public query projection (#72).

## Domain language

**Public timeline** and **Chronology trail** are defined in [`CONTEXT.md`](../../CONTEXT.md).

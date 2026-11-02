# ADR 0175: A relationship trail is a static ordered list of published steps with direction and evidence, and only script adds filters

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#75](https://github.com/journey-to-code-org/open.blog/issues/75)
- Parent story: [#27](https://github.com/journey-to-code-org/open.blog/issues/27)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0100](0100-the-public-timeline-is-a-progressive-ordered-list-with-relative-trails.md),
  [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md),
  [ADR 0170](0170-queries-are-exact-lookup-and-a-bounded-trail-that-infer-nothing.md),
  [ADR 0174](0174-contextual-entry-previews-read-the-public-query-file-and-enhance-an-ordinary-link.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#relationship-trails)

## Context

#75 asks for explorable intellectual relationship trails: list-first static pages with optional
progressive filtering, where every edge shows its type, direction, evidence and uncertainty, a
cycle never traps navigation, any visual enhancement has a complete semantic-list equivalent, and
nothing infers influence. ADR 0170 already defined the walk: bounded breadth first over published
relationships, each relationship crossed once and each entry expanded once, depth 3 and 200
steps, with a flag when it was cut. ADR 0100 settled that the atlas chooses lists and words over a
drawing, for the same reasons: a drawing flattens direction, competing claims and doubt, and is
hard to read without sight or a pointer.

## Decision

- **Where it lives.** Every entry page that has at least one published relationship gets a
  "Relationship trail" section (`#atlas-section-trail`) after its relationship lists, rendered at
  build time from the same query projection that writes `atlas-query.json`, projected once per
  build (so the page and the file cannot disagree, and there is one projection to bound). An entry
  with no published relationship has no section, and a build whose query projection is refused
  (over a bound, or not consistent) has no trails: the relationship lists the page already has are
  the complete fallback. No new page, path, sitemap entry or config key: the capability is the
  atlas the site already opted in to publish, and a site that does not publish it is unchanged.
  A trail from every entry is the navigation: each entry a step reaches links to its own page,
  which continues the trail from there, so a reader moves through the atlas one ordinary page at a
  time and the browser's history is the way back.
- **Static first, and complete.** The trail is an ordered list of distances ("One step from X",
  "Two steps from X", "Three steps from X"), each an ordered list of steps in ADR 0170's fixed
  order (depth, then the order entries were reached, outgoing before incoming, each by id). The
  section is a labelled region with real headings and lists, readable without CSS or JavaScript.
  A skip link ends at a focusable "End of the relationship trail." line, so a keyboard reader can
  leave up to 50 steps at once.
- **Every step shows its relationship, as stated.** The step's sentence is always the stated one,
  from its stated side ("Plato authored Republic", never reversed to suit the walk), and the step
  lists, with the query projection's own wording: its type; its direction; who asserts it; how
  firmly ("not how widely it is accepted"); its standing (contested ones are marked and say how
  many dissents are recorded); its evidence, one reference with its locator per item; and its
  stated uncertainty, clipped visibly to the projection's limit with a link to read it in full. An
  unstated uncertainty says "None stated. That is not a claim that it is certain." and never that
  it is certain. A link goes to the relationship in full on its asserting entry's page.
- **Direction is shown honestly, in two parts.** The first is the direction it was stated ("Stated
  from A to B"). The second is the way this walk crossed it: "This step follows it forward, in the
  direction it was stated" or "backward, against the direction it was stated". A kind that reads
  the same both ways (`related to`) says so, carries `data-direction="symmetric"` and is never
  described as followed against its direction. A trail goes out across relationships in either direction because reading about an
  entry means reading what others said of it, but it never reverses a relationship into one that
  was not published (no "was influenced by" that someone did not state).
- **A cycle is a sentence.** A step that arrives at an entry already on the trail (including the
  starting entry) says "That entry is already on this trail, so the trail does not continue from
  it again", carries `data-again="true"` and a dashed border, and is not expanded again. Because a
  relationship is crossed once and an entry expanded once, the list is always finite, and because
  each reached entry is an ordinary link to its own page, following a loop is following links with
  a Back button, never a trap. The same step can be reached again from another page; nothing
  remembers where a reader has been.
- **Bounded and says so.** At most 50 steps and three steps of distance, as ADR 0170 defines.
  When more exist the page says "The trail stops after 50 relationships; more exist" and that an
  entry's own page continues it; when the distance bound ends it the page says to follow an
  entry's link to go further. An entry past the bound is not named, and nothing implies the trail
  is complete when it is not. The summary line counts relationships and entries on the trail.
- **Facts once, then compact, under a site-wide budget.** Only a first step (`data-depth="1"`)
  writes every fact. A step two or three away is its stated sentence (both ends linked), one
  sentence on which way it was followed (or that it reads the same both ways) and the link to
  the relationship in full; its asserting party, confidence, evidence and doubt are on that page
  and on the entry's own page. Every step keeps its `data-*` attributes, so the filters work on
  all of them (the type comes from `data-kind-label`). The build also counts the trail markup of
  every entry page: when the total would pass 20 MB, every entry page shows its trail one step
  deep and the build prints `warning: knowledge atlas: relationship trails would add ...`. The
  budget is site-wide and all or nothing so pages do not differ in kind, and a site within it
  is unchanged. A hub of 260 entries took the built site from 2.4 MB to 64 MB with full steps at
  200 deep; with these bounds the same site is about 8 MB.
- **A relationship that reads the same both ways is shown under either direction filter.** Its
  `data-direction` is `symmetric`, so it is neither "along" nor "against" anything. Choosing
  either direction keeps it, and the status line then says relationships that read the same both
  ways are shown under either choice, so no filter describes one as followed against its stated
  direction. An unknown direction value shows nothing.
- **It means nothing beyond its steps.** The section opens with a note: a trail is not a line of
  influence, and nothing infers a relationship that was not published, joins steps into a new
  claim, or treats being near as being important. There is no ranking, score, strength, shortest
  path, recommendation or transitive reading, and no graph drawing. A diagram was not built:
  the list is the complete representation and a drawing would be a second one to keep honest, so a
  later visual enhancement must reuse these steps (their ids, order, data attributes and
  words) and add nothing the list lacks.
- **Private research stays out.** The trail is read from the published atlas projection alone, the
  one source ADR 0168 allows, so a private or withdrawn entry or relationship cannot appear in it,
  be counted in it, or change what a visible step says. A test builds a private entry and
  relationship and scans every page.
- **One component adds filters, loaded only where there is a trail.**
  `web/components/ob-atlas-trail.js` defines `<ob-atlas-trail>` around the static section. It adds
  one labelled group of native controls: a relationship type (only types the trail has), the
  direction followed (along or against the stated direction), how far (within one, two or three
  steps), and "only contested or uncertain relationships", with a `role="status"` line stating how
  many steps are shown and every filter in force, and a reset button that leaves focus where it
  was. A filter shows or hides a whole step and never changes what a shown step says; hidden steps
  stay in the page (so headings, order and links are unchanged) and are not reachable by Tab; a
  distance with nothing left is hidden with its heading. The component reads only the page's own
  markup (`data-depth`, `data-kind`, `data-direction`, `data-standing`, `data-uncertain`,
  `data-again` and the words of "Type"), writes only text, fetches nothing, stores nothing, needs
  no inline style, never moves or animates and traps no focus. Print shows the whole trail and
  leaves the controls out, whatever a filter hid. Only an entry page with a trail loads the script.
- **One set of cases.** `tests/fixtures/atlas-trail.json` holds the atlas, the steps the real
  walk and renderer must produce (checked by `crates/openblog-core/tests/atlas_trail.rs`) and the
  filter cases (checked by `tests/web/atlas-trail.test.mjs` against the component's own
  `filterSteps`), so the page's attributes and the component's reading of them cannot drift.
- **The fallback never leaks.** A hostile label or note is escaped once, as text; an entry's own
  page is the only place a relationship is shown in full, and the trail links to it.

## Consequences

- Entry pages of a site that publishes its atlas grow by at most 50 steps: the first step out in
  full (a few hundred bytes of text each) and the rest compact. The earlier plan of 200 full
  steps made one hub's leaf pages dominate the build (260 leaves: 64 MB against 2.4 MB); the
  compact steps, the lower cap and the 20 MB site budget bound it, at the cost that a reader
  follows a link to read the evidence of a relationship two steps away.
- The trail wording is English until the fixed wording of the site is localised, like the rest of
  the atlas pages.
- A reader who wants a longer walk follows links; there is deliberately no path search between two
  entries, which ADR 0170 rules out.
- Asking "who influenced whom" is answered only by the published `influenced` relationships, one
  stated step at a time, with their asserters and doubt.

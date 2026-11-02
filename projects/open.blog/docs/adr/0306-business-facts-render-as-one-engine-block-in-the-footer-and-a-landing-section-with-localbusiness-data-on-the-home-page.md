# ADR 0306: Business facts render as one engine block in the footer and a Landing section, with LocalBusiness data on the home page

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#482](https://github.com/journey-to-code-org/open.blog/issues/482)
- Task: [#507](https://github.com/journey-to-code-org/open.blog/issues/507)
- Parent epic: [#473](https://github.com/journey-to-code-org/open.blog/issues/473)
- Builds on: [ADR 0305](0305-business-facts-are-one-versioned-block-in-openblog-json-that-pages-the-footer-and-structured-data-all-read.md), [ADR 0245](0245-the-landing-page-is-a-versioned-list-of-typed-data-sections-with-no-html-section-and-no-markup-from-content.md), [ADR 0253](0253-pieces-are-validated-data-with-one-form-schema-and-embeds-are-privacy-enhanced-lazy-frames-that-degrade-to-a-link.md)

## Context

The facts of ADR 0305 must appear identically wherever they matter, in every theme, without each theme
re-implementing them, and as structured data that search engines can read. The Landing builder already has a
closed set of sections, nine of them structured pieces, and a rule for adding one.

## Decision

- **One renderer, owned by core.** `BusinessConfig::block_html` writes the block (`ob-business`): name, badge,
  phone and email links, hours, notes (license and issuer, accepted payments, founding year). Every value is
  escaped, nothing is a script or a form, and nothing is written when no fact is stated. The block is the only
  place the facts are formatted, so the footer and the Landing section cannot drift.
- **The footer carries it on every page.** `site_footer` puts it first, inside
  `<section class="ob-footer-business" aria-label="Business details">`. The header is left alone: a header
  block would compete with navigation on a phone. A site with no facts writes the same footer bytes as before
  (tested, and the existing home-page golden files still pass).
- **Themes do not rebuild it.** The engine styles it in `web/base.css` with `--ob-*` tokens only, like the
  series navigation (ADR 0245 consequences): a theme gets the block and the "Licensed and insured" badge with no
  CSS of its own and may override the `ob-business*` hooks. The badge reads "Licensed and insured", "Licensed" or
  "Insured" from the license number and the insured flag, and is the owner's claim, not a verified one.
- **`LocalBusiness` structured data on the home page only**, as a second `application/ld+json` block beside the
  existing `Blog` node (it is not merged into it, so the existing node's bytes do not change). It carries
  `@id` (`<site>/#business`), `@type`, `name`, `legalName` (when different), `url`, `telephone` (E.164),
  `email`, `foundingDate`, `openingHoursSpecification` (one entry per open day; closed days are left out, which is
  how schema.org states a closed day), `paymentAccepted` (labels, comma separated) and the license as
  `hasCredential` (`EducationalOccupationalCredential` with `credentialCategory: license`, `identifier`, and
  `recognizedBy` for the issuer). **Only fields that are stated are emitted.** There is no address (service areas
  own places, story #484), no `aggregateRating`, nothing about customers, and `insured` is not emitted because
  schema.org has no property for it. The name falls back to the site title. The text is escaped for HTML-in-script
  like the existing JSON-LD (`<`, `>`, `&`).
- **The type is a trade subtype where schema.org has one** (ADR 0305's map). Tests check the emitted shape and
  type against the schema.org `LocalBusiness` subtypes the map can produce, every property against the set this
  feature emits, day names against schema.org's day URLs, and times as `HH:MM`.
- **Landing: a tenth piece, `business-facts`, and the version rule is followed.** ADR 0245 says a new section
  type is a new version, so an older release never half-renders or drops a section. The section is added as
  **landing version 2**: this release reads versions 1 and 2, a page is *written* as version 2 only when it holds
  a Business facts section (`LandingPage::stored_version`; the Admin and history seams use
  `version_for_page`), and every other page is still written as version 1 byte for byte. A version 1 file that
  contains the type is refused ("needs `version` 2"). A version above 2 is refused as before and never
  overwritten. The section holds only a required `heading`; it renders the same block under that heading and
  renders nothing while no fact is stated.
- **It is a section, not a post piece.** The nine pieces are also writable in a post as fenced directives
  (ADR 0253), which render without the site configuration. The facts need the configuration, and in a post the
  footer already carries them, so the post-piece set and the "Add something" dialog are unchanged. The Landing
  builder offers it through its section catalog.
- **Not a second source.** The existing `opening-hours` and `contact` sections stay free-text pieces for
  pages that want different wording; the Business facts section is the one that cannot contradict the footer.

## Considered options

- **Merge the business node into the `Blog` JSON-LD.** Rejected: it changes bytes sites already ship and makes
  the home page's one node answer two questions.
- **Emit `LocalBusiness` on every page.** Rejected: the entity belongs to the home page; repeating it adds weight
  and can disagree with pages that are about something else.
- **Add the type without a version bump.** Rejected: contradicts ADR 0245 and would let an older release silently
  drop the section.
- **Bump every page to version 2.** Rejected: rewrites files that do not use the type.
- **A header block.** Deferred: the footer is enough for the story, and a header block would need per-theme care.

## Consequences

- #508 edits the facts in Settings; the Landing builder edits only the heading.
- A new landing section type is still a new version; this ADR is the pattern (read both, write the lowest).
- Story #484's service-area pages can reuse `business_facts` data and add an address to the same node.

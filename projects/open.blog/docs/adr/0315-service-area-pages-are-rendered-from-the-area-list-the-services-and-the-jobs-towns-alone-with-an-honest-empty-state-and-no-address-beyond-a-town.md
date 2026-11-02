# ADR 0315: Service-area pages are rendered from the area list, the services and the jobs' towns alone, with an honest empty state and no address beyond a town

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#484](https://github.com/journey-to-code-org/open.blog/issues/484)
- Task: [#513](https://github.com/journey-to-code-org/open.blog/issues/513)
- Parent epic: [#473](https://github.com/journey-to-code-org/open.blog/issues/473)
- Builds on: [ADR 0314](0314-service-areas-are-a-versioned-list-of-towns-in-openblog-json-checked-for-duplicates-with-regions-formatted-from-a-bundled-list-and-absent-means-nothing-changes.md), [ADR 0312](0312-service-pages-the-index-and-their-structured-data-are-rendered-from-the-collection-alone-deterministically-and-only-for-a-site-that-has-services.md), [ADR 0286](0286-jobs-archives-are-derived-from-job-posts-and-page-like-the-home-page.md), [ADR 0306](0306-business-facts-render-as-one-engine-block-in-the-footer-and-a-landing-section-with-localbusiness-data-on-the-home-page.md)

## Context

A page per town helps local search only if it has something true to say. A town with no finished work must
not be padded, and a page about a job must never reveal where in town it was.

## Decision

- **Only for a site that lists areas.** With no `serviceAreas` nothing is emitted: no page, sitemap entry,
  navigation link, `llms.txt` section or structured data, and `areas` is not reserved. A page or post whose
  first address segment is `areas` fails the build **only while areas exist**, as `services` does (ADR 0312).
  A fixed fixture builds to the same bytes with the member absent and with an empty list.
- **Addresses.** `/areas/` is an index and `/areas/<slug>/` an area's page, the slug derived by ADR 0314.
- **A page is built from three things.** The area (town, region, note), the services collection when the site
  has one (each linked, with its summary), and the jobs whose `place.town` and `place.region` are that area,
  matched with the region formatting of ADR 0314 so `Oregon` and `OR` agree. Jobs are read from the jobs
  archive plan (ADR 0286), newest first, at most ten, so a job is here exactly when the archives list it.
  The business facts block is the engine's own (`block_html`, ADR 0306), placed in its own section.
- **No address, ever.** A job contributes its title, link and date to an area page, and its town and region
  only through the match. The page is a plain list, not cards, because a card's summary is text from the
  job's body. A test builds jobs carrying a street in the place, in an unknown key and in the body, and
  asserts none of it appears on any area page.
- **Honest empty state.** An area with no jobs says, in a plain line, "Work in Bend, OR is not yet posted. A
  finished job there will appear on this page.", and keeps its services. The index says the same in short.
  There is no filler paragraph, no nearby-town stand-in and no invented content. The note is shown as the
  owner wrote it, and with no services collection the services section is simply absent.
- **`areaServed` states what is configured.** An area page carries the site's business node (the trade
  subtype and `@id` of ADR 0306 when facts are stated, otherwise an `Organization` named for the site) with
  `areaServed` for that town only: a `City` with its name, contained in an `AdministrativeArea` named for the
  region (the full name when the bundled list knows it). When business facts are stated, the home page's
  `LocalBusiness` gains `areaServed` listing every area, in plan order. No address, geo point or radius is
  emitted: the note is a sentence, not a distance. Text goes into `<script type="application/ld+json">` with
  `<`, `>` and `&` escaped, so no town or note can end the element.
- **Discovery hooks like services.** The index and each page join `sitemap.xml` and an `llms.txt`
  "Service areas" section, and the header navigation gains an "Areas" link unless the owner's own navigation
  already points at `/areas/`.
- **Deterministic.** The list is sorted for output, so the same areas in any order build the same bytes.
- **Not in this decision.** An Admin screen for the list, and a job's "near" a town: only the same town and
  region match, because nearness would need coordinates the engine does not store.

## Consequences

- Adding a town and rebuilding adds its page, its index row, sitemap entry and structured data together.
- A job posted in a configured town appears on that town's page on the next build, with nothing to edit.

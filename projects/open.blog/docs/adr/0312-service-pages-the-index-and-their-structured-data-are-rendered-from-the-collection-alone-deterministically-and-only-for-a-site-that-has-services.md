# ADR 0312: Service pages, the index and their structured data are rendered from the collection alone, deterministically, and only for a site that has services

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#483](https://github.com/journey-to-code-org/open.blog/issues/483)
- Task: [#510](https://github.com/journey-to-code-org/open.blog/issues/510)
- Parent epic: [#473](https://github.com/journey-to-code-org/open.blog/issues/473)
- Builds on: [ADR 0311](0311-services-are-a-services-collection-of-markdown-files-with-versioned-front-matter-and-a-jobs-service-is-checked-against-it-only-when-the-site-has-one.md), [ADR 0286](0286-jobs-archives-are-derived-from-job-posts-and-page-like-the-home-page.md), [ADR 0306](0306-business-facts-render-as-one-engine-block-in-the-footer-and-a-landing-section-with-localbusiness-data-on-the-home-page.md)

## Context

Services are only useful if customers and search engines can find them, and if the page, the index and the
structured data cannot disagree because they are all read from the same file.

## Decision

- **Addresses.** `/services/` is the index and `/services/<id>/` is a service's page, one file each. The
  id is the address, so a rename is a change of address that the owner chooses. `services` becomes a reserved
  first segment (a page or post there fails the build) **only while the site has services**, the way the atlas
  reserves `atlas`.
- **Only for a site that has services.** With no services nothing is emitted: no page, no sitemap entry, no
  navigation link, no `llms.txt` section. A fixed fixture (posts, a job, a page, a series and business facts)
  builds to the same bytes before and after this change.
- **A page is built from the file only.** Name, summary, price band, typical timeline, `includes`, the
  Markdown body and the questions, then the recent jobs. Text is escaped; the body is the engine's ordinary
  Markdown. No engine CSS or script is added: the page uses existing classes (`ob-page`, `ob-lede`, `ob-meta`,
  `ob-list`), so every theme renders it already.
- **The price band is a label.** It is shown as "Price band: $500 to $2,000" (the words the Job form already
  uses) with the sentence "A price band is a guide, not a quote." Nothing is computed from it, and it is not
  turned into numeric `minPrice` and `maxPrice` in structured data, which would need a currency and
  would read as a stated price.
- **Structured data is one `@graph`.** A `Service` node (`@id` is the page address plus `#service`; `name`,
  `description` from the summary, `url`, `provider`; `hasOfferCatalog` listing what is included; `offers`
  carrying the band's words as a description) and, **only when the service has at least one question**, a
  `FAQPage` node (`mainEntity` of `Question` with an `acceptedAnswer` `Answer`). The provider is the site's
  `LocalBusiness` node by `@id`, type and name when business facts are stated (ADR 0306), and the site title as
  an `Organization` otherwise. It is written into `<script type="application/ld+json">` with `<`, `>` and `&`
  escaped as `\u003c`, `\u003e` and `\u0026`, so no text can end the element. Keys are in a fixed order and
  services are sorted by name then id, so the same files always give the same bytes, whatever order they were
  read in.
- **Recent jobs reuse the jobs archive plan.** A service's page lists its five newest jobs and links to each
  trade's archive for it (`/jobs/<trade>/<id>/`); the index lists the three newest per service. Both read
  `job_archive::plan`, so a job appears here exactly when the archives list it and no second grouping exists.
- **Discovery hooks.** The index and every page join `sitemap.xml` and an `llms.txt` section. The header
  navigation gains a "Services" link unless the owner's own navigation already points at `/services/`.
- **Admin preview.** The editor's preview renders a service through the same function as the build.

## Consequences

- Editing a service and rebuilding changes its page, the index and its structured data together.
- The quote form that uses the same price bands belongs to a later story (TRADE4) and will read this model.

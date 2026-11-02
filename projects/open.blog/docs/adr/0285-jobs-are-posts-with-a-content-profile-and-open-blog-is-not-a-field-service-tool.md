# ADR 0285: Jobs are posts with a content profile, and open.blog is not a field-service tool

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#491](https://github.com/journey-to-code-org/open.blog/issues/491)
- Parent story: [#476](https://github.com/journey-to-code-org/open.blog/issues/476)
- Parent epic: [#471](https://github.com/journey-to-code-org/open.blog/issues/471)

## Context

Tradespeople (contractors, excavators, flooring installers, mobile mechanics, body and paint shops) sell with
evidence: this driveway, that floor, this repair. They need each finished job to become a page with almost no
writing. The project must grow that without becoming a second system next to posts, and without drifting into
software that other tools already do well.

## Decision

- **A job is a Post.** It uses the `job` content profile (the same `profile:` front matter key that
  `research`, `video` and `field-journal` use). Feeds, archives, tags, series, syndication, portable export and
  the Assistant keep working on it unchanged. Trade features are content profiles, publishing capabilities and
  data collections, never a parallel content type.
- **Front matter is one `job` mapping, version 1.** The standard post keys plus:
  `job: { trade, service, place: { town, region }, started, finished, durationHours?, materials?, costBand?,
  media: { before, after }, review? }`. `trade` is a bundled slug (with a site-level extension list),
  `service` is a slug, `started` and `finished` are dates with `finished >= started`, `costBand` is an enum and
  never free text, `media.before` and `media.after` list image references already in the post's media, and
  `review` is the id of a Proof. Unknown keys are preserved so a newer file survives an older build. The shape
  is a stored format: new optional keys may be added, existing keys never change meaning.
- **Towns only, never addresses.** `place` holds a town and a region. A street address, coordinates or a
  customer's name never appear on a public page, in structured data, in a feed or in a log.
- **Customer data is server-side and exportable.** Quote requests and reviews live in the existing server-side
  workspace pattern, are never part of a static build, and have explicit export and erase.
- **Not a field-service tool.** No invoicing, estimating math, dispatch, scheduling of jobs, or payment data.
  A job may name a `costBand` as a public price signal; it is not a quote. Link out to tools that do those things.
- **Opt-in.** A site that has no job posts and enables no trade setting builds byte for byte as before; a test
  holds that.

## Considered options

- **A separate `jobs` collection with its own storage.** Rejected: it would need its own feeds, archives, export
  and Assistant support, all of which a post already has.
- **Free-text cost.** Rejected: an enum is comparable, filterable and cannot hold a promise the business has
  not made.
- **Addresses with a "hide on public" flag.** Rejected: a field that is never published should not be
  collected on the page's source in the first place.

## What would trigger revisiting this

- A trade whose work cannot be described by a town, a service and two sets of images.
- Demand for stored customer records beyond a quote request, which would need its own decision.

## Consequences

- Everything built for posts works for jobs on day one.
- The job shape is documented once and read by every later trade feature.

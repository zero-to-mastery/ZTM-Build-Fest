# ADR 0314: Service areas are a versioned list of towns in openblog.json, checked for duplicates, with regions formatted from a bundled list, and absent means nothing changes

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#484](https://github.com/journey-to-code-org/open.blog/issues/484)
- Task: [#512](https://github.com/journey-to-code-org/open.blog/issues/512)
- Parent epic: [#473](https://github.com/journey-to-code-org/open.blog/issues/473)
- Builds on: [ADR 0285](0285-jobs-are-posts-with-a-content-profile-and-open-blog-is-not-a-field-service-tool.md), [ADR 0305](0305-business-facts-are-one-versioned-block-in-openblog-json-that-pages-the-footer-and-structured-data-all-read.md)

## Context

An owner serves towns, and pages, links and structured data should all come from one list of them. The list
is stored data that other releases will read, so its shape has to be conservative. It is also the one place a
job's town is compared to, so a town can only ever be a town.

## Decision

- **One member of `openblog.json`.** `serviceAreas` is `{ "version": 1, "areas": [ { "town", "region", "note" } ] }`.
  A bare list of areas is read as version 1; the file is always written as the object. Only version 1 is read
  or written: a newer version is refused with a message and the file is not touched. Entries and the object
  accept no other keys, so a typo is an error instead of a silently ignored setting.
- **A town is a town.** `town` and `region` are required, are checked by the same rule as a job's
  `place.town` and `place.region` (ADR 0285: no digits and no commas, so no street address or postal code), and
  have whitespace collapsed. `note` is optional, one line of plain text of at most 120 characters, for a reach
  such as "within 30 miles"; it is shown as written and never read as a distance.
- **Regions are formatted from a bundled list.** The United States (with the District of Columbia) and the
  Canadian provinces and territories are bundled. A region written as a code or a full name, in any case, is
  stored as the code (`Oregon` becomes `OR`). A region not on the list is kept as written, so the list never
  blocks an owner elsewhere. The same function compares a job's region, so `Oregon`, `or` and `OR` are one place.
- **Duplicates are rejected.** Two entries with the same town and region, ignoring case, spacing and region
  spelling, fail with a sentence naming both entries. The same town in two regions is allowed.
- **Bounded.** At most 100 areas. A page for every town in a region is thin content, and the bound keeps the
  build and the sitemap small.
- **Plain messages, all of them.** Every problem is a sentence that names the entry and the field, and all
  are returned, not only the first. `check` and `build` show them as an invalid `openblog.json`.
- **Addresses are derived.** `/areas/<slug>/`, where the slug is the town's slug. A town listed under more than
  one region gets the region added (`portland-me`, `portland-or`), a town with no letters or digits becomes
  `area`, and anything still equal gets `-2`, `-3`. Areas are taken in town then region order, so the same list
  always gives the same addresses whatever order it was written in.
- **Absent means nothing.** With no `serviceAreas` the member is not written back, no page, link or data is
  produced, `areas` is not reserved as an address, and every existing site builds byte for byte as before.
  Having it is never required and never an error for an existing site.

## Consequences

- A town is renamed or removed by editing one list; its page address follows the slug rule.
- Pages and structured data (ADR 0315) read this list and the jobs' towns, nothing else.
- An Admin screen for the list is not part of this decision; the existing Business facts screen pattern can
  edit it later.

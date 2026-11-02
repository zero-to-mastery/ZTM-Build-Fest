# ADR 0311: Services are a `services/` collection of Markdown files with versioned front matter, and a job's service is checked against it only when the site has one

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#483](https://github.com/journey-to-code-org/open.blog/issues/483)
- Task: [#509](https://github.com/journey-to-code-org/open.blog/issues/509)
- Parent epic: [#473](https://github.com/journey-to-code-org/open.blog/issues/473)
- Builds on: [ADR 0285](0285-jobs-are-posts-with-a-content-profile-and-open-blog-is-not-a-field-service-tool.md), [ADR 0305](0305-business-facts-are-one-versioned-block-in-openblog-json-that-pages-the-footer-and-structured-data-all-read.md)

## Context

A job names a `service` as a free short id (`hardwood-install`). The same service then needs a page, a price
signal, a timeline and answers to the questions customers ask, and today each would be retyped wherever it
matters and drift. A service is structured data an owner writes once. Its file format is a one-way door:
owners will hand-write it, so it must be small, versioned and conservative.

## Decision

- **One Markdown file per service in `services/`**, beside `posts/`, `pages/` and `series/`. The file is
  `services/<name>.md`: front matter, then a Markdown body that is the long description. The folder is a new
  source kind (`SourceKind::Service`), so it is read by the same walk as every other content file, and a
  site with no such folder loads exactly as before.
- **Front matter, version 1.** `id` (a short id: lowercase letters, digits and hyphens, at most 60, not
  `page`, the same rule as a job's `service`), `name` (at most 120 characters), `summary` (one line, at
  most 300), `includes` (a list of at most 30 short items), `priceBand`, `typicalTimeline` (a short label such
  as `2 to 4 days`, at most 80) and `faq` (at most 20 entries). `id`, `name` and `summary` are required;
  the rest are optional. Every text value is plain text on one line: no control characters, and nothing is
  read as markup in front matter.
- **Only a file that declares a service marker is a service.** A Markdown file in `services/` is a service only if its front matter declares `version` or `id`. A file with neither is a legacy file from before services existed: it is skipped exactly as if it were not content (not loaded, not an error, not counted, no reserved `services` address, not listed in Admin), so an existing site never starts failing. A file that declares either marker but is otherwise invalid still fails the build, naming the file.
- **`version: 1` is the only version read or written.** A missing `version` means 1. Another value is
  refused with a message that says to update open.blog, and the file is not changed. Keys this release does
  not define stay in the file as written, so a newer file survives an older engine.
- **`priceBand` is the jobs' `costBand` enum, reused, not copied** (`under-500`, `500-2k`, `2k-10k`,
  `10k-50k`, `over-50k`, `ask`). It is a label for what the owner is willing to say in public. Nothing in
  open.blog adds, averages, converts or estimates from it; it is never a quote. Changing one band is changing
  one word in one file.
- **`faq` is a block list of mappings** (`- question:` then `answer:`). The front matter parser knows exactly
  one such key: entry `n`, counting from 1, is stored flattened as `faq.<n>.question` and `faq.<n>.answer`,
  the way `job.*` already is, so the `Value` type and every other key are unchanged and Admin's field map
  carries it as ordinary keys. A `faq` list that is not mappings (`faq: [a, b]`, `- just text`) is refused
  with the shape to write. The writer emits the list back in numeric order, `question` first.
- **Ids are unique.** Two services with one id fail the load, naming both files.
- **A job's `service` is checked against the collection only when the site has at least one service.** An
  unknown id fails the load with the sentence ``job.service: `x` is not one of this site's services; known
  service ids are a, b`` (the ids sorted). A draft job gets the same sentence as a `job not ready to publish`
  warning, as every other job problem does. A site with no `services/` files, and every job already written,
  behave exactly as before: no new rule, no new output, no new warning. Adopting the collection is the owner's
  choice, and the first service switches the check on.
- **Services are public content.** Nothing about a customer belongs in one.

## Consequences

- `Sources` gains `services` and `Site` gains `services`, empty by default.
- A site that already had loose files under `content/services/` (which were ignored) now has them read as
  services and refused if they do not have the front matter. This is the cost of using the folder name the
  epic names; the message names the file.
- Pages, structured data and Admin build on this model (ADR 0312, ADR 0313).

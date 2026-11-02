# ADR 0313: Services are edited in Admin through the document routes with a screen of their own, scaffolded as drafts from the command line

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#483](https://github.com/journey-to-code-org/open.blog/issues/483)
- Task: [#511](https://github.com/journey-to-code-org/open.blog/issues/511)
- Parent epic: [#473](https://github.com/journey-to-code-org/open.blog/issues/473)
- Builds on: [ADR 0311](0311-services-are-a-services-collection-of-markdown-files-with-versioned-front-matter-and-a-jobs-service-is-checked-against-it-only-when-the-site-has-one.md), [ADR 0312](0312-service-pages-the-index-and-their-structured-data-are-rendered-from-the-collection-alone-deterministically-and-only-for-a-site-that-has-services.md), [ADR 0307](0307-the-business-facts-screen-edits-one-member-of-openblog-json-as-text-checked-against-a-revision-of-that-member-and-problems-are-said-beside-the-field.md)

## Context

Services are Markdown files, so an owner could write them by hand, but the people this epic is for work from a
phone. The list of questions is the hard part to type: a block list of mappings with indentation. Admin already
edits posts, pages and series through one set of document routes (list, read, create, save with a revision,
delete to the trash, preview), each behind a session, CSRF and size bounds. Services must not get a second
write path.

## Decision

- **`services` is a fourth document kind on the existing routes.** `GET /admin/api/documents?kind=services`,
  `GET`/`PUT`/`DELETE /admin/api/document?path=services/<id>.md` and `POST /admin/api/document` with
  `kind: "services"` are the same handlers, with the same authentication, CSRF, 2 MiB document bound, revision
  check (a stale write is a 409) and trash. Nothing new is added to the route table. A new service's file is
  `services/<id>.md`, named from its `id` (a service needs no title or slug), and an `id` that is not a valid
  service id refuses the create.
- **A save is checked by the build.** The route composes the file, loads the whole site with it and returns
  the build's own sentences for the edited file as `problems` (422), so a rule can never pass in Admin and fail
  in the build. Nothing is written when the file is refused.
- **The flattened FAQ keys are the only dotted keys besides `job.*`.** The field-name guard accepts
  `faq.<number>.<name>` (a number of up to three digits, one name, nothing deeper) and nothing else; a key like
  `faq.x.question` or `faq.1.question.extra` is refused. The editor sends `faq.1.question`, `faq.1.answer` and
  so on, renumbered from 1, so a removed question leaves no stale key behind and the front matter writer emits
  them back as the block list ADR 0311 defines.
- **A screen of its own, built like Business facts.** `#/services` lists the services; `#/services/new` and
  `#/services/edit/<path>` edit one. It is a module (`web/admin/services.js`) with the pure rules at the top,
  tested without a page, and one column from 320px with every control at least 44px tall and named. It has
  fields for the name, the id (set from the name for a new service, read-only afterwards because it names the
  file and the page address), the summary, a repeating list of included items and a repeating list of questions
  (each with **Up**, **Down** and **Remove**, named by their position, and focus placed in a new row), the price
  band as a select of the jobs' words, the timeline, the page text and a **draft** box. Keys the form does not
  own are sent back as they were. Problems are said beside the field, and the first is focused.
- **A draft service.** `draft: true` keeps a service off the site: it is not built and not counted among the
  known service ids a job is checked against, and while it is unfinished its problems are only warnings
  (`service not ready to publish: ...`). This lets a half-written service be saved from a phone, and lets the
  scaffold below write the file without stopping a build, the way a new job does (ADR 0287). Admin's preview and
  any load that includes drafts see it.
- **Jobs are offered the real ids.** The job form's service suggestions (`meta.job.services`) now include the
  ids of the site's published services.
- **`openblog new "Name" --profile service`** writes `content/services/<id>.md`: `version: 1`, `id` (from
  `--id`, or the name as a slug), `name`, an empty `summary`, `priceBand` when `--price-band` is given, and
  `draft: true`, then a line of body text. The id and the band are checked with the build's own functions and
  nothing is written when one is refused or the file exists. `--series`, `--tags` and the job options are
  refused. `openblog check` lists what is still missing.
- **The durable workspace allow-list** includes `services/` beside `posts/`, `pages/` and `series/`, so a hosted
  Admin can read and write them.

## Consequences

- A service's own file keeps unknown top-level keys; keys inside one question other than `question` and
  `answer` are not kept by the editor, which renumbers entries.
- A `status: draft` key (which other documents accept) also holds a service back, but the draft box only
  reads `draft`.

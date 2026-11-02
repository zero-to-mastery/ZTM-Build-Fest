# ADR 0287: The job form and its scaffold are written once in core and produce a normal post

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#477](https://github.com/journey-to-code-org/open.blog/issues/477)
- Tasks: [#494](https://github.com/journey-to-code-org/open.blog/issues/494), [#495](https://github.com/journey-to-code-org/open.blog/issues/495)
- Builds on: [ADR 0285](0285-jobs-are-posts-with-a-content-profile-and-open-blog-is-not-a-field-service-tool.md)

## Context

A job is a post with a `job` mapping (ADR 0285). Authors should not hand-write that mapping in a generic
editor. Admin and the command line both need to start a job, and they must not drift into two shapes.

## Decision

- **The scaffold is core's.** `job::SCAFFOLD_HEADINGS` (`Problem`, `What we found`, `What we did`, `Result`)
  and `job::scaffold_body()` are the only place the four headings exist. Admin reads the body from
  `GET /admin/api/meta` (`job.scaffold`); `openblog new --profile job` calls the same function.
- **The scaffold is ordinary Markdown, placed once.** Headings are `##`, with an empty line to write under
  each. Admin places them only when the Job profile is chosen and the body holds nothing but space; the CLI
  writes them into the new file. Nothing is locked: the author may rename, reorder or delete a heading, in
  Visual or Markdown mode, and choosing the profile again never overwrites words.
- **The form owns only the fields it asks about.** Trade, service, town, region, started, finished, price
  range and the before and after photos are written as the flattened `job.*` front matter keys. Keys the form
  does not show (`durationHours`, `materials`, `review`, and anything a newer version adds) pass through
  untouched. Switching away from Job hides the form, keeps the answers in the editor and never edits the body.
- **Validation is core's.** `job::normalize_trade` and `job::normalize_service` hold the trade and service
  rules; `from_front_matter` uses them, so the build, the form's "Check this job" button
  (`POST /admin/api/job/check`) and the CLI give the same sentences. The check route is read-only, behind the
  session and CSRF checks, and bounded to 64 KiB.
- **Only `job.*` keys may be dotted.** Admin's field-name rule accepts a dotted name only under `job.`, with
  plain segments and at most three levels, which is the nesting the parser already accepts.
- **Service is free text with suggestions.** The services collection (TRADE3) does not exist yet, so the
  service field suggests the service ids already used by this site's jobs and accepts any valid id. When the
  collection lands it becomes the suggestion source; the stored value does not change.
- **Photos use the existing upload.** The before and after pickers call Admin's `upload` route and store the
  returned site path. No new media handling and no thumbnails of unpublished files.
- **A CLI job starts as a draft.** A new job has a trade, service and town only if the author passed them, so
  `new --profile job` always writes `draft: true`; the build reports what is missing as warnings (ADR 0285).

## Considered options

- **A trade picker fed by free text only.** Rejected: a typo becomes a trade that has no archive.
- **Locking the headings in Visual mode.** Rejected: the brief for the epic is that nothing is locked.
- **A second copy of the headings in JavaScript.** Rejected: two lists would drift.

## Consequences

- Admin and the CLI create the same file shape; the shape is a stored format that ADR 0285 already versions.
- The Job form works at 400 px: one column, labelled controls, 44 px targets, photo names that wrap.

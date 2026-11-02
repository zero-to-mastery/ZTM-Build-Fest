# ADR 0293: A capture is a job draft started from a phone, built from the Job form's own keys

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#479](https://github.com/journey-to-code-org/open.blog/issues/479)
- Task: [#499](https://github.com/journey-to-code-org/open.blog/issues/499)
- Builds on: [ADR 0285](0285-jobs-are-posts-with-a-content-profile-and-open-blog-is-not-a-field-service-tool.md), [ADR 0287](0287-the-job-form-and-its-scaffold-are-written-once-in-core-and-produce-a-normal-post.md)

## Context

A tradesperson on site has a phone, wet hands and a minute. They will not open the editor, so the job has to
be started from photos and a few words and tidied later. Whatever the view saves must be an ordinary job post
(ADR 0285), so nothing downstream learns about "captures".

## Decision

- **A Capture view at `#/capture`** (element `ob-job-capture`, file `web/admin/job-capture.js`) is one
  column designed at 400 px: an **Add photos** control as the largest target (a plain file input with
  `accept="image/*"`, so a phone offers camera or library), thumbnails with Remove, a Trade select, a Service
  field with suggestions, a Town field with the recent towns as buttons, a Notes area and **Save draft**.
- **Saving makes an unpublished job draft.** Fields are `draft: true`, `profile: job` and only the keys the
  Job form already writes (`job.trade`, `job.service`, `job.place.town`, `job.started`, `job.finished`). The
  body is core's job scaffold with the notes under its first heading and the photos as Markdown images after
  it, each with a plain placeholder alt for the author to improve. Nothing is classified as before or after:
  that is the author's call in Write.
- **Photos use the existing Admin `upload` route.** No new media handling.
- **A working title and a collision-free slug.** The title is `<Trade> in <Town>` (or the nearest thing the
  picks allow) and the slug ends in the first six characters of the capture id, so two captures of the same
  kind on one day never meet a "file exists" refusal.
- **Picks are remembered on the device**, under `openblog.capture.prefs.v1` in `localStorage`: the last trade,
  the last service and the last eight towns, most recent first. The record is versioned, bounded (80
  characters per value) and read defensively; anything unreadable or from another version is an empty memory.
  It holds no notes, photos or customer data, and it is never sent anywhere. Without storage the picks are
  simply not remembered.
- **Bounds come from core.** `openblog_core::capture` holds the limits (twelve photos, 8,000 characters of
  notes, the site's `admin.maxUploadMb` per photo) and Admin's meta advertises them as `capture`, so the view,
  the queue and the server agree on one set of numbers.
- **A photo the server refuses for good** (not an image, too large) is left out, named in the result, and the
  draft is still made. Everything else stops the save and is reported with the capture kept on the screen.
- **No provider is contacted.** The view only calls this site's own Admin API.

## Considered options

- **A new `/admin/api/capture` route taking one big request.** Rejected: a phone on a weak connection does
  better with small requests it can retry, and the existing routes already check sizes and bytes.
- **Putting photos in `job.media.before` or `after`.** Rejected: a photo taken on site is not yet either.
- **Asking for a title.** Rejected: a title is the first thing that does not fit in a minute on a roof.

## Consequences

- A capture is only a faster way into a job post; a site that never opens the view builds byte for byte as before.
- The Capture tab is in Admin's Content navigation for every site, since the Job profile is always available.

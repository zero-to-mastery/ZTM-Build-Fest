# ADR 0246: The landing page is one file beside the content, saved by atomic rename against a revision, and a newer file is never overwritten

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#323](https://github.com/journey-to-code-org/open.blog/issues/323)
- Parent story: [#315](https://github.com/journey-to-code-org/open.blog/issues/315)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0245, ADR 0213
- Serves: [#324](https://github.com/journey-to-code-org/open.blog/issues/324)

## Context

ADR 0245 defines the landing page value. Admin needs to save it without corrupting it, without two devices
silently overwriting each other, and without touching any other setting.

## Decision

- **Location: `<content>/landing.json`**, a single structured file, public text beside the posts (not under
  `.openblog/`, which is private). The build reads it like the other content-folder files
  (`third-perspectives.json`, `continuations.json`); the file itself is not copied to the output.
- **Revision: SHA-256 of the stored bytes**, as for reading paths and the source library. A GET returns it
  (`null` when there is no file); a PUT names the revision it is based on.
- **Atomic write.** The canonical bytes are written to a temporary file in the same folder, synced, then renamed
  over the target while the build lock and the content transaction lock are held. A crash leaves the previous
  file and, at worst, an ignored `.landing.*.tmp` file.
- **Conflict.** A save whose revision is not the stored one (including a file that appeared or went away) is a
  `409` with `conflict: true`, the current revision and the current page; nothing is written. Creating the file
  is the one save with no revision, and it conflicts if a file exists.
- **Newer files are untouchable.** A stored file whose `version` is newer than this release reads as invalid
  (with the "newer open.blog" message) and a save over it is a `409` with `newerVersion: true`, even with the
  right revision. An owner can still repair a malformed or hand-broken file by saving over it with its revision.
- **Routes: `GET /admin/api/landing`, `PUT /admin/api/landing`.** Behind the session; the write behind CSRF and
  the same-origin checks; JSON only; bodies over 512 KiB are `413` and a page over 256 KiB is refused as
  invalid. The client cannot choose the stored `format` or `version`: they are set by the server. Any other
  verb or name is not a route. An invalid page is a `422` listing actionable problems and never echoing the bad
  value back.
- **Only that file changes.** A save never reads, rewrites or reformats `openblog.json`. `GET` also returns the
  default layout the legacy `home` settings stand for, so an editor can start from what visitors see.
- **A bad file does not break the site.** At build time a file that does not parse is reported as a warning and
  the home page renders from the legacy settings (ADR 0247), so a hand edit can never take the site down.

## Considered options

- **ETag headers.** Rejected: the existing Admin API carries revisions in the JSON body.
- **Locking the file for the length of an edit.** Rejected: a lock outlives a closed phone browser; a revision
  compare costs the owner a reload only when there is a real conflict.
- **Failing the build on a malformed file.** Rejected: an owner who cannot reach Admin would be locked out of
  the repair; the warning names the file and the problem.

## Consequences

- Unrelated configuration cannot be corrupted by a landing page save, and the reverse.
- #324 renders from the same parsed value Admin saved.

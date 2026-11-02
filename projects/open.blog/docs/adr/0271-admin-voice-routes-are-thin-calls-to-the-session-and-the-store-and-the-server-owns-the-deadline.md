# ADR 0271: Admin voice routes are thin calls to the session and the store, and the server owns the deadline

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#444](https://github.com/journey-to-code-org/open.blog/issues/444)
- Parent story: [#417](https://github.com/journey-to-code-org/open.blog/issues/417)
- Parent epic: [#408](https://github.com/journey-to-code-org/open.blog/issues/408)
- Builds on: ADR 0266, ADR 0267, ADR 0268

## Context

Admin Studio gets a Voice view. The rules that protect the author's words (a rough draft is created once, the
deadline is real, a polished save carries a revision) already live in `voice_session` and `voice_store`. The
Admin layer must add reach, not rules, so that a bug in a page cannot rewrite or extend anything.

## Decision

- **Routes under `/admin/api/voice/`**, in `admin/voice.rs`, each a few lines over the shared modules:
  `GET catalog`, `GET status`, `POST draw`, `GET session`, `DELETE session` (scrap), `POST session/start`,
  `PUT session/draft`, `POST session/lock`, `GET samples`, `POST samples` (a new polished draft),
  `GET samples/{id}`, `PUT samples/{id}` (polished only) and `POST samples/{id}/visibility`. Everything else is
  a 404. Every route needs the session and every write the CSRF token and a same-origin request, like the other
  Admin routes. `POST samples/{id}/promote` is a later task: promotion is one shared store function.
- **Bodies are bounded before they are read.** Routes that carry text take at most 256 KiB, the rest 4 KiB.
  A draft over 60 KiB is a 413 whatever its wrapper.
- **The deadline is read from the session record on the server.** `PUT session/draft` is refused from the
  deadline on (409 with `timeUp`), with no grace. `POST session/lock` accepts the text on screen only within
  the 10 second grace the session module defines; later, the last saved draft is locked. The page's clock is a
  display and decides nothing.
- **Resume is `GET session`.** It returns the original deadline as `remainingSeconds` (a duration, so the page's
  own clock cannot stretch it) and the saved draft. A session whose time has run out is locked from the saved
  text, or discarded when nothing was saved, as the session module does for the CLI. `GET status` reads only,
  for pages that must not change anything.
- **A session has an id**, `<prompt-id>@<startedAt>`. Draft saves and locks name it, so text from an earlier
  session or another tab is refused (409 `otherSession`) rather than written into this one. After a lock the
  session is gone, so a late save is a plain 409 `noSession`.
- **A rough draft has no write route.** `PUT samples/{id}` for a rough name answers 409 `readOnly` without
  opening the file. The only way a rough file is born is the lock, in the store.
- **A polished draft is written beside its rough draft**, in the same folder (so a pair never straddles the
  folders). `POST samples` creates it with no revision and refuses if one exists; `PUT` replaces it with the
  revision read. A stale revision is a 409 `conflict` that carries the revision and the sample stored now, so
  the page can offer the author's choice. The visibility of a pair changes only through `visibility`, which
  moves both files byte for byte.
- **Responses are safe to show.** A path is always relative to the project. An error never repeats sample text
  (a store failure has the project's absolute path replaced by "the project"). Tests send a marker as text and
  check that no error, listing or conflict carries it.
- **The draw leaves out prompts already written today** while at least three others remain, because a session
  for them would be refused; a redraw passes the ids just shown; a `pack` restricts the draw to one pack.

## Considered options

- **Duplicate the deadline check in the page.** Rejected: a page is the one place a clock can be wrong.
- **A PUT for rough drafts that checks the bytes.** Rejected: "unchanged" is not an update; the route does not
  exist so no future change can make it one.
- **Session id from a counter.** Rejected: the record has no counter, and the start time and prompt already
  name a session.

## What would trigger revisiting this

- A second Admin user writing at once: sessions are one per site by design (ADR 0267).
- A hosted store: the routes would call it through the same two modules.

## Consequences

- The CLI and Admin cannot disagree about time, lengths or files.
- The page may be replaced or buggy without being able to extend a session or edit a rough draft.

## Notes

- 2026-10-28: `POST samples/{id}/promote` (ADR 0270) and `GET`/`POST voice/erase` (ADR 0283) were added after
  this decision; the route list above predates them. `DELETE voice/session` now names the session it gives up
  (`{ sessionId }`, a 409 `otherSession` otherwise; only an unreadable record may be scrapped unnamed), so a page
  left on an earlier session cannot throw away a newer one. `GET voice/session` answers `finishing` within the
  lock grace after the deadline instead of locking or discarding, so the surface that was writing can still hand
  over its last words. An error is scrubbed of the project's canonical path; a relative root is never matched.

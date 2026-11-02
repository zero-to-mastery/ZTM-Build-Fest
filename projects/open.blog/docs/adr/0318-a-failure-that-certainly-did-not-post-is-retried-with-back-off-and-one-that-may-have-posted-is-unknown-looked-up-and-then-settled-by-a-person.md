# ADR 0318: A failure that certainly did not post is retried with back-off, and one that may have posted is unknown, looked up, and then settled by a person

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #357 (task #372)

## Context

A provider call can end in four ways that matter: it clearly posted, it clearly did not, the provider said slow
down, or nobody knows (a timeout, a dropped connection, a 5xx, an unreadable answer, a crash between the call and the
record). The epic's rule is that the last one never silently duplicates a post. ADR 0308 already fixed the statuses
and said an unknown outcome resolves only to published or failed; ADR 0316 made a crash after sending `unknown`.
This ADR decides what each outcome does next.

## Decision

- **Five kinds of delivery error, chosen by the adapter** (`netlify/lib/social-delivery.mjs`): `transient` (certainly
  not accepted), `rate-limited` (HTTP 429, with an optional Retry-After), `rejected` (the provider refuses this post
  and will again: 400, 403, 404, 409, 410, 422), `auth` (401) and `uncertain` (everything else). A plain `Error`,
  a timeout, a malformed success (no post id, or one that is not printable and bounded) and any status the adapter did
  not classify are `uncertain`. The classification is the one place that decides safety, so the safe answer is the
  default.
- **What happens next.** `transient` and `rate-limited` go back to `scheduled` with `next_attempt_at`; `rejected` and
  `auth` become `failed` and are not retried; `uncertain` becomes `unknown`. After the allowed attempts (default 5,
  `OPENBLOG_SOCIAL_MAX_ATTEMPTS`, at most 10) a retryable failure becomes `failed` with the code
  `attempts-exhausted`, a dead letter that keeps its history.
- **Back-off** doubles per attempt from a base (60 seconds), is capped (an hour), and keeps at least half its nominal
  wait with jitter in the rest. **Retry-After** is a floor, never a shortcut: the wait is the larger of the hint and the
  back-off, and a hint is capped at a day, so a broken or hostile header cannot park a post for a year. A
  rate limit also **pauses the whole account** (`accounts.paused_until`), so the other announcements for it are not
  sent into the same limit; the claim skips a paused account.
- **Unknown is looked up, never retried.** A post that is `unknown` is looked at again after 5 minutes, then 15
  minutes, 1 hour, 6 hours and a day, by the adapter's optional `reconcile`. It resolves only three ways: the
  provider shows it (`published`, with the provider's own post id, and the attempt is corrected to `published`); the
  provider can say conclusively that it is not there **and** the attempt is at least 15 minutes old (providers lag),
  which makes it `failed` with `not-delivered` (still not sent automatically); or it stays `unknown`. After six
  looks, or at once for a destination that cannot be looked up, it gets `needs-review` and no next look. Nothing
  here ever calls `publish` for an `unknown` post.
- **A person settles what the machine cannot.** Two hosted routes, called through the Admin like the others (admin key,
  version-checked, site-scoped): `announcements/resolve` records an `unknown` post as posted (the author supplies the
  provider's post id, validated) or not posted (`failed`, `reviewed-not-posted`), through the same fenced `settle`
  function; `announcements/retry` puts a `failed` post back in the queue with a fresh allowance of attempts
  (`attempt_floor` is set to the attempts used, so the history stays and the count restarts). An `unknown` post cannot
  be retried (409 `needs-resolution`): the author first says whether it was posted. This keeps to ADR 0308's table
  (`unknown` to `published` or `failed`; `failed` to `scheduled`).
- **Audit.** `announcements/attempts` lists every attempt of one announcement: number, times, outcome, HTTP status,
  a short code and a fixed sentence, and the provider post id. The list never carries the worker, the sending mark, the
  request id, a header, a body or a token. Admin shows it as "What was tried", loaded when opened.
- **Admin UI.** A failed announcement says why in words and offers "Try again" after a confirmation; an unknown one
  offers "Check the result", which asks the author to look at the provider's account and choose posted (with the
  post id) or not posted. A scheduled announcement waiting to retry says when. Controls are labelled, keyboard
  operable and 44px high, and the rows fit a 320px screen.
- **Nothing sensitive is kept or shown.** Error details are fixed sentences by kind (plus the HTTP status); no
  provider text, header, token or key is stored, logged or returned. A provider request id is stored on the attempt
  but not shown.

## Considered options

- **Retry an unknown outcome after a delay.** Rejected: it is exactly the duplicate the epic forbids. A provider
  idempotency key helps only where the provider honours it, and the adapter interface passes one for those that do,
  but the worker does not assume it.
- **Requeue automatically when the provider says it is absent.** Rejected for now: an absence lookup can be wrong
  (eventual consistency), and a duplicate on someone's LinkedIn page is worse than one extra click. The result is
  `failed` with a code that says it is safe to retry by hand.
- **A new `retrying` or `dead` status.** Rejected: `scheduled` with `next_attempt_at` and `failed` with a code carry
  the same meaning and keep the status list, the fixture and the Rust model unchanged.
- **Count rate-limit waits as free.** Rejected: an unbounded loop is worse than a visible dead letter. Only a
  deferral for lack of time in a run gives its attempt back.

## Consequences

- An `unknown` announcement is a to-do for a person when the adapter cannot look it up or cannot be sure; Admin and
  the docs say so, and the attempt history shows what happened.
- A manual "posted" resolution trusts the author's post id; it is not verified against the provider.
- Operators can see stuck work with one query: `status = 'unknown'` or `status = 'failed'` in
  `openblog_social_posts`, with `last_error_code`.

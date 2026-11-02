# ADR 0316: Due announcements are claimed by database functions under a lease, and an expired lease after sending is unknown

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #357 (task #370)

## Context

ADR 0294 shaped the queue for an atomic claim (a `version`, a lease, an attempt counter, an idempotency key) but
wrote no claim. Two workers must never post one announcement, a crashed worker must not strand one, and the epic's
rule is that an outcome nobody confirmed is never retried blindly. PostgREST cannot say `for update skip locked`, and
a read followed by a write lets two callers take one row, so the claim needs to be one database call. This is hosted
schema, which is a one-way door, so it must be additive and reversible.

## Decision

`supabase/social-queue.sql` (undone by `social-queue-rollback.sql`; `social-rollback.sql` drops the functions first)
adds four functions and a few columns, all re-runnable, and changes no existing row:

- **`openblog_social_claim_due`** picks due, `scheduled` rows of one site in time order with
  `for update of p skip locked`, up to a bounded batch (1 to 25), and in the same statement moves them to `claimed`
  with a lease (`lease_expires_at`, 30 to 900 seconds), raises `attempt_count` and `version`, and opens the attempt
  row. A row locked by another claim is skipped, so two concurrent callers get disjoint rows (tested against a real
  Postgres). The status and time are tested again under the lock, so an author's cancel that committed first wins.
  A row is not claimable while `attempt_count - attempt_floor` has reached the attempt limit, while its
  `next_attempt_at` is in the future, while its account is `paused_until` a later time, or while its provider is in
  `p_skip_providers` (a provider this release knows but has no adapter for waits instead of failing). A soft
  per-account cap keeps one account from taking a whole batch.
- **`openblog_social_mark_sending`** stamps the attempt `sending_at` and returns true only while that attempt still
  holds a valid lease and has not already sent. A worker that gets false does not call the provider. The stamp is
  the line between "nothing was sent" and "it might have been".
- **`openblog_social_reap_leases`**, which every claim runs first, finishes claims whose lease ran out. A claim whose
  attempt never reached `sending_at` goes back to `scheduled` (or to `failed`, `attempts-exhausted`, when its attempts
  are used up). A claim that did reach it becomes **`unknown`**: the request may have reached the provider, so it is
  never claimed again, only looked up (ADR 0318).
- **`openblog_social_settle`** records an outcome (`published`, `retry`, `failed`, `unknown`) and finishes the attempt
  in one transaction. It is **fenced by the version** the caller read: if the row has moved on (the lease was reaped
  and another worker holds it) nothing changes and no row comes back, so a stale holder cannot overwrite the current
  one. `published` requires the provider's own post id (the database check of ADR 0294 and the function both refuse
  one without). An `unknown` outcome resolves only to published or failed, as ADR 0308 says.
- **Columns:** `posts.next_attempt_at`, `posts.attempt_floor`, `posts.reconcile_count`, `attempts.sending_at`,
  `accounts.paused_until`, and the schema version row `2`. No status was added: `failed` is the dead letter and
  `unknown` is manual review.
- **Private by construction.** The functions run as the caller (`security invoker`), take the site as an argument and
  check its shape, and only `service_role` may execute them (`anon`, `authenticated` and `public` are revoked). They
  can do nothing the table grants of ADR 0294 do not already allow, and they never delete.
- **Hosted side.** `netlify/lib/social-queue.mjs` is the only caller. It passes the site from the server's settings,
  verifies that every returned row belongs to it, validates what it sends, and turns a storage failure into a fixed
  error that carries no reply and no key.

## Considered options

- **Conditional PATCH over PostgREST, as announcements do.** Right for an author's single-row edit; wrong for a claim,
  where two callers each read the same due rows first. The author's edit and the claim still exclude each other,
  because both condition on `status = scheduled` and the version.
- **`security definer` functions.** Rejected: they would run with the owner's rights; invoker functions are limited
  by the grants already reviewed.
- **Requeue every expired lease.** Rejected: a crash after the request left would post twice. The `sending_at` stamp
  is cheap and makes "never sent" provable.
- **A new `retrying` status.** Rejected: `scheduled` plus `next_attempt_at` is the same state and keeps the status
  list, the fixture and the Rust model unchanged.

## Consequences

- Delivery is opt-in a second time: without `social-queue.sql` announcements still wait, as before.
- An unknown outcome is a real state with a real cost: someone (the reconciliation of ADR 0318, then a person) must
  settle it. That cost is chosen over a duplicate post.
- The per-account cap is a politeness limit, not a guarantee: two simultaneous claims may each take the cap. The
  rate-limit pause of ADR 0318 is what protects an account.

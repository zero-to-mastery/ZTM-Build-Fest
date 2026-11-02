# ADR 0309: Announcement routes are called by the Rust Admin with the admin key and change a row only by version

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #356 (task #368)

## Context

ADR 0293 fixed who may act (the Rust Admin, with a server-held key, naming the signed-in user) and for which site
(the server's `OPENBLOG_SITE_ID`). ADR 0308 fixed what a valid announcement is. This ADR is the routes between
them: create, list, edit, reschedule and cancel, plus the destinations an announcement can go to.

## Decision

- **Two layers, each checking.** The Admin (`/admin/api/social/*`) sits behind the session and CSRF seams like every
  Admin route and is bounded by a 32 KiB preflight limit. It does the checks that need the site: the post must be
  public, and **the link is computed from the site, never taken from the browser** (a request that carries
  `canonicalUrl`, a site, a status or any other unknown field is a 400). It then calls the hosted function
  (`netlify/functions/social.mjs`, logic in `netlify/lib/social-announcements.mjs`) with
  `Authorization: Bearer <OPENBLOG_SOCIAL_ADMIN_KEY>` and `X-OpenBlog-Actor: <user>`. The hosted function accepts only
  the admin role (a worker key is a 403), refuses a body or query that names a site, and applies the ADR 0308 rules
  again before it writes.
- **Off unless configured, on both sides.** The Admin needs the connected-accounts settings, `OPENBLOG_SOCIAL_ENDPOINT`
  (`https`, or `http` to this machine for development; no credentials, query or fragment) and
  `OPENBLOG_SOCIAL_ADMIN_KEY` (32 characters or more) in **its own process environment**. Missing or invalid, every
  route but `social/status` is a 404 and nothing is read or called. The key is never read from `openblog.json` or the
  repository, never returned, and never put in an error. The hosted function is already off unless the settings of
  ADR 0293 are valid. Site builds, exports and cross-posting do not read any of it.
- **Destination ownership is checked in the database's terms.** An account must belong to this site (`site_id` is
  in every query and every row read back is verified), be `connected`, and be of a supported provider. An unknown or
  another site's account is the same 404, so ids cannot be probed across sites; a disconnected or `needs-reauth`
  account is a 409 that says to connect it again.
- **Idempotent creation.** A create carries an idempotency key. The same key for the same destination returns the
  original row (200, `replayed: true`) even if its time has since passed, never a second post; the same key with a
  different request is a 409. Two submits that race on the key resolve through the unique index to one row.
- **A write names the version and the status it expects.** Edit, reschedule and cancel send the `version` they read;
  the update is conditional on that version **and** on `status = scheduled`, and raises the version. If a worker
  claimed the row, or another edit landed, between the read and the write, zero rows change and the author is told
  to reload (409 `conflict` or `stale`, with the current version). A claimed, published, failed or unknown
  announcement cannot be edited or canceled (409 `not-editable`). Canceling twice is the same as once. Nothing is
  deleted (the function has no delete right); cancel is an update that stamps `canceled_at`.
- **What the browser gets back is an allow-list.** The Admin passes on only `announcement`, `announcements`,
  `destinations` and `replayed`, and, for an error, a plain code, a short message and the version or status to
  reload from. The lease owner, the idempotency key and anything else the function says are dropped. A function that
  rejects the Admin key is reported as a 502 setup problem, never a 401, which the Admin UI would read as an expired
  session. An unreachable function is a fixed 502. No error carries a key, an endpoint, a storage response or a
  refused value.
- **No new table or column.** The routes use the ADR 0294 tables as they are. Listing is one page (default 50, at
  most 100), newest first, filterable by status and by post path.

## Considered options

- **Let the browser call the hosted function with a short-lived token.** Rejected: the Admin session would need to
  mint tokens and the hosted function would need a second way to trust a caller (ADR 0293 keeps one).
- **Row-level locking (`select ... for update`) through an RPC.** Rejected for now: PostgREST conditional updates give
  the same guarantee with no new SQL; an RPC can replace them without changing the routes.
- **Trust the browser's link and let the hosted function fetch it to see that it is public.** Rejected: it would make
  the function fetch caller-chosen URLs.

## Consequences

- The hosted function answers only `GET destinations`, `GET|POST|PATCH announcements`,
  `POST announcements/reschedule` and `POST announcements/cancel`; anything else is a 404 or 405.
- The delivery worker (a later story) claims rows by the same `version` and `status` columns, so a claim and an
  author's edit exclude each other.

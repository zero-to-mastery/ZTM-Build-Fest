# ADR 0081: The hosted feedback transport is opt-in twice and reuses the engagement function, its quotas and its moderation token

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#81](https://github.com/journey-to-code-org/open.blog/issues/81)
- Parent story: [#29](https://github.com/journey-to-code-org/open.blog/issues/29)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0079](0079-typed-scholarly-feedback-kinds-and-one-submission-format.md),
  [ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md)
- Coordinates with: [#82](https://github.com/journey-to-code-org/open.blog/issues/82) (forms),
  [#83](https://github.com/journey-to-code-org/open.blog/issues/83) (moderation),
  [#211](https://github.com/journey-to-code-org/open.blog/issues/211) (participation policy),
  [#225](https://github.com/journey-to-code-org/open.blog/issues/225) (moderation inbox)
- Contract: [Hosted engagement](../specs/hosted-engagement.md)

## Context

#81 owns the optional hosted submission transport for passage feedback (#92). The site already
has one hosted seam: the Netlify Function in `netlify/functions/engagement.mjs`, which checks the
request origin, reads the deployed comment-policy manifest, applies Supabase-backed hourly quotas
and authorizes moderation with a server-held token compared in constant time. Static reading must
never depend on it, a site that does not enable feedback must see no change, and no reader may be
e-mailed or notified.

## Decision

- **Opt-in twice, off by default.** The server switch `OPENBLOG_FEEDBACK_ENABLED=true` (exactly
  `true`) says the deployer ran the migration; without it `POST /feedback` and `/admin/feedback`
  answer `404` with code `unavailable` and a plain explanation, before any database or site
  request. The site switch `engagement.feedback` (default `false`, with hosted engagement enabled
  and an endpoint) makes the build publish `openblog-feedback.json`; without it the build output
  is byte-for-byte unchanged and the function accepts nothing, because a missing manifest means
  every post is closed.
- **The site's published policy decides.** The manifest maps each post's path to `open`, `locked`
  or `hidden`, taken from the post's existing `comments:` setting until the participation policy
  (#211) gives feedback its own. The function reads it from `OPENBLOG_SITE_ORIGIN` (below
  `OPENBLOG_SITE_BASE_PATH`) without following redirects, as it reads the comment manifest, and
  accepts feedback only for `open` posts: `locked` answers `403 closed`, anything else
  `403 unavailable`.
- **One request order.** Configuration, origin (a public submission needs the site's exact
  origin), the switch, then the shared validator (`readFeedbackSubmissionJson` from
  `web/components/passage-feedback.js`, the ADR 0079 rules, including passage-target number
  canonicality read from the exact request text), then the policy, then the existing quota, and
  only then storage. A refused submission (`422`, or `413` when too large) costs no database or
  site request, and its code and message are the build's.
- **Quotas reuse the existing abuse controls**: `openblog_consume_rate_limit` with its own
  `feedback` bucket, 5 submissions per client and 500 per site per hour, keyed by a salted hash
  of the connection address, as comments are. A replayed submission counts again and is stored
  as another pending item; nothing else is deduplicated, and no identifier of the reader is
  stored with the row.
- **The receiver stamps the time.** `receivedAt` is the function's clock in canonical UTC whole
  seconds; a reader's `seenAt` later than it is dropped. The reader cannot send `receivedAt`,
  `status`, `channel` or any other field: unknown fields are refused. Every stored row is
  `pending`.
- **Moderation reuses the token.** `GET /admin/feedback?status=&kind=` lists up to 200 items as
  `{id, status, moderatedAt, feedback}`, where `feedback` is the ADR 0079 record that
  `openblog_core::scholarly_feedback::HostedFeedback` reads; `PATCH /admin/feedback {id, status}`
  sets `approved` or `rejected` and the moderation time. Both require
  `Authorization: Bearer OPENBLOG_ADMIN_API_KEY`, compared with `timingSafeEqual`. The reader's
  name appears only in these authorized responses. The Admin moderation screen is #83 and the
  unified inbox #225.
- **No public read yet.** Nothing a reader submitted can be read back through the transport.
  Publishing approved feedback goes through the public provenance projection in the build
  (#83), so a quotation the author has since removed is never republished.
- **No outbound messages.** The transport collects no e-mail and sends nothing to readers or
  anyone else.
- **Failures are scoped.** A provider or site failure answers `502` with a generic message that
  names no table, key or host; canonical files, the page and the browser's data are never changed
  by the transport.
- **The fallback.** With no endpoint, the switch off, a closed post or a failure, the page reads
  exactly as before, and the copy text of ADR 0079 lets a reader send their note to the author,
  who can enter it as manual feedback with the same record. Forms that offer it are #82.
- **Bundling.** The function imports the validator from `web/components/`, so `netlify.toml`
  bundles the engagement function, and only it, with esbuild. Comments, views and analytics
  behave as before; their quota code now goes through the same helper.

## Consequences

- Questions, suggested corrections, suggested sources, other interpretations and later kinds
  (Third Perspectives, section responses, future questions) share one endpoint, one table, one
  quota family and one moderation token.
- A deployment can turn the transport off at once with one environment variable, independently
  of the build and of the database (ADR 0080's rollback).
- The validator runs in the function exactly as in the browser and in Rust, held together by
  the shared fixtures; the function's own tests exercise origin, opt-in, policy, quota, replay,
  hostile text, authorization, provider failure and the SQL it relies on.

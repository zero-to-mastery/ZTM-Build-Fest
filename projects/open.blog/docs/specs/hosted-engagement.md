# Hosted comments and analytics

## Problem

Static Netlify deployments cannot use the local `openblog serve` comment or analytics state. Site
owners need a deployable persistence path without exposing database credentials in generated pages,
and they need one Admin surface for the public endpoint and the private moderation credential.

## Solution

Add a first-party Netlify Function backed by Supabase. The function owns the database seam and reads
all database credentials from the Netlify environment. Public pages talk only to the function. New
comments are moderated by default; the existing privacy-respecting view element uses the same
function. Admin stores the public endpoint in `openblog.json` and a write-only moderation token in
`.openblog/private`, with a server environment variable taking precedence.

## User stories

1. As a reader, I want to read approved comments on a post, so that I can follow its discussion.
2. As a reader, I want to submit a name and comment, so that I can participate without creating an account.
3. As a reader, I want clear pending and failure states, so that moderation is not mistaken for data loss.
4. As a site owner, I want comments pending by default, so that untrusted text is never published automatically.
5. As a site owner, I want token-authenticated moderation endpoints, so that only someone holding my server secret can approve or reject comments.
6. As a site owner, I want view analytics persisted in Supabase, so that Netlify deploys do not lose counts.
7. As a privacy-conscious reader, I want DNT and GPC honored, so that opting out prevents a view event.
8. As a site owner, I want Supabase credentials to remain server-only environment values, so that static assets cannot disclose them.
9. As an Admin user, I want to configure the public function endpoint and a write-only moderation token, so that hosted engagement can be managed without editing JSON or private files.
10. As an Admin user, I want the existing Analytics screen to use hosted data when configured, so that local and Netlify deployments retain one dashboard.
11. As a deployer, I want a checked-in SQL migration and environment-variable guide, so that setup is repeatable.

## Implementation decisions

- Add `engagement` configuration with `enabled`, `comments`, and `endpoint`. The endpoint is public
  and contains no credentials. When enabled, rendering adds one `<ob-comments>` element per post and
  points both comments and view counts at the same endpoint.
- Add a dependency-free progressive-enhancement comments component. It renders returned text only
  through DOM text nodes, bounds input client-side, and works without cookies or local identifiers.
- Add a dependency-free Netlify Function with `/comments`, `/hit`, `/views`, `/admin/comments`, and
  `/admin/analytics` operations. It validates origin, site id, paths, sizes, status values, and JSON.
- Supabase access uses REST/RPC calls authenticated with `SUPABASE_SECRET_KEY` in the `apikey`
  header, without treating the secret key as a bearer JWT. `SUPABASE_SERVICE_ROLE_KEY` remains a
  legacy fallback with JWT bearer authentication; the new variable takes precedence.
  Required environment values are `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or the legacy fallback), `OPENBLOG_SITE_ID`,
  `OPENBLOG_SITE_ORIGIN`, `OPENBLOG_ADMIN_API_KEY`, and `OPENBLOG_ANALYTICS_SALT`.
  `OPENBLOG_SITE_BASE_PATH` is optional for sites published below the origin root.
- Comment moderation and hosted Admin analytics require `Authorization: Bearer <token>` and compare
  against `OPENBLOG_ADMIN_API_KEY` without returning either token or database credentials.
- New comments have `pending` status. Public reads return only `approved` rows.
- Analytics persists daily aggregates and date-scoped visitor hashes. It never stores raw addresses,
  raw user-agent strings, cookies, or cross-day identifiers.
- Admin stores its matching hosted API token using the existing private-credential protection model
  and binds that credential to the endpoint origin. Endpoint changes fail closed until the token is
  explicitly replaced. An `OPENBLOG_ENGAGEMENT_API_KEY` server environment value overrides the
  private copy when `OPENBLOG_ENGAGEMENT_API_ORIGIN` matches the configured origin. Admin proxy
  requests do not follow redirects.
- Supabase-backed per-client and per-site hourly quotas reject excessive public comment and
  analytics writes before storing content or view events.
- The local built-in analytics store remains the default and remains available when hosted
  engagement is disabled.

## Participation policy

Comments are the first kind in the one participation and moderation policy
(`openblog_core::participation` and `openblog_core::moderation`, ADRs 0101 to 0104). The comment
manifest and `<ob-comments>` come from the policy's comment row, which keeps the rule above
unchanged. Further kinds (passage feedback, Third Perspectives, author responses, abuse reports)
are off until `participation.kinds` switches them on, then share this function, its quotas and its
moderation token, read their modes from `openblog-participation.json`, and start pending.

## Moderation inbox

Comments and passage feedback are moderated in one Admin inbox through `GET` and `PATCH
/admin/moderation` (ADR 0105): a keyset-paged list by state and kind, each item offered the
decisions the one policy accepts for the signed-in account's role on its work, every decision
decided again by the function from the stored row (`netlify/lib/participation-moderation.mjs`,
checked against `tests/fixtures/participation-transitions.json`) and written once, conditionally,
with its audit event. The hosted schema for every decision is opt in (ADR 0106): `moderation.sql`
adds a version, the full state and a reason beside the comment `status` column, which keeps its
three values for public reads, and a comment audit table; `feedback.sql` adds the item's
revisions and the audit fields ADR 0083 left. Without `OPENBLOG_MODERATION_ENABLED` the inbox offers
what the older schema can store. With engagement protection (ADRs 0107 and 0108) the inbox also
lists abuse reports with the item each names, upholds them in one transaction, deletes a closed
item's text for the site Admin, and runs retention from a confirmed dry run.

## Engagement protection

Reader receipts, anonymous abuse reports, deletion requests and the retention run (ADRs 0107 and
0108) are opt in behind `supabase/protection.sql` and `OPENBLOG_PROTECTION_ENABLED`. Quotas store
only hourly digests of the client, receipts only their digest, and reports no reporter identity;
purging overwrites text and keeps state and audit events without it. The rules the function
applies (`retentionStep`, `planErasure`, `planUphold`) are checked against
`tests/fixtures/participation-protection.json`, which the Rust policy generates.

## Third Perspectives

A reader's own reflection on a work (ADRs 0109 to 0115) goes through the same `POST /feedback`
route, read by its own contract (`web/components/third-perspective.js`, held to the build by
`tests/fixtures/third-perspective-submissions.json`), into one `openblog_feedback` row of kind
`third-perspective`. It is opt in behind `supabase/feedback.sql` run again and
`OPENBLOG_THIRD_PERSPECTIVES_ENABLED`, on top of protection, because every hosted copy has a
receipt. The row keeps the prompt category, the receipt's digest and the reader's numbered consent
records in `details`; an approval is taken by `openblog_moderate_third_perspective` and records the
consent record it covers in `approved_consent`, so a later consent change makes it stale.
Admin publishes an approved one to `content/third-perspectives.json`, from which builds render
it; nothing reads the hosted rows to show a page. A receipt's `published` flag for this kind is
true only while the row is approved at its current revision under an approved consent record that
agreed to publication while the consent in effect still does (ADR 0115).

## Suggestions for future work

A reader's question or suggested source for future work (ADRs 0152 to 0161) goes through the same
`POST /feedback` route, with the page as the request's `work`, read by its own contract
(`web/components/future-suggestion.js`, held to the build by
`tests/fixtures/future-suggestion-submissions.json`; its link rule by `tests/fixtures/public-urls.json`),
into one `openblog_feedback` row of kind `future-suggestion` with no passage. It is opt in behind
`supabase/feedback.sql` run again (which loosens one check, with
`supabase/future-suggestions-rollback.sql` to undo it) and `OPENBLOG_SUGGESTIONS_ENABLED`, on top of
protection, because every hosted copy has a receipt. A suggestion is private to the editors in every
state: a receipt's `published` flag and an abuse report both ask `isPublishable(kind)` first, and an
accepted suggestion owes retention only the clearing of its contact and unshown name
(`scrub-identity`, ADR 0155).

## Author responses

An author's answer to a Third Perspective about their own section of a shared reflection (ADRs 0131
to 0135) is one more `openblog_feedback` row of kind `author-response`, so it needs no SQL and no
rollback; it is opt in behind `OPENBLOG_AUTHOR_RESPONSES_ENABLED`, on top of Third Perspectives.
Admin decides who may answer from the private record and sends the function one checked request
(`admin/author-response`, Admin's token only), which the function reads with its own contract
(`netlify/lib/author-response.mjs`, held to the build by `tests/fixtures/author-responses.json`),
re-checks against the parent row it reads, and stores pending with the responder in `details`. The
one inbox moderates it; an approval needs a shown parent about that author's section, re-checks
the responder against the private record, and is never the writing account's own. An approved
answer is published by Admin into `third-perspectives.json` under its reflection (version 2 of the
file, only while an answer is in it) and comes off with a withdrawal or removal, with a banner
for any that must (ADRs 0137 to 0139); the hosted schema is unchanged.

## Testing decisions

- Exercise the Netlify handler through HTTP-shaped events with a fake Supabase fetch seam.
- Verify public versus authenticated routes, origin checks, bounds, rate limiting, pending
  moderation, secret non-disclosure, and analytics privacy fields.
- Verify rendering and configuration defaults in core tests.
- Exercise comment submission and text-only rendering through the mounted web component.
- Exercise Admin settings through authenticated/CSRF-protected routes and browser settings controls.
- Run the full Rust, browser, documentation-link, formatting, lint, and locked release-build gates.
- For protection (`tests/web/netlify-protection.test.mjs`): the shared fixture, stored digests
  that change every hour, credentials absent from every answer, a disabled service, origin and
  token checks, malformed JSON, floods and replays, races, receipts, reports, upholding, deletion,
  the retention dry run and run, and the SQL with its rollback.

## Typed passage feedback

The same function carries typed scholarly feedback (questions, suggested sources, suggested
corrections and other interpretations of a passage) as an opt-in extension of this seam, not a
second comment system. The submission format and kinds are [ADR 0079](../adr/0079-typed-scholarly-feedback-kinds-and-one-submission-format.md),
the additive `openblog_feedback` table and its rollback are [ADR 0080](../adr/0080-hosted-feedback-is-one-additive-private-table.md),
and the transport, its double opt-in, quotas and fallback are [ADR 0081](../adr/0081-hosted-feedback-transport-is-opt-in-and-reuses-the-engagement-seam.md).
The reader form on each open post, its passage data and its copy-and-send fallback are
[ADR 0082](../adr/0082-passage-feedback-forms-are-one-progressive-region-over-the-build-passage-text.md).
Moderation, author responses, revision notes and the published notes are
[ADR 0083](../adr/0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md):
`PATCH /admin/feedback` takes `{id, action, from, expectedVersion, reason?, actor?}` and applies
the change with its audit event only while the item still has that state and version (`409`
otherwise), and approved notes are published from `content/reader-feedback.json`, never read back
from the hosted service by a build. Comments, their table and their routes are unchanged.

Evidence submissions and correction decisions (RD6) extend the same two kinds rather than adding a
third: a suggested source or correction may carry a version 2 evidence block naming the published
claim, evidence link, citation or source it concerns
([ADR 0116](../adr/0116-evidence-submissions-are-suggested-sources-and-corrections-with-unverified-reader-evidence.md)),
and only the author's correction decision, separate from moderation and kept in an append-only
log per item, can label one a correction
([ADR 0117](../adr/0117-only-the-authors-correction-decision-labels-a-correction.md)). Both are
opt in ([ADR 0118](../adr/0118-evidence-and-correction-decisions-are-taken-opt-in-and-decided-in-the-inbox.md)):
with `feedback.sql` run again and `OPENBLOG_CORRECTIONS_ENABLED=true`, `POST /feedback` takes
version 2, checked before the quota and stored pending with its block in `evidence`, and `POST
/admin/decisions` appends a decision to the item's `decisions` log with a `decide` audit event, only
while the item is a pending or approved suggestion at the text revision and number of decisions the
author saw. Without the variable version 2 is refused and no decision is stored. The form lists only
what the site publishes (`engagement.evidence`), and the Moderation inbox shows how each item
stands, the reader's evidence beside the claim it names, duplicate cues and "Record decision".
`corrections-rollback.sql` undoes the schema.

## Out of scope

- Reader accounts, email collection, avatars, reactions, notifications, nested replies, rich-text
  comments, automatic spam scoring, real-time subscriptions, and multi-tenant management UI.
- Storing Supabase service-role credentials in `openblog.json`, Admin browser storage, generated HTML,
  or the repository.
- Automatic Netlify environment mutation; Admin explains the required server values but does not
  call Netlify's management API.

## Comment captcha

Hosted comments can optionally require a Cloudflare Turnstile challenge before storage (epic #296,
ADR 0322). It is off unless both `engagement.captcha.provider` and `OPENBLOG_CAPTCHA_PROVIDER` are
`turnstile`; sites that do nothing behave, and build, exactly as before.

12. As a site owner, I want the server to refuse an unverified comment before anything is stored, so that bots cannot fill the moderation queue by calling the API directly.
13. As a reader, I want to be checked at most once per visit and only when I start writing, so that commenting stays quick and the page stays fast.
14. As a reader using a keyboard, a screen reader or an ad blocker, I want the check to work or fail with plain next steps and my words kept.
15. As a site owner, I want only public values (provider, site key, scope) in `openblog.json`, built pages and Admin, so that no credential can leak.

Contract (`POST /comments`, checks in this order: origin, policy, field validation, captcha, rate limit, insert):

- `captchaToken` is verified with the provider and exchanged for a pass in the response
  (`captchaPass`, `captchaPassExpiresAt`); `captchaPass` is validated locally with HMAC-SHA256 and a
  constant-time compare. Neither, or an invalid one: `403 {code: "captcha_required"}`; an expired pass:
  `403 {code: "captcha_expired"}`. Both happen before any database write.
- Every verification attempt (a token or a bad pass) spends the `captcha` rate-limit bucket, before the provider is called, through the existing
  `openblog_consume_rate_limit` function (10 per client and 1,000 per site per hour, no SQL migration);
  over the limit answers `429 {code: "captcha_rate_limited"}`. Successful comments are counted by the
  `comments` bucket as before.
- Enabled but misconfigured answers `503 {code: "captcha_unconfigured"}` naming the variable, never a value.
- `OPENBLOG_CAPTCHA_SCOPE=every-comment` never issues or accepts a pass.
- With the provider off, request and response shapes are unchanged.

See [setup](../../netlify/functions/README.md#comment-captcha-optional) and ADR 0322. Local comments
are unchanged.

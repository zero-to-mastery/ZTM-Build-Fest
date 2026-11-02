# Scheduled social publishing (optional)

Social publishing announces an already-published post on a connected LinkedIn identity or Facebook Page, at a
time you choose. It is off by default. Your site, its exports and cross-posting work exactly the same without it,
and nothing in this guide is needed to read, build or publish a blog.

This page covers the identity and storage foundation (epic #353, story #354), scheduling announcements (story
#356) and the delivery queue and worker (story #357). The provider adapters that actually post arrive in a later story.

## Who is allowed to do what

Nothing in a browser talks to Supabase. The flow is:

1. You sign in to Admin as usual. Admin checks its own session and CSRF token on every route and denies by default.
2. Admin calls the hosted social function with a server-held key and names the signed-in Admin user in the
   `X-OpenBlog-Actor` header. That name is recorded for audit; it grants nothing.
3. The hosted function holds the Supabase `service_role` key. It acts for exactly one site, `OPENBLOG_SITE_ID`,
   and refuses any request that names a site.

The scheduled worker uses a different key and acts as `@worker`. A leaked worker key can never act as an author.

## Settings (hosted function only)

| Variable | Purpose |
| --- | --- |
| `OPENBLOG_SOCIAL_ENABLED` | Must be exactly `true`. Anything else and the routes answer 404. |
| `SUPABASE_URL` | `https://` project origin, no path or credentials. |
| `SUPABASE_SECRET_KEY` | The `service_role`/secret key. Server only. |
| `OPENBLOG_SITE_ID` | The site scope: 1 to 80 of `A-Z a-z 0-9 . _ -`, starting with a letter or digit. |
| `OPENBLOG_SOCIAL_ADMIN_KEY` | At least 32 characters; used by the Rust Admin. |
| `OPENBLOG_SOCIAL_WORKER_KEY` | At least 32 characters; used by the scheduled worker. Differs from the admin key. |
| `OPENBLOG_SOCIAL_TOKEN_KEYS` | Token encryption keys, `id:base64` of 32 random bytes, comma separated; the first encrypts new tokens. Required. |

Neither key may equal the Supabase key, the Admin API key or an anon/publishable key. If the feature is enabled
but something is wrong, it stays off and the log names the settings at fault, never their values.
Never put any of these in `openblog.json`, the repository or a browser bundle.

## The hosted tables

Run `supabase/social.sql` once in the Supabase SQL editor, only if you opt in. It is additive, can be run twice
safely, and creates `openblog_social_accounts`, `openblog_social_posts` (the schedule queue),
`openblog_social_attempts` (delivery history), `openblog_social_credentials` (encrypted tokens) and
`openblog_social_schema` (the schema version). All of them are private: row level security is on with no
policies, the public roles have no access, and only the hosted function (`service_role`) reads and writes. Every
row carries your site scope and relations include it, so a row cannot point at another site's account or post.
Nothing is ever deleted by the function: cancelling and disconnecting are updates.

To undo it, remove `OPENBLOG_SOCIAL_ENABLED`, stop the worker, export what you want to keep (the commands are in
the file) and run `supabase/social-rollback.sql`. It drops only the `openblog_social_*` tables. Revoke the app at
LinkedIn and Facebook as well; stored tokens are deleted by the rollback but stay valid there until revoked.

## Provider tokens

Access and refresh tokens are encrypted by the hosted function before they reach the database
([ADR 0295](adr/0295-provider-tokens-are-envelope-encrypted-by-the-hosted-function-and-refreshed-single-flight.md)).
Each connection gets its own random key, wrapped by a key you keep only in the function's environment, so a database
dump or a leaked `service_role` key does not reveal a token. Generate a key with
`node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"` and store it in your secret
manager as well: if you lose it, every account has to be connected again.

To rotate, put a new key first (`k2:...,k1:...`) and redeploy; new connections use `k2`. Keep `k1` in the list: no
command re-wraps existing connections yet (the library function exists, and a later story adds the operator entry
point). Removing `k1` while a connection still uses it makes that connection unreadable, and it has to be connected
again. Check before removing a key:
`select key_id, count(*) from openblog_social_credentials where status = 'active' group by 1;`
Remove `k1` only when no active row shows it.

Tokens are refreshed once at a time, shortly before they expire. If a provider says a connection is no longer valid,
or you disconnect an account, its stored tokens are erased and the account asks to be connected again. Admin only ever
sees a connection's status and dates, never a token. Tokens never appear in errors or logs, and are never written to
`openblog.json`, the repository, a page or an export.

## Connecting LinkedIn and Facebook (OAuth)

Connecting an account is an OAuth authorization-code flow
([ADR 0299](adr/0299-the-oauth-handshake-is-a-single-use-state-bound-connection-finished-by-the-hosted-function.md)).
The provider sends the author's browser back to your hosted function, so it needs a public `https:` address.

Create an app with each provider you want and set these in the function's environment (never in `openblog.json`):

| Variable | Purpose |
| --- | --- |
| `OPENBLOG_SOCIAL_CALLBACK_BASE` | Public `https://` address of the function, such as `https://blog.example.com/api/social`. No credentials, query or fragment. |
| `OPENBLOG_SOCIAL_LINKEDIN_CLIENT_ID`, `OPENBLOG_SOCIAL_LINKEDIN_CLIENT_SECRET` | The LinkedIn app's credentials. A provider with neither set is simply not offered. |
| `OPENBLOG_SOCIAL_FACEBOOK_CLIENT_ID`, `OPENBLOG_SOCIAL_FACEBOOK_CLIENT_SECRET` | The Meta app's credentials. |
| `OPENBLOG_SOCIAL_<PROVIDER>_API_VERSION` | Optional. LinkedIn `YYYYMM` (default `202510`), Facebook `vNN.N` (default `v23.0`). |
| `OPENBLOG_SOCIAL_<PROVIDER>_SCOPES` | Optional. Replaces the requested scopes (space or comma separated). |
| `OPENBLOG_SOCIAL_LINKEDIN_ORGANIZATIONS` | Optional. `true` also asks for `r_organization_admin` and `w_organization_social`, to post as an organization. |
| `OPENBLOG_SOCIAL_<PROVIDER>_PKCE` | Optional. `true` sends a PKCE (S256) challenge. Off by default; turn it on only if the provider documents it for your app type. |

Register exactly this redirect URL in each provider app (Admin shows it too): `<CALLBACK_BASE>/callback/linkedin`
and `<CALLBACK_BASE>/callback/facebook`. Nothing in a request can change the redirect or the scopes that are sent.

**Verify these when you set up, because providers change them.** The defaults are a starting point, not a promise:

- LinkedIn: confirm the `Linkedin-Version` you set is still supported, that **Share on LinkedIn** is added to the
  app (for `w_member_social`) and **Sign In with LinkedIn using OpenID Connect** (for `openid profile`). Posting
  as an organization needs the Community Management API, which LinkedIn approves per app; until it does, the
  organization scopes are refused and only the member is offered.
- Facebook: confirm the Graph version, and that `pages_show_list` and `pages_manage_posts` are available to your
  app. Until Meta approves **Advanced access** through App Review, only people with a role on the app can
  connect a Page that is not their own. Admin cannot read review status from the API and says so.

Each attempt expires after ten minutes, works once, and at most ten may be open. If the author declines a
permission, the attempt fails with a plain message and nothing is stored. The scopes shown in Admin are the ones
the provider actually granted. Client secrets are sent in the request body to the provider, never in a URL.

## Choosing where to post

After the author authorizes, the function asks the provider where the grant can post
([ADR 0300](adr/0300-destinations-are-discovered-from-the-grant-and-offered-only-when-the-provider-confirms-them.md)).
Admin lists each destination and chooses one; nothing is connected until it does, and the choice is made once.

- **LinkedIn** offers the member, and the organizations they administer when you set
  `OPENBLOG_SOCIAL_LINKEDIN_ORGANIZATIONS=true` and LinkedIn has approved the Community Management API for your app.
  Admin tells apart "not asked for", "not granted", "LinkedIn refused the lookup" (usually no approval), "could not
  be listed" and "you administer none"; it never reads a refusal as an empty list.
- **Facebook** offers a Page only if `pages_manage_posts` was granted, your role on the Page includes creating
  content, and Facebook returned access for it. A Page whose role Facebook did not report is shown but not
  offered. Meta's App Review status cannot be read from the API, so Admin always reminds you to confirm it.
- A destination that is already connected cannot be connected twice; use **Reconnect** on it.

**Reconnect** signs in again and replaces the stored credential, but only for the same LinkedIn identity or the
same Page. A different login is refused, LinkedIn is asked to withdraw that grant, and nothing is changed.

**Disconnect** erases the stored tokens and keeps the account row for history. LinkedIn is asked to revoke the
grant when no other connected LinkedIn account could share it. Facebook is not asked, because withdrawing the grant
would also cut off your other Pages: remove the app under **Settings > Business integrations** in Facebook if you
want the grant gone. Revoke the app in the provider's settings as well when you retire the site.

An account shows as **Needs reconnecting** when a provider dropped the grant, its tokens were erased, or its tokens
(and refresh token) have run out, and as **Expiring** within seven days of that moment. LinkedIn tokens refresh
themselves while a refresh token is valid. Admin shows each account's provider id and name, its status, its dates and
the permissions that were granted, never a token.

## Connected accounts in Admin

Admin has a **Social accounts** page (`#/social`, and in the navigation once social settings exist)
([ADR 0301](adr/0301-connected-accounts-are-managed-through-admin-routes-that-rebuild-every-reply-from-known-fields.md)).
It is the only place you connect, reconnect or disconnect an account. Tell the machine that runs `openblog serve --admin`
where the function is and give it the Admin key, as environment variables (never in `openblog.json`):

| Variable | Purpose |
| --- | --- |
| `OPENBLOG_SOCIAL_ENDPOINT` | The function's address, such as `https://blog.example.com/api/social`. `https:` only (plain `http:` is allowed to `127.0.0.1` or `localhost` for local development). No credentials, query or fragment. |
| `OPENBLOG_SOCIAL_ADMIN_KEY` | The same value as the function's `OPENBLOG_SOCIAL_ADMIN_KEY`. At least 32 characters. |

With neither set, Admin has no Social accounts entry and the page only explains how to turn the feature on. If one is
set but wrong, the page names the setting at fault and sends nothing.

What you can do on the page:

- **Connect**: each provider shows the permissions it will ask for in plain words (optional ones marked) and the
  exact redirect address to register in the provider's app. **Connect** gives a link that opens the provider in a new
  tab; approve access there, return to Admin, press **I have finished, check now** (or just return to the tab), then
  choose where posts may go. The link is not kept after a reload; cancel and start again if you lose it.
- **Choose a destination**: destinations the provider did not confirm are shown disabled, with the reason.
- **Reconnect**: appears on every account and leads when access ran out or was withdrawn. Sign in as the same account.
- **Disconnect**: asks first, then erases the stored tokens and keeps the account in your history.

Each account shows its status as words (Connected, Expiring soon, Needs reconnecting, Disconnected), its dates, who
connected it, its provider id and the permissions the provider granted. Admin never receives a token: the page is
rebuilt from known fields on the Admin server, so even a faulty function reply cannot put one in front of you.
The page works with the keyboard and a screen reader and has no sideways scroll at 320 px.

## Scheduling announcements

An announcement is a caption and a time for one connected account, linking one of your public posts
([ADR 0308](adr/0308-an-announcement-links-a-public-canonical-post-at-a-utc-instant-and-only-a-scheduled-one-can-change.md),
[ADR 0309](adr/0309-announcement-routes-are-called-by-the-rust-admin-with-the-admin-key-and-change-a-row-only-by-version.md)).

What can be announced:

- Only a published post: not a draft, not dated in the future. The link is your site's own address for it, built from
  `url` in `openblog.json`, which must be a public `https` address. A cross-post whose `canonical` points to another
  site is not announced from here.
- A caption of 1 to 3,000 characters. The link is added when the post is sent, so it does not count. Control
  characters (other than a new line) and text-direction overrides are refused.
- A time at least a minute ahead and no more than a year ahead, written with its zone. It is stored in UTC; Admin
  shows it in your own zone. Your zone is not stored.

A scheduled announcement waits in the queue until the delivery worker (below) claims it; without the worker, or without
a provider adapter for its destination, it is never sent.

Only a **scheduled** announcement can be changed, rescheduled or canceled. Once a worker has claimed it, it cannot be.
Saving names the version you were looking at; if it changed meanwhile you are asked to reload. Creating is
idempotent: submitting the same composer twice (a double click, a retry after a timeout) gives one announcement.

### Settings

Scheduling uses the same settings as connected accounts (`OPENBLOG_SOCIAL_ENDPOINT`, `OPENBLOG_SOCIAL_ADMIN_KEY`, above)
on the machine that runs Admin, and the same hosted function: `netlify/functions/social.mjs` serves the announcement
routes beside the account routes, behind the same admin key, and answers 404 to everything unless the hosted settings
(including `OPENBLOG_SOCIAL_ENABLED=true`) are valid. A rejected key shows in Admin as a setup problem, not as a sign-out.

### Routes

Admin (`/admin/api/social/`, session and CSRF like every Admin route): `posts`, `preview`, `destinations`,
`announcements` (`GET` list, `POST` create, `PATCH ?id=` edit), `announcements/reschedule?id=`,
`announcements/cancel?id=`, `announcements/retry?id=`, `announcements/resolve?id=` and `GET announcements/attempts?id=`
(ADR 0318). Hosted (the same names under the endpoint, admin key only): the same set except
`posts` and `preview`, which Admin answers itself.

### The Social screen

With the settings above in place, Admin shows an **Announcements** tab
([ADR 0310](adr/0310-the-social-screen-is-a-labelled-form-with-a-server-checked-preview-and-times-in-the-authors-zone.md)):
a composer (destination, post, caption, date and time, preview) and the list of announcements with edit and cancel.
See [Admin](admin.md#announce-a-post-on-social-media-optional) for how it is used. It only offers connected accounts,
so connecting one is a separate step. Check it in a browser at 320px wide before you rely on it: it should never scroll
sideways.

Before you enable it for real, confirm in each provider's current documentation the API version, the permissions
(scopes) and any app review the posting API needs; none of that is part of this screen, and nothing here posts until
delivery is set up.

## Publishing adapters

The delivery worker calls one adapter per provider through the interface documented in
`netlify/lib/social-delivery.mjs` ([ADR 0319](adr/0319-the-publishing-adapters-implement-the-worker-delivery-contract-and-never-copy-provider-text.md)).
An adapter is registered only for a provider you configured (its client id and secret, below); with none configured,
nothing is delivered and announcements wait. `publish` returns the provider's own post id only when the provider
confirmed the post and named it. Anything else is a typed error the worker acts on (see
[Retries, rate limits and uncertain outcomes](#retries-rate-limits-and-uncertain-outcomes)): a refused sign-in, a
refusal, a rate limit with the provider's `Retry-After`, a request that certainly never left (retried), or an outcome
that may have posted (a server error, a timeout, a dropped connection, a success without an id), which is never sent
again automatically.

Neither LinkedIn nor Facebook accepts an idempotency key on these calls, so none is sent: only an answer that means
"definitely not processed" is ever retried.

**Looking up an unclear outcome.** Facebook: the worker looks at the Page's own published posts since the attempt, read
only, made between just before the attempt started and just after it ended, and settles the announcement only when
exactly one of them has both the same caption and the same link. A post that matches by only one of the two (a link
you shared by hand, another announcement of the same post, a caption you edited on Facebook) cannot be told apart, so
the announcement comes to you as **Needs checking** instead of being guessed at. This needs
`pages_read_engagement` (requested by default); without it the lookup cannot tell and you settle it. LinkedIn: there
is no lookup, because reading a member's or organization's posts needs permissions LinkedIn gives only to approved
partners, so an unclear LinkedIn outcome comes straight to you as **Needs checking**.

### LinkedIn

Posts as the connected member or organization through the versioned REST Posts API (`POST /rest/posts`), with the
post link as an article whose title is the caption's first line. The caption is sent as typed: LinkedIn formatting characters (`( ) [ ] { } < > @ | ~ _ * #`
and the backslash) are escaped, so a caption cannot mention people or format text.

Verify at setup, because LinkedIn changes them: the API version (`OPENBLOG_SOCIAL_LINKEDIN_API_VERSION`, a dated
`YYYYMM` value that LinkedIn retires after about a year; the default is only a starting point), that your app has the
product that grants `w_member_social`, and for organizations the Community Management API and `w_organization_social`.

### Facebook Pages

Posts a message and the post link to the connected Page's feed (`POST /{page-id}/feed`) with that Page's access
token ([ADR 0320](adr/0320-the-facebook-adapter-posts-a-message-and-link-to-the-page-feed-with-the-page-token-in-the-header-and-reads-graph-error-codes.md)).
The token goes in the `Authorization` header, never in the address. Facebook's own error codes decide the result: an
expired token or a removed app asks you to reconnect, a missing permission or Page role is reported as such, a rate
limit (including Meta's Page-level limit, code `80001`, and the other business-use-case codes `80000`-`80014`) pauses
that Page and is tried again later, and an "unknown error" is `unknown` because the post may exist.

Verify at setup, because Meta changes them: the Graph version (`OPENBLOG_SOCIAL_FACEBOOK_API_VERSION`, for example
`v23.0`; old versions are retired), that your app has `pages_manage_posts` (and `pages_show_list`), and App Review:
until the app has Advanced access, only people with a role on the app can post to Pages.

### How the adapters are tested

Both adapters run against one fixture of provider replies (`tests/fixtures/social-publish.json`, [ADR 0321](adr/0321-adapter-behaviour-is-pinned-by-one-fixture-of-provider-replies-and-by-the-real-worker-over-a-scripted-provider.md)):
success, 401, 403, 429, 5xx, a redirect, a network failure, a refused connection, a timeout and ambiguous successes.
The real worker is also run with the real adapters over a scripted provider, from the reply to the stored
announcement, with a check that no token or provider wording reaches a stored error, a summary or a log. No test uses
a real account or the network. The replies are written from the providers' documentation, so check them against the
current documentation when you change an API version.

## Delivery queue

Delivery has three parts, each opt-in on top of the last. This section is the queue; the worker that calls it and the
schedule that wakes the worker are below it.

Run `supabase/social-queue.sql` in the Supabase SQL editor after `social.sql`
([ADR 0316](adr/0316-due-announcements-are-claimed-by-database-functions-under-a-lease-and-an-expired-lease-after-sending-is-unknown.md)).
It is additive and re-runnable: five columns, one index and four functions, no existing row changed. Undo it with
`supabase/social-queue-rollback.sql`; `social-rollback.sql` removes the functions before it drops the tables.

- A **claim** takes due, scheduled announcements of this site, a bounded batch at a time, under a lease (5 minutes by
  default). Two workers at once get different announcements; one an author just canceled is not claimed.
- Each claim counts an **attempt** and opens an attempt row. The **sending mark** is made just before the provider is
  called, and only while the lease is valid.
- A lease that runs out **before** the sending mark returns the announcement to the queue. One that runs out
  **after** it becomes `unknown`: the provider may have posted, so it is never sent again, only looked up or reviewed.
- An outcome is recorded against the version the worker read, so a worker that lost its lease cannot overwrite the one
  that holds it. `published` is recorded only with the provider's own post id.
- Only `service_role` may execute the functions; the browser and the public keys cannot.

Without this file announcements wait in the queue exactly as before.

## The delivery worker

The worker is a hosted function, `netlify/functions/social-worker.mjs`, reached at `POST /api/social-worker`
([ADR 0317](adr/0317-a-protected-worker-endpoint-woken-by-pg-cron-and-pg-net-delivers-a-bounded-batch-through-a-narrow-adapter-interface.md)).
Each call claims a small batch of due announcements, delivers each through its provider's adapter, records the outcome,
and answers with counts only. It is off (404) unless the social settings are valid.

**Who may call it.** Only the worker key, as `Authorization: Bearer <OPENBLOG_SOCIAL_WORKER_KEY>`. The admin key is
refused (403), a missing or wrong key is 401, and a worker key that equals the Supabase service key, the admin key or an
anon or publishable key disables the feature at start-up, so a public key can never run it. Nothing you send can name
a site or change what it does.

**Optional settings** (all have defaults; a value outside its range is ignored and the default used):

| Variable | Default | Range |
| --- | --- | --- |
| `OPENBLOG_SOCIAL_BATCH_SIZE` | 5 | 1 to 25 |
| `OPENBLOG_SOCIAL_LEASE_SECONDS` | 300 | 30 to 900 |
| `OPENBLOG_SOCIAL_PROVIDER_TIMEOUT_SECONDS` | 4 | 2 to 30 |
| `OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS` | 8 | 5 to 50 |

The defaults (a 4-second provider timeout inside an 8-second budget) fit Netlify's default 10-second function
timeout, and a run claims only as many announcements as its budget can finish (one at the defaults; the schedule
wakes it every minute). To deliver more per run, raise the function's timeout in Netlify first (verify the limit for
your plan), then raise the budget to stay about 2 seconds under it. A budget smaller than the provider timeout plus 2
seconds is refused: both settings fall back to their defaults and the setting is reported as a problem. If the platform cuts a run off mid-delivery, the
announcement is not lost and not repeated: its lease runs out and it becomes `unknown` if the provider may have
been called, or returns to the queue if not.

**Set it up** (each step is separate and reversible):

1. Run `supabase/social-queue.sql` (the delivery queue, above).
2. Deploy the function with `OPENBLOG_SOCIAL_WORKER_KEY` set (and the other social settings).
3. Store the worker's address and key in Supabase Vault, from the SQL editor, replacing the placeholders:
   `select vault.create_secret('https://YOUR-SITE.example/api/social-worker', 'openblog_social_worker_url');` and
   `select vault.create_secret('THE-WORKER-KEY', 'openblog_social_worker_key');`
4. Run `supabase/social-cron.sql`. It enables `pg_cron` and `pg_net` and schedules one job, `openblog-social-worker`,
   every minute. Running it again leaves one job. Announcements go out within about a minute of their time.

To stop delivery run `supabase/social-cron-rollback.sql` (it keeps the extensions and the Vault secrets; delete the
secrets and rotate the worker key when you retire the feature). With no job, nothing wakes the worker; you can still call
the endpoint by hand with the key.

**Adapters.** The worker never talks to LinkedIn or Facebook itself. It calls an adapter registered in
`netlify/lib/social-adapters.mjs` through a narrow interface (documented in `netlify/lib/social-delivery.mjs`): `publish`
returns the provider's own post id only when the provider confirmed success, or throws a typed error. An adapter is
registered only for a provider you configured (see [Publishing adapters](#publishing-adapters)); an announcement for a
provider with no adapter **waits in the queue**, untouched, and one for a provider this release does not know fails with
`unsupported-provider`. Provider API versions, permissions and app review are settings you verify at setup (see
Provider setup above); nothing is guessed at run time.

## Retries, rate limits and uncertain outcomes

([ADR 0318](adr/0318-a-failure-that-certainly-did-not-post-is-retried-with-back-off-and-one-that-may-have-posted-is-unknown-looked-up-and-then-settled-by-a-person.md).)
What the worker does depends on what it knows about the provider's answer:

| The provider's answer | The announcement becomes | Next |
| --- | --- | --- |
| Confirmed, with its post id | `published` | Done. The id is kept on the announcement and the attempt. |
| Certainly not accepted (a refused connection, a clear "try later") | `scheduled` again | Retried after a back-off (about 1, 2, 4 minutes and so on, capped at an hour). |
| Rate limited (429) | `scheduled` again | Waits at least the provider's `Retry-After` (at most a day), and **that account sends nothing** until then. |
| Refused (400, 403, 404, 409, 410, 422) | `failed` | Not retried. Fix the cause (the caption, the account) and use **Try again**. |
| The sign-in was refused (401, an expired or removed Facebook token) | `failed`, `needs-reauth` | The account becomes **needs reconnecting**, and its other announcements fail without being sent until you connect it again; then use **Try again**. |
| No answer, a timeout, a 5xx, an unreadable answer, a crash, or a success that could not be recorded | `unknown` | **Never sent again by itself.** Looked up, then yours to settle. |
| Tried the allowed number of times (default 5) | `failed`, `attempts-exhausted` | A dead letter that keeps its history. **Try again** gives it a fresh allowance. |

**Unknown outcomes.** The worker asks the provider, through the adapter's optional lookup, whether the post exists:
after 5 minutes, 15 minutes, an hour, six hours and a day. If it is there, the announcement becomes `published` with
its post id. If the provider says conclusively that it is not there, and the attempt is at least 15 minutes old, it
becomes `failed` (`not-delivered`) and you can use **Try again**. If the lookup cannot tell, or the destination cannot
be looked up, the announcement stays `unknown` with `needs-review` and waits for you: open the account, see whether
the post is there, and choose **Check the result** in Admin. To find stuck work in the database:
`select id, status, last_error_code, updated_at from openblog_social_posts where status in ('unknown','failed');`.

**Settings** (optional, bounded; a value out of range is ignored): `OPENBLOG_SOCIAL_MAX_ATTEMPTS` (default 5, 1 to 10)
and `OPENBLOG_SOCIAL_BACKOFF_SECONDS` (default 60, 5 to 3600). The worker gives an adapter an idempotency key that is the
same for every attempt of one announcement, for a provider that honours one; LinkedIn and Facebook do not, so it is not
sent and nothing relies on it.

**What is recorded.** Each attempt keeps its number, times, outcome, HTTP status, a short code and a fixed sentence,
and the provider's post id. It never keeps a token, a header, a request or anything the provider wrote, so the history
is safe to show in Admin and to paste in a bug report.

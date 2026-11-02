# ADR 0317: A protected worker endpoint, woken by pg_cron and pg_net, delivers a bounded batch through a narrow adapter interface

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #357 (task #371)

## Context

ADR 0316 made claiming safe; something must call it on a schedule, and a call that can post to people's accounts is
exactly what the epic says must not rely on "a public anonymous bearer alone". The provider adapters (LinkedIn Posts
API, Facebook Pages feed) are built in parallel (story SP5), so the worker needs an interface to call, not a
provider. The repository's hosted layer is Netlify functions that share `netlify/lib/` modules with the Admin
(ADR 0293); there is no Supabase Edge Function directory, and the shared modules (`social-scope.mjs`,
`social-credentials.mjs`) are written to run unchanged in Node and Deno.

## Decision

- **A worker endpoint, `netlify/functions/social-worker.mjs` (`POST /api/social-worker`).** It runs one bounded batch
  of `netlify/lib/social-worker.mjs` and answers with counts only. It is off, and a 404, unless the social settings
  are valid (ADR 0293). It accepts `POST` only, a body of at most 1 KiB that is empty or `{}`, and a request that
  names a site is refused. The logic is a module with the HTTP shape on top, using only Web APIs, so the same module can
  be hosted as a Supabase Edge Function later without change; this release ships the Netlify function because that
  is where the rest of the social code is bundled, deployed and tested.
- **Authorization is the worker key, and only that.** `authorizeSocial(..., { allow: ["worker"] })` accepts the
  `OPENBLOG_SOCIAL_WORKER_KEY` (at least 32 characters) and refuses everything else: the admin key is a 403, no key or
  a wrong key is a 401, the worker may not name an actor, and the key is compared by digest. Settings validation
  already refuses a worker key that equals the service key, the admin key or the anon or publishable key, so a public
  bearer can never match. The check runs before the body is read.
- **pg_cron and pg_net wake it, with the secrets in Vault.** `supabase/social-cron.sql` (undone by
  `social-cron-rollback.sql`) schedules one job, `openblog-social-worker`, every minute. It calls
  `public.openblog_social_worker_ping()`, which reads the worker's address and key from Supabase Vault
  (`openblog_social_worker_url`, `openblog_social_worker_key`) and posts to it with `pg_net`. Neither value is in the
  file, in a table a client can read, or in the repository; the function is executable by the database owner only
  (`anon`, `authenticated` and `service_role` are revoked), refuses a non-https address or a short key, and does
  nothing when a secret is missing. Re-running the file leaves one job. Without this file nothing wakes the worker;
  a person can still call the endpoint with the key.
- **One narrow adapter interface** (`netlify/lib/social-delivery.mjs`): `publish({ post, account, accessToken,
  signal })` resolves to the provider's own post id only on confirmed success, or throws a `DeliveryError` of one
  of five kinds; an optional `reconcile(...)` looks the post up. The adapter receives the caption, link,
  idempotency key, the account's provider ids and one access token, never a service key, an admin key, a lease or
  another account's data. `netlify/lib/social-adapters.mjs` is where a deployment registers adapters; this release
  registers none, and the worker is tested with a fake adapter. A provider this release knows but has no adapter for
  (`linkedin`, `facebook`) waits in the queue (`p_skip_providers`), so installing the worker before the adapters
  loses nothing; a provider it does not know fails explicitly as `unsupported-provider`.
- **Bounded.** Batch size (default 5, at most 25), per-account cap (3), lease (300 seconds), provider timeout (8
  seconds) and a run budget (22 seconds) are settings with ranges (`OPENBLOG_SOCIAL_BATCH_SIZE`, `..._LEASE_SECONDS`,
  `..._PROVIDER_TIMEOUT_SECONDS`, `..._WORKER_BUDGET_SECONDS`); a value out of range is ignored and the default is used.
  Before each post the worker checks that the provider timeout and a margin still fit; if not, it gives the attempt
  back (`deferred`) instead of starting a send the platform might cut off. Set the function timeout above the
  budget.
- **The order of a delivery** is: check the destination is connected and has an adapter; get a valid access token
  (refreshing single-flight, ADR 0295); ask the database for the sending mark (refused if the lease is gone);
  call the adapter; record the outcome fenced by version. A success that cannot be recorded because the lease ran out
  meanwhile is recorded against the unknown outcome it became; one that cannot be recorded because storage failed
  leaves the lease to expire into `unknown`. In neither case is it sent again.
- **Nothing sensitive in output.** The summary is counts. Errors and attempt details are fixed sentences chosen by
  kind; no provider text, token, key or request is stored or returned, and nothing is logged.

## Considered options

- **A Supabase Edge Function now.** Rejected for this release: it would duplicate the shared modules into a second
  deploy target and test setup before any adapter exists. The module is portable, so this stays open.
- **Netlify scheduled functions instead of pg_cron.** Rejected: the story asks for a database-driven schedule, and a
  Netlify cron cannot run unless the site is on Netlify.
- **Put the worker key in the cron command or a table.** Rejected: both are readable by more roles than the key needs.
- **Fail announcements whose provider has no adapter.** Rejected: installing the worker before the adapters would
  destroy a schedule.

## Consequences

- To deliver, a site runs `social-queue.sql`, deploys the function with a worker key, sets the two Vault secrets and
  runs `social-cron.sql`, in that order. Each step is separate and reversible.
- Delivery to LinkedIn and Facebook needs the adapters of story SP5; until they register, the worker runs and
  delivers nothing, and says so with a count of zero.
- A once-a-minute schedule means announcements go out within about a minute of their time, not on the second.

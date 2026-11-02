# ADR 0293: Social publishing is authorized by the Rust Admin and scoped to one server-configured site

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #354 (task #361)

## Context

Optional scheduled social publishing stores connected LinkedIn and Facebook Page accounts, a schedule queue
and delivery attempts in Supabase. The epic forbids silently introducing `auth.users` and browser-side RLS, and
asks that existing Admin authorization map to a trusted site and owner scope. open.blog already has the pattern:
workspace and engagement data live in tables that only the `service_role` can touch, reached by a server that
holds the key (`supabase/workspace.sql`, `netlify/functions/engagement.mjs`). Admin itself is a local Rust server
with its own session, CSRF and per-route authorization. It has no Supabase identity.

## Decision

- **Server-side `service_role`, no Supabase Auth, no RLS policies for browsers.** Nothing in a browser talks to
  Supabase. Every social table has row level security enabled, no policy, and all rights revoked from `public`,
  `anon` and `authenticated`; only `service_role` is granted what it needs. A different identity design (Supabase
  Auth with RLS) would need a new ADR.
- **The Rust Admin is the only authority over who the author is.** The Admin session and CSRF check run first,
  as for every Admin route, and deny by default. Only then does the Admin call the hosted social function, with a
  server-held key, naming the signed-in Admin user in `X-OpenBlog-Actor`.
- **Role comes from which key matched, never from the request.** The hosted function has two keys,
  `OPENBLOG_SOCIAL_ADMIN_KEY` and `OPENBLOG_SOCIAL_WORKER_KEY`, compared by digest. Each must be at least 32
  characters, differ from the other and from the Supabase key, the Admin API key and any anon or publishable key,
  so a public bearer can never act. A matched admin key must carry a valid actor (the Admin account rule,
  `1-32` of `a-z 0-9 _ . -`). A matched worker key must carry none and acts as `@worker`, a name no Admin account
  can take. A route lists the roles it accepts. The scheduled worker (later stories) never uses the admin key.
- **The actor is attribution, not authority.** It is stored as `created_by`/`connected_by`/the attempt's actor and
  nothing is granted by it. This is a single-site, trusted-Admin model: every Admin user may manage the site's
  social accounts, and the audit name says which one did.
- **The site scope is the server's.** The site is `OPENBLOG_SITE_ID` (the namespace hosted engagement already
  uses): 1 to 80 characters of `A-Z a-z 0-9 . _ -`, starting with a letter or digit. A request may not name a
  site anywhere (query or any depth of a JSON body), not even the right one; every query is built with
  `site_id=eq.<scope>` and a caller filter on `site_id` is a programming error; every row read back is checked and
  one from another site is an error, never shown. Rust (`openblog_core::social_publishing`) and the hosted
  function (`netlify/lib/social-scope.mjs`) share one fixture of accepted and refused inputs.
- **Off unless configured.** `OPENBLOG_SOCIAL_ENABLED` must be exactly `true` and every setting valid, or the
  feature does not exist: the hosted routes answer 404 and the settings report only the names, never the values,
  of what is wrong. Settings objects hide their keys from `JSON.stringify`, `console.log` and `util.inspect`.
  A test proves that site builds, portable exports and cross-posting plans are byte for byte identical with and
  without every social setting, and carry none of the secret values.

## Considered options

- **Supabase Auth plus RLS.** Rejected: it adds a second identity system beside Admin sessions, needs a user
  mapping and `WITH CHECK` policies on every table, and puts a Supabase session in the browser.
- **One shared key for the Admin and the worker.** Rejected: a leaked cron secret would then act as an author.
- **Site chosen by the request or inferred from the Host.** Rejected: that makes tenancy the caller's choice.

## Consequences

- Stories after this one add routes that call `authorizeSocial` first and use `scopedQuery`/`ensureOwned`.
- A multi-site hosted SaaS is outside the first release; the `site_id` column keeps the door open.

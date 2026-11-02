# ADR 0322: Hosted comment captcha uses Turnstile and a signed tab-session pass

- Status: Accepted
- Date: 2026-10-29
- Parent epic: #296

## Context

Moderation and the hourly comment quotas bound spam but cannot tell a script from a reader:
anything that can POST JSON can still fill the pending queue up to the quota. Readers should
prove they are human at most once per visit, with no account and nothing loaded on page view.

## Decision

**Provider.** Cloudflare Turnstile first: free, no account for readers, usually invisible, no
image puzzles. The server verifier (`netlify/lib/comment-captcha.mjs`, `verifyCaptcha`) is
provider-shaped: it takes the provider, token, secret and client address and answers
`{ ok, reason }` with distinct reasons (`missing_token`, `invalid`, `reused`, `expired`,
`misconfigured`, `rejected`, `network`, `timeout`, `provider_error`). It runs through the injected
`fetchImpl` with a five second limit and never returns or logs a token, secret or provider text.
Another provider adds a branch there and one in the component; the comment flow does not change.
The verifier does not pin the response hostname or action, so Turnstile's published test keys work.

**Pass.** One passed challenge is exchanged for `base64url({ s: siteId, e: expiry, n: nonce }) + "." +
base64url(HMAC-SHA256)`. It is stateless (no table), compared in constant time, bounded to the
site, and lasts 30 minutes by default (`OPENBLOG_CAPTCHA_SESSION_TTL_SECONDS`, kept between 60 and
86400). It is a bearer value, not a reader identity, and is deliberately not bound to an IP
address (readers move between networks). It authorizes only `POST /comments` for the same site.
It cannot be revoked individually; rotating `OPENBLOG_CAPTCHA_SESSION_SECRET` invalidates all.
With `OPENBLOG_CAPTCHA_SCOPE=every-comment` the server neither issues nor accepts one, so the server,
not the client, is the authority on the scope.

**Browser.** The pass lives in `sessionStorage` under a key scoped by endpoint and site key, so it
ends with the tab; if storage is blocked it is held in memory for the page. A rejected or expired
pass causes exactly one fresh challenge and one automatic retry with the same text. The provider
script (one allowlisted origin) loads only when the reader first focuses or types in the form.

**Order and quotas.** origin, policy, field validation, captcha, rate limit, insert, so spam
never reaches Supabase. Every verification attempt (a token or a bad pass) spends a new `captcha` bucket before the provider is called
through the existing `openblog_consume_rate_limit` (10 per client, 1,000 per site per hour); the
bucket name is data, so `supabase/openblog.sql` is unchanged. Successful comments are counted by
the `comments` bucket as before.

**Secrets and configuration.** Only `engagement.captcha` `{ provider, siteKey, scope }` is public and
stored. `OPENBLOG_TURNSTILE_SECRET` and `OPENBLOG_CAPTCHA_SESSION_SECRET` are Netlify environment
variables, never in config, generated HTML, Admin or the repository. The server is independently
switched on with `OPENBLOG_CAPTCHA_PROVIDER=turnstile`, so a browser cannot switch protection off.

**Fail closed.** Enabled with a missing or invalid variable, comments answer `503 captcha_unconfigured`
naming the variable, never a value. With the provider off, requests, responses, markup and tests are
unchanged.

**Headers.** `netlify.toml` publishes no Content-Security-Policy, so nothing is added; a site that adds
one allows only `https://challenges.cloudflare.com` for `script-src` and `frame-src`.

## Alternatives considered

- **hCaptcha or reCAPTCHA first.** Rejected for v1: more reader friction or heavier tracking;
  the seam keeps them possible.
- **A server-side session table.** Rejected: needs a SQL migration and a database read on every
  comment for no extra safety at this scale.
- **A cookie for the pass.** Rejected: it would outlive the tab, travel with every request and
  need a cookie notice; `sessionStorage` is sent only where the component sends it.
- **Proof-of-work or honeypot fields only.** Kept as possible later additions; they do not stop a
  determined script.
- **Trusting a client flag that captcha is on.** Rejected: the server decides from its environment.

## Consequences

Turnstile introduces a disclosed third party, only when a reader starts commenting. Blocking it
prevents protected submissions, and readers can retry or keep their words. A newly opened tab that
inherits an opener's `sessionStorage` copy may reuse its pass until it expires. Owners must keep
the public and server settings in step (provider and scope).

Revisit when: a second provider is wanted; abuse continues from verified sessions (add per-pass
limits or a server-side revocation list); Turnstile pricing or privacy terms change; or comments
need reader accounts.

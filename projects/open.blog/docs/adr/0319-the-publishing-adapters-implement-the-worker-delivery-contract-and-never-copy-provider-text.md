# ADR 0319: The publishing adapters implement the worker's delivery contract and never copy provider text

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #358 (task #373)

## Context

The delivery worker (story #357; ADRs 0316 to 0318) claims a due announcement, opens the account's credential
(ADR 0295) and calls the provider through one adapter interface, documented at the top of
`netlify/lib/social-delivery.mjs`. It must not duplicate a post, must not mark one `published` without proof and must
not leak a token or a provider's text. The LinkedIn and Facebook adapters are the first real implementations of that
interface, so they follow it exactly instead of defining a second one.

## Decision

- **The worker's interface, nothing else.** `netlify/lib/social-publish.mjs` exports `linkedinAdapter(settings,
  { fetchImpl, now })` and `facebookAdapter(...)`; each returns `{ provider, publish, reconcile? }`.
  `publish({ post, account, accessToken, signal })` receives `post` = `{ id, idempotencyKey, caption, canonicalUrl,
  work }` and `account` = `{ provider, kind, externalId, displayName }` from the worker and nothing else of ours.
- **Success is a value, every other outcome a typed throw.** `publish` resolves to `{ providerPostId }` only when the
  provider confirmed success and named the post with an id of its own shape (LinkedIn `urn:li:share|ugcPost:<n>` from
  `x-restli-id`). Anything else throws a `DeliveryError` (ADR 0317) whose `kind` the worker switches on (ADR 0318):
  - `auth`: 401, or a token that is missing or not printable (no request is made). The worker fails the post with
    `needs-reauth` and moves the account from `connected` to `needs-reauth` (the same guarded update the credential
    store makes when a refresh is refused), so its other announcements fail before any send and Admin asks the author
    to connect again.
  - `rejected`: 400, 403, 404, 409, 410, 422 and any other 4xx: the provider read the request and refused it. Also a
    post the adapter cannot send at all (a destination id not of the provider's shape, a caption that fails the
    schedule rules of ADR 0308, a link that is not plain `https`); no request is made.
  - `rate-limited`: 429, with `retryAfterMs` from `Retry-After` (seconds or an HTTP date, via `parseRetryAfter`); the
    worker caps it and pauses the account.
  - `transient`: the request certainly never left: the signal was already aborted, the host did not resolve
    (`ENOTFOUND`, `EAI_AGAIN`), the connection was refused or never established (`ECONNREFUSED`, connect timeout).
  - `uncertain`: it may have posted: a 2xx without a usable id, a 5xx, a 3xx (never followed), a timeout or abort
    after the request left, a dropped connection, an unreadable answer. The worker never re-sends it.
- **The worker's signal bounds the call.** The `signal` it passes (its provider timeout) is handed to `fetch`; the
  adapter does not retry, and makes exactly one provider call per `publish`.
- **No idempotency key is sent.** Neither the LinkedIn Posts API nor the Graph Page feed honours one on these calls,
  so `idempotencyKey` is not sent and nothing relies on it. Duplicates are prevented by the rule above instead: only
  an answer that means "definitely not processed" (`transient`, `rate-limited`) is retried; anything that may have
  posted is `uncertain`.
- **Reconcile only where a read-only lookup exists.** Facebook implements `reconcile` (ADR 0320). LinkedIn omits it:
  listing a member's or organization's posts (`GET /rest/posts?q=author`) needs `r_member_social` or
  `r_organization_social`, which LinkedIn grants only to approved partners and this deployment never requests. An
  unknown LinkedIn outcome therefore goes to a person straight away (`needs-review`, ADR 0318).
- **Registered only when configured.** `socialAdapters({ providers, fetchImpl, now })` (in
  `netlify/lib/social-adapters.mjs`) registers an adapter only for a provider that `socialProviders(env)` reports as
  configured (client id, secret and a valid API version, ADR 0299), in a frozen object with no prototype. With none
  configured it is empty and every announcement waits in the queue (ADR 0317): delivery is off by default. The worker
  looks an adapter up by own property only.
- **Nothing a provider said is copied.** A reply is read for a status, a few headers and an id; an error carries
  only its kind, the HTTP status and the fixed sentence of `social-delivery.mjs`. The token travels only in the
  `Authorization` header. The adapters never log.
- **LinkedIn request.** `POST {apiBase}/rest/posts` with `Authorization: Bearer`, `Linkedin-Version` (the configured
  dated version) and `X-Restli-Protocol-Version: 2.0.0`; none of the obsolete `X-Li-Format` or `ugcPosts` shape. The
  body is a `PUBLIC` `MAIN_FEED` post by the account's member or organization URN with an `article` (`source` the
  canonical link, `title` the caption's first line, at most 200 characters, or "Read the full post"),
  `lifecycleState: PUBLISHED`. `commentary` is LinkedIn "little text", so ``\ | { } @ [ ] ( ) < > # * _ ~`` are
  escaped: a caption posts as typed and cannot mention or format.

## Considered options

- **Return a status object (`published` / `failed` / `unknown`) instead of throwing.** This was the first draft. It
  was rejected because it contradicted the interface the worker already defines (ADRs 0316 to 0318): two shapes would
  need a translation layer in which a mapping mistake duplicates or hides a post. The worker's `DeliveryError` kinds
  already separate a refusal from an ambiguous outcome, and a plain throw is treated as `uncertain`, so a mistake
  fails safe.
- **Treat a 5xx or any network error as retryable.** Rejected: a gateway can time out after the post was created.
  Only errors that happen before the request is sent are `transient`.
- **Send the idempotency key in a custom header anyway.** Rejected: a header a provider ignores gives false comfort.
- **Copy the provider's error message to help the author.** Rejected: it is untrusted text that may echo secrets.

## Consequences

- Every LinkedIn `uncertain` becomes a person's decision in Admin; that is the price of never duplicating.
- A new network is a code change in `providerOf`, `social-publish.mjs` and its fixture cases, on purpose.

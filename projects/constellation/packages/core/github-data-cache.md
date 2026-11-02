# GitHub request cache

GitHub API requests consume GitHub API quota. They do not consume LLM tokens. Constellation caches safe reads to avoid repeating API calls; rendering, styling, layout changes, randomization and navigation operate on already-loaded snapshots and do not poll GitHub.

## Layers and freshness

The HTTP request cache is separate from `pipeline-cache.mjs`, which caches scene computation, and from Studio's account/activity snapshots and loader-specific commit or organization caches. The request cache only helps when a loader actually reaches the fetch boundary. Existing snapshots remain the intentional source for styling and rendering; loading an already-complete account does not force a network revalidation.

The request-cache default TTL is 15 minutes. Callers can set `ttlMs` when creating the cache; the CLI accepts `CONSTELLATION_GITHUB_CACHE_TTL_MS` in milliseconds. A fresh entry is served locally. An expired REST entry with an ETag is revalidated using `If-None-Match`; a `304 Not Modified` reuses the saved body and resets its freshness window. Failures are not cached. The local preview proxy forwards ETags, `304`, rate-limit headers and `Retry-After`.

Studio keeps public request bodies in versioned `sessionStorage` across page reloads. Its request cache is bounded to 500 entries and 5 MiB of retained body/header data. CLI stores public request responses in `.cache/constellation-github-requests-v1.json` with the same bounds. Corrupt files, unavailable browser storage and quota errors are ignored; the current request still proceeds. Authenticated browser responses and token-authenticated CLI responses remain memory-only. Cache keys include the exact URL and query, method, `Accept` representation, and a non-secret hash of the authentication context. Raw tokens are never written to cache files, logs, exports or share links.

Only GitHub REST `GET` responses are eligible. Mutations and GraphQL `POST`s are not cached, including the fixed read-only pinned-repository query. This avoids caching arbitrary GraphQL operations or HTTP-200 GraphQL error bodies. Pinned results continue to use their existing explicit Studio snapshot behavior.

## Refresh and rate limits

CLI `--refresh-data` bypasses request and loader caches and issues fresh requests. The Studio has no refresh button: opening an account again within the 15-minute window reuses cached responses, and a new tab starts fresh. A newer refresh supersedes older in-flight cache writes and Studio snapshot writes. Refresh does not override a live GitHub rate-limit instruction: `Retry-After` or `X-RateLimit-Reset` establishes a bounded cooldown, and subsequent requests fail locally with the retry time instead of repeatedly contacting GitHub. The cooldown survives reloads as hashed metadata only. Existing loaders keep their partial-result diagnostics; cached bodies remain available during the wait, and public-mode status explains that new requests have stopped.

No background polling is used. Request counts can be inspected from `requestCache.statistics()` (`hit`, `miss`, `sharedRequest`, `revalidation`, `entries`, and `retainedBytes`).

## Verification

The deterministic mocked comparison runs independent contribution and commit loaders against the same repository. Without a shared request cache it makes three GitHub GETs: two identical repository-metadata requests and one commit-list request. With the shared request cache it makes two: one metadata request shared by both loaders and one commit-list request. This is a measured test fixture result, not a claim about all accounts or sessions.

Public browser loads are limited to profile identity and one repository page. Public Refresh invalidates only those discovery requests; cached manually added repositories remain available. Optional enrichment is gated by the shared GitHub capability model. The browser records `X-RateLimit-Limit`, `Remaining`, `Reset` and `Resource` headers and reserves five remaining requests, accounting for in-flight calls. A 403/429 stops subsequent requests without retries. Reset times are shown only when GitHub supplies them; otherwise the message asks users to retry later or sign in. Cached responses and existing repository snapshots remain usable. `requestCache.publicRateLimit()` exposes credential-free diagnostics.

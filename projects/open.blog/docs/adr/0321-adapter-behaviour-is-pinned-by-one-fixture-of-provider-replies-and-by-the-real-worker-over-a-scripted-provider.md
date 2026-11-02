# ADR 0321: Adapter behaviour is pinned by one fixture of provider replies and by the real worker over a scripted provider

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #358 (task #375)

## Context

The worker trusts an adapter's answer to decide whether to retry, look up or stop (ADRs 0318 to 0320). A wrong
mapping duplicates a post or hides one. Provider docs change, a single test per adapter would let a mapping drift
unnoticed, and adapter tests alone would not catch an adapter that the worker never calls or calls with a different
shape.

## Decision

- **One data fixture, `tests/fixtures/social-publish.json`,** lists provider replies in the documented shapes
  (2xx, 401, 403, 429 with `Retry-After`, 5xx, a redirect, a network reset, a refused connection, a timeout,
  ambiguous successes such as a 201 with no id or a 200 with an HTML body) beside the answer each must produce under
  the delivery contract: `{ providerPostId }`, or a `DeliveryError` `kind` with its HTTP `status` (and
  `retryAfterMs` for a rate limit). It is hand-written from the documented shapes: no real account was used and no
  secret is in it. A change to an API version means re-checking it against the provider's current documentation first.
- **One contract test runs every case** through the adapters that `socialAdapters()` registers, with a scripted
  `fetch`, and asserts for all of them: a success is exactly `{ providerPostId }`; every other answer is a
  `DeliveryError` (never a plain error) with a fixed message; there is exactly one provider call; the worker's own
  `signal` is the one passed to `fetch`; no redirect is followed; the access token is in the `Authorization` header and
  nowhere else; no idempotency key is sent; no token, trace id or provider wording appears in the answer; nothing is
  written to the console. It also checks that nothing is registered for an unconfigured provider and that no
  unsupported network (a list in the fixture, including `__proto__` and `constructor`) has an adapter.
- **Worker-level tests** (`tests/web/social-publish-worker.test.mjs`) run `createWorker` with `socialAdapters()` over a
  scripted provider and the in-memory queue, and follow each answer to the stored row, attempt and summary: 2xx,
  401, 403, 429 with `Retry-After`, 5xx, timeout, abort, network error, refused connection, ambiguous 2xx, a
  Facebook unknown settled by `reconcile`, an unsupported provider, nothing registered when unconfigured, and no
  token, key or provider text in any stored error, summary or log.
- **The adapter sources are checked** to hold no hosts of their own, no environment access and no logging.

## Considered options

- **Record real responses.** Rejected: it needs real accounts and would put account data in the repository.
- **Test the adapters only separately.** Rejected: the shared contract and the wiring into the worker are the point;
  per-adapter tests alone let the two adapters drift apart and missed that the first draft was never called.

## Consequences

- Adding a provider means adding fixture cases first; the contract and worker tests then cover it.
- The fixture is documentation of what the code assumes, to be re-verified at setup and on version bumps.

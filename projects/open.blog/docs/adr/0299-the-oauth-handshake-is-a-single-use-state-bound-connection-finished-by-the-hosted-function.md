# ADR 0299: The OAuth handshake is a single-use, state-bound connection finished by the hosted function

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #355 (task #364)

## Context

An author connects LinkedIn or Facebook to their site with the OAuth authorization-code flow. The provider sends
the author's browser back to a URL registered in the provider's app. Admin is a local server (or a private
deployment) that the provider can rarely reach, and the epic keeps every credential on the server (ADR 0293,
0295). So the callback has to land on the hosted function, and it must not trust anything in that request that a
stranger could forge.

## Decision

- **A connection row is the handshake.** `start` (Admin key, actor named) inserts a row in
  `openblog_social_connections` and returns the provider's authorization URL. The row holds a SHA-256 hash of a
  256-bit random `state` (the value itself is never stored), the exact redirect URI used, the requested scopes,
  the Admin user who started it, and a ten minute expiry. At most ten attempts are open per site.
- **The callback holds no key; the state is the proof.** `GET /callback/<provider>` is the only route open to the
  author's browser. It reads exactly `state`, `code` and `error` (each at most once, state exactly 43
  base64url characters, code printable ASCII up to 2048), looks the state up by hash, and refuses with one fixed
  page when the row is unknown, belongs to another provider, was already used, was canceled or has expired. All
  those refusals look the same.
- **Single use by a version-checked claim.** The first callback moves the row `pending -> exchanging` with a write
  that names the version and the state it read; a replay, a second tab or a concurrent pair finds the claim
  taken. A failure after the claim never returns the row to `pending`: it ends `failed` or stays `exchanging`
  until it expires. A code is therefore exchanged at most once.
- **Exact redirects, from settings only.** The redirect URI is `OPENBLOG_SOCIAL_CALLBACK_BASE` plus
  `/callback/<provider>` (an `https:` URL with no credentials, query or fragment), registered in the provider's
  app. Nothing in a request, including a `redirect_uri` or `scope` parameter, can change what is sent.
- **PKCE where the deployer has confirmed it.** With `OPENBLOG_SOCIAL_<PROVIDER>_PKCE=true` the URL carries an
  S256 challenge and the verifier is sealed with the token envelope (ADR 0295) until the exchange. It is off by
  default for both providers because neither guarantees it for a confidential web app, and `state` is the
  defence against forged callbacks either way.
- **Scopes are verified from the grant.** The scopes requested are settings (defaults documented, overridable).
  After the exchange the granted scopes are read from the provider (LinkedIn's token reply; Facebook's
  `/me/permissions`, because a person can decline one permission in the dialog). A missing required scope ends
  the attempt as `scopes-missing`, withdraws the grant where the provider allows it, and stores no token. A
  missing optional scope only narrows what can be reached.
- **Secrets stay out of everything.** Client secrets travel in the provider POST body, never a URL. Tokens are
  sealed under the connection id with the key ring before being stored and are erased the moment the attempt
  ends. Every error and the callback page use fixed text; a provider reply, code, state or token is never quoted.
  The page is `no-store`, `noindex`, sent with `Referrer-Policy: no-referrer` and a CSP that allows no script.
- **Versions and scopes are settings, not constants of the design.** LinkedIn's `Linkedin-Version` (a `YYYYMM`)
  and Facebook's Graph version (`vNN.N`) are settings with defaults that the guide tells the deployer to verify
  against the provider's current documentation at setup.

## Considered options

- **Callback on the Admin server.** Rejected: providers need a stable public HTTPS redirect, a local Admin is not
  one, and it would have to hold the client secret.
- **Signed (stateless) `state`.** Rejected: it cannot be made single use without storage, and the row also
  carries the actor, expiry and verifier.
- **PKCE always on.** Rejected: LinkedIn and Facebook do not both document it for server-side web apps, and a
  provider that rejects an unknown parameter would make the feature unusable.

## Consequences

- `social.sql` gains one additive table, `openblog_social_connections`, dropped by `social-rollback.sql`.
- Choosing a destination, discovery and the Admin screens build on the `authorized` state (ADR 0300, 0301).

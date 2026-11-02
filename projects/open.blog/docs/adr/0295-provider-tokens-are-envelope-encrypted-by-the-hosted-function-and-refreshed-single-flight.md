# ADR 0295: Provider tokens are envelope-encrypted by the hosted function and refreshed single-flight

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #354 (task #363)

## Context

A connected LinkedIn or Facebook account yields an access token and usually a refresh token. Anyone holding them
can post as the author. The epic requires them to be Vault or envelope encrypted, server-only, revocable, refreshed
safely and never in a log, response, page or repository. The hosted function already holds the `service_role` key,
so an attacker who gets that key (or a database dump or backup) must still not get usable tokens.

## Decision

- **Envelope encryption in the hosted function, not Supabase Vault.** Vault keeps the secret in the same database
  that a `service_role` leak or a backup exposes, and needs an extension the project may not have enabled. Here each
  credential bundle is encrypted with its own random 256-bit data key (AES-256-GCM, Web Crypto, so it runs in Node
  and Deno). The data key is wrapped by a key-encryption key that exists only in `OPENBLOG_SOCIAL_TOKEN_KEYS`
  (`id:base64` of 32 bytes, comma separated, the first is active) in the function's environment. The database holds
  only ciphertext. Vault stays a possible later swap behind the same `sealCredential`/`openCredential` seam.
- **Bound to its row.** The additional authenticated data of both layers is `site : account : key id`. A ciphertext
  copied to another account, another site or relabelled with another key id fails to open.
- **Rotation.** Add a new first key id and keep the old ones; `rotate` re-wraps the data key under the active key
  and re-seals under its id without reading the tokens out. An unknown key id fails with a fixed message.
- **No plaintext columns.** `openblog_social_credentials` stores `key_id`, the envelope, expiry and scope metadata,
  status and a `version`. A check constraint makes the envelope exist exactly while the credential is `active`;
  revoking sets it to null and stamps `revoked_at`. The row survives for history.
- **Refresh is single-flight and conditional.** A token with more than five minutes left is returned as is.
  Otherwise the caller takes a 60-second lease with an update that names the version it read and requires no live
  lease; only one caller wins and the rest re-read, then retry later (`refresh-in-progress`). The provider's refresh
  call is injected, so tests need no network. A rotated refresh token replaces the old one in the same write. If
  the credential was revoked or reconnected while the provider call ran, the conditional write fails and the new
  tokens are dropped. A crashed refresh holds the lease only for 60 seconds.
- **Failure policy.** A transient failure counts and releases the lease (retryable). A permanent one (the provider
  says the grant is gone) erases the tokens, marks the credential revoked and the account `needs-reauth`, so the
  author connects again. A token that has expired with no refresh token does the same.
- **Revoke** tries the provider (best effort, never blocking), then erases the stored tokens and disconnects the
  account, idempotently.
- **Nothing leaks.** Errors are fixed messages with a code and a retryable flag; no provider response, request,
  stored value or key is ever put in one. `describe` is the only view Admin gets: status and dates. Settings
  objects hide keys from `JSON.stringify` and `util.inspect`. `redact` strips given secrets, bearer values and
  token fields for any message that must mention a failure. The feature stays off unless `OPENBLOG_SOCIAL_TOKEN_KEYS`
  is valid.

## Considered options

- **Supabase Vault.** Rejected for the reason above; revisit if a deployer wants no application-held key.
- **pgcrypto `pgp_sym_encrypt` in SQL.** Rejected: the key would travel in queries and statement logs.
- **Store only the refresh token.** Rejected: it forces a refresh before every post.

## Consequences

- Losing `OPENBLOG_SOCIAL_TOKEN_KEYS` means every account must be connected again; the setup guide says to back it
  up in the secret store.
- Delivery code in later stories calls `accessToken(accountId, { refresh })` and nothing else touches tokens.

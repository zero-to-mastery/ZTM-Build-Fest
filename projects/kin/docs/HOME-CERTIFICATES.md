# Home server certificates (ACME client)

Story #723 (tasks #724–#727, and #751 for ARI), epic #708, following
[ADR 0025](decisions/0025-kin-at-home.md) §5 (certificates), §6–7 (what the
relay and the home server can learn and hold) and §10 (the `home/`
directory).

**Status: built and tested; home mode starts it (#733).** The code lives in
`server/acme/` and has no dependencies (Node's `crypto`, `tls`, `https`,
`fs` only). Nothing in hosted Kin imports it. Home mode with a name
(`server/home/home-server.mjs`, [HOME-SERVER](HOME-SERVER.md#reaching-it-from-anywhere-the-tunnel))
starts one `CertificateManager`; "How home mode wires it" below says how,
and what the control panel (#718) still has to add.

## Modules

| File | Task | What it does |
| --- | --- | --- |
| `der.mjs` | #725 | DER writer (lengths, INTEGER, OID, strings, times, BIT/OCTET STRING, context tags), a bounded TLV reader, and ECDSA P1363 → DER signature encoding |
| `x509.mjs` | #725, #726, #751 | Names, extensions, subjectAltName, key identifiers, ecdsa-with-SHA256 signing, an X.509 v3 certificate builder, PEM; reads a certificate's serial and extensions and computes the ARI certificate identifier |
| `csr.mjs` | #725 | The PKCS#10 CSR: CN (when ≤ 64 characters), the certificate key's SPKI, an extensionRequest with subjectAltName, signed by the certificate key |
| `keys.mjs` | #725 | P-256 key generation, the JWK and its RFC 7638 thumbprint, and `CertificateStore` (files, modes, atomic writes) |
| `transport.mjs` | #724 | The default outbound HTTPS transport (time limit, size cap). Any `fetch`-shaped function can be injected instead |
| `client.mjs` | #724, #751 | The RFC 8555 client, ARI's `renewalInfo` request, and `obtainCertificate` (TLS-ALPN-01, with `replaces`) |
| `tls-alpn.mjs` | #726 | The RFC 8737 validation certificate and `ChallengeResponder` |
| `tls-hook.mjs` | #726, #727 | The only server integration: `ALPNCallback`/`SNICallback` options, closing challenge connections, `applyCertificate` (hot swap) |
| `renewal.mjs` | #727, #751 | `CertificateManager`: schedule (ARI or two thirds), backoff, hot swap, status, daily CT check, CAA records |
| `ct-check.mjs` | #727 | The Certificate Transparency check |
| `staging.mjs` | — | A manual run against Let's Encrypt staging (never run by tests or CI) |
| `acme-test-server.mjs` | tests | The in-process ACME server the tests use |

## The protocol, as implemented

1. `GET` the directory; `HEAD newNonce` when no nonce is held. Every
   response's `Replay-Nonce` is kept for the next request.
2. Every POST is a flattened JWS (RFC 7515 §7.2.2) with protected header
   `{ alg: "ES256", nonce, url, jwk | kid }` and a P1363 (`r ‖ s`) signature.
   `jwk` (public members only) is used for `newAccount` alone; `kid` (the
   account URL) for everything after. POST-as-GET has an empty payload.
3. A `badNonce` error is retried with the nonce that came with it, up to
   three times.
4. `newAccount` with `termsOfServiceAgreed: true` (refused with
   `acme-terms-not-agreed` unless the admin agreed in setup). An existing
   account for the key is found again (200).
5. `newOrder` for the name; each pending authorization's `tls-alpn-01`
   challenge is answered: the responder gets the key authorization
   (`token.thumbprint`), the client POSTs `{}` to the challenge, then polls
   the authorization.
6. Polling honours `Retry-After` (seconds or an HTTP date), waits 1–60
   seconds between polls, and gives up after 30 polls (`acme-timeout`).
7. `finalize` with the CSR (a new P-256 key for every certificate), poll the
   order, download the chain as `application/pem-certificate-chain`, and
   check the leaf certifies our key (`acme-key-mismatch` otherwise).
8. The challenge answer is removed whatever happens.
9. **ARI (RFC 9773).** When the directory has `renewalInfo`, the renewal
   information for a certificate is an unauthenticated `GET
   <renewalInfo>/<certificate identifier>` (no JWS, §4.1). Its
   `suggestedWindow` must be two RFC 3339 times with `end` after `start`
   (anything else is `acme-bad-response`); `explanationURL` is kept only
   when it is `https:`. A renewal's `newOrder` carries `replaces: <the old
   certificate's identifier>` (§5), and only to a CA whose directory has
   `renewalInfo`. If the CA answers 409 `alreadyReplaced`, the order is
   placed once more without `replaces`.

### The ARI certificate identifier

`base64url(AKI keyIdentifier) "." base64url(serial)` with no padding
(RFC 9773 §4.1). The keyIdentifier is the `[0]` field (tag `0x80`) of the
leaf's authorityKeyIdentifier extension (2.5.29.35); the serial is the
content octets of the serialNumber INTEGER exactly as encoded, so a serial
whose top bit is set keeps its leading `00`. Both are read by Kin's own DER
reader (`readCertificate`, `authorityKeyIdentifier`,
`certificateIdentifier` in `x509.mjs`) as views into the certificate, not
by Node. A certificate without that keyIdentifier has no identifier, and is
renewed by the two-thirds rule. The RFC's example is pinned in
[TEST-VECTORS](TEST-VECTORS.md#home-server-certificates-723).

## TLS-ALPN-01

The validation certificate is self-signed with a fresh key that is never
written to disk. It carries exactly one dNSName (the name being validated)
and the critical `id-pe-acmeIdentifier` extension (1.3.6.1.5.5.7.1.31) whose
value is the DER `OCTET STRING` of SHA-256(key authorization):

```text
30 31  06 08 2b 06 01 05 05 07 01 1f  01 01 ff  04 22 04 20 <32-byte digest>
```

The hook answers `acme-tls/1` **only** when the client offers it and the
responder has a pending answer for the SNI name. A client offering only
`acme-tls/1` for any other name is refused with a fatal alert. Ordinary
connections never negotiate `acme-tls/1` and keep the server's own
certificate. A challenge connection is closed right after its handshake and
never reaches HTTP.

How the hook picks the certificate: Node calls `ALPNCallback` while it
reads the ClientHello, and later calls `SNICallback` from the certificate
callback, both with the `TLSSocket` as `this`. `ALPNCallback` marks the
socket, and `SNICallback` gives a marked socket the challenge context.
`tls-hook.test.mjs` asserts this order, so a Node release that changed it
would fail CI rather than quietly break issuance (the hook fails closed:
without the mark, the validator gets the ordinary certificate and validation
fails).

## Files and permissions

In `<data directory>/home/` (ADR 0025 §10), created mode 0700:

| File | Mode | Contents |
| --- | --- | --- |
| `acme-account-key.pem` | 0600 | The ES256 account key (PKCS#8) |
| `acme-account.json` | 0600 | `{ directoryUrl, accountUrl }` |
| `certificate-key.pem` | 0600 | The current certificate's key (PKCS#8) |
| `certificate.pem` | 0600 | The chain, leaf first |
| `certificate-history.json` | 0600 | Public facts about every certificate this server obtained: SPKI SHA-256, serial, expiry (at most 200) |

Every write goes to a fresh temporary file (`O_EXCL`, mode 0600) in the same
directory and is renamed over the target. A file or the directory found with
wider permissions is tightened back when read. On Windows the mode is mostly
ignored: the installer's ACL (#713) restricts it there. Backups that include
`home/` are as sensitive as the computer (ADR 0025 §7, §10).

## Renewal, backoff and status

- **With ARI** (the CA's directory has `renewalInfo`): ask for the window
  as soon as a certificate is loaded or obtained, then again after the CA's
  `Retry-After`, clamped to 1 hour – 24 hours (6 hours when there is none).
  With T = two thirds of the lifetime and the window [S, E):
  - E has passed (an incident, a revocation coming): renew now;
  - the whole window lies after T: renew at T. Never later than T is the
    bound that keeps a wrong or hostile answer from pushing renewal towards
    expiry, so it wins over the window here;
  - otherwise a uniformly random time in [S, min(E, T)): never before the
    window's start, never after T. A time already past means now.

  The time is kept while polls return the same window and chosen again when
  the window moves. A failed poll keeps the last window's time (two thirds
  if there has been none) and polls again after its `Retry-After`, clamped
  the same way. A failed poll is not a renewal failure: it doesn't count in
  `failures` or start the backoff.
- **Without ARI** (no `renewalInfo`, no identifier, or no answer yet):
  renew when two thirds of the lifetime has passed (day 60 of 90). A CA
  without `renewalInfo` is checked again daily (the directory only).
- In every case, renew at once when there is no certificate, it has
  expired, or it doesn't match its key or the name.
- After a failure: 1 hour, doubling to 24 hours; a longer `Retry-After` from
  the CA (rate limits) wins, up to 7 days. While backing off, the backoff
  says when to try again, even when the ARI window says "now"; ARI polls go
  on meanwhile. A success clears the backoff and starts ARI afresh for the
  new certificate.
- The new certificate is put on the running server with
  `tls.Server.setSecureContext` (`applyCertificate`): new connections get it,
  open ones keep theirs, nothing restarts.
- Timers wake at least daily and re-plan, so a sleeping computer catches up.
  One timer serves both renewal and ARI polls (whichever is due first).

`CertificateManager.status()` is what the control panel (#718) shows. It
holds no key and no secret:

```text
{
  name, state: "none" | "valid" | "renewing" | "valid-retrying" | "failed" | "expired",
  certificate: { notBefore, notAfter, serial, issuer, daysLeft } | null,
  expiringSoon,              // under 14 days left
  renewAt,                   // the planned renewal: the ARI choice, else two thirds
  nextAttemptAt, failures,
  lastError: { code, detail, at } | null,
  lastRenewedAt, accountUrl,
  caa: [ '<name>. CAA 0 issue "letsencrypt.org; accounturi=…; validationmethods=tls-alpn-01"',
         '<name>. CAA 0 issuewild ";"' ] | null,
  transparency: { state: "not-checked" | "ok" | "alert", checkedAt, checked,
                  unexpected: [{ id, serial, issuer, notBefore, notAfter }],
                  error: { code, at } | null },
  renewalInfo: {             // ARI (#751); fields added, nothing above changed
    state: "none" | "unknown" | "ok" | "failed" | "unsupported" | "no-identifier",
    certificateId,           // the ARI identifier, or null
    suggestedWindow: { start, end } | null,   // the last good window
    explanationURL,          // the CA's https link about the window, or null
    checkedAt, nextCheckAt,
    error: { code, detail, at } | null        // the last poll's failure
  }
}
```

`explanationURL` is for the control panel to offer as a link (RFC 9773 §4.2
says to show it to the operator); it is never fetched by the server.

`onEvent` reports `renewed`, `failed`, `expiring` (under 14 days) and
`transparency-alert`; #718 turns `expiring` and `transparency-alert` into the
content-free push to admins (ADR 0025 §5).

### Error codes

`lastError.code` is one of: `acme-rate-limited`, `acme-caa`, `acme-dns`,
`acme-connection`, `acme-tls`, `acme-incorrect-response`,
`acme-unauthorized`, `acme-rejected-name`, `acme-bad-csr`, `acme-bad-key`,
`acme-malformed`, `acme-bad-nonce`, `acme-no-account`,
`acme-terms-changed`, `acme-account-binding-required`, `acme-bad-contact`,
`acme-order-not-ready`, `acme-server-error`, `acme-already-revoked`,
`acme-already-replaced` (handled by ordering again without `replaces`),
`acme-bad-request`, `acme-compound` (taken from the first subproblem when
there is one), `acme-error` (unknown types), and the client's own
`acme-network`, `acme-timeout`, `acme-bad-response`, `acme-no-challenge`,
`acme-authorization-invalid`, `acme-order-invalid`,
`acme-terms-not-agreed`, `acme-insecure-url`, `acme-key-mismatch`.
`detail` is the CA's text, cut to 300 characters, for a details view only.

## The daily CT check

Once a day (an hour after a start with no certificate) the manager asks the
CT search service (`https://crt.sh/` by default, `ctBaseUrl` to change) for
unexpired certificates for the name and for `*.<parent>`, keeps those whose
names cover the name, and accepts a certificate when its serial is one of
ours or, after downloading it, its public key is one of ours (which also
covers precertificates). Anything else is listed in
`transparency.unexpected` and the state turns `alert`. An unreachable or
garbled service is an error (`ct-unavailable`, `ct-bad-response`,
`ct-too-many` for more than 50 unknown certificates), not an alert, and the
previous result stays. CT can't name the ACME account, so "not ours" means
"not for a key this server made", which is what an attacker's certificate
would be.

## How home mode wires it (#733), and what #718 adds

- **TLS for tunnel streams.** `HomeTlsEndpoint` (`server/home/home-server.mjs`)
  makes a server-side `TLSSocket` for each tunnel stream with the current
  certificate's secure context and `...acmeTlsServerOptions({ responder })`,
  closes acme-tls/1 connections after the handshake as
  `closeChallengeConnections` does, and hands the others to Kin's HTTP
  server. It makes the socket itself rather than calling
  `tls.Server.emit("connection", stream)`, because the phone's address from
  the stream's `OPEN` frame must be attached to the very socket HTTP sees,
  and a `tls.Server` never hands back the socket it wraps. The endpoint has
  `setSecureContext`, so `CertificateManager` hot-swaps certificates on it
  exactly as on a `tls.Server`.
- **One `CertificateManager`** for the home server's name, with the stored
  certificate loaded at start. Its `beforeOrder` sends the relay `CONTROL`
  op 3 `SET_CAA` with the account URL, after waiting (up to two minutes)
  for the tunnel to route the name; a failure stops the order and shows as
  `lastError.code` `tunnel-not-ready` or `tunnel-caa-*`. Such a failure is
  retried as soon as the tunnel routes the name, not after the hour's
  backoff. For an own domain there is nothing to send: CAA is in the
  household's own DNS.
- **Settings:** the ACME directory is the home setting `acmeDirectory`
  (Let's Encrypt production by default; `KIN_HOME_ACME_DIRECTORY`), and the
  terms agreement is `acmeTermsAgreed` (`KIN_HOME_ACME_TERMS_AGREED`).
- **Control panel (#719, #720, built):** the status page shows `status()` in
  plain words; setup shows an own domain's CAA records (and the ACME account
  they name, made at the terms step) and checks them; the terms step writes
  `acmeTermsAgreed`; `expiring` and `transparency-alert` become a
  content-free push to the household admins, at most daily each
  (`certificateAlerts` in `server/home/control-panel.mjs`, through
  `startHomeServer`'s `onCertificateEvent`). See
  [HOME-SERVER](HOME-SERVER.md#setting-it-up-the-control-panel).

## Not done yet (deliberately)

- Account key rollover, account deactivation and certificate revocation.
- External account binding (Let's Encrypt doesn't use it).

## Tests

`node --test server/acme/*.test.mjs` (part of `npm run verify`). They never
contact a real CA or crt.sh. `server/home/home-tunnel.test.mjs` also gets a
certificate end to end through the real relay: the in-process ACME server
validates TLS-ALPN-01 by connecting to the relay's port.

- `client.test.mjs`: the full flow against `acme-test-server.mjs`, which
  checks every JWS (alg, single-use nonce, `url`, `jwk` vs `kid`, signature),
  validates TLS-ALPN-01 by opening a real loopback TLS connection with ALPN
  `acme-tls/1` and checking the negotiated protocol, the single dNSName and
  the critical acmeIdentifier value, verifies the CSR and issues from a test
  CA. Also badNonce retry, Retry-After polling, error codes, terms, timeouts.
- `der.test.mjs`: DER primitives, the fixed vectors in
  [TEST-VECTORS](TEST-VECTORS.md#home-server-certificates-723), and
  `openssl req -verify` / `openssl x509` on the CSR and the challenge
  certificate (skipped when `openssl` isn't installed).
- `keys.test.mjs`: 0600 files, a 0700 directory, tightening, atomic writes.
- `tls-hook.test.mjs`: the callback order the hook relies on, answers only
  for a pending name, no application data, nothing reaches HTTPS, hot swap.
- `renewal.test.mjs`: two-thirds scheduling, backoff, Retry-After, hot swap,
  restart, status states, CAA, and the CT check (fake search service).
- `renewal-info.test.mjs` (#751): the identifier against RFC 9773's example
  in a real DER certificate, AKI shapes, the time chosen in, across and
  after the window, Retry-After clamping, the client's GET and its
  validation, and the manager against the test CA with `renewalInfo` on:
  `replaces` sent and recorded, a passed window, a CA without ARI (which
  refuses `replaces`, so not sending it is proven), failed polls falling
  back, `alreadyReplaced`, backoff, and a restart. The test CA's
  `renewalInfo` option serves a configurable window (`setRenewalInfo`,
  Let's Encrypt's centred-on-two-thirds window by default), `Retry-After`
  and `explanationURL`, and checks `replaces`.

**CI must confirm on Node 24:** these ran on Node 22.22 locally. The things a
Node change could break are the `ALPNCallback`-before-`SNICallback` order
with the socket as `this` (asserted by name in `tls-hook.test.mjs`) and
`setSecureContext` keeping both callbacks. The `openssl` tests need the CI
image to have `openssl` (Ubuntu runners do); they skip otherwise.

## Trying it against Let's Encrypt staging (manual)

Never from tests or CI. You need a DNS name that resolves to the machine
and port 443 reachable from the internet (forwarded to `--port` if not
443), because the CA validates by connecting to it:

```sh
node server/acme/staging.mjs --name test.example.org \
  --data-dir /tmp/kin-staging --agree-terms --port 8443
```

It uses `https://acme-staging-v02.api.letsencrypt.org/directory`
(`LETS_ENCRYPT_STAGING`; `--directory` points it at another ACME server such
as a local Pebble, and it refuses the production URL), prints the CAA
records for the new account, obtains one certificate into
`/tmp/kin-staging/home/`, runs the CT check and prints the status. Staging
certificates chain to Let's Encrypt's untrusted staging roots, so browsers
won't trust them; `openssl s_client -connect test.example.org:443
-servername test.example.org` shows the chain. Delete the data directory
afterwards: it holds a staging account key.

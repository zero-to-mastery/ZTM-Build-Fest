# Security Policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue, and do
not post exploit details, household data, credentials, pairing codes,
recovery keys or proof-of-concept material anywhere public.

1. Use **GitHub's private vulnerability reporting** on the hosting repository
   (`Security` → `Report a vulnerability`) if it is enabled there.
2. Otherwise, contact the maintainer, Mikey Nichols, through the private
   contact options on the [@mnichols08](https://github.com/mnichols08) GitHub
   profile, and say that it concerns `projects/kin/`.

Include a concise description of the impact, the affected version or commit,
safe reproduction steps using synthetic data only, and any mitigation you
already see. Do not access or keep another person's household information
while investigating.

Kin is a volunteer Build Fest project. Reports are read and taken seriously,
a fix and disclosure are coordinated where applicable, and sensitive details
are not published before affected people can reasonably respond; but there is
no staffed security team and no response-time or remediation guarantee.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest v1.x release (currently v1.6.0, `kin-v1.6.0`, 2026-10-21) | Yes: fixes land in the next release on the same line |
| Earlier v1.x releases | No separate maintenance branches; update to the latest |
| v0.x pre-releases | No; v1.0 starts fresh ([V1.0-COMPATIBILITY](docs/V1.0-COMPATIBILITY.md)) |

## What is in scope

Kin's security-sensitive areas, which a report may concern:

- Safe rendering of household text and imported data.
- The WebAssembly protocol, archive parsing and memory ownership.
- Encrypted IndexedDB storage and its migrations.
- Recovery-key and passkey (PRF) root wrapping, root rotation and journalled
  replacement.
- WebAuthn, account sign-in, device certification and household-admin
  authorization.
- Encrypted archive export and import, lock cancellation, the static shell
  cache, encrypted shared settings and attachments.
- Sync authorization and the relay, the chat, fridge and private streams, and
  the service's rate limits.
- The service sandbox, backups and restore, and the deployment images.

Report issues against behaviour that actually exists, in the current
release.

## What Kin's security is, and isn't

Kin v1.6.0 encrypts household content on the device before it is stored or
sent; the service holds identity and routing metadata, authorization state,
encrypted settings and encrypted envelopes, never household plaintext or
content keys. Pairing is passkey-authenticated, sync is client-encrypted, and
household-admin authority is recorded on the server. It is **not**
independently audited or production-certified.

Things no report can change, which the design accepts:

- Encryption cannot protect a compromised unlocked runtime, origin,
  privileged browser extension or operating system.
- Rotation cannot erase data, keys or archives already copied elsewhere.
- A restored server backup can roll back authorization and revocation state;
  restore procedures say so.
- The service can read the private iCal links of outside calendars members
  sync, and holds them in plaintext ([SELF-HOSTING](docs/SELF-HOSTING.md)).

The known limitations at v1.0, each explained in plain language in the
[threat model](docs/THREAT-MODEL.md#known-limitations-at-v10), are:

- **S4:** a relay can hold back an event without the receiving device
  noticing.
- **S5:** device revocation and key-rotation status come from the relay.
- **A6:** a device that joins without sync keys is approved without a
  certificate (it then can't sync; nothing is exposed).
- **C4:** most of the Content-Security-Policy is set in the page rather than
  an HTTP header.
- **C5:** the recovery key can linger in memory and on the clipboard after
  "Copy key".
- **C6:** an export's header (date, counts, version, vault and wrapper IDs)
  is readable without its key.
- **C2 (residual):** an attachment already open in another tab stays visible
  after Kin locks.
- **Attachment removal** by Limited and Temporary members is blocked by the
  app and the relay, but not re-checked when devices replay the event.

Deeper reading: [THREAT-MODEL](docs/THREAT-MODEL.md),
[CRYPTOGRAPHY](docs/CRYPTOGRAPHY.md), [PRIVACY](docs/PRIVACY.md),
[RECOVERY](docs/RECOVERY.md) and [VERSIONING](docs/VERSIONING.md).

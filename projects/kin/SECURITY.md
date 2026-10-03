# Security Policy

**Current security status:** The last published release is v0.10.3, an incubation prototype with encrypted local household storage, recovery/optional-PRF unlock, journalled root replacement, encrypted archives, passkey-authenticated pairing and client-encrypted sync. The unreleased v0.11.7 implementation candidate adds durable identity/relay storage, an exclusive single-process lock, and verified offline backup/restore. It remains unaudited and is not production-certified. Persistent service databases and backups contain identity/routing metadata and encrypted envelopes; they do not contain household plaintext or content keys. Restore can roll back authorization/revocation state. Encryption cannot protect a compromised unlocked runtime, origin, privileged extension or OS, and rotation cannot erase data, keys or archives already copied. See [THREAT-MODEL](docs/THREAT-MODEL.md), [CRYPTOGRAPHY](docs/CRYPTOGRAPHY.md), [V0.10.0](docs/V0.10.0.md) and [V0.11.0](docs/V0.11.0.md).

## Supported versions

Kin is a prototype and has no staffed security-support commitment or guaranteed response time. Follow the private reporting guidance below and include only synthetic data.

## Reporting a vulnerability

Please do not publish exploitable details, household data, credentials, pairing codes, private keys, or proof-of-concept material in a public issue.

Use GitHub's private vulnerability reporting for the hosting repository if that feature is enabled. If it is unavailable, contact the repository maintainer through a private contact method listed on their GitHub profile and identify the affected path/version. Kin does not operate a dedicated security mailbox or promise a response-time SLA.

Reports should include a concise impact description, affected version/commit, safe reproduction steps, and any mitigations already identified. Use synthetic data only. Do not access or retain another person's household information while investigating.

## Scope and response

Implemented security-sensitive areas include safe rendering, WASM protocol/archive parsing and memory ownership, encrypted IndexedDB migration, recovery/PRF root wrapping, WebAuthn, device authorization, encrypted archive import, lock cancellation, static shell caching, and sync authorization/relay. The v0.11 candidate durably stores server identity/relay metadata and ciphertext, but sessions and in-progress ceremonies remain ephemeral. A separate server backup is needed to restore service authority; a local encrypted archive restores local history only. Report issues against behavior that actually exists.

Maintainers will acknowledge and assess reports when available, coordinate a fix and disclosure where applicable, and avoid publishing sensitive details before affected users can reasonably respond. No response-time or remediation guarantee is made.

# Portable Household Data

**Status:** v0.10.3 implements encrypted `.kin` backup and restore for local household history. Rust owns `KARC` v1 framing, 64 MiB bounds, version validation and complete import planning. Browser crypto/files own authenticated encryption, file selection/download and explicit restore confirmation. Corrupt/unsupported archives never partially import. v0.11 separately adds SQLite service-database backup/restore; these two backup types protect different state. Earlier conceptual sections below are design history.

## Implemented archive boundary

**Stable architecture decision (v0.10.2/v0.10.3): Option A — intentionally
local-only restore.** Archives are recovery copies of household history. They
grant no membership or trusted-device authority. Rejoining a synchronized
household requires a separately authorized future workflow; no partial sync
reattachment is supported. v0.13 must decide and specify whether restore remains
local-only or gains authenticated reattachment. Until that decision is
implemented and reviewed, archive restore continues to grant no sync authority;
v0.14 must communicate the boundary plainly.
Root rotation does not change old archives: each retains its original recovery key.

The public metadata carries archive version, recovery-wrapped root metadata and
encryption parameters. The body is raw AES-GCM ciphertext, avoiding redundant
base64 expansion of the whole archive. HKDF purpose `kin/archive/v1` separates its
key from local-record keys; manifest metadata is authenticated as AAD. The encrypted
body contains exact canonical rows and protected replay/catch-up context. The
normal export includes recovery wrappers; it never emits plaintext JSON or device
private keys. Keep the recovery secret separately from the archive.

Restore requires an unlocked empty target and the archive's recovery key. Rust
validates all bytes/identities/versions, rejects duplicate events and plans the
whole replay before browser encryption/atomic import. The transaction checks that
the target history and transport stores are still empty. Imported events remain
byte-for-byte identical; fresh anonymous local actor/device IDs prevent new local
commands from impersonating the source trusted device.

Restored history is writable **local-only**. Sync reattachment is deliberately
blocked: canonical history from several authors cannot be uploaded as one new
signer's history without an authenticated transport restore protocol. No server
trust, cookies, provisioning entitlement or epoch access is restored. This is an
explicit compatibility boundary, not a claim of same-household server recovery.
The v0.11 service database can preserve server identity and relay state when
backed up separately; a local `.kin` archive cannot reconstruct that authority.

## Ownership principle

### v0.10.3 bounded KARC v1 processing

KARC v1 remains one authenticated payload with unchanged bytes/AAD semantics.
Internal raw-ciphertext APIs avoid base64 conversion of the whole archive.
Additive compact Rust framing/layout calls validate metadata/ciphertext lengths
and headers while browser-owned buffers retain opaque ciphertext. Existing
full-buffer ABI exports and old archives remain supported. Import authenticates
the complete body, verifies canonical data and full Rust replay, then publishes
atomically; corruption at the end cannot partially import. Durable lock checks
guard archive phases and the final native transaction aborts on lock.

This reduces avoidable copies without introducing KARC v2. Web Crypto's complete
AES-GCM payload and the bounded full canonical replay still require whole buffers;
desktop measurements in [V0.10.0](V0.10.0.md) quantify the practical limit.

> Household members should be able to obtain a usable copy of their Kin data.

Portability is a product and privacy responsibility, not only a storage convenience. An export should remain understandable and importable without access to the original browser installation or a live Kin server.

## Conceptual export

A future portable archive (possible extension: `.kin`) contains a versioned manifest and the canonical logical event stream:

```text
Kin Export
├── format_version
├── created_at
├── household_id
├── event_count
├── events (canonical envelopes and original payload bytes)
├── optional non-authoritative projection/checkpoint
└── integrity metadata
```

This describes logical sections, not a committed file/container encoding. The export format version is separate from application, event, ABI, and IndexedDB versions. Any included projection/checkpoint is disposable and must not replace events as source of truth.

## Plaintext and encrypted exports

An export may contain sensitive household history. A plaintext export is straightforward to inspect and recover but is readable by anyone who obtains the file; the UI must warn clearly and avoid creating one silently. The user should choose where to save it and be able to cancel.

An encrypted export may be considered later. It would require a reviewed standard encryption/KDF design, secure random generation, authenticated integrity, a clear user-selected passphrase/recovery policy, and interoperable import support. Kin must not invent cryptography or imply an export is encrypted unless it actually is. The possible passphrase flow, parameters, and key management are undecided; there is no encryption implementation in this release.

For device-to-device transfer, use the same validated portable representation or a separately reviewed secure enrollment protocol. Do not treat physical proximity, a QR code, or an export file as authentication by itself.

## Import validation and atomicity

Before changing current household data, stage and validate the entire import:

- Supported `format_version` and declared counts/lengths
- Well-formed structure, bounded sizes, and valid encoding
- Event IDs, household IDs, actor/device IDs, event versions, and payloads
- Duplicate IDs: exact identical duplicates may be deduplicated; same ID with different canonical bytes is an integrity error
- Deterministic event ordering and successful full replay
- Integrity metadata, when present, with a clear distinction between accidental-corruption detection and authenticity
- Household identity compatibility and explicit choice to restore/replace versus create a separate local household

An import must not merge a different household implicitly. Validate into a temporary destination, show the user the household/date/count summary, and commit atomically only after confirmation. Invalid input leaves the existing household state and source file untouched. Unknown newer event versions are preserved and reported as unsupported; never drop them to force an import.

## Integrity limits

A checksum can detect some accidental corruption but does not prove who created the export or protect plaintext. Authentication requires a separately designed signature/key trust model; encryption/authentication claims must follow [CRYPTOGRAPHY](CRYPTOGRAPHY.md). No cryptographic export guarantees are established here.

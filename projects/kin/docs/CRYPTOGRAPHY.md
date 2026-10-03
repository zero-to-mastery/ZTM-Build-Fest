# Cryptographic Posture

**Status:** Implemented through v0.10.3 for local incubation. Web Crypto supplies AES-GCM, ECDSA P-256/SHA-256, ECDH P-256 and HKDF-SHA-256 for local encryption, archives and existing encrypted sync. Recovery or verified WebAuthn PRF authorizes local root unwrapping. No independent cryptographic audit or production certification is claimed.

## Non-negotiable rule

> Kin will use established cryptographic primitives exposed by standards-based implementations such as Web Crypto and appropriate server-side equivalents.

Do not hand-roll cryptographic primitives. Use standardized APIs and established modes. The implemented versioned envelopes, authenticated context and parameters below require review alongside their tests; using standard primitives does not certify their composition.

## Desired properties

The implemented encrypted sync design provides:

- Confidentiality and integrity/authenticity for household event payloads in transit and on relay storage
- Cryptographically secure random generation for keys and pairing secrets
- Explicit authorization of each receiving device
- Separation between member authentication credentials, device identity keys, and household content keys
- Versioned key envelopes and a deliberate key-rotation path
- No plaintext household content key available to the sync service
- Standard transport security in addition to payload encryption

IndexedDB is not inherently encrypted. v0.10 adds an explicit authenticated encryption layer for household content, protected metadata and private sync material. Browser/device security remains part of the [threat model](THREAT-MODEL.md).

## Conceptual household-key flow

```text
trusted authorized device
          |
          | obtains a household content key through reviewed enrollment
          v
household key held by authorized clients
          |
          | authenticated encryption using a reviewed standard protocol
          v
ciphertext event payload
          |
          v
sync relay stores and forwards ciphertext plus limited metadata
```

Keys come from the platform CSPRNG and reach sync devices through authenticated, recipient-bound provisioning. Sync epoch rotation and local root wrapping are separate protocols. v0.10.2 implements local-root replacement by re-encrypting the corpus and replacing recovery/credential wrappers, as specified below.

## Passkeys are not encryption keys

A passkey/WebAuthn credential authenticates a member to a relying party. It does not by itself provide a household encryption key, encrypt events, prove a device is the only holder of content, or define recovery. Do not derive household keys directly from a passkey assertion or treat a biometric/PIN as a key. Authentication, device keys, and household encryption are separate protocols.

## Enrollment, revocation, and rotation

Each authorized device needs an explicit, authenticated means to obtain access to the household key without exposing it to the relay. Pairing must verify the same session and recipient device before enrollment. On device/member revocation, the service rejects future access and remaining trusted devices must rotate the key for future events. Previously downloaded plaintext or key material cannot be recalled. Whether and how old history is re-encrypted for remaining members is a deliberate future decision; see [PAIRING](PAIRING.md).

## Browser execution risk

Browser-side encryption protects against some server/database exposure but not malicious JavaScript executing in an authorized browser. XSS or a compromised dependency could read plaintext and key material. Minimize external scripts/dependencies, render household text as text, avoid unsafe HTML and `eval`, review Content Security Policy, and keep key lifetimes narrow where practical. These defenses reduce risk; they do not make a compromised client trustworthy.

## v0.9.x implementation record (historical persistence)

- Household content uses one random 256-bit AES-GCM key per monotonically increasing epoch; each event has a 96-bit CSPRNG nonce and 128-bit tag. AAD binds protocol/envelope version, household, event, author device, device sequence, Lamport time and epoch. The relay bounds a household history at 100,000 events, below the documented 2^20 envelopes per-epoch nonce budget.
- Each trusted device has separate non-extractable P-256 ECDH and ECDSA private `CryptoKey`s. Public JWKs are fingerprinted and compared locally during pairing approval. The approver signs a certificate binding the claimant's household/member/device IDs and public keys; recipients validate certificate chains against locally pinned/comparison-approved roots before using directory keys. Device signatures bind opaque envelope metadata and ciphertext; receivers verify before decrypting.
- Provisioning uses ephemeral ECDH P-256, HKDF-SHA-256, and AES-GCM wrapping. Packages bind household, sender, recipient ID/fingerprint, epoch, grant and expiry, and are signed by the sender. The recipient proves possession by unwrapping. Grants are recipient-bound and expiring; exact retries are idempotent.
- Epoch keys are non-extractable at runtime. v0.9.3 IndexedDB stores both a usable AES CryptoKey and AES-GCM-sealed raw bytes, wrapped by a key derived from the persisted device ECDH key and fresh salt. Neither imposes a local authentication boundary. Raw bytes are transient during provisioning. Non-extractability is not protection against same-profile key invocation.

## v0.10 local key hierarchy

The [v0.10 contract](V0.10.0.md) adds a random household storage root, HKDF-separated
local-storage/archive keys, and independent credential/recovery KEKs. Root wrappers
are AES-GCM authenticated and bind household/vault, wrapper ID, type and version.
Adding a wrapper never re-encrypts the event corpus. Removing a wrapper prevents
future normal use of that wrapper, but cannot invalidate a copied wrapper plus
secret; compromise requires root rotation and replacement of protected records.
Never permit deletion of the final verified unlock path. Each adult may wrap the
same root; local storage must not become an Alice-only encryption domain.

Every local record, wrapper and archive encryption derives a one-use AES-256 key
from the 256-bit root/credential secret using HKDF-SHA-256 and a fresh random
256-bit salt. Purpose strings are `kin/local-storage/v1`, `kin/local-wrapper/v1`
and `kin/archive/v1`; sync epoch keys remain independent. AES-GCM uses a fresh
96-bit nonce and 128-bit tag. Encoded string-array AAD binds purpose, version,
vault ID, store and record ID; archive metadata is authenticated as well. Retries
reuse committed ciphertext or generate fresh salt/nonce pairs. Decrypted routing
fields must match the public key-path/index fields.

Wrapper updates compare a durable `configRevision`; removal atomically advances
the lock epoch and invalidates previously unlocked capabilities. This prevents a
stale tab from resurrecting a removed wrapper. The independent recovery wrapper
cannot be removed. Lock drops references, clears engine buffers and closes
capabilities, without promising physical memory erasure.

PRF is an optional WebAuthn extension, not a universal passkey property. Use required
user verification, actual credential-associated extension output and domain-separated
HKDF. A normal WebAuthn signature or server session must never serve as a KEK.
Recovery is a deliberately user-held random 256-bit secret, confirmed before
migration and never stored or sent to the server. An encrypted archive plus that
secret supports profile-loss recovery; a secret alone cannot restore absent data.

PRF enrollment/unlock verifies an assertion with the same-origin identity server;
it requires connectivity and surviving server identity. Recovery unlock works
offline. New registration requests opt into PRF, but existing credentials may not
support it. Actual 32-byte PRF output is required, is never sent to the server and
is discarded after wrapping/unwrapping. Multiple supported adult credentials may
independently wrap this installation's root. Each installation has its own local
root; device pairing provisions separate sync epoch keys.

Legacy nonextractable transport keys require the signed successor migration in
[V0.10.0](V0.10.0.md), rather than pretending they can be exported/wrapped. New
transport private serializations and sync epoch secrets are protected by the local
root; no private decryption capability remains outside that protection. Do not
claim the new boundary until legacy epoch CryptoKeys, self-wrapped copies and
agreement keys are removed and migration verification completes.
- Existing canonical event bytes are encrypted directly. Historical placeholder identities remain byte-for-byte intact; a separate signed, encrypted identity-binding control record establishes the authenticated importing identity for v8 replay. No semantic JSON event replacement is used.
- Tests cover roundtrip, wrong keys, metadata substitution, ciphertext/signature/nonce mutation, unsupported/truncated envelopes, nonce variation, sealed-key restore, correct/wrong recipient, expiry, signature tampering, and actual two-trusted-device opaque relay exchange.

Key generation and authenticated encryption use platform Web Crypto. The implementation has no custom cipher, MAC, nonce counter, or password-derived content key.

## Claims boundary

### v0.10.2 local root lifecycle

[Root rotation contract v1](ROOT-ROTATION.md) establishes an independent random
256-bit root, monotonically advances rootVersion, and verifies a new random
256-bit recovery secret before publication. Confirmation is required in the UI;
the secret is never persisted or transmitted. Old recovery and PRF wrappers do
not survive commit. Passkey unlock must be added again with a verified ceremony.
Transport private keys and sync epoch keys are preserved exactly and only their
local outer protection changes.

Manifest format 2 and local-envelope v2 bind `root-version`, its decimal value,
store and record identity in both HKDF info and AES-GCM AAD. Purpose labels remain
the existing explicit local-storage/local-wrapper v1 strings; AAD's envelope
version advances to 2. Root 1 retains the exact published manifest/envelope v1
encoding. KARC framing and archive crypto remain v1; authenticated archive
metadata includes the source manifest/root version.

During staging, the candidate root may encrypt the source root for exact restart
recovery. The reverse bridge never exists. The source bridge and old wrappers are
removed from authority at event publication, and old key rows/stages are removed
before normal access resumes. A copied old wrapper plus secret cannot recover the
new root or decrypt newly protected local records. This cannot recall copied
plaintext, sync keys, old archives or keys captured from an unlocked browser.

Kin implements authenticated local storage, recovery-wrapped encrypted archives and a relay that stores/forwards opaque envelopes. This is not a zero-knowledge claim. The service sees identifiers, timing, counts, ciphertext sizes, membership, cursors, public keys and network metadata; it controls availability and can withhold history. An authorized compromised browser/runtime can read plaintext and invoke keys. The identity service and relay are memory-only. Archives recover local history, not server identity or trust. Do not claim independent security audit, production hardening, anonymity or protection from an unlocked compromised device.

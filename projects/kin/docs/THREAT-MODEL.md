# Threat Model

**Status:** v0.11.7 implementation candidate; awaiting human review. Local authenticated encryption, credential/recovery root wrappers, locked startup, encrypted archives and signed transport-key migration complement encrypted sync. The candidate adds durable service storage, an exclusive service-process lock, and verified service database backup/restore. Independent security audit, cross-browser certification, and general rollback protection are not provided. v0.12 defines lifecycle/deletion and retention, and v0.13 defines recovery/continuity; neither is implemented or certified by this assessment.

## v0.10 local-at-rest boundary

Implemented protection after verified migration: an unauthorized person with persisted browser site data but
without an authorized Kin credential/recovery mechanism cannot trivially recover
household plaintext while Kin is locked. v0.9.3 does not provide this protection:
its canonical events, draft text and usable sync CryptoKeys survive logout.
The [v0.10 record](V0.10.0.md) gates this claim on complete migration, including
outbox duplicates and legacy provisioning/decryption capabilities.

This does not protect a compromised unlocked browser runtime, privileged malicious
extensions, OS malware, resident-key memory forensics, a compromised origin/build,
XSS while unlocked, someone able to satisfy the configured authenticator/recovery
path, or previously authorized devices that obtained plaintext/keys. Removing a
member or wrapper cannot erase copies. Browser garbage collection is not guaranteed
physical memory zeroization. Lock drops references and closes capability paths;
encryption protects persisted content, not a compromised running endpoint.

Ciphertext still exposes sizes, counts and minimal routing identifiers. Complete
site-data rollback cannot be reliably detected without an independent trusted
monotonic witness. Recovery-secret disclosure grants its intended access; loss of
all authorized secrets means permanent data loss. An incomplete migration remains
explicitly unprotected legacy data and must never be labelled securely locked.

Startup loads public security metadata only. Logout/manual lock cancels work,
clears household DOM/drafts and disposes the engine, store and vault. Broadcast
notification locks peers immediately; a durable lock epoch rejects stale storage
and network capabilities even if notification is missed. Wrapper revision checks
prevent stale updates undoing a removal. Old-version tabs must be closed/reloaded
for migration; no application can recall plaintext previously copied by them.

Encrypted archive plus its independently held recovery secret can recover a lost
profile's local history. Restore does not reactivate revoked devices or re-create
server identity; sync stays disabled on the restored household. Losing every
credential/recovery secret permanently loses the ciphertext.

## Assets and boundaries

### v0.10.2 recovery-secret compromise

Explicit recovery replacement generates an independent random root and new
confirmed secret, re-protects every local event/key store, then retires old
recovery/PRF wrappers. Old copied wrapper+secret pairs cannot decrypt records
newly protected under the replacement root. The candidate alone protects the
transitional source-root bridge, which is removed from authority at publication.
This cannot erase copied plaintext, prior archives, sync epoch keys or material
captured in an unlocked runtime. Complete hostile site-data rollback remains
undetectable without an external monotonic witness. Journal/CAS checks reject
stale manifests, competing rotations and foreign vault/root journals through Kin.

Assets include household plaintext (items, handoffs, Talk topics, Pulse), event history, household/member/device identifiers, authentication credentials, device authorization state, encryption keys, pairing-session secrets, and member safety/expectations.

Trust boundaries include the browser UI ↔ Rust/WASM engine, local browser storage, authorized device ↔ sync service, service ↔ database/logs, and one pairing device ↔ another. The service should relay ciphertext, while household content and content keys remain on authorized clients. A compromised authorized client is inside the confidentiality boundary and can expose what it can access.

## v0.9.x threat assessment (historical; local lock added above)

| Threat                                            | Protected                                                                                                           | Partially protected                                                                                                        | Not protected                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Curious-but-honest service operator               | Household event semantics and content keys are not sent to the relay                                                | Household/device/member IDs, event IDs, epochs, timing, counts, ciphertext size, cursors, and membership links are visible | Traffic-pattern inference, availability, or a compromised authorized client    |
| Service database/process compromise               | Relay contains ciphertext only; no plaintext content key                                                            | Persistent routing metadata, public keys, logs, ciphertext and backups can leak                                            | Availability, honest completeness, or hiding metadata                          |
| Passive network observer                          | HTTPS outside loopback plus payload AEAD/signatures                                                                 | IPs, endpoints, packet lengths and timing                                                                                  | Anonymity or traffic analysis                                                  |
| Active network attacker                           | TLS, authenticated sessions, AEAD AAD, device signature, recipient-bound provisioning                               | Denial/delay                                                                                                               | Compromised origin/runtime or availability                                     |
| Malicious/replayed server response                | Signature/AAD prevent envelope substitution; stable IDs/conflicts and persisted cursors detect some replay/rollback | Reordering and withholding may be detected only against locally observed history                                           | First-client completeness or global anti-equivocation/transparency             |
| Revoked trusted device                            | Service rejects its sessions and new epochs exclude it                                                              | It can decrypt keys/ciphertext already held                                                                                | Forgetting prior plaintext/keys or remote erasure                              |
| Stolen locked device                              | Non-extractable device keys and OS lock reduce casual access                                                        | Browser profile access depends on platform/storage implementation                                                          | Hardware-backed protection or a compromised OS                                 |
| Stolen unlocked trusted device                    | Another trusted device can revoke future authorization                                                              | Existing plaintext and usable keys remain accessible until locked/revoked                                                  | Confidentiality during attacker control                                        |
| Malicious household member                        | Authenticated device signature identifies the key-authoring device; adult removal revokes future access             | Member can create valid content as themselves and may retain already provisioned history                                   | Preventing an authorized member from copying or misusing household information |
| Compromised browser/runtime, XSS, build or origin | Nothing cryptographic after code is executing with authorized access                                                | CSP, safe text rendering, dependency minimization reduce risk                                                              | Plaintext/key confidentiality and integrity                                    |
| Lost trusted device                               | Remaining device can revoke it and rotate forward                                                                   | Offline device learns only on reconnect; remaining-device key transfer is required                                         | Erasing downloaded data                                                        |
| All trusted devices lost                          | No server-held plaintext key or hidden escrow exists                                                                | Recovery only if a trusted device/key copy survives                                                                        | Decrypting history when all keys are lost; it may be unrecoverable             |
| Offline conflicting edits                         | Stable IDs, Lamport ordering, deterministic replay and domain validation                                            | Equal-time archive conflict policy is deterministic; intent may still need user review                                     | Inferring human intent or who is right                                         |
| Rollback/replay of old ciphertext                 | Exact event IDs/envelopes, local applied bytes and cursor high-water checks                                         | Relay restart is detectable against local high-water and cached own envelopes are retried                                  | Fresh-device completeness and global rollback detection                        |

The detailed design and guarantees are in [V0.9.0](V0.9.0.md). The following table is the historical v0.8 pairing assessment.

## v0.8 Pairing Threat Notes

| Threat                           | Desired mitigation                                                                                                                                        | Residual limitation                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen server database           | Encrypt event payloads on clients with keys unavailable in plaintext to the service; restrict and encrypt operational metadata where appropriate.         | Routing metadata, ciphertext size, timing, IDs, and backups may remain visible. Encryption design and key recovery need review.                                                           |
| Network observer                 | Standard transport security plus authenticated payload encryption; reject unauthenticated or replayed enrollment/sync requests.                           | Endpoints and traffic patterns may be observable; transport security alone does not hide content from the service.                                                                        |
| Lost or stolen trusted device    | Device screen lock/platform protection, short-lived sessions, remote authorization revocation, and key rotation for future events.                        | An unlocked device or copied plaintext/keys can expose downloaded history; revocation cannot remotely erase a disconnected device.                                                        |
| Unlocked authorized device       | Clear shared-device expectations, local OS protections, and minimize unnecessary retained plaintext.                                                      | Kin cannot protect household information from someone who already has access to an unlocked authorized device.                                                                            |
| Compromised pairing code         | Short expiry, high entropy, one-time use, rate limits, transcript binding, explicit mutual confirmation, and cancellation.                                | A compromised authorized endpoint or a user approving the wrong fingerprint can still enroll an attacker.                                                                                 |
| XSS or malicious script          | No unsafe HTML rendering, no `eval`, strict review of DOM sinks, minimal third-party scripts, dependency minimization, and a strong CSP where compatible. | Script execution in the authorized origin can access rendered plaintext and potentially keys; CSP is defense in depth, not a substitute for preventing XSS.                               |
| Malicious household text         | Treat all user content as data, render with text APIs/DOM construction, validate lengths and encoding.                                                    | Content can still be harmful or upsetting to a human reader; validation is not relationship moderation.                                                                                   |
| Revoked member/device            | Server checks current authorization on each operation; revoke sessions/tokens; rotate content keys for future events.                                     | Revocation does not erase data already downloaded, exported, screenshotted, or remembered. Old ciphertext may remain decryptable with keys already copied.                                |
| Compromised sync service         | Authenticate clients, validate opaque transport envelopes, limit service authority, monitor abuse, protect operational systems.                           | Service may deny, delay, reorder, replay, or withhold ciphertext and observe metadata. Clients must detect integrity/replay conditions where possible; availability cannot be guaranteed. |
| Malicious dependency/build input | Minimize dependencies, pin/review updates, protect build/release process, avoid remote scripts.                                                           | A compromised browser, build tool, dependency, or distribution channel can undermine client-side protections.                                                                             |

## Metadata and anonymity

The relay sees household/member/device/session identifiers; event IDs; per-device sequence; key epoch; cursors; public device keys; ciphertext and wrapped-key sizes; event counts/timing; provisioning grant participants/expiry; revocation and rotation timing; IP and connection metadata. Encrypted payloads hide semantic event kinds, text, titles, descriptions, categories, and entity identifiers. Traffic patterns and which devices share a household remain observable. Kin does not claim anonymity or zero-knowledge service behavior.

## Security principles

- Assume household text and imported/persisted bytes are untrusted.
- Use standard cryptographic APIs and reviewed protocols; never custom cryptography.
- Minimize server knowledge and third-party script/dependency exposure.
- Fail closed on unsupported protocol versions, invalid authentication, and tampered envelopes; do not silently skip unknown content.
- Provide honest recovery and deletion behavior; do not promise recovery if all authorized keys are lost.
- Security claims require implementation, threat review, and validation, not documentation alone.

## Remaining Limitations

The incubation service stores identity and relay records in memory. Full restart loses household identity, sessions, pairing state, relay envelopes and cursors; surviving local encrypted history cannot alone resume that household's sync. A relay-only reset is detected against local high-water and exact cached envelopes are requeued when identity survives. Encrypted archive restore recovers local data only. There is no transparency witness, pre-join history grant for new adults, server-identity recovery or remote erasure. Missing epoch keys pause sync. Wrapper removal alone cannot invalidate a copied wrapper plus its secret; explicit root replacement in v0.10.2 protects newly re-encrypted local data, while prior copies remain exposed. New runtime private keys are imported nonextractable, but that is not hardware-backed storage. A compromised unlocked runtime defeats confidentiality. Independent security review and production operational hardening remain required.

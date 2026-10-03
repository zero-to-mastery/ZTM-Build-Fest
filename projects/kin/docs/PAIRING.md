# Pairing and Device Enrollment

**Status:** v0.11.7 implementation candidate; awaiting human review. Manual adult and same-member device pairing use one-time codes, passkey claim/approval/activation, locally generated device keys and compared fingerprints. A queued signed device-key successor completes before pairing/provisioning proceeds. Private transport material is available only while the local household is unlocked. Pairing codes, claims and ceremony flows remain process-local and are cancelled by restart; identity and trusted-device authority are durable in the candidate. Local encrypted archive restore does not restore device trust.

## Distinct operations

Inviting another household member changes household membership. Adding a device authorizes another installation for an existing member. They are separate operations with different confirmation and recovery requirements.

## Invite a household member

```text
Member A authenticates
        |
        v
Create household
        |
        v
Start invitation session
        |
        v
Display short-lived pairing code or invitation URL
        |
        v
Member B scans or enters code
        |
        v
Both verify the same pairing session
        |
        v
Member B accepts and creates a passkey
        |
        v
Authorize Member B's device and enroll its key
```

The pairing invitation must not itself be a durable login credential or contain the household encryption key in plaintext. It carries only the minimum short-lived session material required to authenticate a secure enrollment exchange.

## Pairing session requirements

- Generate an unpredictable, high-entropy, single-use secret; store only a verifier server-side if a server is involved.
- Expire quickly (for example, within a few minutes); show a visible countdown and require the inviter to explicitly restart after expiry.
- Bind acceptance to the intended household, inviter, recipient device, and one pairing-session ID.
- Consume the code atomically on successful acceptance. A second submission or replay is rejected.
- Rate-limit guesses and return a generic failure that does not disclose household/member existence.
- Allow either person to cancel. Cancellation, expiry, or failed verification invalidates the session and any derived ephemeral secret.
- A scan alone must not add a member, authorize a device, or disclose prior household content.
- If a code is entered on the wrong or accidental device, either side can cancel; no membership or key access is granted before both sides confirm.
- Bind confirmation to the exact key-exchange transcript. Both devices should show matching human-readable verification information (such as a short fingerprint/word sequence derived using a standard protocol) before approval. The representation and usability must be security-reviewed; it is not an ad hoc cryptographic primitive.
- Show the inviter and invitee which household and member/device are being added, and require clear confirmation from both.

The v0.8.6 implementation uses a ten-minute Pending invitation and starts a separate fifteen-minute approval window after a successful claim. It validates a code before returning WebAuthn registration options. v0.9 adds recipient-bound provisioning and encrypted sync; see [V0.9.0](V0.9.0.md).

Household capacity is derived from active membership records at both invitation creation and final approval. An inactive historical member does not consume one of the two active-adult slots, but remains stored; a full household cannot create an invitation or approve an in-flight claim.

## Add a device for an existing member

```text
Existing member authenticates on an authorized device
        |
        v
Choose “Add this member's device”
        |
        v
New device presents a short-lived enrollment request
        |
        v
Existing device verifies the request and new-device fingerprint
        |
        v
Member confirms on the existing device
        |
        v
New device authenticates with a member credential
        |
        v
Authorize device and provision its household-key access
```

This flow does not create another member. It requires proof of the existing member's authority, binds the locally generated device key to that member/device, compares the fingerprint on both devices, and separately provisions household key epochs. Same-member devices receive retained history. If no authorized device remains, there is no recovery path; possession of an old pairing code is not recovery.

## Revocation

A member should be able to inspect trusted devices and revoke a specific device through an understandable control such as:

```text
Settings
→ Household
→ Trusted devices
→ Revoke device
```

Revocation immediately marks the device unauthorized at the service, invalidates its sessions, and prevents future uploads/downloads. It reserves a new household key epoch; remaining active devices must complete recipient-bound provisioning before sync resumes. Offline events produced by a revoked device are rejected and cannot silently re-enter the household.

Revocation cannot erase plaintext, screenshots, exports, or encryption keys already copied to a lost/compromised device. New events use the accepted new epoch; historical events are not re-encrypted. Remaining trusted devices retain historical keys. A missing key or unavailable active device pauses sync; no server escrow or retroactive erasure is provided.

Member removal and device revocation are different actions. Removing a member must revoke that member's devices and initiate key rotation, but still cannot reclaim data already downloaded.

In v0.8.6, removing another adult requires a fresh passkey assertion bound to the actor, current trusted device, and target member. A session or confirmation dialog alone is insufficient.

## v0.9.x Device-Key Record

The joining device generates separate non-extractable P-256 ECDH/ECDSA keys locally and persists them in the browser key store. It sends only public JWKs during claim. The joining device computes its fingerprint locally; both devices compare the inviter and claimant fingerprints before approval/activation. After fresh passkey approval, the inviter signs a certificate binding the target household/member/device IDs and public keys. Clients verify issuer signatures against locally pinned roots or a manually compared legacy-device key before trusting a directory entry. A changed key or invalid chain blocks sync/provisioning. Key packages are encrypted to the verified recipient ECDH key and signed by the sender; the service stores wrapped bytes only. Same-member devices receive all retained epochs; new/replacement adults receive only current/future epochs. The v0.11 candidate persists service identity and relay state. A separate service-database backup can restore that authority; local archive restore cannot. Process restart cancels active pairing/login ceremonies and expires sessions, so trusted devices must reauthenticate with a passkey.

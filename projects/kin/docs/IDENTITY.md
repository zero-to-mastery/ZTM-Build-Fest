# Identity and Trusted Devices

**Status:** v0.11.7 implementation candidate; awaiting human review. Server member/passkey/device authorization remains distinct from the local encryption unlock. v0.10 protects successor transport private keys and epoch secrets under the local root while retaining public verification history. The candidate persists server identity and device-token verifiers; raw tokens and sessions remain ephemeral. An encrypted local archive restores local history, not an authenticated server household.

## Separate identities

```text
Household
├── Member A
│   ├── Credential A1
│   ├── Device A1
│   └── Device A2
└── Member B
    ├── Credential B1
    └── Device B1
```

The initial multi-device target is one household, two adult members, and multiple trusted devices. Child accounts, extended-family roles, teams, organizations, admin panels, and complex RBAC are out of scope.

| Concept    | Identity                 | Meaning                                                                                                                     |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Household  | `household_id`           | Stable opaque ID for one private coordination space and its event stream.                                                   |
| Member     | `member_id`              | Stable opaque ID for a person. It survives device replacement and credential rotation.                                      |
| Device     | `device_id`              | ID for one application/browser installation authorized to act for a member. A reinstall or replacement is a new device.     |
| Credential | credential ID/public key | An authenticator used to prove control of a member account, likely a passkey. It is not a household key or device identity. |

Events carry household, actor/member, and originating device IDs as specified in [EVENTS](EVENTS.md). IDs are references, not secrets or proof of authorization. In v0.1.0 all are local placeholders; no identity in that version asserts a verified human or remote household.

## Membership and lifecycle

Membership is an explicit relation between a household and a member, not inferred from possession of a device or from event authorship. Conceptual states are invited, active, and removed. Creation, acceptance, and removal must be explicit, attributable events with defined authorization before implementation. Removal blocks future household access but cannot retract data already learned or copied.

The planned first shared household has exactly two active adult-member slots. Removed members remain historically represented but inactive and do not consume a slot, allowing the remaining adult to pair a replacement. Kin does not infer family relationships, rank members, or assign contribution scores. A member may have multiple devices and credentials; removing one device must not silently remove the member.

## Passkey direction

Prefer passkeys through WebAuthn over email/password as the primary authentication experience. The intended interaction is:

```text
Open Kin
   |
   v
Face ID / fingerprint / device PIN
   |
   v
Household view
```

The authenticator's local biometric/PIN operation is handled by the platform; Kin should not collect a biometric or device PIN. Passkeys authenticate a member to the service. They do not automatically encrypt household data, create a household key, identify a particular installation, or provide a general-purpose key-agreement API. Those require separate reviewed key and device protocols.

v0.1.0 had no login. The v0.8.x incubation line supports one passkey per member. v0.9 adds a same-member device-pairing flow with a separate credential per trusted device; account credential replacement remains unsupported. Device-specific keys are generated locally and the existing member approves the device fingerprint before its keys are provisioned.

## Device authorization

A device is trusted only after explicit enrollment by an active member through the pairing flow. The device has its own ID and device key material, separate from the member's credential and household content key. Each accepted event records its originating `device_id` for later sync and audit context; this must not become a covert activity feed.

Conceptual device states are pending, authorized, and revoked. Each enrolled sync-capable device locally generates separate non-extractable P-256 ECDH and ECDSA private keys. The service stores only public JWKs and a SHA-256 fingerprint. During pairing the joining device compares its locally computed fingerprint with the inviter's displayed value; approval is blocked on mismatch. Passkeys never supply or derive content keys.

Only authorized devices may submit or receive encrypted household events. Device revocation and member removal immediately invalidate target sessions and reserve a new household epoch; the remaining trusted devices must provision that epoch before sync resumes. A revoked device receives no later epoch, but keeps any old plaintext/key it already possessed. See [Pairing](PAIRING.md), [Sync](SYNC.md), and [V0.9.0](V0.9.0.md).

An open browser checks authorization on focus/return and every 30 seconds while visible. Once the service can be reached, a revoked session clears its session cookie and a removed/revoked device also clears its device cookie; the UI stops sync and shows the signed-out state while retaining local household data. A disconnected device cannot learn of revocation until it reconnects or returns to the service.

Historical key entitlement is explicit: a new device for an existing member can receive retained history; a newly joined/replacement adult starts at its membership-time/current epoch and later epochs. v0.9.x does not grant pre-join epoch keys. Kin has no encrypted snapshots, so earlier shared history remains unavailable rather than being reconstructed from plaintext server state.

## v0.8.6 existing-member reauthentication

Bootstrap and claim activation set a separate opaque `kin_device` cookie whose hash is bound to the server-side device record. Logout invalidates and clears only the session cookie. Login options are limited to that trusted device's member credentials; after a valid assertion, the service issues a new session and rotates the device token. A missing or revoked device token, removed member, or unrelated credential is rejected. A passkey alone does not silently trust a new browser.

## v0.1.0 boundary

The first coded release uses local household, actor, and device placeholders only. No account, passkey, membership, pairing, authorization, remote session, or multi-device behavior is implied.

## Forward platform gates

The v0.11 implementation candidate persists membership, credential,
trusted-device, revocation and coordination state across restart without
changing the service into a plaintext household authority. The v0.13 line must
define replacement-device and household recovery against current membership,
deletion and revocation state. It remains planned; see [ROADMAP](ROADMAP.md)
and the [v0.11](V0.11.0.md)/[v0.13](V0.13.0.md) contracts.

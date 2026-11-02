# Pairing and Device Enrollment

**Status:** Current as of v1.6.0, including invitations by QR code (#97) and phone-approved computer sign-in (#98) below. Manual adult and same-member device pairing use one-time codes, passkey claim/approval/activation, locally generated device keys and compared fingerprints. A queued signed device-key successor completes before pairing/provisioning proceeds. Private transport material is available only while the local household is unlocked. Pairing codes, claims and ceremony flows remain process-local and are cancelled by restart, except prepared invitations (#613, below), whose codes survive it; identity and trusted-device authority are durable. Household deletion discards household pairing/claim flows immediately and invalidates devices at finalization. Local encrypted archive restore does not restore device trust.

## Distinct operations

Inviting another household member changes household membership. Adding a device authorizes another installation for an existing member. They are separate operations with different confirmation and recovery requirements.

Before either QR or manual-code UI appears, Kin distinguishes **Invite
another person** from **Add my device** and states whether a new member ID will
be created. An authorized inviter chooses the recipient's role under Household
access before any invitation is created, so the People & devices entry point
never silently defaults to Adult. Adding your own device uses the existing
same-member endpoint and never creates another member. Both the code's creator
and the joining device keep the chosen path visible through approval and
activation, and a code whose real purpose contradicts the path the person
chose cannot be activated until they acknowledge the switch (#219, #223). Back
or Cancel grants nothing. Platform, offline, migration and
accessibility evidence is tracked in
[Member and Device Identity Acceptance](IDENTITY-PAIRING-ACCEPTANCE.md).

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

The joining device sends its automatic name ("Chrome on iPhone") with its
claim, so the approver can tell which device is asking; nobody types a name
while pairing. The server stores only automatic names (#71). A member can give
the device a nickname later in Trusted devices, where it stays encrypted
([Identity](IDENTITY.md#device-names)).

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

The v0.8.6 implementation uses a ten-minute Pending invitation and starts a separate fifteen-minute approval window after a successful claim. It validates a code before returning WebAuthn registration options. v0.9 adds recipient-bound provisioning and encrypted sync; see [V0.9.0](planning/V0.9.0.md).

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

This flow does not create another member. It requires proof of the existing member's authority, binds the locally generated device key to that member/device, compares the fingerprint on both devices, and separately provisions household key epochs. Same-member devices receive retained history. Possession of an old pairing code is not recovery.

**Without another device (#568).** A member with an account vault doesn't need an authorized device present: they sign in on the new device with their password (or passkey), open the vault there, and the device certifies itself with the member's certification key, which one of their own devices endorsed earlier (CRYPTOGRAPHY, "Certification key chain"). The household's devices accept that certificate as they accept an approval by that member's device. The device can also replace one of the member's devices, revoking it in the same step (RECOVERY, "Signing in on a new device"). Pairing as above stays available and unchanged; it remains the only way for a member who has no vault yet.

## Invite by QR code (v1.1, #97)

A waiting invitation also shows a QR code. It adds a way to carry the code, not
a way around any gate.

```text
Adult creates an invitation (as above)
        |
        v
Invitation screen: QR code + the typed code, Copy and Share
        |
        v
Joining device opens /pair#code=… (camera app) or scans it in Kin
        |
        v
Join screen with the code filled in (nothing is claimed yet)
        |
        v
Joining person creates a passkey; fingerprints compared; Adult approves
```

- **The code stays in the fragment.** The QR code and Share carry
  `/pair#code=F7KM-Q2DX`. Browsers never send a fragment to a server, so the
  code can't reach a request URL, a server log or a `Referer`
  (`Referrer-Policy: no-referrer` is set as well). Kin takes the code out of
  the address as the app loads and resets the address to `/pair`; a code in a
  query (links from before #97) is removed and not used, because it has
  already travelled to the server (`web/pairing-link.js`).
- **Opening or scanning fills the field, nothing more.** The person still
  checks the code, creates a fresh passkey, and an Adult still approves after
  both compare fingerprints. A device that is already a member drops the code
  and says so.
- **Shown only while it can work.** The QR code appears only while the
  invitation is Pending and before its expiry, and goes once it is claimed.
  An expired or revoked invitation shows "This invitation ended", never a
  stale code.
- The typed code, Copy and Share stay beside the QR code, so a person who
  can't scan has the whole path.

## Set up Kin for someone (#612–#615)

A household admin can prepare an invitation for one person and hand it over
as a printed sheet or a link ([ADR 0021](decisions/0021-kin-for-everyone.md)
§4). It is a new-member invitation with the same gates; the differences:

```text
Admin: People & devices → Set up Kin for someone
   (their name, who they are, easy mode, the helper's name, a note, 1–7 days)
        |
        v
Admin's device seals the card (names, note) under a fresh key;
service keeps a prepared invitation (schema 27) with the card
        |
        v
QR code / link  /pair#code=F7KM-Q2DX&k=<card key>   +  "How to open Kin" sheet
        |
        v
Her device: "Hi Rose — your family set this up for you" → password
   (easy mode already on) → claim with a password
        |
        v
"Waiting for Mikey to say yes" — her device shows its code
        |
        v
Mikey compares that code with his screen and approves with a fresh
passkey or password (in person: side by side)
        |
        v
Her device: "Mikey said yes. Does this code match the one on his screen?"
   → Yes → Today in easy mode
```

- **Lifetime.** 1, 3 or 7 days (the service accepts 1 to 7), single-use, at
  most three waiting per household. Unlike every other pairing it survives a
  restart: the service keeps it in `prepared_invitations` and deletes the row
  once the code stops working. A claim is still process-local; a restart while
  she waits ends the claim and the code works again.
- **Its claim waits a day** for approval (an ordinary claim: 15 minutes), so
  the helper can answer later. The helper finds it under People & devices →
  "Invitations you set up" ("Rose is asking to join" → "Check and say yes").
- **Other invitations.** Making an ordinary invitation, adding a device,
  replacing one or recovery still end the household's other pending
  pairings, but never a prepared invitation, and a prepared invitation ends
  none of them.
- **The link** carries the card's key as `k` beside `code` in the fragment
  (`web/pairing-link.js`), taken out of the address as the app loads. Kin's
  own scanner reads only the code from it. Typing the code works without the
  key: the join screen asks for the name, and the invitation's easy mode
  still applies.
- **What the service says to a code's holder.** `POST /api/account/invitation`
  answers a prepared code with `prepared: { memberKind, easyMode, card,
  expiresAt }`. The card opens only with the link's key
  (`web/security/prepared-card.js`).
- **Approval** is unchanged: the inviter approves with a fresh confirmation
  after comparing the joining device's fingerprint, the inviter's device
  signs its certificate, and the joining device compares the inviter's
  fingerprint before it finishes. **There is no unattended pre-approval**:
  see THREAT-MODEL, "Prepared invitations".

## Sign in on a computer with your phone (v1.1, #98)

A member already signed in on a phone signs a computer in by scanning the
computer's QR code and approving with a passkey. The computer finishes by
typing a 6-digit code shown on the phone.

```text
Computer: Sign in with your phone
        |
        v
Computer makes its keys and a link request; shows a QR code
        |                 (/link#r=<request>&s=<secret>&f=<fingerprint>&c=<nonce>)
        v
Phone: People & devices → Add a computer → Scan
        |
        v
Phone shows the computer's automatic name, "you", and the warning
        |
        v
Phone approves with a fresh passkey (and signs the device certificate)
        |
        v
Phone shows a random 6-digit code (2 minutes); it sent the service the
code and a tag binding its key to the code and the QR nonce
        |
        v
Computer types the code → service releases the approver and the tag →
computer checks the tag, pins the phone's key → signed in →
phone says Done and provisions keys
```

**Gates, in order:**

1. **Request.** The computer generates its device keys locally and asks the
   service for a request with its public keys and its automatic name
   (`POST /api/link/requests`, unauthenticated). The service keeps a SHA-256
   verifier of a 256-bit secret, never the secret, and chooses the computer's
   device ID. Requests last 2 minutes. Every request counts against the
   client's limit (12 a minute), a client holds at most 4 live requests, and
   the service holds at most 512 in all.
2. **Scan.** The QR code carries the request ID, the secret, the key
   fingerprint and a 16-byte nonce, all in the fragment. Kin's scanner accepts
   only a `/link` for its own origin. The phone sends the secret and the
   scanned fingerprint in request bodies only; the nonce never leaves the two
   devices. A sign-in link opened in a browser instead (a phone's camera app)
   is dropped from the address at once, and explained on a device that is
   signed in.
3. **Approval.** Only an Adult's session on a trusted device approves, the same
   rule as adding a device. The scanned fingerprint must match the keys the
   service holds, or the request ends. Approval needs a fresh passkey
   assertion bound to the request and the member. For a new computer the phone
   checks the keys against the fingerprint itself, signs the device certificate
   with its own device key and pins the computer's key. Failures count against
   the member's limit.
4. **Code.** The phone picks the 6-digit code at random and sends it with its
   approval, along with a tag: HMAC-SHA-256 keyed by
   SHA-256(`kin-link-key-v1|nonce|code`), over the request ID, the phone's device ID and key fingerprint,
   and the computer's fingerprint (`linkTag` in `web/device-link.js`). The
   service keeps only the code's hash and the tag, and its status says
   nothing about the approver. The code works for 2 minutes, three wrong tries
   end the request, and it reaches only the computer in front of the person,
   so a QR code shown somewhere else can't be completed.
5. **Completion.** A correct code releases which device approved, its
   fingerprint and the tag. The service checks again that the member is
   active, the phone is still trusted and the household isn't being deleted,
   and, for a new computer, that the household is under its 16-device limit. Tokens go out
   only as cookies. The computer checks the tag with the QR nonce and the
   code the person typed, then checks the directory's copy of that phone's
   key against the fingerprint and pins it, so its first sync can verify the
   household from that phone. If either check fails it signs itself out.

**Two results** ([Identity](IDENTITY.md#signing-in-with-a-phone)):

- **A new computer** becomes a trusted device of the approving member and
  receives retained history, like a device added with a code. The phone syncs
  once the computer finishes, which provisions the household's keys for it.
- **A computer already trusted for that member** offers its existing device's
  keys. When its device cookie names that device with those keys, the service
  says it is returning, and completing gives it a new session and a rotated
  device token, as after a passkey login. Approval as anyone else, or of keys
  any device already has or had, is refused: two devices never share keys.
  "Sign in as someone else" on the computer then starts again with fresh keys
  (a shared computer).

**Either side ends it.** Cancel or Back on either device, starting again,
Kin locking, or closing the page on the computer ends the request with the
service; moving to another view in Kin doesn't, and it then ends when it
expires. Requests are
process-local, like pairings, and end when the service restarts. Errors about
a request are generic: an unknown, expired, cancelled or used request, and a
wrong secret, all look the same. A fingerprint mismatch, a computer already
set up for another account, a code before approval and a wrong code each say
so.

**Audit.** `device_link_requested`, `device_link_approved`,
`device_link_completed`, `device_link_failed` (with a reason) and
`device_link_rate_limited`, plus `device_trusted` for a new computer, hold IDs
and outcomes only. Approval, completion and any end after approval are saved
with the household, except for a household being deleted. A request that was
never approved belongs to no household, so its events stay in the service's
in-memory log.

**Limited and Temporary members** can't approve, as they can't add devices.
A computer that is already theirs signs back in with their passkey, and an
Adult adds a new one.

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

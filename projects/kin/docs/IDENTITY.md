# Identity and Trusted Devices

**Status:** Current as of v1.6.0. Server member/passkey/device authorization remains distinct from the local encryption unlock. The service persists identity and device-token verifiers; raw tokens and sessions remain ephemeral. Household deletion is a separate lifecycle and an encrypted local archive restores local history, not an authenticated server household.

## Placeholder identities and bindings

A household starts local-only, so its first events carry locally generated
placeholder household, actor and device IDs inside their canonical bytes.
Enabling sync never rewrites those bytes. Instead a signed, encrypted binding
maps the exact placeholder tuple (`legacyHouseholdId`, `legacyActorId`,
`legacyDeviceId`) to the authenticated household, member and device, and
every protocol-24 replay of that history applies it ([ABI](ABI.md)). The
"legacy" names refer to pre-sync placeholders, not to an old format: removing
them would make every household created before pairing unreplayable after
sync. The refactor track's protocol reset (Slice 2) therefore keeps them.

## Separate identities

The identity-presentation contract requires the stable member ID to remain the
authority and treats an optional preferred name only as presentation.
“You” identifies the signed-in member; “This device” identifies the active
installation. Neither label, a preferred name nor a device name may change
permissions, event authorship or push filtering. Existing members without a
preferred name keep a deterministic fallback and are never forced to rename
([Preferred member names](#preferred-member-names)). See the cross-platform contract in
[Member and Device Identity Acceptance](IDENTITY-PAIRING-ACCEPTANCE.md).

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

The initial multi-device target was one household, two adult members, and multiple trusted devices. Households now have up to four Adults, Limited members (children/teens), and expiring Temporary members (babysitters, caregivers, guests). A server-recorded household admin flag on Adults governs membership and shared settings; see [HOUSEHOLD-IDENTITY-DEFAULTS.md](HOUSEHOLD-IDENTITY-DEFAULTS.md#authority). Extended-family roles, teams, organizations, and general RBAC remain out of scope.

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

Household lifecycle is `active → deletion_pending → deleted`, distinct from
domain archival, member removal and device revocation. Either active adult may
request deletion after a fresh passkey assertion; both adults are not required.
The service immediately rejects household writes and invalidates sessions,
then permits either active adult to cancel for 30 days with a fresh passkey on
a trusted device. Final deletion purges membership, credential and device
authorization records and cannot be cancelled or recovered. A minimal server
tombstone prevents this database from reviving an older household backup.
Existing local data and exports are not remotely erased. See
[V0.12.0](planning/V0.12.0.md) for authorization and restoration limits.

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

## Username and password sign-in (#557, #558)

Since [ADR 0018](decisions/0018-account-key-vault.md) the first run signs a
member up with a **username and a password** instead of a passkey; a passkey
is offered later (#560, below), never at sign-up. The passkey
paths above are unchanged and stay one tap away ("Set up with a passkey
instead").

- **Usernames** are unique among the service's active members,
  case-insensitive, and stored in normalized form with the member
  (`members.username`, server schema 23): NFKC, trimmed, lower-cased, 3 to 32
  ASCII letters, digits, dots, dashes or underscores
  (`web/security/account-credentials.js`, used by both the browser and the
  service). A removed member's username can be chosen again. A claim waiting
  for approval holds its username until it ends.
- **The password never reaches the service.** The browser derives `authKey`
  and `passwordKey` from it (CRYPTOGRAPHY, "Password keys") and sends only
  `authKey`; the service stores Argon2id(`authKey`) and the PBKDF2 salt and
  iterations (`account_passwords`).
- **Creating a household** (`POST /api/account/bootstrap`) and **accepting an
  invitation** (`POST /api/account/claim`) take `{ username, authKey, salt,
  iterations }` in place of a passkey registration. Both keep their existing
  limits (household creation per client, pairing-code attempts per client).
  A password claim is for a **new member only**: adding a device to an
  existing member, replacing one and member recovery still use a passkey.
- **Joining still needs the inviter's approval.** The joiner's device key and
  fingerprint comparison, the inviter's device certificate and the approval
  are exactly as before; only the joiner's credential differs. An approved
  password claim is activated with `POST /api/claim/activate/password`
  (`authKey`) instead of a passkey assertion.
- **Signing in on a trusted device** (`POST /api/login/password`): the
  `kin_device` cookie names the device, and the username and `authKey` must
  match its member. A success issues a session and rotates the device token,
  as a passkey login does. Every failure (wrong username, wrong password, a
  member without a password) gets the same message and the same Argon2id work
  (a decoy verifier stands in), so neither the answer nor its timing says
  whether a username exists. Failures are limited to 10 per 15 minutes per
  member, per device and per client address; past that even a correct
  password waits. Unlocking with the password signs the device in this way,
  so household actions don't ask again.
- **A sign-in without a device cookie** (a new browser, #568): see "Signing
  in on a new device" below. Pairing from another device works as before.
- **Fresh confirmations.** Actions that need "a fresh passkey" (approving a
  device or a member, signing in a computer, revoking a device, removing a
  member or leaving, household admins, Simple view, chat and fridge access,
  deleting the household and cancelling that) accept a **fresh password
  re-entry** from a member who has no passkey yet: the options response then
  carries `password: { username, salt, iterations }` and the finish request
  `authKey`. A member with a passkey always uses it, exactly as before, and
  an `authKey` is no substitute for it. THREAT-MODEL records this as weaker
  than a passkey until one is added.
- A household needs a usable admin; an admin who signed up with a password
  counts as one (they can confirm freshly).
- `GET /api/claim` reports `signIn: "password" | "passkey"` so the joining
  device knows how to finish. `POST /api/account/username` answers whether a
  username is free (30 checks per client address in 15 minutes) and
  `POST /api/account/invitation` checks an invitation code before a password
  is chosen (the pairing-code limit).

## A member set up by someone else (#612–#615)

A household admin can prepare Kin for one person ("Set up Kin for someone",
[ADR 0021](decisions/0021-kin-for-everyone.md) §4). Identity is the same as
for any invited member; what differs is who types what:

- **Who they are** (Adult, Limited or Temporary, with a Temporary end) is
  chosen by the admin and recorded with the prepared invitation, exactly as an
  ordinary invitation's kind; the member limits are checked when it is made
  and again at approval.
- **Their name** is typed by the admin and travels in the invitation's sealed
  card, which only the link opens. Once she has joined, her own device records
  it as her preferred name (event 51, as "Set my name" does), so the name is
  hers to change, and the service never learns it.
- **Their username** is offered by Kin from her name with four digits
  (`rose.4821`, `web/security/prepared-card.js` `suggestUsername`); she can
  change it, and the usual rules and uniqueness apply. Her password, its
  strength floor and the account vault are as for any password sign-up.
- **Easy mode** is turned on on her device from the invitation before she
  sets her password, and her synced settings carry it from her first private
  change (ADR 0019), so her other devices open in easy mode too. It is a
  presentation she can turn off, not a restriction.
- **Approval** is the inviter's, with the fingerprint comparison, as for every
  member (PAIRING, "Set up Kin for someone").

## Signing in on a new device (#568, #569, #570)

A member signs in on a browser that has no `kin_device` cookie and no local
household, and the browser becomes one of their trusted devices, with no
other device's approval (ADR 0018 section 4; RECOVERY, "Signing in on a new
device"). Routes (`server/pairing-service/new-device.mjs`):

| Route | What it does |
| --- | --- |
| `POST /api/account/sign-in/parameters` `{ username }` | The PBKDF2 salt and iterations for that username (a stable made-up salt for an unknown one). 30 per address per 15 minutes. |
| `POST /api/account/sign-in/password` `{ username, authKey }` | The usual password check and limits, then a **new-device capability** in the HttpOnly cookie `kin_new_device` and its view: method, expiry, member, the device ID this browser will get, the member's trusted devices (ID, automatic name, date) and the household's device count and limit. |
| `POST /api/account/sign-in/passkey/options` / `…/finish` | A passkey sign-in (WebAuthn, user verification, PRF input per passkey from the vault's passkey wrappers), or the passkey step of require-both. |
| `POST /api/account/sign-in/vault` | With the capability: the sealed vault, the one wrapper this sign-in opens, and the member's certification-key endorsement. |
| `POST /api/account/sign-in/device` `{ syncPublicKeys, certificate, replaceDeviceId?, deviceLabel, vaultEpochs }` | Spends the capability: checks the version 2 certificate against the endorsement, revokes `replaceDeviceId` (one of the member's own active devices) in the same transaction, checks the trusted-device limit after that, trusts the device with same-member history and the vault's epochs recorded as provisioned, starts a key rotation, and issues a session and `kin_device`. |
| `POST /api/account/sign-in/backup-code` `{ username, codeAuth }` | The third way in (#572): `codeAuth` is HKDF of the backup code; the service compares SHA-256 of it with the check value kept beside the backup-code wrapper, in constant time, charged and limited like a password. A capability whose registration must set a new password. |
| `GET /api/account/sign-in`, `POST /api/account/sign-in/cancel` | The capability's view; ending it. |
| `PUT /api/account/certification` `{ endorsement }` | A trusted device endorses its member's certification key (CRYPTOGRAPHY, "Certification key chain"). |

**Which sign-in opens the vault** is decided by the service from the vault's
wrapper types (ADR 0018 D3/D4): the password alone while there is a
password wrapper and no passkey wrapper; once a passkey wrapper exists, only
the passkey; with "require password and passkey" (a password-passkey
wrapper and no passkey-only one), the password first and then the passkey.
The backup code always works, and its sign-in opens the backup-code
wrapper. A member without a vault, or whose certification key isn't endorsed
yet, is told to add the device by pairing instead.

`POST /api/account/sign-in/device` after a backup-code sign-in also carries
`newPassword: { salt, iterations, authKey }` (required; `new_password_required`
without it) and `vaultChange: { put, remove }`: the member's password is
replaced and the vault's password wrappers are re-wrapped under it (combined
password-and-passkey wrappers are removed) in the same transaction that
trusts the device. The audit log records `password_reset`.

## A passkey, the password and the backup code for an account (#560, #571)

A member with a password account manages how it opens under **Security**
(and is offered the first two calmly on Today; UX). Every change needs the
current password (`currentAuthKey`, checked fresh with the password limits)
and is one request (`server/pairing-service/account.mjs`, `server.mjs`):

| Route | What it does |
| --- | --- |
| `GET /api/account/security` | The session's member: username, whether they have a password and its current salt and iterations, their passkeys' credential IDs, since when they've had a device, and their vault wrappers (IDs, types, versions, public parameters and update times; no wrapped keys, no backup-code check value). Not counted as a vault download. |
| `POST /api/account/passkeys/options` `{ currentAuthKey }` / `…/finish` `{ flow, credential }` | Registers a passkey for the signed-in member (WebAuthn registration with user verification; the passkey is named for the username). From then on the member's admin-only actions ask for a passkey, not the password. |
| `POST /api/account/vault/wrappers` `{ currentAuthKey, put, remove }` | Removes and adds vault wrappers in one transaction, if the resulting set keeps the wrapper-set rules (`vault_wrapper_rules`; CRYPTOGRAPHY). Adding a passkey's wrapper removes the password-only one; "require password and passkey" swaps the passkey wrapper for a combined one and back; a new backup code replaces the old. |
| `POST /api/account/password` `{ currentAuthKey, salt, iterations, authKey, vaultChange? }` | A new password: the new Argon2id verifier and the re-wrapped password wrappers in one transaction (`password_changed` in the audit log). |
| `POST /api/account/passkeys/remove` `{ currentAuthKey, credentialId, vaultChange? }` | Removes one of the member's passkeys (#592 follow-up): the vault wrappers that named it (and, for the last passkey, a password wrapper back) and the service's record of it, in one transaction (`passkey_removed`). Never the last way in: a member without a password keeps one passkey (`last_way_in`), and the vault keeps a wrapper a password or passkey opens. |
| `PUT` / `DELETE /api/account/vault/wrappers/<id>` | One wrapper at a time, after the same fresh confirmation: `currentAuthKey`, or `{ flow, credential }` from `POST /api/account/confirm/options` (a fresh assertion of the member's own passkey); otherwise `fresh_auth_required` (401). |
| `POST /api/account/migrate/options` / `…/finish` `{ flow, credential, username, salt, iterations, authKey }` | Moves a member set up the old way to an account (#575): a fresh assertion of their own passkey, then their username and password (`account_migrated`). Refused once they have a password (`account_exists`) and for Temporary members (`account_unavailable`). |

**Moving an existing member to an account** (#574/#575): a member who set
Kin up with a passkey and a per-device backup key, before accounts, is
invited on the next unlock (a calm Today card, and **Your account** under
Security; never forced) to choose a username and password. One touch of
their passkey confirms it and, where the passkey supports PRF, gives the
vault its passkey wrapper, so they never have a password-only one and their
next device signs in with the passkey alone; without PRF, the password
opens the vault. The device then makes the vault from the household and
chat keys it holds and a new certification key, endorses that key, and
adds a password unlock beside its passkey and backup key. A device of a
member who moved on another device offers **Use my account here**: the
password (and, if the vault only opens with a passkey, one touch of it)
gives this device the vault key too. Every step resumes after an
interruption. Members who decline keep using Kin exactly as before. The
per-device backup keys keep working; once the member has a backup code,
Security says they're no longer needed (#576).

**Removing a passkey** (#592 follow-up): under Security, each passkey has
**Remove this passkey**, after the password; the last one's going puts the
account back in the password-only stage.

**Adding a passkey** (#561): after the password, the browser registers the
passkey, takes two PRF outputs from it (from the registration where the
authenticator gives them, otherwise from one more assertion), sends the
passkey's vault wrapper and removes the password-only one, then adds passkey
unlock to this device. Once added, **the passkey alone signs in on a new
device** (ADR 0018 D4) and the password alone no longer does.

**Require password and passkey** (#562): a Security setting, off by default.
On, a new-device sign-in asks for the password and then the passkey, and
only both together open the vault; the passkey alone is offered nothing
real. Turning it off asks for both once more and restores the passkey alone.

**The backup code** (#572/#573): one per member, made under Security (and
offered on Today after the first week, never at sign-up), printed or saved,
and turned on with the password. It is the third way in on a new device and
replaces the per-device backup keys for that member (RECOVERY).

The new device is the member's like any other: same member ID, its own keys
and certificate, same-member history (every epoch), and admin-only and
household-authority actions keep their existing requirements (an admin who
signs in on a new device is still an admin, and still confirms admin
actions freshly).

## Device authorization

A device is trusted only after explicit enrollment by an active member through the pairing flow. The device has its own ID and device key material, separate from the member's credential and household content key. Each accepted event records its originating `device_id` for later sync and audit context; this must not become a covert activity feed.

Conceptual device states are pending, authorized, and revoked. Each enrolled sync-capable device locally generates separate non-extractable P-256 ECDH and ECDSA private keys. The service stores only public JWKs and a SHA-256 fingerprint. During pairing the joining device compares its locally computed fingerprint with the inviter's displayed value; approval is blocked on mismatch. Passkeys never supply or derive content keys.

Only authorized devices may submit or receive encrypted household events. Device revocation and member removal immediately invalidate target sessions and reserve a new household epoch; the remaining trusted devices must provision that epoch before sync resumes. A revoked device receives no later epoch, but keeps any old plaintext/key it already possessed. See [Pairing](PAIRING.md), [Sync](SYNC.md), and [V0.9.0](planning/V0.9.0.md).

An open browser checks authorization on focus/return and every 30 seconds while visible. Once the service can be reached, a revoked session clears its session cookie and a removed/revoked device also clears its device cookie; the UI stops sync and shows the signed-out state while retaining local household data. A disconnected device cannot learn of revocation until it reconnects or returns to the service.

Historical key entitlement is explicit: a new device for an existing member can receive retained history; a newly joined/replacement adult starts at its membership-time/current epoch and later epochs. v0.9.x does not grant pre-join epoch keys. Kin has no encrypted snapshots, so earlier shared history remains unavailable rather than being reconstructed from plaintext server state.

## Signing in with a phone

Since v1.1 (#98) a member signed in on a phone can sign a computer in by
scanning its QR code ([Pairing](PAIRING.md#sign-in-on-a-computer-with-your-phone-v11-98)
has the flow and its gates). The result depends on what the computer already
is:

- **A new device.** A computer the service doesn't know, or one whose device
  cookie doesn't name a trusted device with the keys it offers, becomes a new
  trusted device of the approving member. Its keys were generated on it; the
  phone signs its certificate and pins its key, and it pins the phone's key,
  checked through the tag that comes with the 6-digit code. It receives the member's
  retained history, as a same-member device added with a code does. It has
  no passkey of its own: it signs in again with a phone, or with a passkey
  the member can use on it.
- **A new session.** A computer whose cookie names one of the approving
  member's trusted devices, with the same keys, keeps that device. It gets a
  new session and a rotated device token, exactly what a passkey login gives
  it. Its keys and history are unchanged.

Signing in with a phone is a second way to reach the same states as a passkey
login and adding a device; it grants nothing either of them couldn't. The
approving phone's fresh passkey assertion stands in for the computer's own,
and the 6-digit code ties the approval to the computer in front of the person.
Only Adults approve, because only Adults add devices. Two devices never share
keys: a computer set up for another account, or offering keys any device has
had, is refused; "Sign in as someone else" then starts again with fresh keys.

## Device names

Since v1.1 (#71) nobody types a device name. Each device is known by two names:

- **Automatic name** — what the device reports about itself, such as
  "Chrome on iPhone", "iPhone" for the installed Home Screen app, or "Device"
  when it can't tell (`householdDeviceName` in `web/platform.js`). It is the
  only device name the server keeps (`server/pairing-service/device-label.mjs`):
  a label built from anything else is stored as "Device", and labels typed
  before v1.1 are reset to "Device" when the service starts. Approvers see it
  while pairing, before the new device has any household key.
- **Nickname** — an optional name a member gives one of their own devices in
  Trusted devices ("Kitchen tablet"). It exists only as an encrypted
  `DEVICE_NICKNAMED` event, so only household members can read it.

After its first successful sync, a device records its automatic name as an
encrypted `DEVICE_DESCRIBED` event, and again whenever that name changes.
Trusted devices groups devices by member, marks this device, and shows the
nickname, else the synced automatic name, else the server's automatic name,
else "New device" with the start of its sync code. A member who joined later
has no description for devices that described themselves earlier, so they see
those devices by nickname or by the server's automatic name. Only a device's own member
can rename it ([EVENTS](EVENTS.md#v110-device-names) has the rules).

## Preferred member names

Each member may choose the name their household sees, such as "Mikey" (#224,
#225), with **Set my name** on the household panel, which every member can
open (Adults also see it in People & devices). It needs device sync, because
the name is read back from the synced household history. It
exists only as an encrypted `MEMBER_NAMED` event that names its own author, so
nobody can name another member and the relay never sees it. An empty name
clears it. A member who never sets one keeps the existing fallback ("You",
"Household member 1", or their role label), so nothing changes for existing
households and nobody is asked to rename. A name that would pass for "You"
(such as "You" or "Sam (You)") can't be saved, and another member's name like
that is never shown, so nobody appears as "You" beside the trust controls.

When a device has no nickname, People & devices shows its owner's name beside
its automatic name, as "Mikey · Chrome on iPhone" (no possessive, so the
pattern stays translatable). That label is worked out each time it is shown
and never stored: renaming a member updates it everywhere, and it never
replaces a nickname, which always wins. Like every name here, it is
presentation only and proves nothing about who owns a device.

## v0.8.6 existing-member reauthentication

Bootstrap and claim activation set a separate opaque `kin_device` cookie whose hash is bound to the server-side device record. Logout invalidates and clears only the session cookie. Login options are limited to that trusted device's member credentials; after a valid assertion, the service issues a new session and rotates the device token. A missing or revoked device token, removed member, or unrelated credential is rejected. A passkey alone does not silently trust a new browser.

## v0.1.0 boundary

The first coded release uses local household, actor, and device placeholders only. No account, passkey, membership, pairing, authorization, remote session, or multi-device behavior is implied.

## Forward platform gates

The v0.11 implementation candidate persisted membership, credential,
trusted-device, revocation and coordination state across restart without
changing the service into a plaintext household authority. v0.12 adds durable
household deletion, cancellation and final tombstoning without changing the
client encryption boundary. The v0.13 line must
define replacement-device and household recovery against current membership,
deletion and revocation state. It remains planned; see [ROADMAP](ROADMAP.md)
and the [v0.11](planning/V0.11.0.md)/[v0.13](planning/V0.13.0.md) contracts.

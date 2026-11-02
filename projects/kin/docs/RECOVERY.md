# Recovery and Household Continuity

**Status:** implemented through v0.13.4. Recovery restores only authority that a
currently active adult and trusted device can legitimately grant. It never
turns an archive, an old passkey, a stale device, or a server backup into new
household authority.

## Capability matrix

There may be up to four active adults. Where this table says “another active
adult,” any one other active adult may authorize the existing targeted
recovery ceremony; there is no majority or quorum rule.

| Loss scenario | Recoverable? | Authority required | Data preserved? |
| --- | --- | --- | --- |
| One browser session lost | Yes | Existing trusted-device token and that member's valid passkey | Yes; server state and local encrypted storage are unchanged. |
| One trusted device lost | Yes, if another trusted device for that active adult remains | Active same-member session, fresh replacement enrollment, and explicit approval on the remaining device | Yes when the remaining device holds the retained epoch keys; the lost device is revoked. |
| One passkey lost | Yes, if another trusted device/passkey remains | Existing trusted device plus another valid credential; replacement adds a fresh credential | Yes; losing a passkey does not remove content keys already held by devices. |
| Browser profile wiped | Sometimes | Another trusted same-member device can authorize a fresh device, or a local encrypted archive and its recovery secret can restore local-only history | Shared history is preserved when keys are provisioned; archive restore remains local-only. |
| One adult loses all credentials | Yes, while another active adult has a trusted device and valid passkey | One other active adult authorizes; the affected adult establishes and activates a fresh passkey/device | Yes when the authorizing device holds and provisions the entitled epochs. |
| Server DB restored from backup | Yes, within the backup and retained tombstone limits | Service operator, verified backup, explicit deletion-history acknowledgement, and preserved newer lifecycle ledger | Opaque relay data and authority present in the accepted restore are preserved; plaintext keys are never in the DB. |
| Household key missing on one device | Sometimes | Another currently trusted, entitled device must provision the missing epoch | Only epochs held by an entitled device are recoverable; sync pauses instead of skipping ciphertext. |
| All trusted devices lost | Only from an encrypted local archive for local-only use | Archive plus its recovery secret; no sync authority is restored | Archive history may survive, but the server household and missing epoch keys cannot be recovered. |
| All active adults lose credentials | No supported server recovery | None; Kin has no email/SMS fallback, universal delegate, or server escrow | Encrypted local archives may remain locally readable with their secrets; shared authority is unrecoverable. |
| Deleted household | No | None after finalization | Server identity, relay data, and authority are gone; external local copies remain outside the service boundary. |

## Separate recovery authorities

- **Identity recovery** proves a member using a current member-bound credential.
  A household adult cannot silently become another adult.
- **Device replacement** authorizes a fresh device ID, device token, passkey,
  and device key pair. The specifically lost device is revoked atomically with
  approval and its sessions stop working.
- **Content-key continuity** is client-to-client provisioning of only the
  epochs to which the new device is entitled. The service stores wrapped
  packages, never plaintext household keys.
- **Server-state restore** restores the SQLite authorization and opaque relay
  database. It does not recreate client keys, local roots, or passkeys.
- **Household membership continuity** keeps the stable active member record.
  Replacement does not create a third adult or reactivate a removed adult.

## Replacement-device flow

An active adult signs in on a remaining trusted device, chooses the particular
lost device, and starts a ten-minute replacement invitation. The replacement
browser creates a fresh passkey and fresh device identity/key material. The
remaining device reviews the new-device fingerprint and approves the exact
claim with a fresh WebAuthn assertion. Approval revokes the selected lost
device and its sessions, trusts the new device, and lets existing
recipient-bound provisioning deliver retained epochs.

The claim is household-, member-, device-, and version-bound. It expires,
becomes single-use after activation, and cannot replace the approving device.
An old pairing code, revoked device, unrelated member, or archive cannot use
this path. Revocation cannot erase plaintext or keys already copied to the lost
device.

## Member-assisted recovery

Adult A proves current membership, trusted-device control, and their own fresh
passkey approval. Adult B proves participation by creating and then activating
a fresh passkey on a fresh device. A authorizes the bounded recovery ceremony;
A does not receive B's session, cannot authenticate as B, and cannot rotate B's
credential into one of A's existing credentials.

Approval keeps B's stable active member ID, revokes every old B device and
session, removes B's old credential records, and installs only B's newly
created credential/device. The new device is entitled to B's retained history,
which an authorized key-holding device may provision through the existing
recipient-bound encrypted packages. Removed members, unrelated members,
revoked devices, expired claims, stale approval versions, and activation
replays fail closed.

A malicious or compromised account can authorize an attacker as the recovery
claimant and thereby lock B out; the existing trust model lets one active adult
remove another. Kin records the approving member/device and recovery target,
requires a separate claimant credential, and never makes A become B, but it
cannot distinguish a coerced or dishonest approval from a legitimate one.

## Honest failure boundary

Kin has no server-*readable* content keys. A member with an account vault
(ADR 0018) can lose **every** device and still get back in: they sign in on a
new device with their password (or passkey), the vault opens on that device,
and the household's keys come from it (see "Signing in on a new device"
below). If every trusted device, every usable local archive/recovery secret,
every valid credential/recovery authority **and** every way to open the
member's vault (password, passkey, backup code) is gone, encrypted household
content is unrecoverable. This is safer than silently granting authority from
stale server state.

## Signing in on a new device (#568)

A member on a new phone, or a browser whose Kin data was cleared, chooses
**Sign in** on the first screen and enters their username and password (or
uses "Sign in with a passkey" once they've added one, #560, or "Use my
backup code", #572, which then asks for a new password). No other device has
to be present. Once a passkey is added, the password alone no longer signs in
on a new device; with "require password and passkey" on, the password comes
first and the passkey confirms.

1. The service checks the password (or passkey) exactly as for any sign-in,
   with the same limits and the same generic answer, and issues a
   **new-device capability**: a ten-minute, single-use permission bound to
   that member, never a session (THREAT-MODEL, "New-device sign-in").
2. With it the browser downloads the member's vault and the one wrapper its
   sign-in opens, and opens the vault on the device.
3. **"Which device is this?"** lists the member's trusted devices:
   - **Add this as a new device**, or
   - **This replaces &lt;device&gt;**: that device is revoked in the same step
     as this one is trusted, with a clear warning that it is signed out for
     good. Use it for a lost, broken or wiped device.
4. The device gets its own keys, certifies them with the member's
   certification key from the vault (CRYPTOGRAPHY, "Certification key
   chain"), and is registered; its storage is protected by the password (a
   passkey-only sign-in uses that passkey plus a backup key shown once). It
   installs the household's keys from the vault, pins the devices the
   member's account trusts, and syncs. The member lands on Today.

**The trusted-device limit** counts after a replacement's revocation, as for
a replacement pairing: a household at its limit can still replace a device,
but not add one.

**A revoked device can't use this to come back.** Revocation is of a device
record and its keys; signing in again makes a new device with new keys (a
new ID and certificate), and only after the password or passkey check. A
revoked device's own keys, cookie and sessions stay refused.

**Before this works for a member** their certification key must be endorsed
by one of their trusted devices. Kin does it automatically: right after the
vault is created at first run, and, for members whose vault came before
this, the next time one of their devices that holds the vault key opens the
household panel. Until then the sign-in says so and points to pairing.

Pairing from another trusted device stays available, unchanged, for people
who prefer it or have no account vault yet.

## Members who signed up with a password (#557, #558)

Since the first run with a password ([ADR 0018](decisions/0018-account-key-vault.md)),
a new member chooses a username and a password, and **no backup key is shown
or required at first run**. On that member's first device:

- The local root has one wrapper, a **password wrapper**: its key is derived
  from the password on the device, so the password unlocks the device every
  day, offline.
- The member's **account vault** (CRYPTOGRAPHY, "Account key vault") is
  created with the household keys the device holds and one password wrapper,
  and kept current as keys change.

**The final-unlock-path rule, restated.** "Never delete the final verified
unlock path" still holds; what counts as that path is now:

| Device set up | Its verified unlock path | Can it be removed? |
| --- | --- | --- |
| With a backup key (every household before #557, and "Set up with a passkey instead") | The recovery (backup key) wrapper | No, exactly as before; a passkey alone never counts |
| With a password (the first run since #557, or a password sign-in, #568) | The password wrapper | No; a passkey unlock added later can be removed, the password wrapper can't |
| With a passkey alone, by a member whose account has a backup code (#572) | The account: the backup code signs this browser in again | The last passkey wrapper can't be removed; the manifest records `accountRecovery: "backup-code"` |
| With a passkey alone, by a member without a backup code (#568) | A backup key shown for this device at sign-in | No, as for any backup key |

The rule is one test (`hasFinalUnlockPath`, built on `hasVerifiedUnlockPath`,
in `web/security/local-vault.js`) that the vault, `EventStore.prepareSecurity`
and `updateSecurityManifest` all apply. A device set up with a backup key has
no password wrapper and no `accountRecovery`, so the test is the old rule for
it, unchanged. The passkey-only case is the one place the final path isn't on
the device: if that passkey can't open it, the lock screen's "Can't use your
passkey?" offers **Start over on this browser** (#592 follow-up): after a
clear warning, Kin removes its own data from this browser (its databases and
storage entries; the session ends) and opens Sign in, where the member signs
in (password, passkey or backup code) and chooses "This replaces" that
device; the household comes back from sync, and only what the device hadn't
synced is lost. Nobody has to find "clear site data" in the browser's
settings. The passkey also unlocks such a device offline (#551).

A member set up the old way who moves to an account (#575) keeps every
wrapper the device had and gains a password wrapper beside them; the
recovery (backup key) wrapper stays the device's verified path as before.

**The account vault's own rule (#561/#572).** The vault always keeps at least
one wrapper, and the service refuses any set where a password alone opens it
beside a passkey, or a passkey alone beside "require password and passkey"
(CRYPTOGRAPHY, "Which wrappers may exist together"). So the ways back into an
account are, in order of what's set up: the password (until a passkey is
added), the passkey (alone, or with the password when that's required), and
the backup code, always.

**The trade-off, plainly.** Kin can't reset a password: the service never
sees it, only a key derived from it. **The backup code (#571) is the way
back** from a forgotten password or a lost passkey: on a new device (or this
one, after "Start over on this browser"), Sign in → Use my backup code, then
choose a new password; it replaces the old one in the same step that trusts
the device, and the vault's password wrappers are re-wrapped under it. A
"require password and passkey" wrapper needs the passkey too, so a
backup-code sign-in removes it; afterwards the passkey doesn't open the
account on a new device until the member sets it up again under Security
("Set up my passkey") and, if they want, turns the setting back on. Until
then the backup code is how the account signs in on a new device. Without a
backup code or another trusted device, **a forgotten
password on a member's only device means that household can't be opened on
it**: the local data stays encrypted, and with no other device there is
nobody to pair a new one. The account vault doesn't help with a *forgotten*
password when the password is its only wrapper; it helps with a *lost
device*: with the password (or passkey) remembered, the member signs in on a
new device (#568, above). With another trusted device of theirs, the member
pairs a new device as before; another adult can authorize member recovery as
before. The first run says this in one line where the password is chosen;
the lock screen's "Forgot your password?" says what to do.

**Per-device backup keys (#576).** Until a member has a backup code, the
backup keys of the devices they set up the old way are their way back, and
keep working after they move to an account. Once they have a backup code,
Kin no longer asks them for a backup key on any device: a passkey-only
sign-in shows none, Security says "You no longer need this device's backup
key" and stops offering "Replace backup key", and exports open with the code
(PORTABILITY). Backup keys a device already has keep unlocking it (one tap
away on its lock screen, behind the password or passkey) and keep opening the
exports made with them.

## Moving to an account (#574, #575)

Members who set Kin up with a passkey and a per-device backup key, before
accounts, aren't forced to change anything. On their next unlock Today shows
one calm card, "Sign in on your other devices?", with **Set up** and **Not
now** (back no sooner than a week later); Security shows the same offer under
**Your account**. Setting up asks for a username and a password, then one
touch of their passkey, and the device makes their account and vault from
the keys it holds (CRYPTOGRAPHY, "Moving an existing member to an account").
From then on:

- their password unlocks this device too, offline; the passkey and the
  backup key still do;
- a new device signs in with the passkey alone (when it supports PRF; else
  with the password), with no other device present;
- their other old-style devices offer **Use my account here**, which asks
  for the password and gives that device the vault key too.

An interrupted setup is simply run again: each step checks what is already
done, so nothing is made twice.

A device set up with a password exports once the member has a backup code;
before that it has nothing for an export to open with, and says so. Its
household syncs as usual.

**Changing the password (#560).** Under Security → Password, with the
current password: the service's verifier, the vault's password wrappers and
this device's local password wrapper all move to the new password. Another
device, at its next unlock with a connection, notices the change (the
service's password parameters differ from its wrapper's) and asks for the
new password before it opens; then its wrapper follows. If the person types
the new password first, it signs in, and Kin asks once for the previous one,
which that device still needs to open its storage. Offline, that device keeps
opening with the previous password until it is next online (THREAT-MODEL).

## Stale backups and rollback

When an older backup is restored over a surviving validated database, Kin uses
the backup for durable relay history but preserves the target's newer active
authority: member active/removed state, the exact current credential set,
trusted and revoked devices, device-token verifiers, current epoch/rotation
state, live provisioning grants, and a newer cancellation that returned a
household to active. Final deletion tombstones still override the backup, and
pending deletion still blocks restore entirely. Thus an older
device, credential, member record, completed recovery, or pre-rotation state
cannot silently regain authority through restore.

This is deliberately not generalized history merging. If the active database
and every later authority/deletion record are both lost, the service cannot
infer changes made after the chosen backup. Operators must preserve the latest
database/deletion ledger and choose a known-good backup. The explicit restore
acknowledgement remains required.

If the surviving target contains an active household that the selected backup
does not contain, restore is refused. Kin does not reconstruct a household from
authority metadata alone or silently discard authority created after the
backup. Replacement and member-assisted recovery evaluate the trusted-device
limit after their required revocations, so recovery remains possible at the
configured limit without widening the final device count.

## Stale devices and missing keys

A revoked device cannot reauthenticate, upload, pull, receive provisioning,
overwrite a newer epoch, or cancel a completed recovery. Recovery claims are
process-local, bounded, ten/fifteen-minute capabilities; approval versions and
activation are single-use, restart discards unfinished claims, and terminal
records are pruned.

If a legitimate device lacks an epoch, sync pauses and identifies the missing
history instead of skipping undecryptable events. The epoch is recoverable from
another trusted device that is entitled to it, or the history may be recovered
locally from an encrypted archive and its separate recovery secret. If neither
source still holds the epoch key, that history is unrecoverable.

## Server disaster recovery

A verified SQLite backup can restore server membership/routing metadata and
opaque relay ciphertext. Clients then reauthenticate and reconcile against the
restored authority. A backup alone never contains passkey private material,
device private keys, local encryption roots, plaintext household keys, or
plaintext content. If a surviving current database exists, keep it so restore
can preserve newer authority and tombstones. With only an old backup, later
revocations/deletions cannot be reconstructed and global rollback resistance is
not claimed.

## User-visible boundaries

The household view uses “Replace this device,” “Recover access,” and
“Authorize recovery,” not key-epoch or wrapping terminology. Before approval it
states whether another adult is required, which old devices/credentials stop
working, and that previously copied information cannot be erased. Missing key
errors say that some encrypted history cannot be recovered instead of silently
omitting it.

Final household deletion cannot be recovered. A removed member must be invited
as a new member rather than silently reactivated. An old backup cannot override
authority preserved by a newer surviving database. Loss of all entitled epoch
keys and archive secrets is permanent.

Native buttons, checkboxes, forms, confirmation dialogs, live status text, and
alert messages preserve keyboard operation and announcements. Controls retain
48-pixel targets, wrap in narrow layouts, and recovery uses the existing
visible countdown/expiry behavior. Revocation and recovery completion require
explicit confirmation plus WebAuthn approval; activation requires a second
passkey action on the recovering device.

Screens call the recovery key the **backup key for this device** (#563): each
device has its own, and the words say so. This document and the code keep
"recovery key"; the stored format is unchanged.

An export opens only with the recovery key its device had when it was made.
Each key has a short label (for example `K-7F3A`) shown with the key, in
Settings, on the export's file name and on the restore screen, and a wrong key
names the label that opens the export. Store the export and its recovery key
in different places, and write down which key label goes with which export.
See [PORTABILITY](PORTABILITY.md#recovery-key-labels).

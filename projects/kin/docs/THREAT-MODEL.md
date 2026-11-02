# Threat Model

**Status:** Current as of v1.6.0; see [Known limitations at v1.0](#known-limitations-at-v10). Local authenticated encryption, credential/recovery root wrappers, locked startup, encrypted archives and signed transport-key migration complement encrypted sync. The service has durable identity/relay storage, backup/restore and explicit household lifecycle. Independent security audit, cross-browser certification and general rollback protection are not provided.

## Refactor track: decrypted history in memory while unlocked

An unlocked tab now keeps one decrypted copy of the canonical event history in
memory (the session event arena, [STORAGE](STORAGE.md)) instead of decrypting
it again for every command and refresh. Before, each operation produced a
fresh plaintext copy that waited for garbage collection, so an unlocked tab
already held household plaintext in memory: the decrypted events and the
rendered projection. This changes how long one copy lives, not what an unlocked
tab can read. Nothing new is written to disk. The only new persisted value is
a plaintext store-generation counter in `security_state`, which reveals only
that the corpus was replaced.

Lock, close, peer-tab lock and durable-epoch mismatch zero-fill the arena's
buffers and drop them. Zero-filling covers the arena's own buffers. It cannot
erase copies already handed to the engine or the DOM, or copies the JavaScript
engine made internally, and garbage collection still gives no physical-erasure
guarantee. A compromised unlocked runtime could read the history either way.

Rows are checked against their Rust metadata once, when they enter the arena,
instead of on every read. Tampering with persisted ciphertext still fails
authenticated decryption, but it is detected at the next full read (unlock, a
generation or count mismatch), not on the next command. A non-append rewrite
that does not go through Kin's replacement paths (and so does not bump the
generation) is not detected until the next unlock; such a writer already has
storage access.

From Slice 6 the engine instance also keeps its own copy of the canonical
history in WASM memory while unlocked (`rust/src/history.rs`), so a refresh
sends only new events. Before, every replay copied the whole history into
WASM memory and freed it afterwards, without zeroing it. WASM memory never
shrinks, so those bytes could stay resident until something overwrote them. The copy is
zero-filled and dropped on `kin_history_reset` and on lock (`kin_clear` from
`engine.dispose()`). As with the arena, zero-filling covers that buffer only.
From Slice 7 the instance also keeps the replayed household state of that
history (its checkpoint: Item and Note text and other derived values) between
calls. It is dropped, not zero-filled, on the same reset and lock. That state
is what every projection already produced and returned, so this lengthens how
long one copy lives, not what an unlocked engine holds.

Incremental rendering (Slice 4) adds no new plaintext copy. The engine keeps
its last projection buffer between calls, as its result buffer already did, to
compare sections and stamp revisions. The bridge keeps the last decoded state,
which `<kin-app>` already held. Both are dropped on lock (`kin_clear`,
`engine.dispose()`). Revisions are a rendering aid: they never feed replay,
storage, sync or authority. They come from exact byte comparison inside one
engine instance, not from hashes, so crafted content cannot make two different
sections share a revision.

## v0.13 recovery authority

Recovery requires a current trusted adult/device and a fresh claimant
credential; it never derives authority from an archive, stale device, or old
credential. Same-member replacement revokes the selected lost device.
Member-assisted recovery keeps the target member identity but replaces all of
that member's credentials/devices/sessions. A malicious approving adult can
authorize an attacker and lock out other active adults, consistent with the
existing one-adult removal authority; audit attribution and separate claimant
activation prevent silent impersonation but cannot prove honest human intent.

Restore over a surviving database preserves its newer authority and lifecycle
ledger. Loss of that database/ledger leaves no global anti-rollback witness.
Servers never hold plaintext content keys. All trusted key-bearing devices and
archives being lost makes encrypted history permanently unrecoverable.

## v0.10 local-at-rest boundary

Implemented protection after verified migration: an unauthorized person with persisted browser site data but
without an authorized Kin credential/recovery mechanism cannot trivially recover
household plaintext while Kin is locked. While locked, the running tab holds
no reminder titles. It keeps only suspended reminders' record ids, due times and
local vault id, and it cannot show a notification ([PRIVACY](PRIVACY.md)).
v0.9.3 does not provide this protection:
its canonical events, draft text and usable sync CryptoKeys survive logout.
The [v0.10 record](planning/V0.10.0.md) gates this claim on complete migration, including
outbox duplicates and legacy provisioning/decryption capabilities.

**Exception, refresh resume (#351, [ADR 0010](decisions/0010-reload-resume.md)).**
For two minutes after an unlocked tab unloads, that tab's sessionStorage holds
the root sealed with a non-extractable key kept in IndexedDB. Someone with the
person's browser profile in that window could use the browser to combine them
and unlock. The owner accepted this: access to the person's own browser is the
person's responsibility. Both halves are deleted on use, on expiry, on every
real lock and when the device setting is off; only a `reload` of the same tab
with a matching vault, root version and lock epoch can use them.

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
Lock also revokes the blob URLs of attachments opened or downloaded in the last
minute, so they no longer resolve. An attachment already showing in another tab
stays visible there until that tab is closed; Kin cannot reach another tab's
content, and a downloaded file is the person's own copy.

Encrypted archive plus its independently held recovery secret can recover a lost
profile's local history. Restore does not reactivate revoked devices or re-create
server identity; sync stays disabled on the restored household. Losing every
credential/recovery secret permanently loses the ciphertext.

## v0.12 household deletion and rollback boundary

The server persists `active`, `deletion_pending` and `deleted` state. A fresh
passkey-authorized request immediately invalidates sessions and rejects sync;
the 30-day pending interval exists to permit authenticated cancellation.
Finalization removes server-held ciphertext and authorization state while
retaining a minimal opaque household-ID tombstone. The state machine does not
delete browser stores, device-held plaintext/keys, exported archives or backups
outside the active database.

Kin refuses restore over an existing target containing any `deletion_pending`
household. The operator must cancel deletion using current valid household
authority or allow it to finalize first; this prevents stale backup authority
from enabling cancellation by a removed adult or revoked device during the
grace period. Existing finalized deletion tombstones are still merged into the
verified backup and its deleted household rows are purged/non-authoritative.
Active targets remain restorable. The admin restore command requires explicit acknowledgement.
If both the current database and the deletion record are lost, Kin cannot infer
a later deletion from a stale backup; this remains a rollback limitation, not a
global anti-rollback guarantee. The permanent tombstone is minimal but its
count grows with deleted households. No physical media sanitization,
cryptographic erasure of client keys or external backup expiration is claimed.

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

## Account key vault (ADR 0018, #564)

| Threat | With the vault |
| --- | --- |
| Stolen copy of the service's database | Vault ciphertext and wrappers. With a passkey added: nothing to guess (256-bit PRF). Password-only wrapper (D3): weak passwords can be guessed offline at PBKDF2 cost (600,000 SHA-256 iterations per guess); the Argon2id(authKey) verifier (19 MiB, 2 passes) slows checking the password too. Old database backups keep old vaults and wrappers, including a password-only wrapper removed since. |
| Malicious or compromised service | Can withhold the vault, refuse updates or serve an older version under its own number (the version is authenticated, so it can't relabel one as newer); a device detects rollback only against a version it has seen. Can't read the vault, move it to another member, or swap a wrapper's type or owner (all authenticated). |
| Another member, a removed member or a revoked device | Refused by the routes: only the session's own member, on a trusted device, reads or writes their vault. |

The ADR's full table (stolen password, phished passkey account, phishing)
applies now that password sign-in (#557) and new-device sign-in (#568) are in;
the new-device rows are below.

### Password sign-in (#557, #558)

| Threat | With password sign-in |
| --- | --- |
| Stolen password, no device | Since #568, **enough to sign in as that member on a new device while they have no passkey in their vault** (ADR 0018 D3, the owner's accepted trade-off): see "New-device sign-in" below. Joining as a new member still needs an invitation code and the inviter's approval. |
| Stolen password and an unlocked or stolen trusted device | The password unlocks that device's local copy offline and signs it in. Same as a stolen backup key today, except a password can be guessed: at a full PBKDF2 (600,000 iterations) per guess against the device, and the strength floor (10 characters, not one of ~200 very common passwords, not the username) only stops the first guesses. |
| Online guessing against the service | From a trusted device's cookie, or (#568) from any browser through the new-device sign-in; failures are limited to 10 per 15 minutes per member, per device and per address, and past that even the right password waits. One message and the same Argon2id work for every failure, so neither says whether a username exists. |
| A **fresh password** instead of a fresh passkey | Weaker than a passkey until one is added. For a member with no passkey, admin-only and trust actions (approving a device or a member, signing in a computer, revoking a device, removing a member, household admins, Simple view, chat and fridge access, household features, deleting the household or cancelling that) accept a password re-entry. Anyone who has the member's password *and* one of their trusted devices (or an open session on one) can do those things; with a passkey, they'd also need the passkey's device or account. A member who has a passkey always confirms with it, and an `authKey` is no substitute. |
| Usernames can be listed | Whether a username is free is answered at sign-up, as on every sign-up page, limited to 30 checks per client address in 15 minutes. A claim waiting for approval holds its username. |
| Forgotten password, one device, no other way in | With a backup code (#571): sign in with it (on a new device, or on this one after "Start over on this browser") and choose a new password. Without one, the household can't be opened on that device (RECOVERY, "Members who signed up with a password"); the first run says so in one line and Today offers the backup code after the first week. |
| Password changed on one device, another device still has the old one | **Online:** at the other device's next unlock it asks the service for the account's current password parameters; when they differ from its wrapper's, it doesn't open the household until the **new** password signs in, then re-wraps its local root under it (#560 follow-up; the old password, or the new one typed first, opens the root once to do that). **The remaining offline window:** while that device has no connection (or the service doesn't answer), its local wrapper still opens with the old password, since only the device itself can re-wrap it; someone who knows the old password and holds that device offline can open its local copy, as before the change. A device that never comes online keeps that window. Changing the password doesn't revoke a device: to shut a lost device out, revoke or replace it. |
| Phishing for the password | Possible, as for any password; another reason to add a passkey (offered on Today after the first useful action, #562). A phished `authKey` alone opens nothing locally (the local wrapper's key is derived separately). |

Nothing in the vault, the verifier or the local wrapper lets the service
read household content: it sees `authKey` (from which the password-derived
keys can't be computed) and stores only its Argon2id hash.

### New-device sign-in (#568, #569, #570)

A browser with no trusted-device cookie signs in with a password or passkey
and gets a **new-device capability**, not a session.

| Threat | What Kin does |
| --- | --- |
| **What a stolen password allows before a passkey exists** | Everything the member can do from a new device: sign in, open the vault (password wrapper, D3), certify a new device of theirs that the household trusts, read the household, and replace (revoke) one of their devices. The owner accepted this for the first run (ADR 0018 D3); the member sees the new device in their device list and the audit log records it (`new_device_sign_in`, `device_trusted` with reason `account_sign_in`). Admin-only actions still need a fresh confirmation, which for a member without a passkey is the same password (see above). Adding a passkey closes this: the password alone then signs in nowhere new. |
| Capability theft | It is a random 256-bit token in an HttpOnly, SameSite=Strict cookie (`kin_new_device`), never in a URL or a response body, kept on the service only as a hash and only in memory. It lasts 10 minutes, is bound to one member and one pre-assigned device ID, downloads the vault at most 3 times, and is spent by the first registration (3 failed registration attempts spend it too). A thief still needs the password or passkey to use the vault it downloads. |
| Capability replay | Single use: registration deletes it before trusting the device, in the same transaction; any later download or registration with it is `new_device_expired`. A restart cancels every capability. |
| Online guessing | The password check is the existing one: Argon2id work for every attempt (also for unknown usernames), one generic answer, 10 failures per 15 minutes per member (or per unknown name) and per address, after which even the right password waits. Passkey failures are charged to the same limits. Capabilities issued per member: 6 per 15 minutes, at most 2 live per member, 256 in all. Username parameter lookups: 30 per address per 15 minutes; an unknown name gets a stable made-up salt and a made-up passkey, so neither answer says whether an account exists. |
| A member's device count | No per-member cap beyond the household's 16 trusted devices (the replaced device's place is freed first). A thief with the password could fill the household's remaining places (a denial of service the members see in their device lists); the issuance limit slows it. |
| A revoked device coming back | It can't with its own keys, cookie or sessions (all refused as before). Signing in again needs the password or passkey and always makes a **new** device with new keys and a new certificate; "This replaces …" revokes the old record in the same step as trusting the new one, and the household rotates its key so the replaced device gets nothing new. |
| A service minting a device the household trusts | Not possible without the member's certification key, which exists only inside their vault: other devices accept a version 2 certificate only when it is signed by the certification key that one of the member's own trusted devices endorsed, and they pin that key per member. A colluding service plus a stolen **device** key of that member could endorse a different certification key; devices that already pinned the member's key refuse it, devices that never saw one could accept it (the same exposure as that stolen device key approving a device today). |
| A service lying to the new device | It can't make the new device trust another certification key or extra anchors: the endorsement must be the vault's own key and signed by it. It can withhold the vault, the endorsement or the directory (the sign-in then stops), or serve an older vault version (the new device may start without the newest household key and waits for another device to provision it). |
| Passkey-alone sign-in (D4) and require-both | The service lets the password sign in on a new device only while the vault has a password wrapper and no passkey wrapper; with a passkey wrapper, only the passkey (WebAuthn with user verification, then its PRF output opens the wrapper); with "require password and passkey", the password step leaves the capability pending until the passkey assertion completes it, and only the combined wrapper is released. Whoever controls a synced passkey can sign in on a new device unless require-both is on (ADR 0018). |

Deferred (not claimed): rotating a member's certification key; showing the
member a notice on their other devices when a new device signs in.

### A passkey and a backup code for an account (#560, #571)

What each way into an account protects against (the success criterion of
epic #546), with the wrapper-set rules the service enforces (CRYPTOGRAPHY,
"Which wrappers may exist together"):

| The account has | Stolen copy of the service's database | Stolen password | Stolen or phished synced passkey (the account that syncs it) | Lost every device |
| --- | --- | --- | --- | --- |
| Password only (sign-up, D3) | Weak passwords can be guessed offline at PBKDF2 cost | Opens the account on a new device | n/a | Password signs in on a new device |
| Password + passkey (default once added, D4) | Nothing to guess: the password-only wrapper is gone, the passkey wrapper's key is 256 PRF bits. Older database backups still hold the old password-only wrapper. | Not enough on its own: the service refuses the password alone (`passkey_required`) and holds no wrapper it opens | **Enough** on its own: whoever controls the synced passkey signs in on a new device (ADR 0018 D4, owner's choice) | Passkey signs in on a new device |
| "Require password and passkey" on | Nothing to guess (the combined key needs the PRF output) | Not enough | Not enough: the passkey alone is offered nothing real and opens nothing; both are needed | Password and passkey together |
| + a backup code (any of the above) | Nothing to guess: the code is 256 random bits; the service keeps only SHA-256 of a key derived from it | — | — | The backup code signs in and sets a new password |

| Threat | What Kin does |
| --- | --- |
| **Stolen backup code** | Enough on its own, with the username, to sign in on a new device, open the vault and replace the password (it is the way back when everything else is lost). That's why it's printed and kept at home, never asked for at sign-up, and offered only after the first week. The sign-in is charged and limited like a password (10 failures per 15 minutes per member and per address, one generic answer) and appears in the member's device list and the audit log (`new_device_sign_in` with method `backup-code`, `password_reset`). Making a new code stops the old one at once (its wrapper and check value are replaced in one step); exports made under the old code still open with it (PORTABILITY). |
| Guessing a backup code online | 256 bits, behind the password limits: not feasible. A typo is caught on the device (a 24-bit check) before anything is sent, so honest typos don't spend the limit. |
| A session alone (a browser left signed in) changing how the account opens | Every account change (adding or removing a passkey, require-both on or off, a new backup code, a new password) needs the current password, checked fresh with the password limits, and goes to the service as one request; the service also checks the resulting wrapper set. The one-wrapper routes (`PUT`/`DELETE /api/account/vault/wrappers/<id>`) need the same: the current password, or a fresh assertion of the member's own passkey (a single-use challenge from `/api/account/confirm/options`); without one they answer `fresh_auth_required` (#592 follow-up). |
| Removing a passkey | After the password, its vault wrappers and the service's record of it go in one transaction; it stops signing in and stops confirming admin actions (with no passkey left, the password confirms them again, as before one was added). Never the last way in: a member without a password keeps at least one passkey, and the vault keeps a wrapper a password or passkey opens; removing the last passkey brings the password wrapper back (the password-only stage, D3, with its offline-guessing trade-off). This device's passkey unlock goes with it; a device whose only unlock it was gets a password unlock instead. Other devices' passkey unlock for it keeps working **offline** (their local PRF wrapper is theirs) until they unlock online, where the service no longer accepts it. |
| A passkey without the PRF extension | Kin keeps it for confirming household actions but can't use it for the vault; Security says so and the password keeps working. |
| Admin actions after a passkey is added | They ask for the passkey again (as for members who started with one); the password is no longer accepted as a fresh confirmation. |
| A device signed in with a passkey alone, for a member with a backup code | It has no backup key; its passkey unlocks it offline too (#551). Its final path is the account (RECOVERY): if the passkey stops working there, "Start over on this browser" (#592 follow-up) removes Kin's data from that browser after a clear warning and opens Sign in, where the member signs in again (password, passkey or backup code) and replaces that device; anything it hadn't synced is lost. Start over removes only Kin's own databases and storage entries and ends the browser's session; it needs no proof of who is asking, because it only deletes what that browser holds and gives access to nothing. |

### Moving an existing household to accounts (#574, #575)

| Threat | What Kin does |
| --- | --- |
| Someone with an unlocked device sets a password for its member | Choosing the username and password needs a fresh assertion of the member's own passkey (WebAuthn with user verification, a single-use challenge for this member and device); a session or an unlocked screen alone isn't enough. Once a member has a password, the service refuses to set another this way (`account_exists`); changing it needs the current one. |
| A stolen copy of the service's database right after the move | A member whose passkey has PRF gets only a passkey wrapper, so nothing in the database can be guessed (D4). A passkey without PRF gives a password wrapper: the password-only stage (D3), with its trade-off, until a passkey with PRF is added. |
| An interrupted move | Each step looks at what is done: the password set but no vault (the next run checks the typed password by signing in, then makes the vault), the vault key kept before the vault is uploaded (the next run uploads the same key), a vault made by another of the member's devices (opened through its password or passkey wrapper). No step ever makes a second account or a second vault. |
| Members who decline | Nothing changes for them: the invitation is a card they can put away (for a week), and their passkey and backup keys work as before. Guests (Temporary members) are never invited. |
| The per-device backup key after the move | Keeps working (#576); once the member has a backup code, Security says it's no longer needed and stops offering a new one, and it still opens the exports made with it. Someone holding that key and the device can still open that device's local copy, as before. |

### Offline passkey unlock (#551, #552)

| Threat | What Kin does |
| --- | --- |
| A stolen device, offline | The passkey unlocks it only through the authenticator: a challenge made on the device, user verification required, the wrapper's credential only, and the PRF output for the wrapper's salt is what unwraps the local root. A thief needs the passkey's authenticator and its user verification (face, fingerprint or screen lock), exactly as online. |
| No service check | Online, the service also checks the assertion and refreshes the session; offline it can't. That check never protected local data (the PRF output did), so nothing it guarded is lost; what the device skips is the session, so it doesn't sync until it signs in again. |
| A passkey removed from the account, or a revoked device | Offline, a device's own PRF wrapper keeps opening its local copy (as its backup key or password would); it can't sync or reach anything on the service. Online, the service refuses the passkey as before and the device doesn't fall back to the local challenge. |
| A spoofed "offline" | Kin uses the local challenge only when the browser says it's offline or the service can't be reached (no connection, or a 5xx); a reachable service's refusal is never bypassed. Making the service unreachable gains an attacker nothing they couldn't do offline with the authenticator. |

### A member's own export of their private things (#493)

| Threat | What Kin does |
| --- | --- |
| Someone else opens the file | It is sealed under the member key; only the member's own devices hold it (from their vault), or their backup code opens it (the file carries the code's vault wrapper and the member keys under the vault key). Without one of those, nothing in it is readable; its header says only who made it and when, how many private changes and photos it holds, and which member-key epoch seals it. |
| Restoring someone else's file | Refused before anything is opened (the header names another member or household), and every envelope must open under the restoring member's own key for the member it is bound to; one that doesn't makes the whole file refused. |
| A household export leaking private things | Household exports never read the private log or private blobs; private things are only in this separate file, and this file holds nothing of the household's. |
| Duplicates or replays | Restore merges by event ID: restoring a file twice, or one whose events the device already has, adds nothing. Restored events the service no longer has stay on that device (the relay accepts only a device's own new envelopes); the file restores them on another device too. |
| Photos left out | When photos don't fit (64 MiB per file), the newest go in and the rest are counted and named in the message; they stay in the member's account. |

## Private storage per member (ADR 0019, #489)

| Threat | With private storage |
| --- | --- |
| Another member, an Adult or a household admin, wants to read someone's private things | Can't: private envelopes are sealed under that member's member key, which lives only in their vault (sealed under their vault key) and on their unlocked devices. No route names a member, so another member's device reaches only its own private stream, and a device refuses a private event signed by anyone else's device. An admin can turn private storage off for children and teens, which stops the relay, and can remove a member, which purges their stream; neither reveals anything. |
| Malicious or compromised service | Sees only ciphertext, sizes, times, the sending device and the member-key epoch number of each private envelope, per member; can withhold or delay them, or serve an older vault version (a device prefers a newer one it has cached). Can't read them, move one into another member's stream (the member is in the AAD), or forge one (device signatures). |
| A revoked device of the member | Loses its session, so it reaches nothing. It keeps what it already had, including member-key epochs it held. The member's remaining devices start a new epoch once they see the revocation, and new private envelopes use it; an envelope claiming that device under a later epoch is refused. |
| Lost every device | Not a loss: signing in on a new device (ADR 0018) opens the vault, which holds every member-key epoch, and the private stream is pulled again. |
| Timing and volume | The service and anyone watching it can see when and how much a member writes privately. Live hints go only to that member's own devices, so other members' devices don't learn it. |
| Another member fetches a journal photo (#502) | Can't: private blobs are stored per member and no route names one, so their request reaches only their own blobs (404). The bytes are sealed under a per-photo key that lives only inside the member's private record. |
| A deleted journal photo lingers | The device deletes it on the service once Undo has passed, on the next private pass. If Kin locks before that, the sealed blob stays on the service (counted in the member's quota) until the member is removed or the household deleted; its key remains only in the member's private log. |

## v0.9.x threat assessment (historical; local lock added above)

| Threat                                            | Protected                                                                                                           | Partially protected                                                                                                        | Not protected                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Curious-but-honest service operator               | Household event semantics and content keys are not sent to the relay                                                | Household/device/member IDs, event IDs, epochs, timing, counts, ciphertext size, cursors, and membership links are visible | Traffic-pattern inference, availability, or a compromised authorized client    |
| Service database/process compromise               | Relay contains ciphertext only; no plaintext content key                                                            | Persistent routing metadata, public keys, logs, ciphertext and backups can leak                                            | Availability, honest completeness, or hiding metadata                          |
| Passive network observer                          | HTTPS outside loopback plus payload AEAD/signatures                                                                 | IPs, endpoints, packet lengths and timing                                                                                  | Anonymity or traffic analysis                                                  |
| Active network attacker                           | TLS, authenticated sessions, AEAD AAD, device signature, recipient-bound provisioning with epochs taken only from signed packages                               | Denial/delay                                                                                                               | Compromised origin/runtime or availability                                     |
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

The detailed design and guarantees are in [V0.9.0](planning/V0.9.0.md). The following table is the historical v0.8 pairing assessment.

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
| Anonymous household flooding     | Creating a household is limited to 3 per client key an hour (`server/pairing-service/bootstrap-limits.mjs`); operators can cap households (`KIN_MAX_HOUSEHOLDS`) or close creation (`KIN_ALLOW_NEW_HOUSEHOLDS=false`). | Without `KIN_TRUSTED_PROXIES` behind a proxy, every client shares one allowance. Distinct addresses (or IPv6 /64s) each get their own; only the cap or closing creation bounds the total. |
| Malicious dependency/build input | Minimize dependencies, pin/review updates, protect build/release process, avoid remote scripts.                                                           | A compromised browser, build tool, dependency, or distribution channel can undermine client-side protections.                                                                             |

## Metadata and anonymity

The relay sees household/member/device/session identifiers; event IDs; per-device sequence; key epoch; cursors; public device keys; ciphertext and wrapped-key sizes; event counts/timing; provisioning grant participants/expiry; revocation and rotation timing; IP and connection metadata. Encrypted payloads hide semantic event kinds, text, titles, descriptions, categories, and entity identifiers. Traffic patterns and which devices share a household remain observable. Kin does not claim anonymity or zero-knowledge service behavior.

## Ephemeral live-channel messages (#257, #258, #259)

The live channel has a closed seam for short-lived messages ([SYNC](SYNC.md#ephemeral-envelope-v11-257-258), [ADR 0009](decisions/0009-ephemeral-signaling-boundary.md)); production accepts no category, so today it is an attack surface only for an authenticated trusted device sending a record that is refused and closes its own socket. For a category added later the model is:

- **Spoofed sender.** The sender in a delivery is stamped by the service from the sender's session; a request has no sender field.
- **Misdirection and probing.** Targets are canonical member and device IDs within the sender's household; others receive nothing and the sender learns nothing, so the path is neither a presence oracle nor a way to enumerate devices.
- **Stale or revoked routes.** Receivers are chosen from open sockets and re-checked at dispatch; losing access closes the socket, so nothing is routed after revocation, member removal, lock, sign-out or deletion.
- **Persistence by accident.** The path has no database, file, log or queue access; a test reads the source to keep it so. Messages are not replayed, exported or pushed.
- **Flooding.** A per-category rate, a payload limit, the 1 MiB socket backpressure bound (a receiver that cannot take a message misses it) and closing of abusive connections.
- **Not claimed.** The service sees envelope metadata (who sent what category to whom, when) for the instant it relays it. A media connection's own encryption is not Kin's household end-to-end claim.

## Sharing into Kin (#389)

Another app's share sheet POSTs the shared title, text, link and files to
`/share`. The service worker answers that request itself: the content stays
in the worker's memory under a random 128-bit id for at most five minutes and
is handed, once, to the Kin page that asks for that id. It is never written
to the Cache API, IndexedDB or any other storage, and it reaches household
data only when the member chooses a destination after unlock, through the
ordinary encrypted commands. When no service worker is in control, the POST
reaches the server, which discards the body unread and redirects to `/`.
Limits: while waiting, the shared content is plaintext in the browser's
memory (as it is in the sharing app); any page of Kin's origin that guesses
or learns the id could take it first, so the id is random and taken once.

## The Google Play app (ADR 0020, #527)

The Play app is a Trusted Web Activity: it opens
`https://kin.journeytocode.io` in the browser and contains no Kin code.

| What it adds | What that means |
| --- | --- |
| Google's `androidbrowserhelper` (with `androidx.browser`) in the Android app | Third-party code runs in the **app**, not in Kin: it launches the browser, hands over shared content and shows delegated notifications. It never sees household data except what the user shares into Kin, which it passes to the browser as the share sheet would, and the content-free push notifications Kin already sends (see "Push notifications reveal timing"). The app has no INTERNET permission and stores only which browser it verified and the splash image it hands over. Kin's web runtime, engine and server don't include it. |
| Storage shared with the browser | Kin's data, device keys, service worker and passkeys are the browser profile's for the origin, exactly as for the installed web app: the Play app and a Chrome tab on `kin.journeytocode.io` are the same Kin, with the same lock. Anyone who can use that Chrome profile can reach the same locked Kin either way. Clearing the site's data in Chrome clears it in the app; uninstalling the app doesn't. |
| A second way in through Android intents | Links to the origin and Kin's shortcuts open the app; other apps can share text, links, images and PDFs into it. Shared content follows the web share target's path ("Sharing into Kin" above): nothing reaches household data until the member chooses a destination after unlock. |
| Asset Links | `/.well-known/assetlinks.json` names the package and its signing certificates' fingerprints (public values). A wrong or missing entry shows a URL bar; it can't let another app open Kin full-screen. |
| Signing | Google holds the app signing key (Play App Signing). The owner's upload key, kept offline and never in the repository or CI, can only submit builds to Play, and Play support can replace it if lost or leaked (ANDROID "Lost upload key"). |
| Falling back | Without a TWA-capable browser the app opens a Custom Tab, with a URL bar, in the user's browser, never a WebView with its own storage. |

## Unreleased (Kin at home, ADR 0025): the home server and the connection relay

**Partly built.** The connection relay is built in `relay/` (#728) and not yet
deployed; the home server's side of the tunnel is built in `server/home/`
(#733); the control panel's setup and status pages (#719, #720) are built
in `server/home/` and `web/control/`; updates and backups are not. [ADR 0025](decisions/0025-kin-at-home.md) (epic #708)
decides a home server reached through a **connection relay**: a cloud
program that reads only the server name (SNI) from each TLS ClientHello and
splices the still-encrypted bytes to the home server over a tunnel the home
server dialled out. It is a different thing from the sync service, which this
document calls "the relay" (S4, S5). Nothing here is claimed as protection
until it is built and reviewed (#740 requires an independent review of the
relay, the tunnel, the SNI parser and the ACME client).

The ACME client (#723, [HOME-CERTIFICATES](HOME-CERTIFICATES.md)) is
started by home mode with a name (#733): TLS-ALPN-01 answered only for a
pending name, keys made on the home server and stored 0600, the free name's
CAA record set at the relay before the first order, and the daily CT check.

What the home side of the tunnel (#733) does, as built and tested on
loopback (`server/home/*.test.mjs`): the home key is made on the home
server, stored 0600 and never sent; the sign-in signature covers a TLS
exporter value, so it can't be replayed on another connection; the relay's
certificate is checked the normal way; TLS for each phone ends in the
service, and a test searches every byte the relay handled for HTTP text, a
session cookie and its token and finds none. Each stream is flow-controlled
(a stalled phone stops the response at its source). Client addresses are
taken from `OPEN` only on sockets the tunnel made, so a direct connection
can't claim one, and `X-Forwarded-For` is ignored on tunnel sockets even if
`KIN_TRUSTED_PROXIES` lists the address. Logs carry no address. A damaged
home key stops startup instead of being replaced. Two copies of one home
key (a restored backup running elsewhere) take the tunnel from each other,
each waiting a random time up to five minutes after losing it; the control
panel's status page explains `replaced` in plain words.

What the control panel (#719, #720) does, as built and tested on loopback
(`server/home/control-panel.test.mjs`, `setup.test.mjs`,
`control-setup-e2e.test.mjs`, `scripts/control-panel-regression.mjs`):

- **The setup code.** On first run (no name) the service prints a one-time
  code to its window and log: 10 characters from 29 without look-alikes,
  valid for one hour, used once, destroyed after five wrong tries, and only
  its SHA-256 is kept, in memory. A new code replaces the old one, at most
  one every 30 seconds. Anyone who can read Kin's log (the computer's
  administrators, `journalctl`, `docker logs`) can set Kin up; that is the
  same trust as running it. Until a name is set the app's own API is
  closed, so no household is made on `localhost`.
- **The loopback panel.** `http://localhost:<port>/control/` has its own API
  (`/control/api/*`), separate from the app's: only sockets from the
  loopback listener (never a tunnel stream, whatever its `Host` says), a
  loopback peer, a `Host` that is a loopback name with the listener's port
  (so a DNS-rebinding page is refused), no forwarding headers, and none at
  all when `KIN_TRUSTED_PROXIES` is set. Changes need `Origin` to be exactly
  the panel's, a JSON body and `Sec-Fetch-Site: same-origin` when sent, so
  another site can't drive it from the person's browser. After the code the
  browser gets a 30-day session (random 32 bytes, an HttpOnly, SameSite=Strict
  cookie for `/control`; its hash is stored 0600 in
  `home/control-sessions.json`).
- **Changes need a fresh confirmation.** On loopback, a confirmation code
  Kin prints to its window and log (10 minutes, once, five tries); through
  the household's address, the household admin's fresh passkey, or password
  for an admin without one, through the app's own flows and origin check.
  The setup steps themselves (name, terms, connect) are confirmed by the
  setup code and are refused once a certificate exists.
- **The status holds counts, not content:** states, dates, error codes,
  sizes and the number of households and trusted devices. No household
  content, no household, member or device identifier, no device label, no
  key, no ACME account URL and no address.
- **The app's origin is not widened.** `assertSecureOrigin`, WebAuthn's
  relying party and the app API's origin check keep the one origin,
  `https://<name>`.
- **Certificate alerts.** Fewer than 14 days left on the certificate, or a
  certificate in the CT logs this server didn't make, sends the household
  admins the usual content-free push, at most daily for each.

| Threat | What the design does | What remains |
| --- | --- | --- |
| The connection relay reads household traffic | TLS ends on the home server with its own key and certificate; the relay holds no key or certificate for any home server's name and never serves a page, script or service worker for one. App code always comes from the home server. | The relay sees names, phones' and the home server's IP addresses, connection times and sizes, and the home server's uptime (PRIVACY). |
| The relay operator (or someone who takes over the relay) gets a certificate for a household's free name | CAA with `accounturi` and `validationmethods=tls-alpn-01` (RFC 8657) binds each name to the home server's ACME account; unclaimed names have `issue ";"`. The home server checks Certificate Transparency daily for certificates it didn't make and alerts admins. | **The relay operator controls the DNS for its zone and carries the challenge traffic**, so it can change CAA and get a certificate. With it, it could serve its own app code to the household's phones, which would run as Kin (ask for passwords, read what the unlocked app shows). CT monitoring detects this only afterwards. Households that don't want to trust the relay operator use their own domain, where DNS and CAA are theirs and the relay can't get a certificate. The relay's zone has no DNSSEC at first. |
| A name passes to another home server | A name is bound to one Ed25519 home key forever; released or lapsed names are never given to anyone else (a name that never got a certificate is the only exception). Transfer needs the old key's signed tunnel and the new key's signature. | Whoever holds the home key and the ACME account key (the data directory or a backup) is the home server: backups are as sensitive as the computer. |
| A malformed or hostile ClientHello attacks the relay | A bounded parser (16 KiB, 4 records, 10 seconds) that reads only the `server_name` extension and refuses anything malformed; fuzz-tested. | Parser bugs before review. |
| Encrypted Client Hello hides the name | The relay's DNS publishes no ECH configuration, so browsers send the real SNI; own domains that publish one are refused. GREASE ECH is ignored. | The name each phone connects to is visible on the network path. |
| Tunnel takeover or replay | The home server signs in with its home key over a signature bound to the tunnel's TLS session (exporter); a newer tunnel replaces an older one. | A stolen home key. |
| A false client address breaks rate limits | The phone's address travels in the tunnel's `OPEN` frame; the home server uses it, and ignores `X-Forwarded-For`, only on tunnel streams. | A dishonest relay can lie about addresses; it gains no more than it could by dropping traffic. |
| Cookie tossing from a home name onto `kin.journeytocode.io` | A Public Suffix List entry for `home.kin.journeytocode.io`, and `__Host-` session cookie names on HTTPS origins. | Until both are in use (the PSL takes months), a home server under the zone could set cookies for parent domains. |
| Misuse of a name for something other than Kin | Per-name connection and bandwidth limits, claim limits, an abuse address and suspension. | The relay can't look inside connections, by design. |
| Relay down or unreachable | Devices are local-first and keep working; the home server reconnects with backoff; push, calendar sync and certificate renewal are outbound and don't need the relay. | No access from outside, or from inside without the relay (direct LAN access is deferred). |
| A stranger sends a household to a home server | Receiving needs a move code printed only on the home server's own computer (one use, one hour, five tries), then a bearer token for that one transfer; the package is checked whole, opened as a Kin database and validated, and refused if it clashes with anything already there (#739, ADR 0026). | An operator who gives the code away. |
| A malicious update | Releases are signed with an offline Ed25519 key built into the home server (#722); the launcher verifies the signature before reading the manifest, and the file's size and SHA-256 before running it, backs up first, tries the release as the sandboxed service and keeps it only after it passes its health check. A release is offered only when newer than the running one. | A stolen release key. Someone who can block or replay the release files can keep a server on the release it has (it never learns of a newer one). The account Kin runs as may write its install folder, so a process running as that account outside the sandbox could replace the executable; the service itself can't. |
| The home server's control panel | Loopback with a one-time code from Kin's window or log (single use, an hour, five tries), then a 30-day HttpOnly session; its own API with loopback-only, Host, forwarding-header and same-origin checks; or a signed-in household admin through the app's API. Every change needs a fresh confirmation: a printed code on the computer, the admin's passkey or password through the household's address. Built (#719, #720). | Anyone who can read Kin's log or window, or who holds a control session cookie on that computer, can use the loopback panel; a program running as the person who started Kin can read both. The browser opened by the launcher and the person's other tabs share the `localhost` cookie jar with any other local web app on that host. |
| The home server reaches into the LAN | The calendar fetcher's guard against private, loopback and link-local addresses stays on. | As for the hosted service ("Synced outside calendars"). |

## Security principles

- Assume household text and imported/persisted bytes are untrusted.
- Use standard cryptographic APIs and reviewed protocols; never custom cryptography.
- Minimize server knowledge and third-party script/dependency exposure.
- Fail closed on unsupported protocol versions, invalid authentication, and tampered envelopes; do not silently skip unknown content.
- Provide honest recovery and deletion behavior; do not promise recovery if all authorized keys are lost.
- Security claims require implementation, threat review, and validation, not documentation alone.

## Known limitations at v1.0

Plain language first, technical detail second. Each entry says who could
exploit it, what they would get, and what is planned. None of these lets a
stranger read household content without first controlling the relay server or
an unlocked household device.

### S4: the relay can hold back an event without the client noticing

**What it is.** A household's devices trust the relay to deliver every event.
A dishonest relay could quietly skip one, and the receiving device would not
know it was missing.

**Who and what.** Only someone running or controlling the relay. They could
make one device miss a change (an item added, a task completed). They cannot
read or forge the event.

**Detail.** Clients don't track a per-remote-device sequence high-water mark,
so a gap in another device's `deviceSequence` isn't detected. An honest relay
enforces contiguous device sequences on push.

**Planned.** Per-device sequence tracking on the client, with a visible
"missing changes" state.

### S5: revocation and rotation status come from the relay

**What it is.** When an Adult removes a device or rotates the household key,
other devices learn about it from the relay. A dishonest relay could hide a
revocation, or report rotation state that isn't true.

**Who and what.** Someone controlling the relay, working with a revoked
device. The revoked device could keep receiving keys for new epochs it should
no longer read, for example an expired committed-rotation package for an epoch
the relay reports, or a losing concurrent proposal's key. The relay still
cannot relabel a key as a different epoch: epoch numbers come only from signed
packages (#152).

**Detail.** The current committed epoch, the committed-rotation marker and
device revocation are relay-asserted (existing limitation R-3, Remaining
Limitations below). Kin no longer reuses a pending rotation key that was
wrapped for a device that has since left or re-keyed (#176), so an honest
relay is never handed such a key to keep.

**Planned.** Adult-signed revocation and rotation-commit records that every
device verifies.

### A6: a device that joins without sync keys is approved without a certificate

**What it is.** If a joining device submits its claim without sync keys, the
approval can complete without a device certificate.

**Who and what.** A buggy or modified client. The result is lost
availability, not exposure: other devices fail closed and won't send that
device keys, so it simply can't sync.

**Planned.** Require sync keys for every new claim.

### C4: most of the Content-Security-Policy is set in the page, not a header

**What it is.** Kin's main browser protection against injected scripts is
declared in the HTML page. Only `frame-ancestors 'none'` is sent as an HTTP
header.

**Who and what.** Matters only if something can alter the page before the
browser reads its meta tag, for example a misconfigured proxy that injects
content. Kin renders household text with text APIs, never as HTML.

**Planned.** Send the full policy as a header and add Trusted Types.

`img-src` allows `data:` images (beside `'self'` and `blob:`) so a report's
screenshot (ADR 0021 §3) can draw Kin's own page as an SVG image in browsers
that won't read a `blob:` one back. Images can't run script, and
`connect-src` still stops a data image from reaching any other origin.

### C5: the recovery key can linger in memory and on the clipboard

**What it is.** JavaScript can't wipe a string, so the recovery key text
stays in browser memory until it is garbage-collected. After "Copy key" it
also stays on the clipboard until something else is copied.

**Who and what.** Someone with access to the unlocked device, its clipboard
history, or a clipboard-reading app. They would get the recovery key, which
unlocks that device's copy of the household.

**Planned.** Clear the clipboard after about 60 seconds if it still holds the
key.

**Password managers (since #163).** Setup and key replacement mark the key as
a new password, so the browser may offer to save it, and the recovery unlock
form can autofill it. That is the person's choice; it puts the key wherever
their password manager keeps and syncs passwords, protected by that account.
Each entry is named for the device and the key's label ("Kin backup key —
Chrome on Android (K-7F3A)" since #563; "Kin recovery key K-7F3A" before),
because each device has its own key: under one shared name, saving a second
device's key, or a replacement, would overwrite the first, and a synced
password manager would offer it on devices where it can't work. The device
name is the automatic one, which the household service already knows, never
a nickname. The device remembers the entry name (with its label, never the
key) in its own browser storage so unlock asks for that entry; without it,
unlock asks for the older name. A replaced key's old entry stays until the
person deletes it; unlock asks for the current label's entry, so autofill
doesn't offer the old key. If setup fails and is retried, the retry has a new
key and label, so an unused entry may be left behind.

### C6: an export's header is readable without the key

**What it is.** The start of a Kin export can be read without its recovery
key. It shows when the export was made, how many changes and attachments it
holds, the Kin version, the vault ID, and the recovery wrapper IDs (from which
the recovery key label is computed).

**Who and what.** Anyone who gets the file. They learn those facts, not any
household content; the header is authenticated, so changing it makes the
export fail to open.

**Detail.** Package metadata is AAD for the archive key, not encrypted.

### C2 (residual): an opened attachment stays visible in its own tab after lock

**What it is.** Locking Kin revokes the attachment links it opened, but an
attachment already showing in another browser tab stays on screen until that
tab is closed.

**Who and what.** Someone who can see or use the unlocked computer after Kin
locks.

**Detail.** Object URLs are revoked on lock (#161); a browser cannot be made
to close or blank a tab the page did not create in a way it can control.

### Attachment removal by Limited and Temporary members is enforced by the app, not by sync

**What it is.** The app doesn't let Limited or Temporary members remove
attachments, and the relay refuses to delete a stored attachment unless the
uploader or an Adult asks. But the household event that marks an attachment
removed is not checked against the member's role when devices replay it.

**Who and what.** A Limited or Temporary member running a modified client.
They could hide an attachment from the household's view. The encrypted file
stays on the relay unless the uploader or an Adult deletes it.

**Detail.** Replay (`AttachmentRemoved`) doesn't know member roles; role
checks happen in the client (#156) and in the relay's blob deletion (#156,
server schema 9).

**Planned.** Carry member roles into replay, or move removal behind an
Adult-signed record.

### Push notifications reveal timing to push services (v1.1)

**What it is.** A device that turns on notifications (#85) gives the Kin
service a push endpoint run by its browser's vendor.

**Who and what.** The push service operator (Google, Mozilla, Apple or
Microsoft) learns when that device receives a push, which roughly tracks when
other members change something. The Kin service stores the endpoint and keys;
it already knew when the household had new events. Neither learns any content:
the payload is a fixed "something is new", encrypted to the device (RFC 8291).

**Detail.** Pushes are coalesced to at most one per device per two minutes.
Endpoints are allowlisted, so a subscription can't make the service contact
other hosts. Subscriptions are deleted when a device loses access.

**Planned.** Nothing further; notifications are opt-in per device.

### A published install identity is not encrypted (v1.1)

**What it is.** A household admin can choose to show the household's name and
icon on home screens (#78). That copy is stored by the service in plain form,
because the service builds the installed app's manifest from it.

**Who and what.** Anyone who can read the service's database or backups, and
the household's own trusted devices (which already know it). They learn the
published name, short name, description and icon, nothing else. It is off by
default, the panel says what is stored before the first publish, and only the
household's own trusted devices are served it.

**Detail.** Withdrawal and household deletion delete the row; backups taken
earlier keep it until they are rotated out. An installed app keeps showing the
old name and icon until its platform checks the manifest again, and on iPhone
and iPad until it is added again.

**Planned.** Nothing further; this is the opt-in trade the feature makes.

### Household chat: what the service and members learn (#104, v1.2.0)

**What it is.** The household chat epic ([ADR 0008](decisions/0008-household-chat.md))
adds a chat room with read receipts, typing indicators and "online now". This
entry records what the service and members can learn from chat; each story updates it.

**Who and what.**
- **The service** relays encrypted chat events and stores encrypted content
  blobs. It never sees message text, file names or contents, which message
  someone read, or what anyone typed. It does learn routing metadata: when a
  device holds a live connection, which device sent each event, roughly
  when messages are sent and how
  large they and their blobs are, and, while a member shares them, that a
  receipt, typing or presence signal passed between devices.
- **Household members** see each other's read receipts, typing and "online
  now" only while both share them; each member can turn off sending their
  own, which also stops showing them others'. None is kept as history: there
  is no "last seen".
- **Deleted messages.** Deleting or editing a message deletes its content
  blob on the relay and on every device (offline devices when they next
  sync); the log keeps the message event (who sent it, when, and that it was
  edited or deleted) but not its content. Nothing can recall what someone
  already saw, screenshotted, downloaded or exported, and a device that never
  syncs again keeps its copy.
- **Admin removal** of another member's message is shown to everyone as
  "Removed by an admin", never silent.

**Content blobs (#110, in place).** The service stores each message's
content as a blob sealed under that message's own key, which only the
encrypted chat event carries; it checks a blob's hash and records which
member and device uploaded it. A deleted blob's bytes are dropped on the
service with freed pages zeroed, and a tombstone (reference, size, uploader,
times) keeps it from being served or accepted again; a deletion that beats
its upload is kept as a claim that refuses the upload. Devices drop their
copies when they next read the chat. Only the uploader or a household admin
can have the service delete a blob; in a legacy household with no admin,
nobody can delete a removed member's blobs on the service (it fails closed).
The service also learns when each device fetches each blob (a read signal
to whoever runs it, finer than a read receipt) and when blobs are retired
(when messages are edited or deleted). Limits: any trusted device of the
household can upload blobs within the household's quota; a member who
copied a blob's bytes and key before deletion keeps them; service backups
keep deleted bytes as of backup time, and restoring one can bring deleted
blobs back on the service.

**Chat relay (#111, in place).** Chat events travel in their own relay
stream, encrypted and signed like household events and, until the chat key
(#123), under the household key epoch: anyone holding that epoch (every
device of the household that may sync) can read them, and the service can't.
The service learns each chat event's size, time, sending device and order,
and counts chat apart from household events, so it can tell chat activity
from other household activity. Devices accept a chat event only from a
verified household device, signed by it, with the same identity inside as
outside, so the service can't forge, alter or misattribute who wrote one; it
can still withhold or delay events, as for household sync. Two limits:
whether a deletion counts as an admin's removal rests on the service's
record of who is a household admin (the device directory's `householdAdmin`,
not signed by any device), applied when a page is read, so the service could
make a member's deletion show as an admin removal or hide a real one, and a
removal stops showing as one once its author is no longer an admin (its
content is gone either way). And an event that fails authentication is
skipped and reported rather than stopping chat, so a member's device can
send events other devices refuse, but can't block the room. The device keeps
chat events as those encrypted envelopes; the decrypted log lives in memory
only while unlocked.

**Edit and delete (#117, in place).** Editing replaces a message's content
blob and retires the old one; earlier versions aren't kept. Deleting for
everyone keeps the event (author and time) and retires the content
everywhere as devices sync; a delete wins over a concurrent edit. Deleting
"for me" is kept in a record sealed to the member's own devices and signed
by one of them: other members, and the service, can't read which messages a
member hid. That rests on the device directory: whoever can make a device
trusted for a member (an Adult approving it, a service that forges what the
directory says about revocation) can make it a recipient of later revisions,
as with household key rotation. The service learns that a member's record
changed, its size and when. A member's device that never syncs again keeps showing what it showed.

**Photos and files (#114, in place).** An attachment is one sealed manifest
(the message's content blob: caption, file names, types and sizes, and the
keys of its parts) plus one sealed blob per 1 MiB part and per photo
thumbnail, each under its own key. The service sees part sizes and hashes,
and the number of parts, which bounds a file's size to within a megabyte; it
never sees names, types or contents. Photos are drawn again on the device,
which drops their location, camera and other metadata; a browser that can't
do that refuses the photo. Other files are sent as they are, so a PDF's own
metadata goes with it. A member's device keeps decrypted names only while
the room is open. Deleting the message retires the manifest and every part
on the service and on each device that kept them; a copy a member saved or
downloaded is not recalled.

**Read receipts and typing (#120, in place).** A member's read cursor and
settings are one sealed slot on the service, a signed household-key envelope,
and typing is a sealed frame relayed over the live channel and never stored.
The service sees that a slot changed and when, its size, and that a typing
frame passed between two devices at some moment; it can't read a cursor, a
setting or whether anyone is typing, and it can't forge one without a
device's signing key. Because the slot is household-wide, any trusted device
of any member can read every member's cursor and settings, which is the
point; a member who doesn't want to be seen reading turns receipts off, which
clears their cursor. A malicious service can withhold or replay a slot or a
frame: a stale "Seen by" line, a missing one, or a typing indicator that lingers
at most 6 seconds. Presence shows "seen" when a message was on a member's
screen in a focused window, not that they understood it, and a member's
device clock can make a message look seen slightly early or late.

**Status.** Each chat story records its own detail here.

### QR pairing and phone sign-in (v1.1)

**What it is.** Invitations can travel as a QR code (#97), and a phone can
sign a computer in by scanning the computer's QR code and approving with a
passkey (#98).

**QR-jacking.** An attacker shows a victim their own computer's sign-in QR
code, for example on a page that looks like Kin, and hopes the victim scans
and approves it. Approval alone signs nothing in: the phone then shows a
6-digit code, and only a computer that types it finishes. The attacker's
computer is not in front of the victim, so it never sees the code unless the
victim reads it out or types it into the attacker's page. The code is
random, and nothing about the approval is released before it is typed, so
the QR code alone (photographed, or shown on a page) can't finish the
sign-in. The phone names the computer, says it will sign in as you, warns "Only approve a computer that's
in front of you." and says to type the code only on that computer. Three
wrong codes end the request, and each approval allows only those three
tries, so guessing the code means about one chance in 333 000 per approval.
**Residual:** a victim who approves and then types the code into a page the
attacker controls (a live relay) signs the attacker's computer in. That is
the same trust a person places in typing a one-time code anywhere; the screens
say where it belongs.

**A camera-swapped fingerprint vs a server-swapped one.** The QR code carries
the computer's key fingerprint along with the request. The service refuses an
approval whose scanned fingerprint doesn't match the keys it holds, and the
phone itself checks the keys the service returns against the fingerprint it
scanned before it signs a certificate. So a service that swaps the computer's
keys is caught by the phone, which read the fingerprint from the computer's
own screen. A camera that reads a different QR code (someone else's screen)
is the QR-jacking case above: the keys match that code, and the 6-digit code
is what stops it. The invitation QR code carries only the pairing code; its
fingerprints are still compared on both screens before approval.

**Which phone the computer trusts.** A new computer must pin the approving
phone's key before its first sync can verify anything. It learns that key
from the service, which could name a device of its own. The phone's tag
prevents that: an HMAC over the request and the phone's device ID and key,
keyed by the code and a nonce that only the QR code carries. The service has
the code but not the nonce, so it can't make a tag for a device of its own;
the computer checks the tag with the nonce and the code the person typed,
and pins only a directory key with the tagged fingerprint. Someone who
photographs the QR code has the nonce but not the code, and the service
releases nothing until the right code is typed (three tries in a million).
**Residual:** the service and a QR holder working together could forge a tag;
only comparing fingerprints by eye defends against that, and this flow
doesn't ask people to.

**Shoulder-surfing a QR code.** A sign-in QR code photographed by someone else
gives them a request they can't use: scanning it needs an Adult's trusted
session and a fresh passkey, and finishing needs the code shown on that
Adult's phone. It lasts 2 minutes. **Residual:** whoever holds it can end
the request (cancelling needs only the secret), and an Adult of any household
could scan and approve it under their own account, which ends the owner's
attempt; neither can finish it without the code. A cancelled request ends
the computer's screen, and the person shows a new code. A foreign approval
makes the computer ask for a code its owner never receives, until they
cancel or it expires. An invitation QR code is the invitation
code itself: whoever reads it can claim it, as with a code read over a
shoulder, and an Adult must still approve the claim after comparing
fingerprints. Either side can cancel.

**What the service sees.** Secrets and codes travel in URL fragments and
request bodies, never in a request URL, a log or a `Referer`. The service
keeps a verifier of the request secret, not the secret. It does receive the
6-digit code and keeps it only as a hash, which, with a million possible
codes, is no secret from the service itself; it keeps the tag as is. Neither
is any use without the QR code's nonce, which the service never sees. Audit
events hold IDs and outcomes only.

**Planned.** Nothing further for v1.1; comparing fingerprints by eye remains
the defence against a malicious service working with a QR holder.

### A fridge on a shared kitchen screen (#324)

A tablet left on the counter showing the fridge is an unlocked Kin: anyone who
picks it up can leave the fridge and see the household's lists, chat and
settings. Kitchen-screen mode and full screen deliberately do not weaken this
boundary or add a separate "kiosk" unlock: automatic lock runs as everywhere
(drawing counts as use, so a fridge in use stays open), locking leaves full
screen, and the rail states which applies on this device, including when
automatic lock is off. Households that keep a shared screen should turn
automatic lock on; Kin does not force it. A kiosk mode limited to the fridge
would need its own credential and is out of scope.

### A kitchen display is an unlocked adult's device (#669, ADR 0022 §4)

Kitchen display mode turns an Adult's device into a wall screen. It stays
unlocked and signed in as that adult, and **automatic lock doesn't apply**
while it is a display: a screen that locked after five minutes would be no
use on the wall. The trade-off, stated to the adult before they turn it on:

- **Anyone in the kitchen can see and tick household things**: today's
  events and the week, the children's chore charts, today's meals, the
  shopping list, the fridge, and the newest chat messages (read-only). What
  they tick or add is recorded as this adult's device, as any change on it
  would be; chore points still go to the chore's owner.
- **Hidden, not just undrawn**: the adult's private storage (journal, Just
  for me, reminders), Search, item details, Household settings, every admin
  action, Chat composition, shares and keyboard shortcuts have no panel and
  no route: every address opens the display. This is a layout on an
  unlocked device, as Simple view is (above): someone with the device and
  developer tools, or who reads its storage while it is unlocked, gets what
  the adult's unlocked Kin holds. Don't make a device a display if that
  matters; a display is for the shared kitchen, not a hallway in a shared
  house.
- **Leaving needs the adult's passkey or password** (on a device set up
  before accounts, the household's backup key, which is what unlocks it),
  checked on the device by opening its vault once more, so it works offline.
  A wrong one is refused calmly.
- **A child's reward needs the same secret** (#705). Rewards (kind 78) are
  the one setting the display offers, so saving or removing one there, and
  Undo or Redo of one, first asks for the adult's passkey or password (or
  the backup key) with the same on-device check as leaving; cancelled or
  refused, nothing is written. This stops someone in the kitchen changing a
  child's reward with the adult's authority; ticking chores, shopping and
  the fridge stay open by design. It is a check in this device's Kin, not a
  new authority: as above, someone with the unlocked device and developer
  tools could still write a reward, and the service can't tell the
  difference (rewards are end-to-end encrypted). The phone's chart doesn't
  ask (the owner's decision): there the adult's own unlocked Kin already
  allows every change, and automatic lock applies. The display can still be **locked** like
  any Kin (closing the browser, a lock from another tab), and unlocking
  needs the same secret; after an unlock it opens as the display again.
- **Switching the feature off, or a member who isn't an Adult**: if the
  household turns "Kitchen display" off, or the service says this member
  isn't an Adult, the display **locks** rather than opening the adult's full
  Kin to whoever is in the kitchen.
- **Stored on the device:** whether it is a display (for one household's
  vault), its night hours and its photo frame wait, unencrypted in local
  storage, like the display preferences. No household content.
- **Screen:** it keeps the screen on with the Screen Wake Lock API where the
  browser allows, dims on a night schedule and shows family photos when
  quiet. Photos on the screensaver are visible to anyone in the room, as
  they are to everyone in the household.

### Simple view is a layout, not a lock (#341)

An admin can turn on Simple view for a Limited member
([ADR 0013](decisions/0013-simple-view.md)). The service enforces who changes
that switch, and Chat and Fridge access; it can't enforce anything else,
because household events are end-to-end encrypted and it can't tell a
child's "done" from any other change. A child's device holds the household
key, so with other software it could write any household event, and the
service would accept it. Simple view hides the rest of Kin; it doesn't
prevent it. The flag is cached on the child's device so an offline unlock
keeps Simple view; turning it off reaches that device only when it next
connects. A device belongs to one member, so a tablet registered to an Adult
shows the Adult's Kin; a child needs their own device.

### Household features are a layout, except Chat and Fridge (#623)

A household admin can switch features off for everyone
([ADR 0021](decisions/0021-kin-for-everyone.md) §2). The service records the
set (`households.features_off`), and only a household admin with a fresh
passkey (or password, for an admin without one; see above) can change it;
a change names the revision it was made from, so a stale screen can't
overwrite another admin's choice. The service enforces **Chat and Fridge**:
while either is off, its routes refuse every member, admins included, as
for "No access", and nothing new reaches the chat or the fridge. Everything
else is a **layout, not a lock**, as for Simple view: household events are
end-to-end encrypted, so the service can't tell a meal or a routine from
any other change, and every device still holds the household key and the
whole history. A member's device with other software, or one that hasn't
heard of the change yet (offline, or a Kin from before this addition), still
shows and writes Meals, Routines, notes and the rest, and other devices
accept those events; they stay in the history and show again when the
feature is switched on. The device keeps the last set it heard of, so an
offline unlock hides the same things; a household that doesn't sync keeps
its set on its one device. Switching a feature off never deletes data.

### The sitter page is a layout, not a lock (#442)

The sitter page ([ADR 0017](decisions/0017-sitter-page.md)) chooses what a
Temporary member's Kin shows first; it doesn't limit what that device can
read. While access lasts, a Temporary member's device holds the household key
and the whole household history, so with other software it could read every
note, reference record and routine, not only those on the page. Access ends
with the existing Temporary expiry.

Only Adults may change the page, and the app enforces that, not replay: Rust
doesn't know member kinds, so a Limited or Temporary member running a
modified client could write a `SITTER_PAGE_SET` event and other devices would
accept it, as for attachment removal above. The page can only point at
records already in the household, so the worst case is a rearranged or
emptied page that an Adult sets again.

### Family photos: who may remove a photo is enforced by the app, not by replay (#673)

The family album ([ADR 0022](decisions/0022-family-hub.md) §5) holds photos
everyone in the household can see. Its images are ordinary household
attachment blobs: encrypted on the device under the household key, uploaded
to the same relay, unreadable to the service. What the service learns is the
same as for any attachment, plus that an attachment is an album photo (its
ID starts `a1b0`) and how many there are and how big.

Only whoever added a photo, or a household admin, may remove it (owner
decision). Rust records who added each photo but doesn't know who is an
admin, so the check is on the app's single command append path
(`canRemoveAlbumPhoto`), as for the sitter page. A member running a modified
client could write an `ALBUM_PHOTO_REMOVED` event for someone else's photo,
and other devices would accept it. The relay still refuses to delete the
encrypted file unless its uploader or an Adult asks, and Undo can bring the
photo back for an hour; after that, an Adult's device deletes the unneeded
blob. The worst case is a removed photo the person who added it can add
again.

A removed photo's encrypted file stays on devices and the relay for up to an
hour (so Undo works) before the next sync pass deletes it. Photos another
device added are downloaded the first time they are shown and kept on this
device in `kin-album:<household>`, sealed like the household's other
attachments; "Start over on this browser" deletes that database too.

### The chore chart's rules are kept by the app (#676)

The chore chart ([ADR 0022](decisions/0022-family-hub.md) §6) has three
rules Rust can't fully enforce, because it doesn't know member kinds or the
service's settings: only Adults set points (kind 77) and rewards (kind 78),
and an adult joins (kind 79) only while a household admin allows adults.
The app enforces them on the single command path; a Limited member running
a modified client could change a routine's points or a reward, or an Adult
could join while adults aren't allowed (their card shows only on devices
where the setting is on, which it isn't). Replay does enforce that a member
joins or leaves only for themselves: a kind-79 event naming someone else has
no effect. Points are a household game derived from completions anyone in
the household can already record; they protect nothing.

### Prepared invitations: a printed sheet is an invitation (#613, ADR 0021 §4)

"Set up Kin for someone" lets a household admin prepare an invitation for one
person and print it as a one-page sheet. Security review of what changes
against an ordinary invitation:

- **What the service holds.** A row in `prepared_invitations` (server schema
  27): the household, the inviting member and device and that device's key
  fingerprint, the member kind (and a Temporary member's end), whether the
  person starts in easy mode, the times, the code's verifier, and the
  **card**. The card (the person's name, the helper's name and an optional
  note) is sealed on the admin's device with AES-GCM under a fresh random
  128-bit key that only the link's fragment carries
  (`/pair#code=…&k=…`); Kin never sends the key, and browsers never send a
  fragment, so the service, its operator and a stolen database copy can't
  read the names. Easy mode and the member kind are readable, as for any
  invitation's kind.
- **The code's verifier.** Ordinary codes are verified with an HMAC keyed by
  a per-process secret, which is why a restart ends them. A prepared code must
  survive a restart, so its verifier is a domain-separated SHA-256 of the
  8-character code (about 40 bits). Someone holding a copy of the database can
  recover a still-open code by brute force. What that code gets them is what
  the sheet gets anyone: a **claim**, never membership; see the next point.
  The row is deleted as soon as the code stops working (approved, cancelled,
  expired, the household deleted), so old backups hold only codes that have
  ended, unless the backup was taken while one was open.
- **Lifetime and guessing.** A prepared code lasts 1 to 7 days instead of 10
  minutes, so it is open to online guessing for longer. Guessing is limited
  as for every code (12 failures a minute per client), the answer to a wrong
  code is the same generic one, at most three prepared invitations wait per
  household, and each is single-use: the first claim holds it, and approval
  spends it.
- **Approval stays the gate.** A claim joins nothing and reveals nothing of
  the household until the inviter approves it with a fresh passkey (or
  password), after comparing the joining device's fingerprint, exactly as for
  any invitation; the joining device then compares the inviter's fingerprint
  before it finishes. A sheet that is lost, photographed or intercepted in
  the post lets its finder *ask* to join; the helper sees a request they
  weren't expecting (or a device name that isn't Rose's) and a fingerprint
  that doesn't match Rose's screen, and cancels. If the finder claims first,
  Rose's own attempt says the invitation was already used, and the helper
  cancels and makes a new one: an annoyance, not a way in. The sheet says
  "Keep it private: anyone with it can ask to join".
- **A day to say yes.** A prepared invitation's claim waits up to 24 hours
  for approval (an ordinary claim: 15 minutes), because the helper may not be
  at hand. Like every claim it is process-local: a restart while she waits
  ends the claim and the code works again until it expires.
- **In person.** The safest way is side by side: Rose's screen shows her
  device's code, the helper's screen shows the same one ("The codes match on
  both screens"), and after approval Rose's screen asks "Do these match?"
  against the code on the helper's screen. Remotely, they compare by phone,
  which is only as good as knowing it's really Rose on the line.
- **No unattended pre-approval (deferred).** A pre-approval made before the
  sheet is posted can't be bound to the joining device's key, because that
  key doesn't exist until Rose opens the link; bound only to the code, it
  would turn the paper into a bearer credential that admits whoever holds it
  and gives them the household's keys. The only binding that keeps today's
  guarantee is a comparison of the claim's fingerprint on both devices,
  which is the in-person path above. Pre-approval is therefore not offered.
- **What stays in memory.** The admin's device keeps the code, the card's key
  and the names only in the open page, to print the sheet again; they are
  never stored, so after Kin closes or locks the sheet can't be reprinted
  (cancel and make a new one). The joining device turns easy mode on from
  the invitation before the password is set (a presentation setting, kept
  in `kin.easy-mode` like text size).

### Reports to the Kin team are readable by the operator (ADR 0021 §3)

A problem report's typed text and picture, and a suggestion's text, are
plaintext on the service: its operator (and anyone with the database or a
backup) can read them. When forwarding is on, the typed text and the
diagnostics are also readable by whoever can read the issue tracker, which
is everyone for a public repository; the preview warns, and the operator
guide recommends a private one. Pictures never leave the service. A picture
shows whatever was on screen, household content included; it is off by
default, shown before sending, croppable and warned about, but Kin can't
tell what in it is private. The diagnostics are limited by construction (a
fixed table and a code registry the service re-checks), not by review.

An unsent report waits unencrypted in the device's `kin-feedback-outbox`
until it is sent or removed, so someone with the unlocked browser profile
can read it. Reports sent without signing in are rate-limited by address
only (2 an hour, 5 a day, 60 an hour across the service); behind a proxy
without `KIN_TRUSTED_PROXIES` every client shares those limits. A signed-in
member can make the service store up to 5 reports with 1 MiB pictures an
hour; the service caps stored reports at 20,000 and pictures at 1 GiB. The
GitHub token, if configured, can write that repository's issues; scope it
to Issues on one repository.

### Synced outside calendars are readable by the service (ADR 0022 §3, #667)

A calendar a member syncs is fetched by the Kin service, which reads it in
plaintext while it holds it (at most 30 minutes in memory) and relays it to
the devices in its audience over TLS only, not end-to-end encrypted. The
service's database holds each calendar's private link in plaintext, because
it must fetch it: the operator, or anyone with the database or a backup, can
read those calendars for as long as the links work. Members are warned
before turning sync on; importing a file instead keeps the calendar off the
service.

The fetcher is a way for members to make the service request URLs, so it is
guarded against server-side request forgery (server/calendar-fetcher.mjs):
`https:` on port 443 only, no credentials in the link; every address the host
resolves to must be public unicast (no private, loopback, link-local,
carrier-NAT, multicast, documentation, benchmarking, 6to4, Teredo or other
reserved IPv4 or IPv6 range, and IPv4-mapped or NAT64 IPv6 judged by the
IPv4 address), checked again on every redirect hop (5 at most, never away
from https), and the connection goes to the address that was checked, so DNS
rebinding between check and connect doesn't work; 2 MB and 15 seconds per
fetch, no compressed answers; 10 calendars per member, 30 per household and
20 additions per member an hour; backoff from 5 minutes to 6 hours after
errors. Residual risks: the service still reaches any public HTTPS host a
member names (it can be used to send a GET to a public site about every 30
minutes per calendar, and to learn whether a host serves something that looks
like a calendar); an operator whose own network treats a public address as
internal (for example an allowlist by source address) is not protected by
these checks. Feeds are parsed only on the devices, by the same bounded Rust
parser as file import.

### v1.0 was not tested across every browser and device

**What it is.** v1.0 shipped on the owner's decision with limited real-world
testing. The automated browser suites run the full flow on Edge for Windows on
every change. Beyond that, only the owner's and a few testers' use of the test
server on real phones and computers was recorded. Firefox, Safari on macOS,
Chrome on Android, installed-app updates and offline launch, roaming security
keys, separate networks and moving an export between physical devices were
not run ([V1.0_RELEASE_ACCEPTANCE](audits/V1.0_RELEASE_ACCEPTANCE.md)).

**Who and what.** No attacker gains anything from this. People on untested
browsers or devices may hit problems nobody has seen yet.

**Planned.** Run the remaining rows on later releases and report problems as
issues.

## Remaining Limitations

The incubation service stores identity and relay records in memory. Full restart loses household identity, sessions, pairing state, relay envelopes and cursors; surviving local encrypted history cannot alone resume that household's sync. A relay-only reset is detected against local high-water and exact cached envelopes are requeued when identity survives. Encrypted archive restore recovers local data only. There is no transparency witness, pre-join history grant for new adults, server-identity recovery or remote erasure. Missing epoch keys pause sync. Key-grant epochs come only from signed packages, so a relay cannot relabel an old key as a newer epoch. The current committed epoch, the committed-rotation marker and device revocation are still relay-asserted, so the expiry relaxation for committed-rotation packages only keeps an honest relay consistent; it gives no protection against a malicious one. Such a relay can serve any expired package signed by a device in its directory for an epoch at or below the epoch it reports, including a losing concurrent rotation proposal's key or one signed by a device it has hidden the revocation of. It still cannot relabel a key as a different epoch. Adult-signed rotation and revocation records are the long-term fix. Wrapper removal alone cannot invalidate a copied wrapper plus its secret; explicit root replacement in v0.10.2 protects newly re-encrypted local data, while prior copies remain exposed. New runtime private keys are imported nonextractable, but that is not hardware-backed storage. A compromised unlocked runtime defeats confidentiality. Independent security review and production operational hardening remain required.

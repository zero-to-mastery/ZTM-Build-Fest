# Privacy

v0.17.0 Checklist Steps add no Step-specific server interpretation or metadata.
Step labels, IDs, parent associations, and event semantics remain inside
canonical events protected by the existing local and sync encryption
boundaries. Rendering uses text nodes/textContent; household Step text is not
treated as HTML or sent to an AI service.

**Status:** Current as of v1.6.0. Local protected content is encrypted after verified migration. Sync is optional and uploads client-encrypted canonical event envelopes. The durable service receives no plaintext household event payloads or content keys, but it sees and persists routing and traffic metadata; no anonymity or zero-knowledge claim is made.

v0.10 encrypts local canonical events, duplicated outbox content, protected metadata
and private sync key material. Household drafts remain in unlocked memory only;
lock/reload discards them. Startup removes historical sessionStorage draft keys.
Locked startup does not load/replay household plaintext. The content-free
`household-locked` peer message and durable lock epoch invalidate peer capabilities.
Minimal routing IDs, format/lock state, ciphertext lengths and root wrappers remain
visible. Recovery secrets are user-held: Kin never persists them or sends them to the relay. If the person accepts, the browser saves one in its own password manager (THREAT-MODEL C5).

While unlocked, a tab keeps one decrypted copy of the household event history
in memory so it does not decrypt everything again for each change. It is never
written anywhere. Locking, closing the tab, or a lock from another tab
zero-fills and drops it; see [THREAT-MODEL](THREAT-MODEL.md) for what that
does and does not guarantee.

A refresh of the same tab can reopen the household without unlocking again
([ADR 0010](decisions/0010-reload-resume.md)). For that, the tab keeps a
non-extractable key in IndexedDB while unlocked and, only while the page
unloads, writes the root sealed with that key to its own sessionStorage. Both
are deleted when used, after two minutes, on any real lock, and when the
setting is off. No household plaintext or raw key is stored.

Local reminders are in-memory timers in one tab only and are never persisted.
A lock suspends them. While locked, Kin keeps only each reminder's record id,
due time and local vault id; it keeps no title and no timer, so nothing can
notify. Unlocking the same vault re-arms them with titles read from the
freshly decrypted records. A reminder that came due while locked fires once
after unlock. Reminders for records that were archived or removed are dropped,
as are reminders from another vault. Logout, leaving or deletion of the
household, and restoring an export discard reminders entirely. Reload and tab
close also discard them.

With private storage on (#520), a reminder is a private record in the
member's own private log instead: sealed under their member key, relayed only
to their own devices, and readable by none of the household's other members,
its admins or the service. It names the item or routine by ID, its due
instant, and the setter's UTC offset and IANA time zone at that instant (so
another device can say "9:00 where it was set"); never the item's text. Each
device that allows notifications arms it from the log with the title read
from the household records while unlocked, exactly as above; dismissing it
on one device records that it was dismissed, which clears it on the others.
The time zone is a coarse location; it stays inside the member's private
storage. Personal settings that follow the member (theme, text size, reduced
motion, reminder alerts, the app icon count) are private records the same
way.

Same-origin tabs may exchange the fixed `events-changed` notification over `BroadcastChannel` after a committed write. The notification contains no household or event content; each tab reloads the event log from IndexedDB and reconstructs its own view locally.

Since You Last Looked stores only a local event cursor and local timestamp in the existing `local_context` singleton. A cursor means that this installation explicitly advanced through a boundary; it does not identify a person or assert that a named member read anything. Viewing or marking the summary does not write a household event. The additional `view-state-changed` BroadcastChannel message is a fixed, content-free marker; it carries no cursor, IDs, count, text, actor, or device.

Household information can be highly personal. Sync remains disabled until an authenticated adult explicitly enables it. Local-only use continues without sync.

## Intended principles

Future preferred member names and member/device groupings must be presentation
carried in encrypted household events; they must not become relay authorization
metadata. The existing automatic technical device name remains the narrow
exception needed to identify a device before provisioning. Typed nicknames are
not sent to the relay, and a preferred-member-name implementation must preserve
that boundary. See
[Member and Device Identity Acceptance](IDENTITY-PAIRING-ACCEPTANCE.md) for
the migration and cross-platform privacy checks.

- **Local-first:** Begin with data stored and processed on the user's device where practical.
- **Minimum server knowledge:** If a service is introduced, design it to know as little household content as reasonably possible.
- **No advertising and no sale of data:** These are product commitments for the intended direction.
- **No household-content analytics:** Do not collect household content for analytics.
- **No default AI processing:** Household content will not be sent to an AI service by default. Kin is not designed around an AI runtime.
- **Encrypted synchronization:** v0.9 encrypts canonical event bytes before upload and verifies device signatures on recipients. A compromised authorized browser/runtime can still read content.
- **Explicit device authorization:** Pairing and local fingerprint comparison bind generated device keys before provisioning.
- **Device revocation:** Sessions are invalidated and future epochs rotate; prior plaintext/keys cannot be recalled.
- **Clear export and deletion controls:** These should be designed before meaningful household data is stored or synchronized.

## Local-first progression

The v0.1.0 release stores a local event history in browser storage and reconstructs state locally:

```text
Browser
   |
   v
IndexedDB
   |
   v
Rust reconstructs state
```

No remote sync exists in v0.1.0. Local-first describes where this release processes data; it is not a claim that browser storage alone is secure against device compromise, shared browser profiles, or malicious extensions.

## v0.9 Encrypted Sync Boundary

```text
Parent A
    |
  passkey
    |
 household key
    |
 encrypted events
    v
 sync service
    v
 encrypted events
    |
 household key
    |
  Parent B
```

The browser encrypts the exact canonical event bytes and signs envelopes with a device key. The service authorizes, stores, and forwards opaque envelopes; it does not reduce household semantics or hold plaintext epoch keys. Passkeys authenticate members and are not content keys. Full implementation details are in [V0.9.0](planning/V0.9.0.md).

The service still sees household/member/device/session IDs, event IDs, per-device sequences, key epochs, cursors, ciphertext sizes, event counts/timing, provisioning participants, revocation timing, IP addresses, and connection patterns. It can infer which devices share a household and when they synchronize. Encryption does not make traffic anonymous.

Package-v2 exports keep canonical household events, an optional bounded
membership snapshot and protected attachments inside the encrypted payload.
Their public authenticated manifest reveals format/application versions,
export time, event/attachment counts and attachment ciphertext byte count so
compatibility and bounds can be checked. It does not expose household text or
IDs, membership records, credentials, device trust, sessions, or server
authorization. The encrypted membership snapshot is descriptive only. An
archive and its recovery key do not authorize pairing or sync.

The v0.11 implementation candidate stored identity, credential-verification
metadata, trusted-device authorization, opaque relay ciphertext, cursors,
provisioning coordination and bounded security audit entries in SQLite.
Successful relay acknowledgements follow a committed SQLite transaction;
recipient delivery/read, backup existence and hardware-level persistence are
not guaranteed. Sessions, WebAuthn ceremonies, unclaimed pairings and
rate-limit windows are process-local and reset on restart. Local event bytes
and cached exact envelopes remain on devices that hold them. Service backups
contain sensitive routing metadata and encrypted envelopes, and a stale restore
could roll back revocations or key epochs. v0.12 adds a durable deletion
state-machine, immediate session/write invalidation, a 30-day cancellation
window, final service-side purge and a minimal tombstone. Existing-target backup
restore merges newer tombstones; restoring without the newer database/ledger
remains a disclosed rollback limitation. Local event bytes, keys and exported
copies remain on devices that hold them. New/replacement adults do not receive
pre-join epoch keys in v0.9; missing history may be unavailable. All
trusted-device/key loss can make content unrecoverable. See [V0.11.0](planning/V0.11.0.md)
and the [Threat Model](THREAT-MODEL.md).

Push notifications (v1.1, #85): off by default, per device. The service
stores each subscribed device's push endpoint and keys, and already knows
from the relay when a household accepts an encrypted event. A push carries a
fixed payload with no content, event type, author or count, and nothing about
delivery or clicks is recorded. The push service a browser uses (Google,
Mozilla, Apple or Microsoft) sees its own endpoint and when pushes arrive.
Revocation, removal and household deletion delete subscriptions. See
[Push notifications](PUSH.md).

Count on the app icon (#476): off by default, per device. When a member
turns it on, the installed app's icon shows a number (unread messages, and
optionally their own things today), worked out on the device from decrypted
state; nothing about it is sent to the service. The number is shown
**outside the lock**: anyone who can see the device's home screen, dock or
taskbar sees it, including after Kin is closed, and it tells them how much
is waiting (never what). Locking Kin and signing out clear it; turning the
setting off clears it at once. The browser and operating system receive only
the number.

Published install identity (v1.1, #78): off by default. If a household admin
turns on "Show our name and icon on home screens", the service stores the
household name, a short name, an optional description and the icons without
encryption, so it can build the installed app's manifest. Only the household's
own trusted devices can fetch them. Withdrawing deletes the copy, as does
deleting the household; backups taken while it was published still contain
it. The unlocked app uses the name and icon from encrypted household settings,
not this plaintext copy, so withdrawing publication does not remove internal
branding. See
[Household identity](HOUSEHOLD-IDENTITY-DEFAULTS.md#published-install-identity).
The latest accepted encrypted identity revision is cached only in the device's
root-protected sync-key store for offline startup. Its decrypted icon URL is
session-scoped and is revoked when Kin locks, logs out, or changes households.

Device names (v1.1, #71): the server keeps only each device's automatic name
("Chrome on iPhone", or "Device"), which it needs to show approvers which
device is asking to join before that device holds any household key. A name
someone types is a nickname: it travels only inside encrypted household events,
so the server, its logs and its backups never contain it. Labels typed before
v1.1 are reset to "Device" when the service starts, with freed database pages
zeroed and the write-ahead log truncated. Backups taken before that still
contain them until they are rotated out, and restoring one brings them back
until the next start resets them again. See
[Identity](IDENTITY.md#device-names).

Account key vaults (ADR 0018, #564): a member's device may store the
member's keys on the service, sealed so the service can't read them. The
service learns that the member has a vault, its size, its version and when
it changes (which hints at key rotations), how many ways it can be opened
and of which kind (password, passkey, both, backup code), and the public
parameters for those (a password salt, a passkey's credential ID). It never
receives the vault key, a password, a passkey's PRF output or a backup
code. Deleting the household deletes the vaults; backups keep old copies.
See [Cryptography](CRYPTOGRAPHY.md#account-key-vault-adr-0018).

A passkey and a backup code for an account (#560, #571): the service also
learns **when a member adds a passkey, changes their password, turns
"require password and passkey" on or off, or makes a new backup code**
(each changes their wrappers or verifier; the audit log records
`passkey_added`, `password_changed` and `password_reset`), and keeps, for a
backup code, **SHA-256 of a key derived from it** so it can check a
backup-code sign-in. That value never leaves the service and can't be turned
back into the code. A backup-code sign-in is recorded like any new-device
sign-in (method `backup-code`). The code itself, its printout and the
exports it opens stay with the member.

Username and password sign-in (#557, #558): for a member who signs up with
a password, the service now stores **a username** (with the member, in
normalized lower-case form, unique among active members) and **an Argon2id
verifier of a key derived from the password** (`authKey`), with the
password's salt and iteration count. It never receives the password itself,
nor the separate password-derived key that opens the member's vault and
their devices' local data. It learns when the member signs in with the
password and from which address (as for a passkey login), and how many
attempts failed (to limit them). Whether a username is taken is answered to
anyone signing up, as on any sign-up page, at a limited rate. A username is
chosen by the member and can be anything that fits the rules; it need not
be a real name or an email address, and Kin has no email system. Deleting
the household deletes the usernames and verifiers. Removing a member, or a
member leaving, deletes their username, verifier, account vault and its
wrappers on the service (backups keep old copies), and the username can be
chosen again. The member's preferred display name, typed at
first run, is a household event like before: encrypted, never seen by the
service.

A member set up the old way who moves to an account (#575) gives the service
the same things, from then on: a username, the password's verifier and
parameters, and an account vault (`account_migrated` in the audit log); the
service still never sees the password, the passkey's PRF output or the
vault key. Members who decline give it nothing new. "Not now" on the Today
invitation is remembered on that device only (a date in browser storage).

"Start over on this browser" (#592 follow-up) removes Kin's databases and
storage entries from that browser and ends its session; the service learns
only that the session ended, and later that the member signed in again.

**Private storage for each member (ADR 0019, #489).** A member's private
things (the journal, "Just for me", reminders that follow them) are sealed
under a member key that only their own devices hold, read from their account
vault; no other member, household admins included, can read them, and the
service can't either. For each member who uses private storage the service
learns: that they use it; how many private events and blobs they have, how
large and when; which of their devices sent each one; and the member-key
epoch number each is sealed under (which says how many times their key
changed after a device of theirs was revoked). Never their content. Only that
member's other devices are hinted that something changed. A household admin
can turn private storage off for children and teens (it is on by default);
that only stops the service relaying it, and nobody gains access to what is
already on the child's devices. Temporary members have none. Removing a
member deletes their private stream on the service; deleting the household
deletes every member's. Copies on the member's own devices stay, as for
household data. Household exports never include private logs; a member saves
their own private things in a separate file only they can open (#493,
PORTABILITY "A member's private things"), made on their device and never sent
to the service, and restorable only for themselves. Reminders and
settings that follow a member (#520) make the member key on the member's
first private change: a reminder, or a setting changed from Kin's default
(a device that already has some brings them the first time it opens with
private storage). From then on the service learns that the member uses
private storage.

**Just for me (#510).** Private to-dos, notes on them and the member's
"show on my Today" setting are private-log records (kinds 110–118): sealed
like every private event, so the service sees only their count, size and
timing. They show only on that member's devices: in Lists › Just for me
and, when the member's setting is on, on their own Today and This week,
marked "Private"; never in Simple view, household search, the sitter page,
calendar (.ics) exports or household exports. A deleted item stays in the
member's private log (so Undo can restore it), like every private record.
Moving something between private and the household is always an explicit
choice: **Share with the household…** asks first and names who will see it,
then writes an ordinary household item, which every member can read from
then on; **Make private** archives the household item (the household keeps
its archived record, as with Archive) and keeps a private copy. The
household item made by sharing has an ID derived one way (SHA-256) from the
private item's, so it reveals nothing about the private log.

**The journal (#496).** Entries and their photos are private records: the
service learns how many private events and photo blobs a member has, their
sizes and times, never a word or a picture. Photos are drawn again before
sealing, so no location or camera details are kept. Search, the month jump
and On this day run on the member's own device over what it decrypted;
nothing is indexed on the service, nothing reaches household search, Today,
chat, catch-up or exports, and nothing is ever a notification. The draft
stays in the unlocked page only.

**Household features (#623, ADR 0021).** When a household admin switches
parts of Kin off (Household › Features), the service learns **which features
the household switched off**, when, and which admin did it (its audit log),
and tells every member's device the set with its revision. It learns nothing
about how the household uses the features that stay on, and nothing about
what is inside the ones switched off: that data stays end-to-end encrypted in
the household's history, untouched. Each device keeps the last set it heard
of in browser storage (`kin.household-features`, with the household's ID), so
an offline unlock hides the same things; it names features, never content,
and "Start over on this browser" removes it. A household that doesn't sync
keeps its choice on its one device and the service never learns it.

The planning design for these boundaries is documented in [Identity](IDENTITY.md), [Pairing](PAIRING.md), [Synchronization](SYNC.md), [Cryptography](CRYPTOGRAPHY.md), and the [Threat Model](THREAT-MODEL.md). These documents specify intended properties and open decisions; they do not establish implemented security guarantees.

## Data lifecycle

The implemented service retention policy distinguishes routine archival,
household deletion, device revocation and member removal in
[RETENTION](RETENTION.md), and specifies user-controlled portable copies in
[PORTABILITY](PORTABILITY.md). Service backups remain operator-managed with no
automatic expiry. Full encrypted relay history is retained until final
deletion or the hard event cap; it is not compacted. Deletion does not erase
copies already held by devices, archives or external backups.

### Voice messages (#134)

Kin asks for the microphone only when a member taps Voice, and releases it the
moment recording stops, is discarded, the page is hidden or the chat locks. A
recording stays on the device until it is sent as an ordinary sealed chat
attachment; nothing is uploaded while recording or reviewing, and nothing is
transcribed or analysed. The waveform (64 numbers) and the length travel
inside the sealed attachment manifest, so the service sees only a file of
ciphertext parts like any other.

### Chat in exports (#136)

An export can include the household chat (on by default, with its size shown
first, and only on a device that may read chat). It is encrypted with the rest
of the export, under the same recovery key, and holds chat events, message
text, photos, files and voice. Messages deleted for everyone appear only as
deleted placeholders. Your "delete for me" list goes only in your own export.
A file you export is outside Kin's control: anyone with it and its recovery key
can read the chat as of that moment. The admin's chat policy (#123) still
applies: a member who may not read chat has no chat to export, and restoring an
export does not give a device chat access it has not been given
([PORTABILITY](PORTABILITY.md#household-chat-in-an-archive-v11-136)).

## Reports and suggestions to the Kin team (ADR 0021 §3)

- **Only on Send.** A report or suggestion leaves the device only after the
  person presses Send on a preview that shows everything in it and where it
  goes. There is no automatic crash reporting, no telemetry, and diagnostics
  are never collected until a report is opened.
- **What it holds:** the person's typed text; diagnostics from a fixed table
  (version, browser, system, screen size, text size, installed or tab, the
  page as a route name, easy mode and Simple view, sync state and last sync
  time, storage use, online state) and up to 50 recent error codes from the
  in-memory diagnostic ring buffer, which accepts only codes from a fixed
  list and numbers; and, only when chosen, a cropped picture of Kin's own
  screen. Each diagnostic can be removed in the preview. No household text,
  names, usernames or IDs are in the diagnostics; the service re-checks
  them against the same table.
- **Where it goes:** to the Kin service, which stores it in plaintext for
  its operator, linked to the member (for rate limits and their status) or,
  from the lock screen and setup, to nobody. If the operator forwards
  reports, the title, typed text, diagnostics and reference become a GitHub
  issue with no household or member ID, username or picture; in a public
  repository anyone can read the typed text, and the preview says so.
- **How long:** 180 days, sooner on member removal or household deletion
  ([RETENTION](RETENTION.md)).
- **On the device:** an unsent report waits in `kin-feedback-outbox`, an
  IndexedDB database outside the encrypted household stores (a report can
  be written when no household key is open), until it is sent or removed.

## Outside calendars synced by the service (ADR 0022 §3, #665)

Turning on sync for a Google, Apple or Outlook calendar is opt-in per
calendar, and the member is told first: "Your Kin server will download this
calendar about every 30 minutes and can read it while it does."

- **What the service reads:** the calendar itself, in plaintext, whenever it
  downloads it (when a device in its audience asks and the service's copy is
  30 minutes old or more). Unlike household content, a synced calendar is
  **not** end-to-end encrypted on its way to the devices: it reaches them
  over the same TLS connection as everything else.
- **What the service keeps:** in its database, the calendar's private link
  (plaintext: anyone with the link can read that calendar), who added it,
  who sees it ("Just me" or "Everyone in the household"), when it was added
  and last fetched, the last error code and the calendar server's ETag.
  Never the calendar's events: a downloaded feed is held in memory for at
  most 30 minutes and is never written to the database or logs.
- **Who sees it:** the member who added it, or everyone in the household
  (Limited and Temporary members included) when they chose so. Only Adults
  can add one. Other members never get the link back from the service.
- **The calendar's own server** sees the Kin server's address and a request
  about every 30 minutes, with the Kin server's ETag; nothing about the
  household.
- **On the devices:** each device in the audience parses the feed itself
  and keeps it sealed by its local vault (`kin-calendar-feeds:<household>`).
  The events never enter the household history or exports.
- **How long:** until the member turns it off (or a household admin does),
  the member leaves or is removed, or the household is deleted; then the
  link and status go from the service, and each device drops its copy the
  next time it lists its calendars ([RETENTION](RETENTION.md)).
- **Importing** a `.ics` file instead never involves the service.

## The family hub (ADR 0022, v2.0.0)

The Calendar, the family album, the chore chart, meal plans and the kitchen
display are household content like items and routines. They follow the rules
above unless this section says otherwise; synced outside calendars are the
exception and have their own section above.

- **Calendar events and member colours** (kinds 71–74) are encrypted events
  in the household history. The service learns only what it learns for any
  event: that a device wrote one, its size and its time. Every member sees
  every event, as for items; attendees and colours are visible to the
  household like members' names. Events are in household exports and `.ics`
  exports.
- **Importing a `.ics` file** happens on the device: the file is parsed in the
  app and never sent anywhere. What is imported becomes ordinary household
  events, so everyone in the household sees it. The import screen says so
  before the file is chosen.
- **The family album** (kinds 75–76) stores photos as household attachments,
  encrypted like every attachment. Because album photos have their own quota,
  the service learns which encrypted blobs are album photos, how many there
  are and their sizes, never what they show or their captions. Removing a
  photo removes it from every device's album; copies already saved elsewhere,
  or in older exports, stay.
- **The chore chart** (kinds 77–79): points and rewards are worked out on
  devices from completions already in the history; there is no score stored
  anywhere, nothing about points goes to the service, and totals cover only
  the current week. Children's weekly totals are visible to the household,
  including other children (owner decision). An adult appears on the chart
  only if a household admin allows adults **and** that adult joins; the
  service stores the admin's setting (a yes or no and a revision), not who
  joined. There are no notifications about points.
- **Meal plans and favourites** (kinds 80–82) are household content like
  dinners.
- **The kitchen display** shows household things to whoever is in the room
  while it stays unlocked as one adult's device: today and the week, the
  children's charts, meals, shopping, the fridge and recent chat messages,
  read-only. It never shows that adult's private storage (journal, Just for
  me, reminders), and leaving it needs their password or passkey. The adult is
  told this before turning it on; THREAT-MODEL explains why it is a layout
  rather than a lock. It sends nothing new to the service.

## Unreleased (Kin at home, ADR 0025): a home server and the connection relay

**Partly built.** The connection relay is built in `relay/` (#728) and not
yet deployed; it keeps exactly what is listed below. The home server's side
is not built. [ADR 0025](decisions/0025-kin-at-home.md) (epic
#708) decides how a household can run Kin on its own computer, reached
through a **connection relay** (a cloud program that forwards encrypted
connections; not the sync service, which Kin's documents call "the relay").
Nothing below is in use yet; this section records what was decided, so the
built version can be checked against it.

- **The home server** is the Kin service running in the household's home. It
  sees exactly what the hosted service sees today (sections above), and the
  person who runs it is its operator. Household content stays end-to-end
  encrypted, as before.
- **What the connection relay can see:** each home server's name (for
  example `smith.home.kin.journeytocode.io`), the home server's IP address
  while it is connected and when it is online, phones' IP addresses and
  which name each connects to, when connections open and close, and how many
  bytes go each way.
- **What it can't see:** anything inside the connections. TLS ends on the
  home server with the home server's own certificate; the relay has no key
  for it. Pages, app code, requests, events, chat, photos, cookies, passwords
  and passkeys pass through it encrypted. It doesn't know the household's
  name, members or devices.
- **What it keeps:** a registry of names (name, a hash of the home server's
  public key, the claim date, the last day it connected, own domains, its
  certificate-authority account link, suspended or not), kept while the name
  exists; retired names forever as the name and key hash only; and hourly
  counts of connections and bytes per name for 30 days. Phones' addresses
  are held in memory only, for rate limits, for at most 24 hours. No access
  logs and no per-connection records. This is what the open-source relay
  does; a household can't verify from outside what a relay operator
  actually runs.
- **Names are public.** A home server's name appears in public Certificate
  Transparency logs (as every HTTPS site's does) and in plain text at the
  start of each connection (the SNI).
- **What the home server sends out:** as today, Web Push to browsers' push
  services, outside-calendar downloads and, if its admins turn it on, report
  forwarding; and in addition, requests to Let's Encrypt for its
  certificate, a daily check of a Certificate Transparency search service
  (crt.sh by default) for its own name, and a daily check for updates (#722:
  GitHub, where releases are published, sees the home server's address and
  when it checks; nothing is sent but the request, and with no release key
  built in there is no check). None
  of these carries household content.
- **The home server's control panel** (#719, #720, built) shows its
  operator and the household admins the connection, the certificate, the
  storage used and how many households and trusted devices there are: counts,
  never what a household keeps, nor any member's or device's name. Its
  one-time codes are printed to the home server's own window and log; the
  browser on that computer keeps a control-panel session whose token is
  stored on the server only as a hash.
- **Backups on the home server** (#721, built) hold the database (as
  encrypted as the service's) and the home server's keys and settings, but
  not the control panel's sessions. They stay in the `backups` folder of
  the home server's own data folder (the 14 newest), and are never sent
  anywhere; a copy to a drive the household chooses is planned. The control
  panel shows their dates and sizes only. Whoever has a copy can act as the
  home server, so they are as private as the computer.
- **Moving from the hosted service** ([ADR 0026](decisions/0026-moving-a-household.md),
  #738, #739): when a household admin moves the household, with a fresh
  passkey or password and a code read on the home server, the service sends
  that household's records to the home server's address: the same
  encrypted history, chat, fridge, private spaces and attachments, account
  vaults (only their password and backup-code wrappers), password and
  backup-code checks, members, and devices' public keys. No device token,
  passkey, push subscription, invitation, report or audit record is sent.
  The hosted service keeps a record that the household moved and where to,
  and refuses its sessions; nothing is deleted there until an admin closes
  the household (the usual 30 days).



Kin implements client-side encrypted event sync, but it has not received independent security review or production operational hardening. Do not call the service zero-knowledge, anonymous, or robustly recoverable; do not imply cryptography protects a compromised unlocked browser/runtime.

## v0.5.0 Pulse

Fixed Pulse value/expiry stay in local canonical events. No analytics, history UI, scores, interpretation, external service or content-bearing broadcasts. Expiry hides current detail without deleting source events. No actor ID/name is displayed. See [V0.5.0](planning/V0.5.0.md).

## v0.6.0 Since You Last Looked

The summary derives household changes without monitoring people. It includes no read receipt, member-view tracking, actor attribution, contribution analytics, individual event timestamps, activity timeline, or summary history. It is processed locally, with no analytics, AI, or external service. See [V0.6.0](planning/V0.6.0.md).

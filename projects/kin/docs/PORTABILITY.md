# Portable Household Data

**Status:** v0.40.1 preserves explicit Temporary-member removal separately from natural expiry in the v0.39/v0.40 package-v2 flow. v0.40.0 adds a package-format-v2 manifest in the existing KARC v1 encrypted container. Package metadata is authenticated with the encrypted payload. The payload keeps exact canonical event history, a validated membership snapshot when available, protected local context and attachment records, including ciphertext and digest metadata. Since refactor Slice 9 Kin writes package format 3, which seals the same contents as a stream of segments (below); it still reads package format 2, which v0.47 and earlier wrote. Development-era package-v1 files are refused (refactor track, D3). The complete package remains bounded to 160 MiB; attachments remain bounded to 64 records and 50 MiB ciphertext. Membership snapshots are descriptive data only; credentials, sessions, device trust and authorization are never restored from an archive. Earlier conceptual sections below are design history.

Current attachment and export limits are in [ATTACHMENT-ARCHIVE-LIMITS](ATTACHMENT-ARCHIVE-LIMITS.md). The pre-v0.39 corrective line keeps attachment ciphertext at a 50 MiB household bound and permits a bounded 160 MiB complete `.kin` archive, including protected snapshot serialization and KARC framing. Rust and browser import/export validation share this archive ceiling; the earlier 64 MiB figure below is historical.

## v0.23.0 calendar export

The Lists page can create a separate, unencrypted `.ics` convenience export
from active Items with explicit planning dates. It contains Item text and
all-day dates, not the canonical event corpus or household metadata. The UI
warns before the user requests a download. The file is a one-way snapshot for
calendar applications; it is not an encrypted backup, sync channel, archive
restore, or import format. Export is limited to 10,000 Items and 16 MiB, and
does not alter Kin storage.

## Implemented archive boundary

**Stable architecture decision (v0.10.2/v0.10.3): archives carry household
history, not authority.** They grant no membership or trusted-device authority.
Device approval and encrypted sync remain separate ceremonies; possession of an
archive and its recovery key is not proof of current membership.
Root rotation does not change old archives: each retains its original recovery key.

The public metadata carries package version, a bounded event/attachment summary,
recovery-wrapped root metadata and encryption parameters. The body is raw
AES-GCM ciphertext, avoiding redundant
base64 expansion of the whole archive. HKDF purpose `kin/archive/v1` separates its
key from local-record keys; manifest metadata is authenticated as AAD. The encrypted
body contains exact canonical rows and protected replay/catch-up context. The
normal export includes recovery wrappers (never a password or passkey
wrapper) and, for a member with an account backup code, a wrapper that opens
with that code (see "Exports that open with the backup code" below); it
never emits plaintext JSON or device private keys. Store the export and its
recovery key (or backup code) in different places, and write down which key
label goes with which export (see Recovery key labels below).

Restore requires an unlocked empty target and the archive's recovery key. Kin
validates the manifest, authenticates and decrypts the complete payload, checks
attachment integrity and plans the whole canonical replay before browser
encryption/atomic import. The transaction checks that
the target history and transport stores are still empty. Imported events remain
byte-for-byte identical; fresh anonymous local actor/device IDs prevent new local
commands from impersonating the source trusted device.

### Streaming archives (package format 3, refactor Slice 9)

Package format 3 keeps the KARC v1 container and the archive's contents but
seals them as segments instead of one value, so export and restore never hold
the whole household as one serialized value, one plaintext and one
ciphertext. Inside the ciphertext region each segment is `length:u32` and its
AES-256-GCM ciphertext, in this order: the local context row, one segment per
attachment record, then the history in chunks of 256 events (each chunk:
count, then local sequence and length per record, then the canonical
records). Every other event row field is derived from the canonical bytes on
restore. `web/security/archive-stream.js` documents the layout.

All segments are sealed under one key for the archive, derived from the root
with HKDF (purpose `kin/archive-stream/v1`, a fresh 32-byte salt, the
authenticated metadata in the derivation info). Each nonce is a random 8-byte
prefix and the segment's index; the additional data names the index and
whether the segment is the last. The reader decides "last" from position, so
a dropped, repeated, reordered or truncated segment fails to open, and the
segment count and chunking must match the authenticated manifest's counts.

Export reads the history from the session arena the unlocked app already
holds (nothing is decrypted again) and writes the archive into one buffer of
its final size. Restore opens segments one at a time into one event arena,
replays it from the engine's own history for the import plan, then protects
rows 256 events at a time before the same single atomic transaction as
before. Both report progress, which the security panel shows as a progress
bar. At 10,000 events with 4 KB of text, export took 0.2 s instead of 20 s
and restore 15 s instead of 26 s, and each needed less than half the extra
memory (docs/audits/REFACTOR-BASELINE.md, Slice 9). The archive is about 30%
smaller because canonical records are no longer base64 text inside it.

Restored history remains local until the device completes normal household
approval. After approval, the ordinary encrypted sync path binds imported
historical identities to the approved device, deduplicates canonical event IDs,
and catches up with current authorized state. Restore alone supplies no server
trust, cookies, provisioning entitlement or epoch access. A stale archive
cannot reverse server-side removal, expiry, revocation or key state.

## Recovery key labels

Each device has its own recovery key, and an export opens only with the key
its device had when the export was made. Replacing the key doesn't change
exports already made. To tie them together, every recovery key has a short,
non-secret label such as `K-7F3A`: the first 4 hex characters of SHA-256 over
the recovery wrapper's random ID and the vault's root version
(`web/security/key-label.js`). Both values are already public in the security
manifest and in every export's authenticated header, and neither comes from
the key, so the label reveals nothing about it. Two keys can share a label by
chance (1 in 65,536); it is for a person to match, not an identifier.

- The label is shown with a new key when it is created or replaced, in
  Settings → Recovery key, and in the export's success message.
- Export files are named `kin-<YYYY-MM-DD>-K-XXXX.kin` (the date in UTC). The
  name shows when an export was made and which exports share a key, to anyone
  who can see the file list; rename it if that matters.
- Before asking for a key, the restore screen reads the export's header and
  says when it was made and which label opens it.
- A wrong key names the label that opens the export.
- The label is computed from the header, so the archive format is unchanged
  and exports made before labels existed show one too.

The storage rule, used everywhere Kin mentions exports: **Store the export and
its recovery key in different places, and write down which key label goes
with which export.**

## Exports that open with the backup code (#572)

**Decision: an export from a member with an account backup code opens with
that code**, not with the password. A device set up with a password (or with
a passkey alone) has no per-device backup key, and the backup code is the
one secret such a member keeps for exactly this: 256 random bits, printed
and kept at home. Sealing exports for the password instead was rejected: an
export file can be copied anywhere, and a password-sealed export could be
guessed offline at PBKDF2 cost, which is the very exposure adding a passkey
removes from the service (ADR 0018 D3).

How (CRYPTOGRAPHY, "Exports for a member with a backup code"): the export's
security manifest gets one more `recovery`-type root wrapper, **after** the
device's own recovery wrappers if it has any. Its 32-byte secret is
HKDF(VK, "kin/export-backup-code/v1", vault ID), and it carries the code's
vault wrapper as `backupCode: { householdId, memberId, wrapperId, version,
wrapped }`. Restoring with the code: the code opens that vault wrapper (VK),
VK derives the secret, the secret opens the root. Offline, with nothing but
the file and the code.

- **Format.** Still package format 3 (and 2 still read); the only addition is
  the optional `backupCode` field on one recovery wrapper of the header's
  manifest, which the archive key authenticates with the rest of the header.
  Exports made before #572 are unchanged and open exactly as before.
- **Which code.** The one current when the export was made: making a new
  code doesn't change exports already made, and the old code keeps opening
  them (and only them). Keep each code until you no longer need the exports
  made under it, or make a new export after a new code.
- **Both.** A device that also has its own backup key (households set up
  before accounts) makes exports that open with either; older Kin releases
  find the device key first, as they always did, and can't use the code.
- **Restore screen.** It says whether an export opens with the account
  backup code, a device's backup key, or both; one field takes either (the
  code is recognised by its shape: 8 groups of 7 letters and numbers).
- **Needs a connection.** The device fetches the code's current vault wrapper
  from the service when exporting; a device with its own backup key still
  exports offline.
- The export grants no authority, as before: the code opens the history in
  the file, never membership or device trust.

## A member's private things (#493, #494, #495)

**A household export never includes private data.** The journal, the "Just
for me" list, and the reminders and settings that follow a member live in
that member's private log (ADR 0019), which the household export never
reads. A member saves their own copy separately, under Security → Backup and
move → **Your private things**:

- **Save my private things** makes one file, `kin-private-<date>.kinp`
  (format KPEX 1, CRYPTOGRAPHY "A member's own export of their private
  things"): every private change this device holds, exactly as it's kept
  (each sealed under the member key for its epoch), and the member's journal
  photos, newest first, **as long as the file stays under 64 MiB**. Photos
  that don't fit are counted and named in the message ("3 journal photos
  didn't fit in the file and aren't included; they stay in your account").
  The whole is sealed under the member key; nothing of the household's (no
  household event, key, setting or chat) is in it.
- **Who can open it.** Only that member: on any of their own devices (their
  vault gives the member key), or, for a member with an account backup code,
  with the code alone (the file carries the code's vault wrapper and the
  member keys under the vault key). Without a backup code the message says
  so, and suggests making one.
- **Restore my private things** takes the file and, only if Kin asks, the
  backup code. Kin restores private things **only for the member who saved
  them**: a file naming another member or household is refused before
  anything is opened, and every change in it must open under this member's
  own key. What's already here is skipped by event ID, so restoring twice, or
  on a device that already has it all, adds nothing ("Everything in this file
  is already here. Nothing was duplicated."). Photos come back as pending
  uploads.
- **What a restore can't do.** Changes the service no longer has (for
  example after a service restore from an old backup) come back on the
  device that restores them; the relay takes only a device's own new
  changes, so another device gets them by restoring the same file there.
- **Format.** New, additive (V1.0-COMPATIBILITY): the household package
  formats (2 and 3) are unchanged.

## Ownership principle

### Household chat in an archive (v1.1, #136)

An export can include the household chat. Choosing it adds, after the
history, to the same sealed stream (package format 3; the container and
format number don't change): one segment of notes (who exported, and the
messages they deleted for themselves), the chat events in chunks of 256, and
one segment per chat blob that fits. The package manifest names the counts
(`chatEventCount`, `chatBlobCount`, `chatBlobBytes`), which are authenticated
like the rest; an export without chat has none of them and is byte-for-byte
what package format 3 has always been, so every release reads it; a release
from before this change refuses an export that includes chat rather than
ignoring part of it. Layout: `web/security/archive-stream.js`,
`web/chat/chat-archive.js`.

- **What goes in.** Every chat event this device holds (the engine's own
  canonical bytes, without the transport envelope), and the sealed content
  blobs (message text, photos, files, voice) this device still has for messages
  that still exist. Blobs are added newest first until the archive's 160 MiB
  limit is reached; older ones that don't fit are left out and the export says
  how many (they stay in Kin and on the household's relay, and open from there
  as usual). The size is shown, and the box is on by default, before the export
  is made. Only a device that may read chat offers it.
- **What stays out.** A message deleted for everyone (by its author or an
  admin) is exported as the events that say so, a deleted placeholder with
  no content: its blobs are already removed and are never added. Edited-away
  versions are gone the same way. Another member's "delete for me" list is
  not on this device and cannot be exported; the exporting member's own is,
  and a restore keeps it only for that member.
- **Memory.** The chat events are the buffer the chat room already holds;
  blobs are read one at a time as their segment is sealed. Restore reads one
  segment at a time and holds the chat's events and blobs (never more than the
  archive's 160 MiB) until the whole file has been checked.
- **Restore.** Before anything is written the engine decodes and replays every
  chat event (each must be a chat event of this household, with a unique ID),
  every blob must hash to its reference, and the counts and sizes must match
  the manifest. Corruption anywhere fails the whole file, as for the rest of
  the archive. The household is then restored in its one atomic transaction
  and the chat is written next, into its own storage (chat storage is a
  separate database): if that second step fails, the household is restored and
  Kin says its chat is not, and restoring the same export again completes it.
  Each event is stored sealed by the local vault (it has no relay signature to
  check until the device is approved) and the blobs go to the chat blob store.
  An event the relay already gave this device is left as it is.
- **After restore.** Chat appears once the device is approved. Syncing then
  brings what the household did after the export (new messages, edits and
  deletions) and stores nothing twice. A deletion for everyone made after the
  export arrives as an ordinary chat event and removes that content on this
  device, so a restore never brings back content that was deleted for everyone
  after the export was made while the household is still syncing. A blob this
  device already deleted is never stored again.
- **Trust.** An imported event carries no relay signature; it is trusted
  because the archive is authenticated under its recovery key. When the
  household syncs, the relay's signed copy of each event replaces the
  imported one in place, and from then on it is authenticated like any other.
  A deleted message's post event still names its content key; the content
  itself is not in the export or on the relay, but a copy of the old
  ciphertext someone kept elsewhere would still open with it.
- **Replacing the recovery key.** Imported chat events not yet replaced by the
  relay's copy are sealed by the vault's root, which a recovery key replacement
  changes. Chat then opens without them rather than stopping, and restoring the
  same export again seals them afresh. Events from the relay are unaffected.
- **Consistency.** An export is a snapshot: the events, the deletions that
  decide which blobs are left out (including a deleted attachment's parts) and
  the manifest counts are read together, so events that sync meanwhile are not
  half in the file.

### The family fridge in an archive (#363)

An export always includes the family fridge when this device holds any of it
(the fridge is small: at most 250,000 events of a few hundred bytes). It adds,
after the history and any chat, the board events in chunks of 256 to the same
sealed stream (package format 3, KARC 1). The package manifest names
`boardEventCount`, authenticated like the rest; an export without a fridge has
no such key and is unchanged, and a release from before this change refuses an
export that has one rather than ignoring part of it. Layout:
`web/security/archive-stream.js`, `web/board/board-archive.js`.

- **What goes in.** Every board event this device holds, as the engine's
  canonical bytes without the transport envelope. Erased strokes, cleared
  boards and taken-down magnets go in as the events that say so, exactly as
  the household sees them; nothing is filtered or flattened. A member with no
  access to the fridge exports none.
- **Restore.** Before anything is written, every event must decode as a board
  event of this household with a unique ID, the count must match the
  manifest, and the engine must replay the whole fridge. Corruption anywhere
  fails the whole file. The household is restored first; the fridge is then
  written into its own storage, each event sealed by the local vault (store
  `board-import`). If that step fails the household is still restored, and
  restoring the same export again completes it. An event the relay already
  gave this device is left as it is.
- **After restore.** The fridge shows at once. When the household syncs, the
  relay's signed copy of each event replaces the imported one in place, and
  what the household drew after the export arrives as usual.
- **Replacing the recovery key.** As for chat: imported events not yet
  replaced are sealed by the vault's root, so the fridge opens without them
  rather than stopping, and restoring the export again seals them afresh.

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
desktop measurements in [V0.10.0](planning/V0.10.0.md) quantify the practical limit.

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

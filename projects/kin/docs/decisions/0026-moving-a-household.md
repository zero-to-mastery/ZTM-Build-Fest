# ADR 0026 — Moving a household to a home server, server to server

Status: **Accepted** (#737, tasks #738 and #739, epic #708). The owner chose
the shape on 2026-10-25, the hosted service sending the household's records
straight to the home server, which the admin authorizes on both ends, and
answered the open questions the same day (recorded at the end). It replaces
the plan in [ADR 0025](0025-kin-at-home.md) §12, which assumed the existing
household export could carry a household to a new server; it can't
(Context). Built so far: the move package (`server/move-package.mjs`) and
the home server's receiving side, the move code and `/api/move/*`
(`server/home/move-receive.mjs`, #739; [HOME-SERVER](../HOME-SERVER.md#moving-a-household-here)).
The sending side's server (#738: the move routes, the frozen and moved
states, the sender, undo and closing; `server/household-move.mjs`,
`server/move-sender.mjs`) is built too, and so are the app's screens (#737): the admin's
*Move to a home server* (Household access), the moving and moved screens in
the household panel and on Today, and sync stopping for good on
`household_moved` and waiting on `household_moving`
(`web/components/household/move.js`). Re-joining uses the existing
new-device sign-in, and the existing Today card offers the new passkey
(a new address has no passkey and fresh storage).

*As built (#737, screens).* Marking devices carried over from the old
address, and removing them together (§6), came later: see the #769 note
below.

*As built (#738, server).* Three choices this record didn't make:

- **The move's state is its own table**, `household_moves` (schema 30), not
  new `lifecycle_state` values: that column's CHECK would need the
  households table rebuilt, and deletion keeps working unchanged (closing a
  moved household is the existing deletion). The table stays behind when a
  household moves.
- **A moved household refuses every session, reads included** (§5 said
  downloads would still work), as a household pending deletion does: the
  whole history is at the new address, and a device's changes that never
  reached the old server stay on it either way. `/api/status` tells the
  device where the household went (`householdLifecycle.state` `moved`,
  `movedTo`, `undoUntil`, `remindAt`), so the app can say so; the device
  cookie is kept for that and for undo and closing, which go through the
  trusted device with a fresh passkey or password.
- **While it is being sent**, sessions get `household_moving` (409) and keep
  their cookies; the admin who started it can follow it. A send cut short by
  a restart leaves the household in use (`move-interrupted`).

*As built (#739).* The package travels in pieces (§3): `start` with the
move code returns a bearer token for one transfer (two hours, kept as its
hash), then 8 MiB `chunk`s by offset, `status` to resume, and `finish`,
which checks the size and SHA-256 before the package is opened. Node's
request time limit (5 minutes) and slow home uplinks make one 4 GB request
impractical. After the import Kin restarts, as after setup, so every part of
the service loads the household. A device's stored record carries its token
hash too; the package clears both. Marking carried-over devices (§6) is in
the #769 note below.

*As built (#769).* The mark is `carriedOver: true` in the device record. The
home server's import sets it on every device that arrives unrevoked (it isn't
in the package, and it isn't guessed from a missing token: a new device has
none for a moment too), and removes it from a revoked one, so a second move
marks afresh. Giving a device a token here removes it. `/api/devices`
reports it, and People & devices shows "From the old address · can't sign in
here", without Verify or Replace. An admin removes the ones left over with
`POST /api/devices/carried-over/revocation/options` and `/finish` after one
fresh passkey or password confirmation (409 `nothing_carried_over` when none
are left). The server revokes the devices it listed at options that are
still marked and still have no token, all at one time and in one access
change, so there is one new household epoch; each gets a `device_revoked`
audit entry with reason `carried_over`. Rows are revoked, never deleted, so
history still verifies and certificates still endorse a new sign-in. Removal
isn't held back until everyone has re-joined: the confirmation names who
hasn't signed in here yet and how they still can (password or backup code,
or a recovery invitation). A household moved before this has no marks; its
old devices are removed one at a time. The last-admin and last-Adult checks
count a marked device only once it has a token, since until then it can't
sign in here (#778). Nothing backfills the mark for a household moved
before it (#779): the move and the mark ship in the same release, so only a
household moved on a development build has none, and a missing token alone
can't tell a carried-over device from one that lost its token for another
reason.

## Context

ADR 0025 §12 planned the move from what exists: an admin exports the
household (PORTABILITY), "creates Kin from that export" at the home server's
address, and the others re-join. Looking at what exists:

- **No flow starts a household on a server from an export.** Restoring an
  export fills one browser's storage; the device keeps the old household's
  ID, and sync refuses it under any other household ("This export belongs to
  another household", `web/storage/event-store.js`). A fresh server's first
  run always makes new household, member and device IDs
  (`server/pairing-service/sessions.mjs`).
- **Identities don't carry over.** Every event names its author's member and
  device IDs inside its signed bytes. A member who joins a new server gets a
  new member ID, and nothing maps the old one to it.
- **Accounts can't move.** A member's vault (ADR 0018) and each of its
  wrappers are sealed with the household and member IDs as associated data,
  and live only on the service, with the password and backup-code verifiers.
  There is no route that exports them.
- **A passkey can't open a vault at another address.** Its PRF output
  belongs to the old name, and once a member adds a passkey the
  password-only wrapper is removed (ADR 0018 §2). Such a member opens their
  vault elsewhere only with a backup code.

What can move is the household's **server-side record**: everything the
hosted service keeps for it is ciphertext, public keys, signed envelopes and
metadata. With the same household, member and device IDs on the home
server, every event, every vault and every signature stays valid: a member
signs in at the new address with their username and password (or backup
code) and their new device downloads the whole history, as any new device
does today.

## Decision

### 1. The move, step by step

1. **On the home server**, set up as usual (name, certificate), its operator
   asks the control panel on that computer for a **move code**: one use, one
   hour, five tries, printed to Kin's window and log like the other codes
   (ADR 0025 §11). The panel shows the server's address and the code.
2. **On the hosted service**, a household admin opens *Move to a home server*
   (Household settings). Kin shows who is ready (§4), then asks for the
   address and the move code, and a fresh passkey or password, like every
   admin change.
3. **The hosted service sends the household** (§2) to
   `https://<address>/api/move/receive` with the code. The household on the
   hosted service is **frozen** while it goes: no uploads.
4. **The home server checks and imports it** (§3) and answers with a
   receipt. The hosted household becomes **moved** (§5): it points every
   member's app at the new address. If anything fails, the hosted household
   is unfrozen and nothing changed.
5. **Each member opens the new address** (the moved banner links to it) and
   signs in with the same username and password, or their backup code. Their
   vault opens, the device certifies itself with their certification key
   (ADR 0018 §3) and the whole history arrives. Then Kin offers a new
   passkey, as on any first sign-in.
6. **When everyone has moved**, an admin closes the old household with the
   existing deletion (30 days' grace, then purge). Nothing on the hosted
   service is deleted before that.

No file of the household's records ever exists outside the two servers.

### 2. What moves, and what doesn't

The hosted service builds a **move package**: a SQLite database holding
only this household's rows, made with the same verified copy as backups
(`VACUUM INTO` of a filtered copy, then opened and validated), streamed as
the request body.

| Moves (as stored) | Doesn't move |
| --- | --- |
| The household, its settings, lifecycle and install identity | Sessions and device tokens (`token_hash` is cleared): every device signs in again |
| Members, kinds, admins, display names, usernames | Passkeys (`credentials`): bound to the old name |
| Account vaults, their password and backup-code wrappers, the password and backup-code verifiers | Passkey and password+passkey vault wrappers: useless at another name, dropped |
| Devices: public keys, certificates, fingerprints, revoked state (the verified device directory history checks against) | Push subscriptions: bound to the old origin's service worker |
| Household, chat, fridge and private-space envelopes, sequences, attachments and chat blobs | Pending invitations, prepared invitations, provisioning grants and pairing flows |
| Chat key packages, epochs and their history | Reports and feedback (they belong to the hosted service's team) |
| Calendar subscriptions | The security audit stays with the hosted service; the home server starts its own |

Every carried device keeps its keys and certificates but has no token, so
nothing can authenticate as it; after the move an admin can revoke the old
devices in one step once everyone has re-joined (§6), with the usual new
epoch.

### 3. Receiving

`POST /api/move/receive` on the home server's own name (through the
connection relay; TLS ends on the home server as for every request):

- **Authentication:** the move code, in a header. A wrong code costs one of
  its five tries; the code dies after them, after one hour, or once used.
- **Limits:** one move at a time; the body streams to a file in the data
  directory with a size limit (proposed 4 GB; the household's attachments
  dominate), and the request must finish within an hour.
- **Checks before anything changes:** the package opens as a Kin database of
  a schema this server can read (older schemas are migrated forward; a newer
  one is refused with "update this home server first"), holds exactly one
  household, passes the startup validator, and no household, member,
  device or username in it already exists here. The household limit
  (ADR 0025 §9) counts it.
- **Import:** in one transaction, the package's rows are inserted into the
  home server's database; then the service reloads that household as at
  startup. The answer is a receipt: the household's ID and counts.

### 4. Who is ready to move

The hosted service knows which wrappers each member's vault has. Before
step 2 the admin sees, by display name only:

- **Ready:** has a password wrapper or a backup code.
- **Needs a backup code first:** has only passkey wrappers. Their app shows a
  card asking them to make one before the move.
- **No account yet** (a member from before accounts): they re-join through an
  invitation at the new address (§6).

The move refuses to start unless at least one admin is ready: somebody must
be able to sign in at the new address.

### 5. The old household: frozen, then moved

A new lifecycle state on the hosted service, `moved`, holding the new
origin. In it:

- uploads are refused with `household_moved` and the new address; a
  member's app shows "Your household moved to https://… — open it and sign
  in there", with the steps of §1.5 in plain words, including that passkeys
  stay behind;
- downloads still work, so a device that was offline catches up on what was
  there before the move;
- changes a device made offline and never sent stay on that device; the
  banner says how many and offers the existing household export so nothing
  is silently lost;
- admins can still close it (deletion, §1.6). The hosted service can't see
  sign-ins at the new address, so a week after the move the old app reminds
  its admins to close it once everyone is there;
- within the first day, admins can
  **undo the move** if the home server is gone (state back to `active`);
  after that, undoing would split the household's history.

### 6. Re-joining at the new address

- **Password or backup code:** the existing new-device sign-in (ADR 0018 §4),
  unchanged: "Add this as a new device", vault, certification, history.
- **Then a passkey:** offered at once, since the old one doesn't work here.
- **Members without an account or a usable wrapper:** an admin, once signed
  in at the new address, invites them with the existing recovery invitation
  for an existing member (it keeps their member ID); a trusted device of the
  admin approves and provisions keys, as today.
- **Old devices:** the household's device list marks devices carried over
  from the old address; after everyone has re-joined, an admin removes them
  together (revocation, new epoch).

### 7. The hosted service's request

- Only to `https://<name>:443`, where the name is a host name (no IP
  literal), resolved and connected with the same public-address guard as the
  calendar fetcher (`server/calendar-fetcher.mjs`): never a private, loopback
  or link-local address.
- The certificate is checked as for any HTTPS request; the hosted service
  pins nothing (a home server's certificate renews).
- The move code goes only in that request, never in a URL.
- The household is frozen first; a failed or interrupted request unfreezes
  it. A request that succeeded on the home server but whose receipt was lost
  leaves the household frozen with "the home server may have it": the admin
  checks the new address and either confirms the move or undoes it.

## Threats

| Threat | What stops it | Remaining |
| --- | --- | --- |
| Someone else's server receives the household | The admin types the address and a code that only the home server's operator can read (its window and log); a fresh admin passkey or password is needed | An admin tricked into typing an attacker's address and code. The package is what the hosted operator holds today: ciphertext, signatures, and password and backup-code verifiers that allow offline guessing of weak passwords (as ADR 0018 D3 says of a stolen database) |
| Guessing the move code | Five tries per code, one hour, one use, one move at a time | — |
| A carried device token is replayed at the new address | Token hashes are cleared; carried devices can't authenticate | — |
| The hosted service tampers with the package | Same as today: it can't forge envelopes, certificates or vaults without keys; members verify history as on any new device | It could withhold history or send an old copy (rollback), as it can today |
| The hosted service is used to probe a private network | Public addresses only, HTTPS on 443, host names only | — |
| Two copies of the household diverge | Frozen during the send, then `moved` refuses uploads; undo only within a day | Changes made offline before the move stay on the device that made them |
| A large package fills the home server's disk | Size limit, streamed to the data directory, refused before import if too large | — |

## Owner answers (2026-10-25)

1. **Frozen at once:** the hosted household refuses uploads from the moment
   the move succeeds (§5).
2. **One ready admin is enough:** members who only have a passkey are asked
   for a backup code first, or re-join by recovery invitation (§4, §6).
3. **Closing is manual:** an admin starts the existing deletion (§1.6). The
   answer as asked also had the old app remind admins once everyone has
   signed in at the new address; the hosted service can't know that without
   a channel back from the home server, so it reminds them a week after the
   move instead (§5).
4. **Undo within one day** (§5).
5. **Size limit:** 4 GB, as proposed (not asked separately; change it here if
   needed).

## Alternatives considered

- **The admin carries a file** of the records (the owner's second option):
  simpler, but the file holds every member's verifiers and sealed vaults,
  and anyone who gets it could guess passwords offline.
- **A fresh household, history local to the admin's device** (the third
  option): others lose the shared history; doesn't meet #737.
- **New IDs at the new address, with a map from old to new:** every vault,
  wrapper, certificate and event signature binds the old IDs; re-sealing
  vaults needs each member's secret, and events can't be rewritten without
  breaking the history's signatures.
- **A hand-off between the two origins in one browser** (`postMessage` from
  the old address's page to the new one's): it would carry a device's keys
  without the vault, but hands secrets across origins and only helps members
  who use the same browser; the vault already does this job.
- **Moving the name instead** (relay `TRANSFER`): that moves a home server
  between computers (ADR 0025 §3), not a household between servers. `RELEASE`
  and `REMOVE_DOMAIN` from the control panel are a separate task.

## Consequences

- **New on the hosted service:** the move screen, the readiness check, the
  move package builder, the outbound request with the address guard, the
  `moved` lifecycle state and its banner, and undo.
- **New on the home server:** the move code in the control panel,
  `/api/move/receive`, the package checks and import, and the "carried over"
  mark on old devices.
- **Unchanged:** event, envelope, vault, certificate and export formats; the
  new-device sign-in; deletion. The move package is a database of the
  current schema, never a stored format.
- **Documents:** PRIVACY (what the move sends and to whom), THREAT-MODEL,
  HOME-SERVER (a moving guide), SELF-HOSTING, V1.0-COMPATIBILITY (the
  `moved` state and `household_moved`).
- **Tasks:** #738 becomes the hosted side and the guide (§1, §2, §4, §5,
  §7); #739 the home side and re-joining (§3, §6).

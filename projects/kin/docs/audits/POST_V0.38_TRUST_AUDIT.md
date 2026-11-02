# Kin Post-v0.38 Trust-Boundary Audit (interim)

**Audited:** `kin-development` at `70a1f89` (Kin `0.38.1`), 2026-10-11.
**Branch:** `kin-trust-audit-post-v0.38`. Product code was not changed.

This is an **interim, narrowed** audit. The full post-v0.40 product audit cannot
run yet: v0.39 (Portable Household Export v2) and v0.40 (Restore & Device
Migration UX) do not exist on any branch. This audit examines the member model
that v0.39/v0.40 will serialize and restore: the v0.36 Limited members, v0.37
Temporary members, v0.38 Modes/member context and v0.38.1 self-leave. It covers
membership, trust, privacy, recovery/deletion and limits, plus the current
automated gate.

Sections of the post-v0.40 brief deliberately **not** covered here, and to be run
after v0.40: fresh-start, ten-second loop, navigation/IA, ordinary household use,
export/restore drills, device migration, offline/PWA install drills, browser
matrix, performance at scale, product pruning, and the full documentation-claim
audit.

## Executive summary

The **core Adult-only trust-management routes are enforced on the server, with
one confirmed authorization gap: Limited and Temporary members can enable
household sync (B-006).** The server-side authorization boundary is therefore
not universally sound. Every audited trust-management route (pairing, device
approval/revocation/replacement, member removal, recovery, key
rotation/provisioning, household deletion) refuses Limited and Temporary members
on the server; `/api/sync/enable` does not. Authority always comes from the session/device cookie, never from
the request body. Temporary expiry is enforced by the server clock on every
request, and unknown member kinds fail closed. Removed and expired members cannot
sync or re-pair. Recovery does not escalate a Limited member. No surveillance UI
(presence, last active, read receipts, rankings, activity streams) was found, and
no household content reaches the relay in plaintext.

The **weak point is household-level availability and recovery**, not
confidentiality:

- Replay is fail-closed with no quarantine. One replay-invalid event stops sync
  for every device, permanently. Honest offline use produces such an event
  (B-001, B-002). The engine accepts a deliberately crafted event of this kind,
  and the relay contract permits its shape, so any member's trusted device,
  including a Limited or Temporary member's, could plausibly submit one (B-003;
  engine-reproduced and relay-contract-confirmed, not a full relay round trip).
- The household can be left with no usable Adult (B-004). Device revocation is
  one unlabeled click with no confirmation (B-005).
- Two promises are broken in code. Non-Adults can enable sync (B-006). Installed
  PWAs are still served the v0.34 client, because the service-worker cache name
  was never bumped (B-007).
- Encrypted archive export fails within the documented attachment allowance
  (B-008). This should be resolved before v0.39 builds on the archive.

## Readiness recommendation

**NOT READY** — the v0.36–v0.38 trust model is not yet a safe foundation for
v0.39/v0.40. Export/restore would serialize and replay the same history: one
poisoned event would make restore fail as a whole, and recovery-by-restore
inherits B-004. Fix the blockers below first.

This is not a release-candidate verdict. That belongs to the post-v0.40 audit.

| Class | Count |
|---|---|
| BLOCKER | 8 |
| POLISH | 19 |
| FUTURE | 12 |

## Reproducing the findings

The reproduction scripts are in [`post-v0.38-repro/`](post-v0.38-repro/). They
drive the shipped `web/wasm/kin_engine.wasm`, the real server modules, and an
in-memory `DurableStore`. Run them with Node ≥ 22.13:

```powershell
node projects/kin/docs/audits/post-v0.38-repro/<script>.mjs
```

On Node 22.x an `ExperimentalWarning: SQLite` line is printed; it is harmless.

---

## BLOCKERS

### B-001 — An honest offline edit to an item archived elsewhere halts sync for the whole household

**Area:** sync / replay / data availability
**Severity:** BLOCKER: honest everyday use, household-wide, no user recovery path.

**Reproduction:** `post-v0.38-repro/b001-offline-archive-conflict.mjs`

1. Device A and device B have both seen item X (logical time 1).
2. Device A archives X (logical time 2) and syncs.
3. Device B, offline, adds item Y (its logical time 2), then completes X (its
   logical time 3). B's local replay is valid.
4. B reconnects. `SyncCoordinator.runOnce` **pushes before it pulls**
   (`web/sync/sync-coordinator.js`, `pushPendingEvents()` precedes the
   `/api/sync/events` pull), so the relay accepts B's events.
5. Replay sorts by `(logical_time, device_id, event_id)` (`rust/src/state.rs:421`).
   That gives archive X @2 → add Y @2 → complete X @3, and the complete is
   rejected (`KinError::InvalidEvent`, code 4).

**Expected:** a concurrent action on an archived item becomes a stored no-op, as
it already does when the logical times are equal.

**Actual:** `engine.applyEvents` throws on **every device**, B included.
`commitRemoteBatch` aborts (`web/storage/event-store.js` ~1615), the cursor
never advances, and the coordinator shows "paused" with "That household change
is not valid. Review its current state and try again." It retries every five
seconds indefinitely. The UI offers no repair, skip or quarantine.

**Why it matters:** this is the normal offline story Kin promises. `docs/SYNC.md:187` and `docs/EVENTS.md:173`
define the failure as "a causally later action after observing archive". But
replay infers "observed" from a greater Lamport number, and a device reaches a
greater number simply by doing more than one thing offline.

**Suggested direction:** treat any mutation of an archived target as a stored
no-op unless the event carries real causal evidence that its author saw the
archive. Separately, introduce a bounded quarantine or skip path for
replay-invalid remote events (see B-003).

### B-002 — Responsibility changes concurrent with archive break replay; v0.38 auto-reconcile triggers it

**Area:** Responsibility / member removal / Temporary expiry
**Severity:** BLOCKER: new in v0.36–v0.38, triggered automatically.

**Reproduction:** `post-v0.38-repro/b002-responsibility-concurrent-archive.mjs`.
Output: `EQUAL-LT complete: OK`, `EQUAL-LT change-responsibility: FAILS 4`,
`EQUAL-LT change-responsibility (clear): FAILS 4`.

**Expected:** like completion, steps and notes, a `ResponsibilityChanged` at the
same logical time as a cross-device archive is a stored no-op.

**Actual:** `EventKind::ResponsibilityChanged` (`rust/src/state.rs` ~1189–1221)
has no `has_concurrent_archive` handling and returns `InvalidEvent` whenever the
target is archived. `kin-app.js reconcileResponsibilityMembers` (~1525–1540)
makes **every active device** emit a clear for owners who are removed or expired.
When a Temporary member expires, every device emits that clear at about the same
time, which raises the chance of colliding with an archive.

**Why it matters:** an honest expiry or removal can halt household sync (same
failure as B-001).

**Suggested direction:** add the same equal-time archive tolerance to
`ResponsibilityChanged`. Make reconcile skip archived targets (see P-008).

### B-003 — A single member can permanently halt household sync (poison event and logical-time exhaustion)

**Area:** trust boundary / availability
**Severity:** BLOCKER: v0.36–v0.37 admit less-trusted participants. `docs/THREAT-MODEL.md:109`
assumes a malicious member can only "create valid content as themselves".

**Reproduction:** `post-v0.38-repro/b003-single-member-halts-sync.mjs`

**Evidence level: ENGINE-REPRODUCED + RELAY-CONTRACT-CONFIRMED.** The replay
failures are reproduced directly in the shipped WASM engine. The relay's real
envelope check is exercised separately and accepts the relevant input shape. The
repro does **not** perform the full sign → encrypt → upload → pull → replay
round trip through a live relay; the end-to-end attack is inferred from the
implementation, as marked below.

- **(A) Poison.**
  - REPRODUCED (engine): a Limited actor's device creates an item locally and
    emits a `ResponsibilityChanged` for it; replaying the honest history plus
    only that event fails with code 4 ("That household change is not valid").
  - INFERRED FROM IMPLEMENTATION: in real sync the event would reach every
    device. The relay validates envelope shape and routing only
    (`server/sync-contract.mjs` `isEventEnvelopeValid`; `sync-service.mjs`
    `validateEventEnvelope`). It never decrypts or inspects the payload, so it
    cannot reject a domain-invalid event from a trusted device. Receiving
    devices verify the signer, not replay validity, before `commitRemoteBatch`.
    Relay events are deleted only by whole-household purge
    (`durable-store.mjs` `purgeHouseholdData`), not on member removal or expiry,
    so the event would persist.
- **(C) Logical-time exhaustion.**
  - REPRODUCED (engine): an event with `logicalTime = 2^64-2` is accepted by
    replay (line C). An honest follow-up at that logical time is rejected (line
    C2, code 4).
  - REPRODUCED (relay contract): line D shows the server's real
    `isEventEnvelopeValid` accepting `logicalTime` of 2^64-2, 2^64-1 and a
    2^128-scale value. The check is digits-only (`server/sync-contract.mjs:38`).
  - INFERRED FROM IMPLEMENTATION: after such an event is committed,
    `commitRemoteBatch` sets `next_logical_time` to the maximum. The next local
    write would need `2^64-1`, which `event-store.js:480–484` refuses with "Kin
    has reached a supported event-order limit." on every device. The repro does
    not drive the IndexedDB event store.

**Expected:** a participant without trust authority cannot deny service to the
whole household. The impact of one member's malformed or hostile events is
bounded and recoverable.

**Actual:** permanent household-wide sync and write denial. No recovery path
exists short of household deletion.

**Why it matters:** v0.40 restore will replay the same history all-or-nothing, so
a poisoned relay or archive cannot be restored either.

**Suggested direction:** bound the logical-time advance per event, both on the
relay and in replay. Quarantine (store, do not apply) remote events that fail
replay, rather than aborting the batch. Show Adults a plain-language "some
changes could not be applied" state.

### B-004 — Last-Adult protection counts an Adult who has no trusted device, so the household can be orphaned

**Area:** membership / recovery
**Severity:** BLOCKER: unrecoverable loss of household administration.

**Reproduction:** `post-v0.38-repro/b004-last-adult-without-device.mjs` (last
section; over HTTP against `createKinServer` and an in-memory store).

```
A DELETE /api/devices/<B device>: 200
A remove/finish self (fresh passkey): 200 {"removed":true}
B POST /api/login/options: 403 device_not_trusted
Limited2 GET /api/sync/status: 200 {"rotationPending":true,...}
remaining active members: adult(devices=0), temporary(devices=1), limited(devices=1)
```

**Expected:** an Adult cannot leave unless another Adult can still act, meaning
that Adult has at least one non-revoked device.

**Actual:** `leaveHousehold` (`server/pairing-service.mjs:1445–1449`) checks only
`other?.active && canManageTrust(other)`. After A leaves:

- B cannot sign in.
- Only Adults can approve recovery or rotate the key epoch, so nobody can.
- The leave set rotation pending. Limited and Temporary pushes fail with
  `sync_rotation_pending` permanently.

A realistic path: B loses a phone, A revokes it, and A leaves before B recovers.

**Suggested direction:** count only Adults who have a non-revoked device, in
`leaveHousehold`, in removal, and in `revokeDevice`, which revokes another
Adult's last device. Add a regression test for an Adult with no devices.

### B-005 — "Revoke device" is one click, unlabeled, unconfirmed, and needs no fresh passkey

**Area:** trust UI / accessibility
**Severity:** BLOCKER: an irreversible trust action that contradicts documented
safeguards, and the shortest path into B-004.

**Reproduction:** Household → Trusted devices (Adult), any device row →
"Revoke device". Code: `web/components/kin-household.js` ~915–932, server
`DELETE /api/devices/:id` at `server/server.mjs:637–647`.

**Expected:**
- `docs/ACCESSIBILITY.md:18`: "Destructive authority changes use an explicit
  confirmation and fresh passkey ceremony."
- `docs/releases/V0.38.0.md:18`: "Adult actions include a target in their
  accessible name."

**Actual:**
- No `confirm()` and no fresh-passkey flow; the server route needs only a
  session.
- The button's accessible name is "Revoke device" on every row, with no target.
  The label lives in a sibling `<span>` with no `aria-describedby`.
- The handler is not wrapped in `run()`, so a failure is an unhandled rejection
  and nothing is announced.
- The sibling controls "Verify device", "The codes match.", "Trust this device"
  and "Replace this device" have the same naming problem (P-012).

**Suggested direction:** route device revocation through the existing
fresh-passkey removal flow. Name the target in the button and the confirmation.
Wrap the handler in `run()`.

### B-006 — Limited and Temporary members can turn on household sync

**Area:** trust boundary / privacy promise
**Severity:** BLOCKER: breaks a documented privacy promise; one-way.

**Reproduction:** `post-v0.38-repro/b006-non-adult-enables-sync.mjs`. A Temporary
session calls `enable()` → `{ enabled: true }`; the Adult then sees
`enabled: true`.

**Expected:** `docs/PRIVACY.md:23`: "Sync remains disabled until an
authenticated adult explicitly enables it."

**Actual:**
- `server/sync-service.mjs:82–89` `enable()` calls only `authorize()`. v0.36
  added `requireTrustAuthority` to provisioning and rotation but not here.
- The "Enable device sync" control is rendered for every member kind
  (`kin-household.js:391`).
- A local-only household can already contain Limited and Temporary members
  (`createPairing` does not require sync).
- There is no route to disable sync again.

**Suggested direction:** call `requireTrustAuthority` in `enable()`, hide the
control for non-Adults, and add the route to the Limited/Temporary denial test.

### B-007 — Service-worker cache name frozen at v0.34: installed clients run the v0.34 UI against a v0.38 server

**Area:** PWA / release integrity
**Severity:** BLOCKER: users with an installed or previously visited Kin never
receive v0.35–v0.38.1 client code, including the v0.36–v0.38 trust UI.

**Reproduction:**
- `web/service-worker.js:3` is `const CACHE = "kin-static-v0.34.0";`.
- `git log -- projects/kin/web/service-worker.js` ends at `d450cbb` (v0.34.0).
  Since then `kin-household.js`, `kin-app.js`, `sync-coordinator.js` and
  `app.css` have changed (e.g. `git diff --stat d450cbb HEAD --
  projects/kin/web/components/kin-household.js` → 119+/44−).
- The worker bytes have not changed, so no update installs. `index.html` is
  network-first (`service-worker.js:47–49`), but every shell module is served
  cache-first without revalidation (`:50–56`). The browser loads v0.38
  `index.html` with v0.34 `kin-app.js`.
- `scripts/check_version.py` does not check the cache name.
  `service-worker.test.mjs` covers only a v0.28→v0.34 rename.

**Secondary defect (same root cause):** install writes into the *same* cache
name it serves from (`:19–23`) and rejects only after `allSettled`. A failed
install therefore leaves the active worker's cache holding a mix of old and new
assets. The comment at `:25–26` ("A partial new cache must never replace a
working offline shell") holds only when the name changes.

**Why it matters for v0.39/v0.40:** new export and restore UI would not reach
installed users either.

**Suggested direction:**
- Derive the cache name from the release version, and have `check_version.py`
  enforce it.
- Stage into the new cache name only.
- Add a test for a failed install under an unchanged name.

### B-008 — Encrypted archive export fails within the documented attachment allowance

**Area:** backup / recovery (input to v0.39)
**Severity:** BLOCKER: the household's only user-held backup path fails for
households that stay inside documented limits.

**Reproduction:** `post-v0.38-repro/b008-archive-export-at-attachment-cap.mjs`.
This uses the real `serializeProtectedValue` on a synthetic snapshot; the UI
download was **not** executed end-to-end.

```
11 attachments (44.04 MiB): serialized 58.73 MiB OK
12 attachments (48.05 MiB): VaultError "The protected record is too large."
```

**Expected:** a household within the local 50 MiB attachment allowance
(`event-store.js:327`; server `durable-store.mjs:36–38`) can export.

**Actual:**
- Export serializes the snapshot with base64url bytes against `MAX_VALUE_BYTES`
  = 64 MiB (`web/security/local-vault.js:4,317,325`), so the effective
  attachment budget is about 46 MiB.
- The error text "The protected record is too large." is shown to the user via
  `kin-security.js:449`.

**Suggested direction:** v0.39 must set an explicit, tested export budget:
binary framing for attachments, or a documented attachment ceiling that leaves
headroom. The error needs plain household wording.

---

## POLISH

### P-001 — The server suite fails on Node 22.x even though Kin declares Node ≥ 22.13 supported
On Node 22.21.1, `node --test server/*.test.mjs` gives **242/251 pass, 9 fail**.
Child processes print `ExperimentalWarning: SQLite is an experimental feature`
to stderr, which breaks exact-string and JSON assertions in `admin.test.mjs:73`,
`startup.test.mjs:49+`, `durable-lock`/`durable-restart`, and production startup.
The same suite passes 251/251 on Node 24.21.0, which v0.36–v0.38.1 used.
Operators on Node 22 also see that warning appended to admin CLI messages.
Either raise the floor or filter or expect the warning in tests.

### P-002 — Reference Record total size is about 4.2 KB, not the documented 16 × 1024 B
`post-v0.38-repro/p002-reference-record-total-cap.mjs`: the engine accepts at
most 4221 B of total field values. At 4222 B it rejects with "Kin could not read
that household event" (code 2), although `validateReference` reports
`valid=true`. The cause is the KCMD cap in `rust/src/command.rs:781–787`.
`MAX_REFERENCE_COMMAND_BYTES` (`state.rs:123`) is unused. Align the UI, docs and
cap, and give a specific message.

### P-003 — Playbook entries of 81–256 characters break "Use checklist" partway through
`post-v0.38-repro/p003-playbook-step-length.mjs`: an entry passes Playbook
validation (256 B) but becomes an Item Step capped at 80 characters
(`state.rs:199–206`). Instantiation (`kin-app.js:1206,1233`) creates the Item and
the earlier Steps, then fails with "Step text must be short plain text."
Retrying fails again.

### P-004 — Maintenance summary: the browser counts UTF-16 units, Rust counts bytes
`kin-notes.js:365` uses `maxLength=240` with no byte or control check; Rust caps
at 240 **bytes** (`state.rs:107`). 100 CJK characters or 61 emoji pass the
browser, then fail with the misleading "Add a short maintenance note."

### P-005 — Member-removal errors are wiped before they can be announced
`removeMember` (`kin-household.js:1123–1135`) always calls `showHousehold()`
after `run()`. `replaceChildren()` then deletes the alert for passkey
cancellation, `last_adult`, `fresh_auth_required` and network errors.

### P-006 — The `last_adult` message contradicts the UI
"…Household deletion and recovery are not available."
(`pairing-service.mjs:1451`) appears while the same view offers "Delete
household" (`kin-household.js:1008`). Leave is also offered to the last Adult.

### P-007 — Responsibility calls every assignee "Household adult N", with inconsistent numbering
`kin-responsibility.js:8–26` labels Limited and Temporary members "Household
adult N". N is the position in device-directory order, so it can differ between
devices and shifts after a removal. Settings uses a different scheme ("Limited
member 1", `kin-household.js:968`).

### P-008 — Responsibility reconcile uses the device clock, and one failure blocks the rest
- `activeResponsibilityMemberIds` (`sync-coordinator.js:20–25`) compares
  `memberExpiresAt` with the local clock. A fast clock writes canonical clears
  early.
- It also drops an Adult whose only device is revoked during recovery, which
  clears that Adult's responsibilities household-wide.
- The reconcile loop runs in one `try`: the first archived stale entry throws
  (see B-002), blocks clearing the rest, and repeats on every sync.

### P-009 — Device-approval certificates accept non-Adult and revoked issuers (investigation)
`verifyDeviceAuthorizationCertificate` (`web/sync/crypto.js:395–445`) and
`loadDeviceDirectory().verify` (`sync-coordinator.js:358–432`) accept any
directory device as issuer, without checking that the issuer is an active Adult.
Rotation recipients are chosen with `!revokedAt && publicKeys` only (`:480`).
`docs/CRYPTOGRAPHY.md:59` relies on this chain against keys injected through the
relay. Since v0.36, Limited devices, and removed members' devices that still hold
keys, are valid-looking issuers. Exploitation needs a relay plus a colluding
(former) member; this was confirmed in code, not demonstrated.

### P-010 — Small server inconsistencies
- `leaveHousehold` calls `canParticipate(member)` without `this.now()`
  (`pairing-service.mjs:1439`); every other call passes it.
- `POST /api/pairings` with `{"kind": null}` creates an **Adult** invitation
  (`server.mjs:474`, `body?.kind ?? "adult"`). This is Adult-only, so nothing is
  escalated, but a malformed request should not default to the most privileged
  kind.

### P-011 — Household and device views lose focus and announcements on re-render
- `render()`, `showHousehold()` and `showDevices()` call `replaceChildren()`, so
  after removal, revoke, back or navigation, focus falls to `<body>`. This
  contradicts "dynamic focus restoration" in ACCESSIBILITY.md.
- `message()` (`kin-household.js:1257–1266`) creates its live region lazily and
  sets role and text in the same tick, so announcements are unreliable. The
  region is also destroyed on re-render.
- The Temporary expiry help text is not linked through `aria-describedby`, and
  errors appear in the shared region rather than at the field.

### P-012 — Repeated device controls have no target in their names
"Verify device", "The codes match.", "Trust this device" and "Replace this
device" (`kin-household.js:881–924`) are identical on every row. "Replace this
device" appears on *other* devices. "Trust this device" is also not wrapped in
`run()`. The pairing "Revoke" button (`:490`) has no object.

### P-013 — Recovery and replacement confirmations are wrong or vague
- "Authorize recovery for this adult?" (`kin-household.js:632`) is shown for
  Limited members too.
- "Replace this device?" (`:616`) does not name the device.
- Member labels are positional ("Adult 2"), and counting includes "You" and
  ended Temporary entries. The actions are correctly bound to member IDs.

### P-014 — Internal jargon in user-facing sync and storage errors
Sync-coordinator errors are shown in the paused-sync notice
(`kin-app.js:918–922`). Examples:
- `sync-service.mjs:579` "The household key epoch changed. Retry with the
  current epoch."
- `durable-store.mjs:1645` "…retry from the current cursor."
- `sync-coordinator.js:301` "This device is missing key epoch N"
- `:802` "The encrypted envelope does not match its canonical event bytes."
- `event-store.js:1590` "Kin rejected a sync cursor rollback."
- `local-vault.js:325` "The protected record is too large."
- Form copy using "UTF-8 bytes" and "MiB" (`kin-compose.js:121`,
  `kin-notes.js:448–449`, `attachment-crypto.js:39`)

There is also raw `error.message` passthrough at `kin-household.js:1236` and
`kin-app.js:899,1331,1355,1467`.

### P-015 — Count caps fail with a generic message
The 33rd Area, the 33rd Playbook and the 129th Reference Record surface "Kin
could not validate that household change." (engine code 4 with no specific
message). The browser checks none of these counts first.

### P-016 — Privacy documents omit v0.36–v0.38 server-visible metadata
- `PRIVACY.md` (header still v0.12.3) and `THREAT-MODEL.md:135` don't list
  plaintext member kind, Temporary `expires_at`, free-text device labels (which
  may carry names), or credential transports. Only `releases/V0.36.0.md`
  mentions kind and expiry. With device-to-member mapping, the relay can
  attribute event timing to "the Temporary member".
- `CRYPTOGRAPHY.md:141` still says "The identity service and relay are
  memory-only" (they have used durable SQLite since v0.11).
- `THREAT-MODEL.md:135` says "Encrypted payloads hide semantic event kinds", but
  ciphertext is unpadded (F-004).
- `RETENTION.md` implies member data ends "until member/household transition",
  but removed members' rows persist until household deletion (F-003).

### P-017 — Accessibility documentation and tests stop before v0.36
`ACCESSIBILITY.md` has no v0.36–v0.38.1 section. `kin-household.test.mjs` and
`household-leave-regression.mjs` cover only the Leave control. Removal names,
device actions, the Temporary form and focus behaviour are untested. The
V0.38.0 note "Adult actions include a target in their accessible name" is not
true for device actions (B-005, P-012).

### P-018 — Trust-boundary test gaps
`pairing-service.test.mjs` "Limited and Temporary direct HTTP trust-management
calls are denied" does not cover any of these:
- `/api/devices/replacements`
- approve/finish
- deletion/finish
- deletion/cancel/*
- remove/finish with body fields that try to redirect the target
- `/api/sync/enable` (B-006)

Also untested:
- `temporary_expiry_elapsed` at approval
- recovery of a Limited or Temporary member keeping its kind
- Adult with no devices (B-004)
- logical-time bounds (B-003)

### P-019 — Modes: any member can change the household mode, and the select commits on every change
A Temporary guest or caregiver can set Vacation or Rest, which changes routines
for everyone. `HouseholdModeChanged` has no actor gate (`state.rs:891`; UI
`kin-app.js:572`). That may be intended, but nothing documents it. The mode
`<select>` commits on each `change` (`kin-app.js:581`), so keyboard browsers
that fire `change` on every arrow key append one mode event per keypress.

## FUTURE

- **F-001** — Temporary expiry has no maximum. `Number.MAX_SAFE_INTEGER` is
  accepted (effectively permanent Limited access), and values above 8.64e15
  render "ends Invalid Date" (`kin-household.js:969`).
- **F-002** — Device labels are plaintext on the server, in every service
  backup, and kept after removal or expiry. Consider client-side encryption, or
  dropping the label on removal.
- **F-003** — Inactive members' rows (kind, expiry, credentials, labels) persist
  until household deletion, and their number is unbounded.
- **F-004** — Event ciphertext is unpadded, so fixed-shape events (acknowledge,
  archive, Responsibility) are probably distinguishable by size. Not measured.
- **F-005** — Clock rollback before a sweep can briefly restore an expired
  Temporary member. `createProvisioningGrant` and `rotateEpoch` filter on
  `member.active` rather than `canParticipate` (`sync-service.mjs:423,584–590`).
  Not exploitable over HTTP, where the sweep runs first.
- **F-006** — A member admitted without sync keys has no
  `syncHistoryFromEpoch`, and later key registration sets `historyFromEpoch: 1`
  (`server.mjs:660–676`). Clients fail closed (certificate check), so this is a
  sync denial of service rather than a confidentiality leak. Reachable only from
  a non-UI client.
- **F-007** — `GET /api/household/lifecycle` is unauthenticated (state and
  `finalizeAt` for anyone holding the 128-bit household ID). Predates v0.36.
- **F-008** — Service backups are plaintext SQLite. File mode 0600 is applied
  only off Windows.
- **F-009** — Any member can `DELETE /api/sync/attachments/:id`, and clients
  auto-delete remote "orphans" (`attachment-lifecycle.js:116`). Possible race
  with a peer's bind event that hasn't been pulled yet. Not reproduced.
- **F-010** — Clients accept old-epoch events from removed signers
  (`sync-coordinator.js:288`) and rely on the relay to refuse new ones. This
  matters only with a malicious relay.
- **F-011** — `/api/sync/devices` exposes every device's member kind and expiry
  to Limited and Temporary members. Probably needed for keys; make it an
  explicit decision.
- **F-012** — Limits housekeeping:
  - `MAX_ATTACHMENTS_PER_PARENT = 5` is dead code.
  - Rust allows 256 lifetime attachment bindings; server and local storage
    allow 64.
  - The attachment name `.slice(0,240)` can split a surrogate pair.
  - U+0085 is trimmed by Rust but rejected by the browser.
  - The device-label limit says "48 characters" but counts UTF-16 units.

---

## Membership/trust findings

| Scenario | Verdict | Evidence |
|---|---|---|
| Limited → Adult operations (16 operations, service + HTTP) | ENFORCED | `requireTrustAuthority` at `pairing-service.mjs` 335, 377, 524, 621, 681, 748, 943, 1184, 1206, 1343, 1462, 1542; `sync-service.mjs` 380, 543 |
| Temporary → Adult operations | ENFORCED | same paths |
| Enable household sync | **NOT ENFORCED** | B-006 |
| Temporary expiry, server-side | ENFORCED (server clock; at `expiresAt` → 401/403) | `server.mjs:275–278`, `pairing-service.mjs:78–84, 595–617` |
| Temporary without a valid expiry | Fails closed (create, runtime, storage trigger, load) | `pairing-service.mjs:527–530`; `durable-store.mjs:735–744, 917–920` |
| Unknown or invalid kind | Fails closed; a *missing* kind is a legacy Adult (tested, intentional) | `normalizeMemberKind` (38–54); DB `CHECK` |
| Removed member / revoked device sync, re-pair, recover | ENFORCED | `removeMembership` 1496–1538; `authorize`/`trustedDevice` |
| Self-leave targeting someone else | ENFORCED (target from the server-side flow; body ignored) | `server.mjs:926–976` |
| Fresh-passkey removal | ENFORCED for members; **not** for device revoke (B-005) | |
| Last-Adult protection | **PARTIAL** (B-004) | `pairing-service.mjs:1445–1449` |
| Recovery escalation of Limited/Temporary | ENFORCED (kind and ID preserved) | 1036–1057 |
| Household deletion | ENFORCED (Adult + fresh passkey; cancel also Adult) | 333–385; `server.mjs:787–899` |
| Pairing replay / expired / wrong device | ENFORCED | single-use claim, version-checked approval, inviter-bound |
| Replay-level member authority | Not modelled. Trust operations are not events; members can author every household event kind. Availability consequence: B-003 | `rust/src/event.rs` |
| Historical attribution | Authorship is never displayed, which is consistent with the entity-centric design. Labels are inconsistent (P-007) | |

**Surveillance audit:** PASS. `web/` contains no online status, last active,
location, read receipts, completion rankings, contribution scores, presence or
activity stream. The server stores no last-seen or login time.

## Privacy findings

- No household content is visible to the relay. Notes, Reference Records,
  Maintenance, Playbooks, Responsibility, Modes and Pins exist only inside
  AES-GCM event ciphertext. Attachment filename, MIME type and size are
  encrypted inside the blob.
- Server plaintext that is necessary: member kind, Temporary expiry, member and
  device IDs, credential public keys, routing envelope fields, ciphertext sizes,
  and the security audit log. Disclosure is incomplete (P-016).
- Server plaintext that is not necessary: free-text device labels (F-002).
- Logs are clean: request ID and outcome code only; no IPs, tokens, names or
  content.
- Service-worker Cache Storage holds only the fixed static shell. `/api/*`,
  non-GET requests, query URLs and pairing URLs are never cached. Versioning is
  broken (B-007).
- Local IndexedDB is wrapped by `encryptedDatabase`, and nothing uses
  localStorage, which matches `STORAGE.md`.

## Recovery and deletion findings

- Removal, revocation, expiry and deletion are one-way on the server. No code
  path reactivates a member. Durable backup restore keeps kind and expiry, and
  keeps ended Temporary access ended.
- Recovery cannot escalate authority. It can be **lost entirely** (B-004).
- Encrypted archive export has a lower effective ceiling than attachment storage
  (B-008).

## Limits (browser / Rust / server)

The values agree for:
- members: 12 total, 4 Adult, 8 Limited, Temporary within the 12
- trusted devices (16)
- Item, Handoff, Talk and Routine text (4096 B)
- Steps (80 characters / 256 B / 16)
- Notes, Areas, Pins (10)
- attachment size (4 MiB)
- event count

They disagree for:
- Reference Record total (P-002)
- Playbook entry → Step (P-003)
- Maintenance summary bytes (P-004)
- archive budget vs attachment allowance (B-008)
- attachment binding count (F-012)

Count caps for Areas, Playbooks and References are enforced only in Rust
(P-015).

## Inputs v0.39/v0.40 must account for

1. **Member kind and Temporary expiry are server-held, not in the canonical
   history.** The `.kin` archive contains event history and local context only
   (`releases/V0.36.0.md`, `V0.37.0.md`). Export v2 must decide explicitly
   whether member classes travel, and restore must never grant them. The
   post-v0.40 drill's "restore preserves member kinds / Temporary expiry" check
   only makes sense once that decision exists.
2. **All-or-nothing restore and fail-closed replay mean one bad event makes a
   whole archive unrestorable** (B-001, B-002, B-003). Settle quarantine
   semantics before designing restore validation.
3. **Export size budget** (B-008) must be explicit and tested against the
   attachment allowance.
4. **Shell delivery** (B-007) must work, or new export and restore UI will not
   reach installed clients.
5. **Device migration must not route around B-004.** "Join on a new device"
   needs an Adult with a working device; the UX should warn before the last
   such device is revoked.

---

## Automated gate

Environment: Windows 11 x64, Rust 1.93.0, Node 22.21.1 (via fnm; PATH default
22.12.0 is below the floor), Node 24.21.0 for the server re-run, Microsoft Edge
155.0.4283.45. Logs were kept in the session scratchpad, not committed.

### PASS

| Gate | Result |
|---|---|
| `cargo fmt -- --check` | PASS |
| `cargo clippy --all-targets -- -D warnings` | PASS |
| `cargo test` (native) | PASS: 170 passed, 0 failed |
| Release WASM build (`wasm32-unknown-unknown --release`) | PASS; SHA-256 **identical** to committed `web/wasm/kin_engine.wasm` (`4996a337…`) |
| Server suite, Node 24.21.0 | PASS: 251/251 (pairing, member classes, Temporary expiry, revocation, recovery, deletion, durable store, sync, WebAuthn) |
| Web/WASM suite (`web/**/*.test.mjs`, Node 22.21.1) | PASS: 126/126, including real-WASM, Responsibility, Modes, Playbooks, Maintenance, service worker, household components |
| `scripts/check_version.py` | PASS: 0.38.1 consistent (does not cover the SW cache name; see B-007) |
| `browser-regression.mjs` (Edge 155) | PASS: 33 groups, including 320px reflow, forced colors, reduced motion, 200% page scale, keyboard, offline, sync migration, CSP |
| `security-storage-regression.mjs` (Edge 155) | PASS: 8 groups |
| `security-ui-regression.mjs` (Edge 155) | PASS: 6 groups, including 36 household-leave assertions and 133 lock/recovery/offline assertions |
| `passkey-regression.mjs` (Edge 155 virtual authenticator) | PASS: 32 assertions, PRF exercised |
| `core-performance.mjs` | PASS: 351,190 B raw / 108,407 B gzip; instantiate 1.03 ms; replay of 10,000 events 9.66 ms median (Node raw ABI) |
| `git diff --check` | PASS |

The other `scripts/*-regression.mjs` files are helper modules imported by the
four runners above. They are not separate gates and are not counted.

### FAIL

| Gate | Result |
|---|---|
| Server suite on Node 22.21.1 (declared supported floor ≥ 22.13) | FAIL: 242/251; 9 failures, all from the SQLite `ExperimentalWarning` on child stderr (P-001) |
| Audit reproductions | B-001 to B-008 and P-002/P-003 reproduce; see `post-v0.38-repro/`. B-003 is engine-reproduced plus relay-contract-confirmed; it does not include a live relay round trip |

### UNVERIFIED — ENVIRONMENT

- `cargo test --target wasm32-unknown-unknown`: Windows cannot execute the WASM
  test binary. Real-WASM behaviour is covered by the Node suite.
- Firefox: not installed.
- Safari/WebKit and mobile Safari: not available on Windows.
- Chrome 15x and mobile Chromium: installed but not run (Edge was the regression
  target).
- NVDA, VoiceOver and native desktop zoom: not available.
- Installed-PWA update flow with a real prior install: not executed. B-007 is
  established from code and a scripted cache reproduction.
- Multi-device end-to-end with real hardware passkeys: not executed. The
  server-boundary reproductions use the WebAuthn test stub; the browser runs use
  Edge's virtual authenticator.
- Archive export with 12 real 4 MiB attachments through the UI: not executed.
  B-008 uses the real serializer on a synthetic snapshot.

## Recommended stabilization plan

No implementation is part of this audit. These are proposed **patches on the
v0.38 line before v0.39 starts**, not new minor versions:

1. **Replay resilience** (B-001, B-002, B-003): make archived-target mutations
   no-ops without causal evidence; add archive tolerance to Responsibility; bound
   the logical-time advance on relay and replay; quarantine replay-invalid remote
   events with a plain Adult-facing notice. This is the highest value, because
   export and restore inherit it.
2. **Trust recoverability** (B-004, B-005, B-006): count only Adults with a
   usable device; put device revoke behind the fresh-passkey removal flow with a
   named target; restrict sync enable to Adults; close the test gaps in P-018.
3. **Shell delivery** (B-007): version the cache name from the release, have the
   version checker enforce it, stage into the new cache only, and test a failed
   install.
4. **Export budget** (B-008, P-002, P-003, P-004): one pass aligning browser,
   Rust and archive limits, with UTF-8-aware validation and specific messages.
5. **Member-UI accessibility and copy** (P-005, P-006, P-007, P-011–P-014,
   P-016, P-017): bring ACCESSIBILITY.md and PRIVACY.md up to v0.38.1.

After items 1–3, v0.39 has a stable base. Items 4–5 can run alongside it.

The next action is human review of this audit.

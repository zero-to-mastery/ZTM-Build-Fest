# Kin Live Household Authority & Recovery Verification

**Dates:** 2026-10-11 (server integration pass), 2026-10-12 (independent-profile
drills, B-002 recovery hardening, and fingerprint-control evidence)
**Base:** `kin-development` at `59c94a7` (PR #36 merged; v0.40.1 candidate)
**Working branch:** `test/kin-live-household-verification` (PR #37). Results
below were re-executed against head `db086ba` (hardening commit on `6d04c10`).
**Scope:** Verification evidence, the defects that evidence found, and focused
B-002/P-001 key-rotation recovery. No version bump, archive format, encryption
format, package-signature format, or authorization-policy change.

> **2026-10-16 follow-up:** This document preserves the CI state observed on
> PR #37. Kin now has an active repository-root verification workflow. Statements
> below that CI was not configured remain historical evidence for that earlier
> head, not the current repository state.

## Summary

The post-v0.40 audit left household admission, revocation, expiry, restore, and
offline reconnect "UNVERIFIED — ENVIRONMENT" because no automated evidence used
genuinely separate clients. This branch closes most of that gap with
`scripts/household-authority-regression.mjs`: five independent headless
browser profiles (separate `--user-data-dir`, cookies, IndexedDB, device keys,
and CDP virtual authenticators) exercise one real in-process Kin server and
relay over loopback through the product's pairing, approval, activation,
member-removal, device-revocation, export, and restore controls. The server
clock is injectable, so Temporary expiry is enforced deterministically.

The drill now passes **102 assertions** in Edge 155.0.4283.45 and Chrome
154.0.8037.98 on Windows. That is up from 94 because pairing now drives the real
fingerprint controls. The drill and its follow-up found five defects, all fixed
on this branch with regressions:

- **B-001:** the household lifecycle route always returned 500.
- **B-002:** revoking the Adult that committed a rotation stranded the other devices.
- **B-003:** Limited and Temporary clients paused on Adult-only key steps.
- **B-004:** invitations created from the household page never showed their code.
- **P-002:** the trusted-device list stayed stale after revocation.

**P-001** was fixed with B-002. Four findings remain open: polish issues
P-003, P-004, and P-005, and nonblocking residual risks R-1 to R-4.

B-002 and B-004 are **fixed in the branch, subject to independent review and
CI on the final pushed commit**. No CI workflow exists for Kin in this
repository, so every result below is local.

Separate profiles on one machine are not physical devices, separate networks,
or independent people. Those drills, installed-PWA behavior, Firefox,
Safari/WebKit, and mobile remain **NOT RUN** and have manual instructions below.

## Status Legend

| Status | Meaning |
|---|---|
| **PASS** | Executed in the stated environment for this record and passed. |
| **FAIL** | Executed and failed. (None outstanding.) |
| **NOT RUN** | Not executed. Environment unavailable or out of scope. |
| **NOT VERIFIED** | Partly exercised, but the evidence does not prove the claim as a user would experience it. |

## Evidence Levels

| Level | What it is here | Evidence |
|---|---|---|
| Unit / service tests | Node tests of `PairingService`, `EncryptedSyncService`, components, and pure client helpers; Rust domain tests. | Complete server + web Node suite, `cargo test`. |
| Integration tests | Real HTTP server and relay on loopback with scripted sessions (no browser). | `server/sync-http.test.mjs` two-client test; `server/household-lifecycle.test.mjs` lifecycle route test. |
| Browser automation, single profile | Existing Edge runners with a stubbed API or the real server in one profile. | `security-ui`, `security-storage`, `browser`, `passkey` regressions. |
| Browser automation, independent profiles | Five separate browser processes/profiles against the real server, relay, and WebAuthn verifier. | `scripts/household-authority-regression.mjs`. |
| Physical devices / humans / networks | Not run. | Manual instructions below. |

## What the drill does and does not prove

- **Real:** separate profiles, IndexedDB stores, device keys, virtual
  authenticators and passkey ceremonies; real HTTP relay; product controls for
  invitation, claim, approval, activation, removal, revocation, export, and
  restore. Invitations must show their code in the page, not only in component
  state (this is how B-004 was found).
- **Fingerprint verification:** earlier revisions set `verifiedFingerprint`
  and `verifiedInviterFingerprint` directly on the component, which skipped the
  confirmation controls. The drill now reads the fingerprint each profile
  renders and passes those strings between processes. It requires the joining
  device's displayed key to match the approver's display, and the approver's
  displayed key to match the joining device's display. It then checks that
  approval is refused before the checkbox is ticked, with no server call (see
  P-005). Next it ticks the real "I compared this fingerprint on both devices"
  checkbox and clicks the real passkey button. Activation must be disabled until
  its own checkbox is ticked.
- **Not proven:** the comparison is automated string equality, not a person
  reading two screens. **Human fingerprint verification is NOT VERIFIED** and
  is not counted as a completed manual security test.
- **Deterministic shortcuts that remain:**
  - The server clock is injected. For the B-002 step, the server clock moves
    forward 7 minutes and A's page clock 11 minutes past the package TTL. Both
    are rewound afterward so later steps line up with real browser time.
  - Network loss uses CDP emulation, not OS-level disconnection.
  - For assertions, the drill inspects server and relay state in process and
    issues its own inspection sessions. Every household action under test goes
    through a browser profile.

## Verification Matrix

Execution method for every "multi-profile drill" row: the drill run on
2026-10-12 with Node 22.13.0 (`fnm exec --using v22.13.0`) on Windows 11
(NT 10.0.26300) x64, in Edge 155.0.4283.45 and Chrome 154.0.8037.98. It used an
in-memory SQLite `DurableStore`, an injectable server clock, and synthetic
households only. Cumulative assertion counts are from the 102-assertion run.

| Scenario | Expected outcome from current contract | Actual result | Environment / execution method | Evidence | Status |
|---|---|---|---|---|---|
| Adult joins household | Real pairing: invite → claim with fresh passkey → fingerprint-confirmed approval → activation. The new Adult has Adult trust authority and receives current and later key epochs only ([PAIRING](../PAIRING.md) "new/replacement adults receive only current/future epochs"). | Profile B joined through the product controls, with the code displayed, fingerprints matching across profiles, approval refused before confirmation, and activation gated. B reloaded, unlocked, held the approved identity, created and cancelled an invitation (201/200), received A's post-admission event, and did not receive the pre-join event. | Multi-profile drill (A, B). | "Adult admission assertions" (16 cumulative). | **PASS — multi-profile drill** |
| Fingerprint confirmation controls | Approval and activation require explicit fingerprint confirmation of matching displayed keys. | Matching displays and gating confirmed for B, C, C2, and D. The approval button is not visually disabled before confirmation (P-005), but the handler refuses. | Multi-profile drill. | Admission sections; console `NOTE … (P-005)`. | **PASS — automated gating**; **NOT VERIFIED — human comparison** |
| Limited member joins | Member participates in sync but every trust-management route is denied with `403 adult_required`. | Profile C joined as Limited; seven trust routes (invitations, device pairing, sync enable, device list, member removal, provisioning grants, epoch rotation) returned 403; C synced after A provisioned it and A received C's event. | Multi-profile drill (A, C). | "Limited admission and restriction assertions" (32 cumulative); `server/pairing-service.test.mjs` HTTP denial cases. | **PASS — multi-profile drill** |
| Temporary member joins | Status and absolute expiry come only from the Adult's invitation; the member cannot manage trust; participates until expiry. | Profile C2 joined with the inviter-chosen expiry, was denied trust management, synced, and A received its event. | Multi-profile drill (A, C2). | "Temporary expiry and committed-rotation race assertions". | **PASS — multi-profile drill** |
| Temporary member expires | After expiry the server ends participation on the next request, revokes the member's devices, reserves a rotation, and reports `expired` (not `removed`). | Server clock advanced 4 min past expiry: B's household view showed the member ended, server status `expired`, C2's session was refused, C2's sync paused, C2's local history stayed intact, and B committed the reserved rotation. | Multi-profile drill with injectable server clock. | "Temporary expiry and committed-rotation race assertions" (60 cumulative). | **PASS — multi-profile drill (controlled server clock)** |
| Member is removed | Removal through the Adult UI revokes the member's devices and sessions; subsequent operations fail; nothing already shared is erased. | While C was offline with an unsent event, A removed C with a fresh passkey. The server marked C `removed` and revoked its device. On reconnect C's sync paused with an authorization code, status and push returned 401, and C's local history and outbox were unchanged. A kept C's earlier event and never received the post-removal one; the relay held exactly one envelope from C. | Multi-profile drill (A, C) with CDP network offline emulation. | "member removal during disconnection assertions" (41 cumulative). | **PASS — multi-profile drill** |
| Device is revoked | Fresh-passkey revocation through the UI; the device's session and device cookie cannot regain access; membership itself persists; the remaining Adult recovers any committed epoch before rotating. | B committed the expiry rotation while A was offline. A revoked B before receiving the package, advanced past its package TTL, recovered the signed epoch package, and committed the required following rotation. B's reconnect sync paused, push returned 401, and login with B's device cookie was refused. B's local history and outbox were intact, and the relay held no envelope from B. | Multi-profile drill (A, B) with server and client clocks advanced deterministically. | "device revocation during disconnection assertions" (72 cumulative). | **PASS — Edge and Chrome** |
| Rotation committed by a later-revoked device (B-002) | Remaining trusted devices recover every committed epoch intended for them, even after package TTL, then complete the required next rotation; revoked, removed, and expired recipients cannot. | As above in the browser. Service tests add consecutive rotations, a lost acknowledgement, sender key succession, tampered, forged, and misaddressed packages, recipient revocation, removal, and expiry, capacity bounds, and restart equivalence. | Multi-profile drill plus deterministic service, crypto, and durable-restart tests. | Drill (60 and 72 cumulative); `server/rotation-recovery.test.mjs`; `server/durable-sync-integrity.test.mjs`. | **PASS — fixed in branch, pending independent review and final-head CI** |
| Household is exported | Export through the product control produces a package whose event count equals local history and whose membership snapshot carries authoritative `active`/`removed`/`expired` statuses. | A's export matched its local history and recorded A active, B active (device revoked, member not removed), C removed, C2 expired. | Multi-profile drill; `downloadArchive()` with the blob captured. | "export assertions" (75 cumulative). | **PASS — multi-profile drill** (P-003 clock-skew note) |
| Household is restored | Validation stages without touching the target; restore imports exact history including removed/expired members' events; membership statuses survive; no identity, sync state, coordinator, or server authority results. | Clean profile D validated and restored A's archive. It staged zero events and imported the exact count. It showed events from removed and expired members and nothing after the export, and preserved the snapshot byte for byte. It had no identity, sync state, or coordinator, and `/api/sync/status` returned 401. | Multi-profile drill (D) via the restore form and file input. | "clean-profile restore and re-authorization assertions" (93 cumulative). | **PASS — multi-profile drill** |
| Restore to clean browser, then re-authorize | A restored device gains sync only through ordinary same-member device pairing; after approval it catches up and deduplicates. | A created a same-member device invitation (code displayed). D claimed with matching fingerprints, A approved after confirmation, and D activated and bound to A's membership. A provisioned all epochs; D caught up with the post-export event and ended with the same event-ID set as A. The relay gained no duplicate. | Multi-profile drill (A, D). | Same section. | **PASS — multi-profile drill** |
| Revocation during disconnection | Stale offline state cannot override server revocation on reconnect; local unsent history is neither uploaded nor erased. | Covered by both the member-removal and device-revocation rows above (client offline through CDP network emulation while the Adult revoked). | Multi-profile drill. | Rows above; `server/sync-http.test.mjs`. | **PASS — multi-profile drill**; OS-level network loss **NOT RUN** |
| Two clients reconnect | Concurrent offline edits converge once on both clients with empty outboxes and no duplicates after repeated syncs. | A and D each added an item offline, reconnected, and after two sync rounds each held both items once, identical event-ID sets, empty outboxes; the relay gained exactly two events. | Multi-profile drill (A, D). | "two-client reconciliation assertions" (102 cumulative). | **PASS — multi-profile drill** |
| Physical devices, separate networks, installed PWA, Firefox/Safari/WebKit/mobile, human fingerprint comparison | — | Not exercised. | — | Manual instructions below. | **NOT RUN — ENVIRONMENTAL** |

## Findings

### B-001 — Household lifecycle route always returned 500 (FIXED)

Area: Server / authorization recovery. Severity: BLOCKER (reliability of the
path a revoked or removed device uses to tell lost access from deletion).

**Reproduction:** `node docs/audits/post-v0.40-repro/b001-lifecycle-route-500.mjs`
(prints 200 now; before the fix every `GET /api/household/lifecycle?householdId=…`
threw a `ReferenceError` because the route read a `store` binding that only
exists in the server factory).
**Fix:** `server/server.mjs` reads `context.store`. Regression:
`server/household-lifecycle.test.mjs` "HTTP lifecycle lookup answers without a
session…" (fails on the old code).

### B-002 — Revoking the device that committed the latest rotation strands the household (FIXED in branch)

Area: Key rotation / revocation recovery. Severity: BLOCKER before the fix
(permanent loss of household sync for every remaining device; no in-product
recovery).

**Reproduction:** `node docs/audits/post-v0.40-repro/b002-revoked-sender-rotation-strands-adult.mjs`
(prints `Fixed:` now). Two Adults. An access change reserves a rotation, and B
commits epoch 3 with A's package waiting in the relay. A revokes B before
syncing. `onAccessChange` used to delete every grant from the excluded sender,
so A could never obtain epoch 3. Without it, `commitRotation` refused to rotate
to epoch 4.
**Fix:** `rotateEpoch` marks packages from the authorized, committed
compare-and-advance as `committedRotation`. Retention follows these rules:

- The package is kept after sender revocation, including beyond its original
  expiry, only while its recipient remains trusted.
- `onAccessChange` removes it once the recipient is revoked, removed, or expired,
  even without an explicit exclusion.
- A recipient key transition removes it.
- A sender key transition keeps it, because the original signature still
  verifies against the sender's history.

The client relaxes only the expiry check, and only when the relay marks the
grant this way. The device ID, recipient fingerprint, and sender signature are
still verified against verified device-key history. Acknowledgement clears the
marker so normal pruning reclaims the grant. Rotation records the sender's own
epoch (P-001).
**Regression evidence (all PASS):**
- `server/rotation-recovery.test.mjs`
  - recovery after sender revocation and expiry, then the next rotation
  - packages for revoked, removed, and expired recipients removed, and their
    stale sessions refused
  - an access change without exclusions drops packages for untrusted recipients
  - tampered `wrappedKey`/`salt`/`nonce`/`signature`, a moved epoch, extended
    expiry, a forged signer, and wrong-device or superseded-recipient-key
    packages rejected even with the exception enabled
  - neither a package body nor a rotating client can set or clear the marker,
    and ordinary transfers still expire with 410
  - two consecutive epochs from a later-revoked Adult recovered in order, a lost
    acknowledgement redelivered idempotently, history byte-identical and never
    duplicated, the revoked device unable to push or retry, and acknowledged
    grants pruned
  - sender key succession: the package fails with only the successor key, with
    no local mutation, no acknowledgement, and the package retained; it succeeds
    with the authentic history
  - the retained-package bound is enforced atomically and never blocks the
    largest supported history
- `server/durable-sync-integrity.test.mjs`
  - retention across restart
  - sender revocation after restart matches revocation before it
  - recipient revocation after restart removes the package
  - the acknowledged grant reloads unmarked and prunes
  - six corrupt-marker variants rejected at startup, including a marker injected
    into an ordinary grant
  - pre-marker rotation grants load and expire as ordinary grants
- `web/sync/crypto.test.mjs`
- The drill's committed-rotation race in Edge and Chrome.

Mutation checks against the new tests caught each removed or weakened rule:
trust check, expiry exception, marker source, sender-key retention, the pruning
rule, the contract marker check, and sender-epoch recording.

### B-003 — Non-Adult clients paused sync on Adult-only steps (FIXED)

Area: Client sync / participation. Severity: BLOCKER before the fix (Limited
and Temporary members could not pull or push after any epoch rotation, which
every join, removal, revocation, and expiry triggers).

**Reproduction:** before the fix, the drill's Limited profile paused with
`adult_required: Only adults can provision household key access.` on its first
sync. Root cause is P-001 plus the coordinator attempting
`provisionMemberHistory` and `commitRotation` regardless of member kind, before
pull and push.
**Fix:** `web/sync/sync-coordinator.js` skips both steps unless
`memberHasTrustAuthority(status)` (the server reports `memberKind`). Regression:
`web/sync/sync-coordinator.test.mjs` for the helper and the drill's Limited and
Temporary rows (which fail on the old code).

### B-004 — Invitations from the household page never showed their code (FIXED in branch)

Area: Pairing / admission UX. Severity: BLOCKER (an Adult could not invite a
member or add a device through the product UI). The defect predates this branch.
Since v0.9.3, `kin-household.js` has checked the create response's
`inviterKeyFingerprint` against the local device key. `POST /api/pairings` and
`POST /api/devices/pairings` never returned that field, so every invitation
failed with "This device's approved key does not match its local key.", and the
code was never rendered. Earlier drill revisions missed it because they read the
code from component state.
**Reproduction:** `node docs/audits/post-v0.40-repro/b004-invitation-omits-inviter-key.mjs`
(prints `defect` on the old server and `fixed` now). The drill fails at the first
invitation on the old server.
**Fix:** both create responses return `inviterDeviceId` and
`inviterKeyFingerprint`, the same values `pairingView()` already gives the
inviter. No cryptographic or authorization change. Regression:
`server/pairing-service.test.mjs` "new invitations echo the inviter key…"
(fails on the old code) and the drill's displayed-code checks.

### P-001 — Rotation did not record the rotating device's own epoch (FIXED with B-002)

`EncryptedSyncService.rotateEpoch` records the committed epoch on the rotating
device in the same persisted update, after the capacity check. Covered by the
service, durable-restart, and capacity tests above.

### P-002 — Trusted-device list stayed stale after revocation (FIXED)

The revoke handler called `showDevices()` from inside its own `run()` busy
guard, so the refresh silently returned and the revoked device kept showing
"Trusted" until the page was reopened. Fixed in `web/components/kin-household.js`
to refresh after the operation releases the guard. Regression:
`web/components/kin-household.test.mjs` "device revocation refreshes the
trusted-device list…" (fails on the old code).

### P-003 — Archive membership validation is clock-skew sensitive (OPEN)

`validatePortableMembership` in `web/storage/event-store.js` rejects a
Temporary member with the server's authoritative `expired` status when the
browser's clock is still before `expiresAt`. With the drill's server clock 4
minutes ahead, export failed with "Kin found invalid household membership in
this export." A real client whose clock lags the server by Δ cannot export, or
restore such an archive, during the Δ window after an expiry. Not changed here
because it alters archive validation semantics; the drill uses a short real
expiry before exporting so both clocks agree.

### P-004 — `leaveHousehold` ignores the injected service clock (OPEN, test-infra)

`PairingService.leaveHousehold` calls `canParticipate(member)` with the real
`Date.now()` rather than `this.now()`. Production clocks coincide, so no user
impact, but fake-clock tests of Temporary self-leave behave differently.

### P-005 — Approval button is not visually disabled before fingerprint confirmation (OPEN)

`KinHousehold.render()` ends with `this.disabled = this.disabled`. When the
component is enabled, that setter enables every button, which overrides the
"Approve with passkey" gate set during rendering. Clicking it early is still
refused by `approve()` ("Compare the device fingerprint on both devices before
approving.") with no server call, so this is not an authorization bypass. The
activation view returns before that line and stays correctly gated. Not changed
here, to keep UI changes out of this PR. The drill asserts the enforced refusal
and prints a `NOTE … (P-005)` line.

### Residual risks (OPEN, nonblocking)

- **R-1 — legacy key migration can still strand a device.** Severity: low.
  Device key transitions happen only in the one-time legacy key-store migration,
  and `runOnce` completes a pending transition before receiving provisioning. A
  not-yet-migrated device that misses a committed rotation, while its sender is
  revoked, loses that package on migration. The package is bound to the old
  fingerprint, and the old private key is discarded. Another Adult holding the
  epoch can still provision it. If none exists, the device needs re-pairing.
  Fixing this would mean keeping the old agreement key or reordering migration,
  which is a protocol-adjacent change outside this PR. Reproduction: as in the
  "the expired-package exception never relaxes…" test, apply the recipient key
  transition before receiving.
- **R-2 — the client trusts the relay's marker.** Severity: low, within the
  threat model's honest-but-curious relay. A relay that falsely marks a grant
  can only make an expired but authentic, correctly addressed package
  acceptable. Expiry is chosen and signed by the sender, and a conflicting key
  for an epoch already held is refused (`saveEpoch`), so the impact is limited
  to availability.
- **R-3 — revoked senders' packages stay acceptable.** Severity: low.
  **Disposition: accepted limitation under the existing threat model; not
  proof against a compromised relay.**

  *Behavior.* Clients accept a key package from a sender the directory marks
  revoked, as long as these checks pass:
  - the package names this device and its current fingerprint;
  - its signature verifies against a key in the sender's verified history
    (certificate chain, pins, and signed key transitions).

  B-002 recovery needs this behavior. The base branch (`59c94a7`) already
  behaved this way: `receiveProvisioning` never checked sender revocation.
  Packages carry no signed creation time, so a client cannot tell a package
  signed before revocation from one signed after it.

  *Why it holds under an honest relay* (THREAT-MODEL "Revoked trusted device":
  "Service rejects its sessions and new epochs exclude it"):
  - **No new material from a revoked device.** Revocation deletes the device's
    sessions, so it cannot reach `rotateEpoch` or `submitProvisioning`.
  - **No impersonation.** The relay binds every package's `senderDeviceId` to
    the submitting session, so no other device can submit packages that name
    the revoked device as sender.
  - **The relay alone sets the recovery marker.** Only `rotateEpoch` sets it;
    package bodies cannot set or clear it, and durable validation rejects
    forged markers.
  - **No new access for the revoked device.** A recovered epoch is one the
    revoked device already legitimately held. Uploads stay blocked until a
    remaining Adult commits the next rotation, and that rotation excludes the
    revoked device.

  All four points are covered by `server/rotation-recovery.test.mjs` and
  `server/durable-sync-integrity.test.mjs`.

  *Against a compromised relay* (outside that model): a relay that also holds a
  revoked device's signing key could report a fabricated epoch and serve a
  validly signed key the attacker chose. It can also replay authentic old
  packages. Replay yields only keys originally sent to that device, and
  `saveEpoch` refuses conflicting keys for epochs already held. A client-side
  revocation check would not close the fabrication case. Revocation status
  itself comes from the relay, and the same adversary could leave the device
  unrevoked or restore its sessions directly. Resistance needs Adult-signed
  revocation and rotation-commit records (a signed-commit mechanism), which is
  a future protocol change and not attempted here. Similarly, offline events
  written under the pre-revocation epoch may upload after the next rotation.
  They are unreadable to the revoked device only while the relay honestly
  refuses its sessions.
- **R-4 — persistence cost grows with retained packages.** Severity: low.
  `saveSyncState` rewrites every grant on each persist. With
  `MAX_TRUSTED_DEVICES = 16`, a household can retain at most 127 × 15 committed
  packages, so this costs performance in extreme histories, not correctness.

## Executed Checks

All commands run from the repository root on 2026-10-12 against `db086ba`, on Windows 11
(NT 10.0.26300) x64. Toolchain: rustc/cargo 1.93.0 (pinned in
`rust-toolchain.toml`), and Node 22.13.0 through `fnm exec --using v22.13.0`
(the declared minimum; PATH Node is 22.12.0). Python 3.13.14. Browsers: Edge
155.0.4283.45 and Chrome 154.0.8037.98. `NODE_NO_WARNINGS=1` suppresses the
runtime's experimental SQLite warning.

```powershell
cargo fmt --manifest-path projects/kin/Cargo.toml -- --check
cargo clippy --manifest-path projects/kin/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path projects/kin/Cargo.toml
cargo build --manifest-path projects/kin/Cargo.toml --target wasm32-unknown-unknown --release
fnm exec --using v22.13.0 node --test (rg --files projects/kin/server projects/kin/web -g '*.test.mjs')
fnm exec --using v22.13.0 npm.cmd run test:server --prefix projects/kin
npm.cmd run test:server --prefix projects/kin   # PATH Node 22.12.0
python projects/kin/scripts/check_version.py
$kinBrowser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
fnm exec --using v22.13.0 node projects/kin/scripts/household-authority-regression.mjs $kinBrowser
fnm exec --using v22.13.0 node projects/kin/scripts/household-authority-regression.mjs 'C:\Program Files\Google\Chrome\Application\chrome.exe'
fnm exec --using v22.13.0 node projects/kin/scripts/browser-regression.mjs $kinBrowser
fnm exec --using v22.13.0 node projects/kin/scripts/security-storage-regression.mjs $kinBrowser
fnm exec --using v22.13.0 node projects/kin/scripts/security-ui-regression.mjs $kinBrowser
fnm exec --using v22.13.0 node projects/kin/scripts/passkey-regression.mjs $kinBrowser
fnm exec --using v22.13.0 node projects/kin/docs/audits/post-v0.40-repro/<script>.mjs   # each of the four
git diff --check
```

| Check | Result |
|---|---|
| `cargo fmt --check` | **PASS** |
| `cargo clippy --all-targets -D warnings` | **PASS** |
| `cargo test` | **PASS** — 173 passed, 0 failed (no Rust changes) |
| Release WASM build | **PASS** — output byte-identical to committed `web/wasm/kin_engine.wasm` (SHA-256 `988b930b…bdb8f`), so not copied |
| Complete server + web Node suite (22.13.0) | **PASS** — 416 passed, 0 failed, 0 skipped (399 at `6d04c10`; +17 regressions) |
| `npm run test:server` (22.13.0) | **PASS** — 279 passed, 0 failed (262 at `6d04c10`) |
| `npm run test:server` (PATH Node 22.12.0) | **FAIL — environment**: all 20 files fail to load with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`; this runtime is below the declared `>=22.13.0`. Not a code failure. |
| Version consistency | **PASS** — 0.40.1 consistent across client, server, and release metadata |
| `household-authority-regression.mjs`, Edge | **PASS** — 102 assertions |
| `household-authority-regression.mjs`, Chrome | **PASS** — 102 assertions |
| `browser-regression.mjs`, Edge | **PASS** — complete runner, including 10,000-event replay, CSP/same-origin, and encrypted sync storage |
| `security-storage-regression.mjs`, Edge | **PASS** — 47 + 37 + 12 + 158 + 22 + 29 + 4 + 4 assertions, including page-reload and process-restart recovery |
| `security-ui-regression.mjs`, Edge | **PASS** — 56 core, 20 overlapping-operation, 7 lifecycle-cancellation, 36 household-leave, 17 root-rotation UI, 143 lock/recovery/peer-tab/offline assertions |
| `passkey-regression.mjs`, Edge | **PASS** — 32 virtual-authenticator assertions; PRF supported and exercised |
| Reproduction scripts (B-001, B-002, B-004, P-001) | **PASS** — each prints its fixed state |
| `git diff --check` | **PASS** |
| Firefox, Safari/WebKit, mobile browsers | **NOT RUN** — the runners drive Chromium over CDP |
| CI on the final pushed head | **CI NOT CONFIGURED** — no Kin GitHub Actions workflow exists; PR #37 at `db086ba` reports no status checks |

## Manual Reproduction for NOT RUN Scenarios

Use synthetic households, a local build (`projects/kin/run.ps1`), and the
loopback relay. Never use production household data.

1. **Physical devices / independent people.** Repeat the drill's sequence with
   two phones or laptops on different networks: Profile A creates the
   household; B (Adult), C (Limited), D (Temporary with a 10-minute expiry) join
   through the invitation link. Confirm the invitation code appears (B-004), and
   have two people **read the fingerprints aloud from both screens** before
   ticking each confirmation box. Verify each role's controls and the HTTP
   denials from the browser devtools network tab.
2. **OS-level disconnection.** Put B in airplane mode, add an item, revoke B's
   device from A, reconnect B. Expect B's sync notice "no longer trusted", B's
   item still present locally, A never receiving it.
3. **Expiry in real time.** Wait past D's expiry; expect A's household page to
   show "access ended", D's sync to pause, and export from A to validate.
4. **Installed PWA.** Install Kin from the browser menu, lock, relaunch offline,
   unlock with the recovery key, then reconnect and confirm catch-up.
5. **Restore on a different machine.** Export from A, copy the file and
   recovery key out of band, restore into a fresh browser on another machine,
   confirm no sync until A approves a same-member device pairing, then confirm
   identical history and no duplicates.
6. **B-002 committed-rotation recovery (physical-device follow-up).** Two
   Adults online; let a Temporary member expire; take A offline before its
   next sync; wait for B to commit the rotation; revoke B before A receives its
   package; wait more than 10 minutes; then reconnect A. Expect A to recover
   the committed epoch, finish the required next rotation, and sync without
   skipping the missing epoch.
7. Record browser/OS versions, timestamps, and sanitized request outcomes. Do
   not record passkeys, recovery keys, cookies, or household text.

## v0.40.2 Follow-up — P-003 and P-004

The clock/archive follow-up fixes P-003 and P-004 without changing archive
formats or the server authorization contract. `validatePortableMembership`
now validates historical membership structure only; browser time cannot reject
an authoritative `expired` status or rewrite an `active` status. Export and
restore preserve `active`, `removed`, and `expired` exactly. Structural
contradictions such as expiry on Adult/Limited members, missing or invalid
Temporary expiry, unknown statuses, duplicate IDs, and oversized snapshots
remain rejected. Legacy packages without a membership snapshot and package-v1
archives remain supported.

`PairingService.leaveHousehold` now evaluates participation with the injected
service clock. Before-expiry Temporary self-leave succeeds; after-expiry access
is denied, and a completed leave invalidates the session. Adult, Limited,
removal, revocation, expiry, and lifecycle tests remain passing.

Validation was re-run on the v0.40.2 branch in Windows x64 with Node 22.13.0,
Rust 1.93.0, and Edge 155.0.4283.45. The complete Node server/web suite,
173 Rust tests, formatting, Clippy, release WASM, household authority drill
(103 assertions), browser, security storage, security UI, and passkey
regressions passed. Detailed results and limitations are recorded in
[`V0.40.2`](../planning/releases/V0.40.2.md). No tag or release was created. Physical
devices, human fingerprint comparison, non-Chromium/mobile environments, and
CI on a pushed final head remain unverified; R-3's honest-relay assumption is
unchanged.

## Release Recommendation

**Ready to merge into `kin-development`; NOT RELEASE-READY.** B-001 to B-004
and P-001/P-002 have focused fixes and regressions. The final review of B-002
found no defect, and R-3 is an accepted limitation under the honest-relay
threat model. Every locally executable gate passed when re-run against
`db086ba`.

- **CI is not configured.** That local run is the only automated evidence for
  this head.
- **Not proven against a compromised relay.** R-3 needs a future
  signed-commit mechanism for that.
- **Not run or not verified:** physical-device, cross-network, installed-PWA,
  non-Chromium, and human fingerprint-verification testing.
- **No production certification** is claimed.

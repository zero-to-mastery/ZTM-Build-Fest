# Kin Post-v0.40 Release Audit

**Audit date:** 2026-10-11
**Base:** `kin-development` at `7af1713` (`kin-v0.40.1` candidate)
**Audit branch:** `kin-post-v0.40-release-audit`

## Executive Summary

Kin's core event replay, local persistence, encrypted-storage lifecycle, recovery UI, and the exercised Edge household flows performed well in the available automated checks. No reproducible product defect that meets the BLOCKER definition was confirmed in this audit. The isolated Edge suite passed its core, keyboard, 320px, 200% zoom, forced-colors, reduced-motion, replay, and sync-storage scenarios. Rust formatting, Clippy, 173 Rust tests, and the release WASM build passed.

This is not enough evidence for a READY verdict. The complete automated frontend/server suite passed 392 tests on the installed Node 22.13.0 runtime, and automated server trust/durability tests passed. The full product drills involving real household admission, migration/catch-up, Temporary expiry, deletion/recovery, and offline reconnect across separate live profiles were not conducted. Cross-browser, mobile, real PWA installation/update, and assistive-technology testing are also outstanding. The automated browser suites are valuable regression evidence, not substitutes for these drills.

## Release-Candidate Recommendation

**NOT READY**

This recommendation means the evidence does not establish release-candidate readiness yet. It does not assert a confirmed security or data-loss defect. No BLOCKER was confirmed; the release gate remains incomplete in high-impact server authority/recovery and environment coverage.

## BLOCKERS

None confirmed.

## POLISH

### P-001 — Roadmap status and release records lag the implemented candidate

Area: Documentation claims / Roadmap reconciliation
Severity: POLISH

**Resolved 2026-10-16:** The roadmap and current-version documents now identify
v0.47.0 as the implementation candidate, preserve v0.42.x–v0.45.x as
unactivated planning contracts, and distinguish historical targets from current
stabilization. The reproduction below is retained as the original audit record.

**Reproduction:** Open `docs/ROADMAP.md`. Its first line still says the v0.35.0 candidate is on `kin-v0.35-more-adults`, and the diagram jumps from v0.27–v0.40 to later proposals without listing v0.28–v0.30 or v0.36–v0.40 individually. Compare with `README.md`, `CHANGELOG.md`, and `docs/releases/V0.40.1.md`, which identify v0.40.1 as the current candidate and v0.40 as the final planned feature line.

**Expected:** A reader can identify the current implementation candidate and understand which later release documents remain proposals.
**Actual:** The roadmap's leading status claim and its chronology are stale against the merged candidate.
**Why it matters:** Maintainers and reviewers can mistake historical plans for current state or miss that the planned feature arc is complete.
**Evidence:** `docs/ROADMAP.md` opening paragraph and release diagram; `README.md` current-candidate section; `docs/releases/V0.40.1.md`.
**Suggested direction:** Reconcile the roadmap's status and sequence after human review of this audit. Keep release history intact and label future lines as proposals; do not activate a new version as part of this audit.

### P-002 — More combines everyday context with trust and continuity controls

Area: Navigation / Product pruning
Severity: POLISH

**Reproduction:** Unlock a household, select **More**, and scan the page from top to bottom. Search, household mode, Pulse, Areas, Notes, household/member/device controls, and Privacy & continuity/export/restore are assembled on the same destination.
**Expected:** The destination label and grouping help a member quickly distinguish occasional administration from ordinary household work.
**Actual:** Daily context and trust/recovery controls share a long page headed “Household context, people, devices, and continuity.” The source builds these sections together in `web/components/kin-app.js` (`More` page construction, around lines 546–600).
**Why it matters:** After the feature arc, this page makes the product feel broader and more administrative than the open → see → act → leave loop needs. This is a hierarchy and scanning cost, not a core-use failure.
**Evidence:** The `More` page source and labels; the five top-level navigation buttons are Today, Lists, Routines, Handoff, and More. Search is a link from More, not a sixth primary navigation button.
**Suggested direction:** During stabilization, consider grouping daily household context separately from privacy, membership, and recovery controls, and validate the grouping with a first-use walkthrough. Do not remove capabilities based on this observation alone.

### P-003 — Maximum-size archive work has high desktop latency and memory use

Area: Performance / Export & Restore
Severity: POLISH

**Reproduction:** On Windows x64, run:

```powershell
node projects/kin/scripts/security-storage-regression.mjs `
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' `
  --performance-only --maximum-payload
```

The Edge 155 harness's largest case used 10,000 events with 4,096-byte text fields (about 42.08 MB canonical data), generated a 60.21 MB archive, and retained source fixture rows for exact round-trip comparison. It reported 25.91 s unlock/decrypt, 14.65 s export, 19.21 s restore, and a sampled peak sum of renderer working sets of 1,463,877,632 bytes across the benchmark cases. Archive round-trip exactness passed.
**Expected:** A within-limit archive remains recoverable without unexpectedly large browser memory pressure or long opaque waits.
**Actual:** This maximum-payload desktop case completes exactly but has long waits and high peak memory.
**Why it matters:** Large households or attachment-rich archives may make recovery feel stalled or exhaust constrained devices. This synthetic upper-bound fixture is not a representative ten-second daily action; it does not establish failure on ordinary households.
**Evidence:** Existing `security-storage-regression.mjs --performance-only --maximum-payload` output on Edge 155.0.4283.45, Node 22.12.0, Windows x64; 10,000 × 4,096-byte event case; archive round-trip exact.
**Suggested direction:** Keep the current bounded behavior. During stabilization, profile a representative household separately and assess whether progress feedback or reduced peak copies would materially improve constrained-device restore before changing implementation.

## FUTURE

### F-001 — Additional household capabilities without audit evidence

Area: Product pruning
Severity: FUTURE

Do not add a feature merely to fill a planned release slot. This audit found no demonstrated core-loop gap that requires another domain capability. Reassess the undated v0.41–v0.45 proposals after completing the stabilization evidence below; retain only work tied to a confirmed finding or user evidence. This is a scope recommendation, not a defect.

## Fresh Install

**Status: UNVERIFIED — ENVIRONMENT / incomplete manual walkthrough.** The Edge regressions used fresh temporary browser profiles and exercised startup, local storage, recovery, keyboard operation, and application flows. They did not constitute a first-time household usability study exercising every requested first entity (Item, Routine, List, Note, Shopping, Reference, Maintenance, attachment, Reminder, Playbook) with a new human user. No dead end or security-jargon blocker was observed in the executed paths. Exact friction for the omitted end-to-end onboarding sequence remains unestablished.

## Ten-Second Loop

**Status: PASS for automated Edge paths; manual timing across all loops UNVERIFIED — ENVIRONMENT.** Edge regressions passed Item add/complete/reopen/archive, Handoff, Shopping, Routine, keyboard focus restoration, retries, and persistence. The browser runner also measured 10,000-event real-WASM replay and verified a bounded result. The security UI runner recorded 79.4 ms empty setup, 20.8 ms one-event unlock/replay, and 24.7 ms offline unlock/replay on this Windows/Edge environment. These harness timings do not represent a human tap count or a large populated household. A live, timed add → responsibility → complete → leave loop and the Routine/Shopping variants were not manually measured.

## Navigation

The shell has five primary destinations: Today, Lists, Routines, Handoff, and More. Search is reachable from More; Pins and Playbooks appear within household surfaces. The source does not create a sixth primary nav button. A full interactive discoverability walkthrough for Reference Records, Maintenance, attachments, household settings, members, export, and restore was not completed. P-002 records the specific More-page grouping concern.

## Household Use

Automated Edge coverage passed Shopping and Staples, Routines, Playbooks, Handoff, Talk, Pulse, household modes, Reference Records, Areas, Notes, calendar export, and cross-tab convergence scenarios. Unit tests cover Maintenance, attachments, Responsibility, and portable archives. **UNVERIFIED — ENVIRONMENT:** no large household was populated and cross-feature archive/import/responsibility/member-removal/attachment scenarios were not run end to end against two authorized browser profiles and the service.

## Membership & Trust

Rust, frontend, server, and Edge security regressions passed their executed authority, lock, recovery, and local state cases. The Node suite includes direct HTTP denials for Limited/Temporary trust-management calls, server-side Temporary expiry/access changes, last-Adult safety, member removal, device revocation, recovery, deletion and durable-store restart cases. `security-ui-regression.mjs` passed 56 core security UI, 20 overlapping-operation, 7 lifecycle cancellation, 36 household-leave component, 17 root-rotation UI, and 143 application lock/recovery/peer-tab/offline assertions. A real multi-person household admission/removal/expiry workflow across live profiles remains **UNVERIFIED — ENVIRONMENT**. UI hiding is not counted as API authorization evidence.

## Privacy

Source/docs review found the intended local-first and encrypted-relay boundary documented: the relay persists identity/routing/traffic metadata and ciphertext, not household plaintext or content keys; it is not anonymous or zero-knowledge. No presence, last-seen, read-receipt, productivity, fairness, or location feature was found in the reviewed shell and privacy claims. Local tests passed content-free cross-tab invalidation and encrypted storage checks. **UNVERIFIED — ENVIRONMENT:** relay metadata was not inspected from a newly exercised live service during this audit. No plaintext-metadata leak was confirmed.

## Export & Restore

The frontend test suite passed the archive coverage, the full Node suite passed all 392 tests, and the Edge security-storage runner passed corruption, transaction, lock, and restore-related assertions. v0.40 documentation explicitly says restore stages the complete package in memory, validates canonical replay and attachment integrity before promotion, refuses incompatible non-empty targets, and does not restore credentials/device trust. **UNVERIFIED — ENVIRONMENT:** the full requested matrix (unsupported future format, wrong household/key, oversize package, invalid event, corrupt attachment, interrupted promotion, reload, unavailable service, offline restore) was not rerun as a single release drill; real member/attachment-rich export and clean-profile restore was not performed.

## Device Migration

**UNVERIFIED — ENVIRONMENT.** No real two-profile/device migration with another trusted Adult approving a new device, a stale export, attachments, sync catch-up, and Temporary/removed-member history was performed. The v0.40 contract and tests preserve the architecture boundary that export restores history but grants no device trust or sync authority. The Edge virtual-authenticator WebAuthn regression passed 32 assertions, including PRF, but does not count as a physical multi-device migration drill.

## Offline

Edge local storage/security tests passed offline unlock, content-free peer notifications, recovery after refresh, and storage transaction assertions. **UNVERIFIED — ENVIRONMENT:** a populated household was not taken through online → offline → mutate → process restart → further mutation → reconnect/reconcile across Items, Routines, Shopping, Responsibility, Maintenance, attachments, and Temporary expiry. No lost-mutation or false-sync defect was reproduced.

## PWA

The 135 passing frontend tests include service-worker tests, and the Edge application regression passed its core offline/local-shell paths. **UNVERIFIED — ENVIRONMENT:** installation from browser UI, installed launch, actual offline launch after installation, service-worker update offer/later/update-now, failed staging rollback, old-cache cleanup, and update timing during active edits were not exercised as an installable PWA lifecycle in this audit.

## Browsers

| Browser | Result | Evidence / limit |
|---|---|---|
| Chromium / Edge | PASS | Edge 155.0.4283.45, Windows x64; isolated core browser, security-storage, and security-UI runners passed. |
| Chrome | UNVERIFIED — ENVIRONMENT | No Chrome executable was available by command lookup or exercised. |
| Firefox | UNVERIFIED — ENVIRONMENT | Not installed/exercised. |
| Safari / WebKit | UNVERIFIED — ENVIRONMENT | Not available on this Windows host. |
| Mobile Safari | UNVERIFIED — ENVIRONMENT | No iOS device/runtime. |
| Mobile Chromium | UNVERIFIED — ENVIRONMENT | No mobile device/runtime. |

## Accessibility

**PASS:** Edge regression exercised keyboard paths, visible focus, focus restoration, 320px reflow, 200% page-scale zoom, forced colors, reduced motion, text spacing, target sizing, and status messaging. Restore controls use labels and status/alert regions by source and contract. **UNVERIFIED — ENVIRONMENT:** actual screen-reader/assistive-technology testing, all member-management accessible names in a manual audit, and mobile assistive technology were not run. No screen-reader certification is claimed.

## Performance

The Edge UI runner measured 79.4 ms empty setup, 20.8 ms one-event unlock/replay, and 24.7 ms offline unlock/replay. The core browser regression passed its 10,000-event real-WASM replay. The maximum-payload harness completed in Edge 155.0.4283.45 on Windows x64. Initialization was 6.6 ms. At 1,000 short-text events: migration 416 ms, unlock/decrypt 281 ms, replay 4.6 ms, export 162 ms, restore 415 ms. At 10,000 short-text events: migration 3.50 s, unlock/decrypt 3.22 s, replay 46 ms, export 1.81 s, restore 3.77 s. At 10,000 events with 4,096-byte text: migration 20.30 s, unlock/decrypt 25.91 s, replay 156 ms, export 14.65 s, restore 19.21 s. The last case used 84.06 MB serialized encrypted records, estimated 92.20 MB origin usage, a 60.21 MB archive, and sampled peak renderer working set of 1.46 GB. Each archive round-trip was exact. This synthetic max-text case shows a large-input recovery performance concern (P-003); it is not evidence that the ordinary ten-second loop is slow. Search, full Today render, many Routines, attachment-heavy Reference Records, and server sync catch-up at documented limits remain unmeasured.

## Product Pruning

P-002 is the confirmed hierarchy concern from the reviewed shell. No feature was removed. The inspected product language explicitly rejects streaks/pressure and distinguishes household Guest mode from Temporary membership; no scoring or surveillance capability was observed. F-001 records the recommendation to reassess proposed features using audit evidence.

## Documentation Claims

README and portability documentation explain that exports are manual, restore local history only, device authorization is separate, and browser notifications may be suppressed while suspended/terminated. Those claims were not found to overpromise automatic backup or notification delivery. P-001 records the concrete stale roadmap status. `SECURITY.md` and several architecture/privacy docs retain historical v0.10/v0.11/v0.12 status sections; those are visibly labeled as last published release or historical implementation status, but should be clearly separated from current candidate status in the next documentation pass. No cryptographic-erasure or cross-browser certification claim was confirmed in the inspected claims.

## Roadmap Reconciliation

| Proposal | Audit disposition |
|---|---|
| v0.41.x Backup Safety & Disaster Drills | Still justified as validation work only if drills expose concrete gaps; much of the requested audit scope is verification rather than a new product capability. Re-scope after this report; do not start it now. |
| v0.42.x Cross-Browser & Mobile Hardening | Still justified by the unverified browser matrix, but should be a validation/stabilization plan rather than assumed feature release. |
| v0.43.x Performance & Large-Household Limits | P-003 confirms a max-text archive latency/memory concern; pursue only a measured stabilization improvement if representative-device profiling supports it. |
| v0.44.x Release Candidate & Accessibility | Partly superseded by this audit's purpose; screen-reader/manual accessibility and full release-gate evidence remain outstanding. Reconcile to evidence, not a scheduled capability. |
| v0.45.x Stable Release Preparation | Future administrative work only if human review accepts the stabilization result; no new feature justification established. |

The v0.41–v0.45 release files are planning contracts, not active work. No feature line or version was activated by this audit.

## Automated Gate

### PASS

- `cargo fmt --manifest-path projects/kin/Cargo.toml -- --check`.
- `cargo clippy --manifest-path projects/kin/Cargo.toml --all-targets -- -D warnings`.
- `cargo test --manifest-path projects/kin/Cargo.toml`: 173 passed, 0 failed.
- `cargo build --manifest-path projects/kin/Cargo.toml --target wasm32-unknown-unknown --release`.
- Full frontend + server Node test suite under Node 22.13.0 with `NODE_NO_WARNINGS=1`: 392 passed, 0 failed. The environment variable suppresses the runtime's experimental SQLite warning, which otherwise polluted child CLI output asserted by tests.
- Edge 155 core `browser-regression.mjs`: completed without reported failure; included core household flows, 10,000-event real-WASM replay, keyboard/focus, 320px/200% zoom, forced colors, reduced motion, and sync-storage coverage.
- Edge `security-storage-regression.mjs`: encrypted storage, migration, lock, bounded paging, rotation/restart assertions passed.
- Edge `security-ui-regression.mjs`: security UI, lock/recovery, peer-tab, offline and household lifecycle assertions passed.
- Edge `passkey-regression.mjs` under Node 22.13.0: 32 virtual-authenticator assertions passed; PRF supported and exercised.
- `python projects/kin/scripts/check_version.py`: candidate 0.40.1 consistent across client, server, and release metadata.
- `git diff --cached --check` after staging the report: clean.

### FAIL

None in the final rerun set.

### UNVERIFIED — ENVIRONMENT

- Real separate browser/profile/device authority and recovery drills; Chrome/Chromium multi-profile use, Firefox, Safari/WebKit, mobile browsers, installed-PWA behavior, and manual assistive-technology/screen-reader testing remain outstanding.
- Manual fresh-install first-action and complete ten-second loop usability timings.

## Recommended Stabilization Plan

1. Complete real multi-profile authority and recovery drills not covered by automated tests. Use separate live browser profiles/devices to exercise Adult admission, Limited admission, Temporary admission, Temporary expiry, manual Temporary revocation, member removal, device revocation, recovery, household deletion, stale-export migration, and new-device restore followed by re-authorization.
2. In those migration/reconnect drills, verify attachment digests and deduplication, Responsibility convergence, and preservation of archives, Pins, Playbooks, Routines, and Shopping without rolling back removed members, revoked devices, or expired Temporary access.
3. Complete the PWA lifecycle, Firefox, Chrome, Safari/WebKit/mobile where available, and manual screen-reader checks; classify unavailable platforms explicitly.
4. Profile representative household size on a constrained device against the ten-second daily loop and compare it with P-003's synthetic maximum before deciding whether archive-memory or progress-feedback work is warranted.
5. Reconcile stale roadmap/current-candidate documentation, then validate the More-page hierarchy with a first-use walkthrough before changing information architecture.

These are stabilization and evidence tasks, not a feature-release sequence. Do not begin v0.41, bump the version, tag, merge, or implement findings as part of this audit.

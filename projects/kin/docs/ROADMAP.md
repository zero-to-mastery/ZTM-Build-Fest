# Roadmap

Current release: `v1.6.0 — Kin for Everyone`, released
2026-10-21 as `kin-v1.6.0`. The release before it was `v1.5.0 — One Account and Private Spaces`.
The work between v0.10.3 and v1.0.0 shipped per the owner's
[review-gate decisions](audits/V1.0_REVIEW_GATES.md); this page records how Kin
got there and continues through v1.1. Work after v1.0 is tracked as GitHub
issues.

```text
v0.9.3 — Encrypted Event Sync Stabilization
	↓
v0.10.x — Portable Core + Local Security
	↓
v0.11.x — Durable Service & Deployment
	↓
v0.12.x — Data Lifecycle, Retention & Deletion (v0.12.3 candidate)
	↓
v0.13.x — Recovery & Household Continuity
	↓
v0.14.x — UX/UI Consolidation
	↓
v0.15.x — Household Areas
	↓
v0.16.x — Household Notes & Reference Context (v0.16.3 hardening candidate)
	↓
v0.17.0 — Checklist Steps (existing tagged candidate)
	↓
v0.18.0 — Richer Routine Scheduling (implementation candidate)
	↓
v0.19.x — Shared Shopping Lists (authorized fast-track)
	↓
v0.20.x — Staples & Replenishment (prior fast-track candidate)
	↓
v0.21.0 — Household Modes (implemented candidate)
	↓
v0.22.0 — Lightweight Planning Dates (implemented candidate)
	↓
v0.23.x–v0.40.x — Calendar, history, search, household knowledge, membership and portability candidates
	↓
v0.41.x — Mobile Experience & Passkey-First UX candidate
	↓
v0.42.x–v0.45.x — Unactivated follow-up planning contracts
	↓
v0.46.0 — Personal Appearance candidate
	↓
v0.47.0 — Household Identity & Shared Appearance
	↓
v1.0 readiness — security fixes, sync quarantine, recovery-key labels, Node 24, frozen formats, real-device testing
	↓
v1.0.0 — Stable Kin Platform
	↓
v1.1.0 — Connected Household Devices
	↓
v1.1.1 — Member and Notification Clarity
	↓
v1.1.2 — Private Household Branding
```

Kin supports encrypted local storage, recovery/optional PRF unlock, verified migration, Rust commands/codecs, encrypted archives and a static offline shell alongside opt-in encrypted sync. The v0.11 candidate adds durable server identity/relay state and service database backup/restore. Archives recover local history, not server identity. Independent security review and broader browser/authenticator coverage remain outstanding.

The v0.11 candidate settled service durability before v0.12 lifecycle/deletion.
The detailed release records preserve the candidate progression through v0.41.1.
The v0.46.0 candidate added protected member-bound personal appearance, and
v0.47.0 added encrypted revisioned household identity/default appearance plus
recorded admin authority. v0.21.0–v0.47.0 were never tagged; they shipped in
v1.0.0. The v0.42.x–v0.45.x documents were planning contracts that were never
activated; v1.0 readiness (epic #150) took their place.

v1.1.0 delivers device names and nicknames (#71), household identity on home
screens (#78), opt-in content-free push notifications (#85), QR pairing and
phone-approved computer sign-in (#93), and the Node service sandbox (#106).
v1.1.1 clarifies member/device identity, pairing choices, device trust, and
push-recipient diagnostics (#221).
v1.1.2 keeps private household branding synchronized across the unlocked shell,
installed-app identity, and session transitions (#231–#233).
The next unshipped product capability is tracked in GitHub rather than assigned
a version here.

## October direction

The October daily plan below is now historical planning context. It drove small
candidate increments through v0.40.x, but dates and proposal numbers are not
release evidence. It ended in v1.0.0.

> Kin should help a household remember, coordinate, hand off, and recover context without requiring everyone to become a project manager.

The existing milestone history and detailed platform contracts remain part of this roadmap. Historical descriptions below record behavior at that release, including memory-only relay storage and draft persistence later superseded by v0.10/v0.11 work. See the [changelog](../CHANGELOG.md) for release evidence and the [README](../README.md) for current setup and limitations.

## Planning releases

### `v0.0.1` — Product foundation

Define what Kin is, who it initially serves, the everyday problem it addresses, its first useful daily loop, and its non-goals. Record the product principles.

### `v0.0.2` — Technical foundation

Document intended browser/Rust responsibilities, a conceptual event model, the local-first direction, the future sync boundary, the privacy posture, and dependency policy.

### `v0.0.3` — UX and implementation planning

Describe conceptual daily flows, sequence the implementation roadmap, and specify the initial direction for the first coded release. Later planning releases refine the domain, trust model, and implementation contract; no app ships in this release.

### `v0.0.4` — Household Domain Specification

Define household entities and lifecycles, the immutable event envelope and naming convention, event availability by release, deterministic validation/replay, and state/tombstone semantics. See [DOMAIN](DOMAIN.md), [EVENTS](EVENTS.md), [STATE](STATE.md), and [LIFECYCLES](LIFECYCLES.md).

### `v0.0.5` — Trust, Identity, and Synchronization Design

Specify household/member/device/credential identity, pairing and device revocation, cryptographic posture, threats, encrypted relay responsibilities, metadata exposure, and offline conflict classes. Design only; no identity, crypto, or sync implementation. See [IDENTITY](IDENTITY.md), [PAIRING](PAIRING.md), [SYNC](SYNC.md), [CRYPTOGRAPHY](CRYPTOGRAPHY.md), and [THREAT-MODEL](THREAT-MODEL.md).

### `v0.0.6` — Implementation Contract

Freeze the initial v0.1.0 scope and specify its ABI, protocol, local storage, components, testing, accessibility, and release gate. The `.0.7`–`.0.9` planning releases add durability, contributor guidance, and final preflight; v0.0.6 does not ship an app. See [IMPLEMENTATION](IMPLEMENTATION.md), [ABI](ABI.md), [STORAGE](STORAGE.md), [COMPONENTS](COMPONENTS.md), [TESTING](TESTING.md), [ACCESSIBILITY](ACCESSIBILITY.md), and [V0.1.0](planning/V0.1.0.md).

### `v0.0.7` — Data Durability & Evolution

Define independent persistent-contract versions, compatibility and migration failure behavior, portable export/import requirements, data retention/deletion boundaries, and event-log growth/checkpoint principles. Specifications only; no migration or export functionality. See [VERSIONING](VERSIONING.md), [MIGRATIONS](MIGRATIONS.md), [PORTABILITY](PORTABILITY.md), and [RETENTION](RETENTION.md).

### `v0.0.8` — Developer & Contributor Experience

Document human contribution expectations, intended cross-platform development setup, code style, release procedure, and privacy-safe debugging. The commands/workflow are guidance only; no executable tooling or application code. See [CONTRIBUTING](../CONTRIBUTING.md), [DEVELOPMENT](DEVELOPMENT.md), [CODE-STYLE](CODE-STYLE.md), [RELEASES](RELEASES.md), and [DEBUGGING](DEBUGGING.md).

### `v0.0.9` — Implementation Preflight

Complete the specification audit, accepted decision records, canonical test vectors, and requirement traceability for the frozen v0.1.0 scope. This Specification Release Candidate 1 completes technical planning; it does not begin implementation. See [PREFLIGHT](planning/PREFLIGHT.md), [TEST-VECTORS](TEST-VECTORS.md), [TRACEABILITY](planning/TRACEABILITY.md), and [accepted decisions](decisions/0001-event-sourced-household-state.md).

### `v0.0.10` — GitHub Community & Project Documentation

Align README with the Build Fest project requirements and add project-scoped conduct, security, support, issue, and pull-request guidance. The MIT license already exists. Because Kin is nested in a monorepo, GitHub does not automatically discover the nested community files/templates; document this limitation rather than changing parent-repository files. This release remains documentation-only.

### `v0.0.11` — Implementation Cycle Handoff

Record the general release cadence for future implementation lines, reaffirm v0.1.0 as the first implementation milestone, and correct stale current-version wording. Preserve the v0.1.0 specification and v0.0.10 community-health work; this release adds no application code or build tooling.

### `v0.0.12` — Changelog & Release History

Establish a Kin-scoped changelog from actual tagged release history and document its maintenance. This is a documentation-only release; it does not begin v0.1.0 implementation.

## First coded release

Each minor release represents a new product capability. Its initial stabilization patches address correctness (`.1`), resilience/accessibility (`.2`), and hardening (`.3`) when needed; additional fixes remain patches `.4` and onward. Earlier lines used a human feedback checkpoint before the next feature. Historical work follows the [daily cadence](planning/BUILD-FEST-CADENCE.md) and [release-line protocol](planning/RELEASE-LINE-PROTOCOL.md); v1.0.0 and every later release remain subject to the same validation, compatibility and human-review gates.

### `v0.1.0` — Household Heartbeat

Implemented: Rust compiled to WebAssembly, a native `<kin-app>` with focused child custom elements, the manual versioned JS/WASM ABI, `ITEM_ADDED` and `ITEM_COMPLETED`, deterministic Rust replay, IndexedDB event-only persistence, and add/complete/reload behavior using local placeholder identities. No partner login, sync, or other product areas are included. See [V0.1.0.md](planning/V0.1.0.md) for the frozen contract and release checks.

The detailed boundary and acceptance scope are in [V0.1.0.md](planning/V0.1.0.md); release history is in [CHANGELOG](../CHANGELOG.md).

### `v0.1.1` — Core Correctness

Hardened Unicode roundtripping, local storage startup cleanup, and stored-event metadata validation. Regression checks cover malformed input, invalid-event non-append behavior, corrupted-row preservation, concurrent tabs, and rapid repeated submission. No new product capability was added.

### `v0.1.2` — Resilience & Accessibility

Preserves an in-progress compose draft across same-tab reloads using best-effort `sessionStorage`, restores keyboard focus after asynchronous add/complete operations, exposes `aria-busy`, and improves feedback when WASM or local storage is unavailable. Reflow and touch targets were checked at narrow widths. No new product capability was added.

### `v0.1.3` — Household Heartbeat Hardening

Audits the Rust/JavaScript ownership boundary, future-capability leverage, dependency surface, local-only privacy behavior, and v0.0.10 community documentation. Fixes only meaningful infrastructure or hardening gaps; introduces no new product capability.

### `v0.1.4` — Household Heartbeat Maintenance

Continues approved correctness, resilience, accessibility, test, and tooling improvements to the existing Household Heartbeat. No new product capability.

### `v0.1.5` — Final 0.1.x Stabilization

Associates draft clearing with the successfully persisted submission, preserves newer drafts during retry or delayed completion, and adds browser-native regressions. Fixes PowerShell build failure propagation. No new product capability; no further 0.1.x polishing is planned.

## Product increments

### `v0.2.0` — Today + Needs

Implemented: Today and Needs views, lightweight fixed classification, fast capture defaulting to Needs, complete/reopen/archive item transitions, and local deterministic replay. Legacy v0.1.x unclassified items appear in Today. Protocol v2 carries the new projection while protocol v1 and IndexedDB schema 1 remain unchanged.

### `v0.2.1` — Today + Needs Correctness

Completed: added exact reopen/archive payload-boundary tests, ensured protocol v1 fails closed for unrepresentable state, and checked event/logical-counter atomicity through failures, aborts, and retries. No product concept was added.

### `v0.2.2` — Today + Needs Resilience & Accessibility

Completed: drafts and item actions recover across failures/retries and peer state changes; stale retries clear against Rust-derived state. Keyboard focus, forced colors, reduced motion, increased text spacing, 320px reflow, and 200% page-scale emulation were checked. No new capability.

### `v0.2.3` — Today + Needs Hardening & Polish

Completed: verified the architecture/privacy boundary, parser/version handling, 10,000-event/64 MiB behavior, and current Today + Needs clarity. No new capability. Stop here for release-line evaluation.

### `v0.2.4` — Today + Needs Compatibility Fixes

Completed: corrected protocol-v1 result headers without changing the historical byte layout, disabled every item action while busy, and added exact WASM ABI and browser regression coverage. No new capability. Stop for user review before further work.

### `v0.3.0` — Handoff

Implemented locally: short Handoff capture, acknowledgement, recent context, and terminal archival. Protocol v3 preserves Item history and adds Handoff projection; actors remain local placeholders. Stabilization through v0.3.3 is complete; stop for user evaluation.

### `v0.3.1` — Handoff Correctness

Completed: lifecycle, protocol/payload/result boundaries, actor provenance, event/counter rollback and canonical-byte preservation.

### `v0.3.2` — Handoff Resilience & Accessibility

Completed: interrupted capture, drafts, failed-action retries, stale peers, focus, keyboard, busy state and accessibility modes.

### `v0.3.3` — Handoff Hardening & Polish

Completed: parser boundaries, 10,000-event replay, real WASM memory growth, architecture/privacy audit and documentation reconciliation. Stop for evaluation.

### `v0.3.4` — Handoff Retry Recovery

Completed: preserve failed command retries through repeated canonical-refresh failures. Reconcile stale actions after recovery and discard superseded retries. No new capability. Stop for evaluation.

### `v0.3.5` — Build & Run Convenience

Completed: add project-local PowerShell and POSIX shell launchers that build the WASM module through the established scripts and serve the web app on loopback port 8000. No product capability or runtime dependency added.

### `v0.4.0` — Talk

Implemented: short Talk capture, Open/Resolved lists, resolve, reopen and terminal archive. Resolution is workflow state only. See [V0.4.0](planning/V0.4.0.md).

### `v0.4.1` — Talk Correctness

Completed: lifecycle/payload/result/compatibility audit, exact legacy bytes, combined limits and atomic storage regressions.

### `v0.4.2` — Talk Resilience & Accessibility

Completed: keyboard lifecycle/focus, semantic controls, native focus order, independent drafts and stale retries with/without invalidation or refresh recovery.

### `v0.4.3` — Talk Hardening & Polish

Completed: parser truncation/length boundaries, maximum mixed replay, real WASM growth/copied results, architecture/privacy review and documentation reconciliation. Pulse preserves all Talk regressions.

### `v0.5.0` — Pulse

Implemented: fixed actor-scoped capacity, set/replace/clear, deterministic explicit-time expiry and protocol v5. No acknowledgement, scoring or interpretation. See [V0.5.0](planning/V0.5.0.md).

### `v0.6.0` — Since You Last Looked

Completed: derive a bounded, Rust-owned summary of Item, Handoff and Talk changes since this installation's explicit local cursor. Pulse is excluded. Protocol v6 preserves the exact snapshot boundary; IndexedDB remains schema 1 and no household event records a view. See [V0.6.0](planning/V0.6.0.md).

### `v0.6.1` — Summary Correctness

Completed: audited empty and cursor-position cases, duplicate/conflicting event IDs, exact cap boundaries, and malformed/partial local metadata. No new capability or production behavior change.

### `v0.6.2` — Summary Resilience & Accessibility

Completed: audited cursor write failures/abort, refresh recovery, pending-write reconnect, missed invalidation, cross-tab orderings, Pulse timer refresh, keyboard/focus and accessibility modes. No new capability.

### `v0.6.3` — Summary Hardening & Polish

Completed: audited v6 parser/result boundaries, 10,000-event replay, WASM memory/copy behavior, privacy and restrained UI polish without adding capability. Stop for user evaluation.

### `v0.7.0` — Routines

Implemented: Daily and Monday-start Weekly Routines with deterministic civil-date occurrence keys, current-period complete/reopen, terminal archive, catch-up summary integration and browser lifecycle reprojection. See [V0.7.0](planning/V0.7.0.md).

### `v0.7.1` — Routine Correctness

Audit recurrence boundaries, replay, malformed protocol, duplicates/conflicts and historical compatibility. No new capability.

### `v0.7.2` — Routine Resilience & Accessibility

Audit suspended/stale tabs, midnight/focus/visibility, failed writes/retries, keyboard/focus and accessibility modes. No new capability.

### `v0.7.3` — Routine Hardening & Polish

Audit ABI/allocation/maximum replay, privacy and documentation consistency; restrained UX polish only. Stop for evaluation.

### `v0.7.4` — Routine Stale-Action Correctness

Reject stale same-period completion/reopen commands before persistence, add multi-client regression coverage, harden manual Wasm ABI allocation ownership, and refresh pairing-document status for the v0.8.0 planning checkpoint. No product capability, protocol-layout or persistent-storage change.

### `v0.8.0` — Household Pairing

Completed through v0.8.8: one household with exactly two active adult-member slots, manual pairing codes/invitation URLs, passkeys, member-bound approval and activation, trusted-device controls and session invalidation, reauthentication, protected membership removal, replacement after removal or leave with historical membership retention, terminal-claim cleanup, and bounded authentication flows. QR is deferred. At the v0.8.8 boundary, household content sync remained unimplemented; v0.9.x adds it. The implementation record is [V0.8.0](planning/V0.8.0.md).

### `v0.9.0` — Encrypted Sync

Completed as the first encrypted-sync iteration: reviewed threat/key lifecycle contract, versioned AES-GCM event envelopes with device signatures, opaque authorized push/pull relay, exact retry outbox, bounded cursoring, additive IndexedDB schema 2, and offline Rust/WASM/browser fixtures. Existing canonical bytes remain unchanged. See [V0.9.0](planning/V0.9.0.md).

### `v0.9.1` — Device Provisioning, Epochs, and Revocation

Completed: locally generated non-extractable device keys, same-member trusted-device pairing with fingerprint comparison, recipient-bound key wrapping, atomic epoch compare-and-advance, revocation/member-removal rotation gates, historical-key entitlements, and retry/stale epoch coverage. Revocation cannot erase prior keys/plaintext.

### `v0.9.2` — Offline Reconciliation and Conflict Semantics

Completed: persistent exact-envelope outbox, crash-safe remote commit/cursor advancement, separate catch-up cursor, additive Rust v8 identity resolution, equal-Lamport deterministic replay, stale local-clock advancement, documented archive conflict behavior, and relay-cursor reset detection/retry.

### `v0.9.3` — Recovery, Privacy, and Feedback Readiness

Completed: recovery and metadata threat assessment, encrypted logging/privacy boundary, bounds and malformed-envelope handling, same-member device enrollment, relay restart semantics, browser storage migration verification, and product-facing sync states. The identity service/relay remain memory-only and no independent security audit is claimed. This is the final v0.9.x encrypted-sync stabilization gate.

### `v0.10.x` — Portable Core + Local Security

The final local architecture/security development line. v0.10.0 implements cryptographically locked local household data, independent credential/recovery wrappers, recoverable plaintext migration, Rust-owned command semantics and canonical codecs, encrypted export/import, native domain tests, a static offline shell and signed transport-key migration. v0.10.1 corrects overlapping unlock feedback, asynchronous trusted-device pinning and interrupted key-rotation recovery; v0.10.2 adds local root rotation; v0.10.3 hardens bounded storage/archive processing and closes this implementation line. The evidence inventory, compatibility, measured limits and readiness work are in [V0.10.0](planning/V0.10.0.md). Human review of the v0.10 gate preceded the next implementation line; its v1.0 decision is in [review gates](audits/V1.0_REVIEW_GATES.md).

Increase the Rust footprint by increasing the amount of Kin that is deterministic, portable, invariant-driven, and independently testable — not by moving browser-native capabilities into Wasm. Web Crypto and networking remain browser/server adapter responsibilities.

### `v0.11.x` — Durable Service & Deployment (implementation candidate)

The candidate implements SQLite server schema v1, durable identity/authorization
and opaque relay state, commit-before-acknowledgement, fail-closed migration and
corruption handling, an exclusive production-process lock, and verified
online-backup/offline-restore commands. Automated tests include a spawned HTTP
process restart and persistence of reauthentication, event identity, cursor and
device sequence. It was a review candidate, never published on its own; its
v1.0 gate decision is item G2 in [review gates](audits/V1.0_REVIEW_GATES.md). See [V0.11.0](planning/V0.11.0.md).

### `v0.12.x` — Data Lifecycle, Retention & Deletion

The implementation defines `active → deletion_pending → deleted`, fresh-passkey
authorization, a 30-day cancellation window, final server-side purge, permanent
minimal tombstones, stale-client rejection and explicit backup restore
acknowledgement. It preserves full encrypted history until final deletion and
documents local/exported-copy and rollback limitations. See [V0.12.0](planning/V0.12.0.md).

### `v0.13.x` — Recovery & Household Continuity

Define explicit recovery outcomes for lost credentials, devices, server state and
archives; preserve the boundary between household history and identity/device
authority; and ensure replacement enrollment is not an authorization bypass.
Unrecoverable cases must be stated honestly. See [V0.13.0](planning/V0.13.0.md).

### `v0.14.x` — UX/UI Consolidation

After the preceding platform semantics are settled, consolidate information
architecture, navigation, onboarding, security/recovery/deletion presentation,
responsive behavior, accessibility, interaction and visual consistency across
Kin's existing product areas. This line presents stable platform behavior; it
does not redesign encryption, storage, service durability, deletion, recovery,
canonical events or sync semantics. See [V0.14.0](planning/V0.14.0.md).

## Foundation and early October sequence

Keep the platform work in order: durable service, lifecycle/deletion, recovery authority, then coherent UX/UI. The existing v0.11–v0.14 documents remain the canonical detailed contracts; the new v0.15/v0.16 contracts extend that foundation.

| Release | Status | Purpose and contract |
|---|---|---|
| `v0.11.x` | Tagged through `kin-v0.11.7`; v1.0 gate decision G2 in [review gates](audits/V1.0_REVIEW_GATES.md) | [Durable Service & Deployment](planning/V0.11.0.md) — restart-safe identity/relay acceptance while preserving the encrypted relay boundary. |
| `v0.12.x` | Tagged through `kin-v0.12.4`; v1.0 gate decision G3 in [review gates](audits/V1.0_REVIEW_GATES.md) | [Data Lifecycle, Retention & Deletion](planning/V0.12.0.md) — explicit deletion, retention, archive, revocation, backup and stale-device behavior. |
| `v0.13.x` | Tagged candidate through `v0.13.5` | [Recovery & Household Continuity](planning/V0.13.0.md) — explicit outcomes for loss of credentials, devices, browser profiles, server data and recovery material. |
| `v0.14.x` | Complete through `v0.14.5` | [UX/UI Consolidation](planning/V0.14.0.md) — one coherent, accessible presentation of the settled platform and household workflows. |
| `v0.15.x` | Complete through v0.15.5 | [Household Areas](planning/releases/V0.15.0.md) — optional, bounded place/context without project management. |
| `v0.16.x` | v0.16.3 Notes hardening candidate | [Household Notes & Reference Context](planning/releases/V0.16.0.md), [v0.16.1](planning/releases/V0.16.1.md), [v0.16.2](planning/releases/V0.16.2.md), and [v0.16.3](planning/releases/V0.16.3.md) — concurrent cross-device archives converge; stale rearchives remain rejected. |
| `v0.17.x` | Complete through the existing v0.17.0 Checklist Steps candidate; preserve its tag | [Checklist Steps](planning/releases/V0.17.0.md). |
| `v0.18.x` | Authorized fast-track | [Richer Routine Scheduling](planning/releases/V0.18.0.md). |
| `v0.19.x` | Authorized fast-track | [Shared Shopping Lists](planning/releases/V0.19.0.md). |
| `v0.20.x` | Authorized fast-track | [Staples & Replenishment](planning/releases/V0.20.0.md). |

The [bridge plan](planning/BRIDGE-0.11-0.16.md) records the dependency order. v0.12–v0.16 occupy October 3–7 in the daily schedule, followed by v0.17 on October 8. Each line requires the preceding gate; only v0.11 must be settled before the first daily target. A release contract is a plan, not evidence of completion.

## October daily feature plan

These are planning targets, with each release linked to its contract. Start each day by defining the smallest complete end-to-end feature and its acceptance criteria. Keep capture fast and preserve existing household history, offline behavior, accessibility and privacy. If a capability is too large for one day, narrow it or move its date; do not compress unfinished prerequisites into a nominal release.

The [Build Fest cadence](planning/BUILD-FEST-CADENCE.md) covers the daily loop; the [release-line protocol](planning/RELEASE-LINE-PROTOCOL.md) covers correctness, resilience/accessibility and hardening. Create stabilization patches only for real changes. Hardening and release-candidate follow-ups are now undated: if they add no product capability, deliver them as patches to the current minor line and revise the proposed numbering instead of inventing a feature release.

| Target date | Proposed release / contract | Capability |
|---|---|---|
| 2026-10-03 | [`v0.12.x`](planning/V0.12.0.md) | **Data Lifecycle, Retention & Deletion** — Make deletion, retention, archive and stale-device behavior explicit and testable. |
| 2026-10-04 | [`v0.13.x`](planning/V0.13.0.md) | **Recovery & Household Continuity** — Define recovery outcomes without confusing history with identity/device authority. |
| 2026-10-04 | [`v0.14.x`](planning/V0.14.0.md) | **UX/UI Consolidation** — Completed through tagged v0.14.5. |
| 2026-10-04 | [`v0.15.x`](planning/releases/V0.15.0.md) | **Household Areas** — User-authorized full release line; implement and validate one milestone at a time. |
| 2026-10-07 | [`v0.16.x`](planning/releases/V0.16.0.md) | **Household Notes & Reference Context** — Add short reference context without chat or a document editor. |
| 2026-10-08 | [`v0.17.x`](planning/releases/V0.17.0.md) | **Checklist Steps** — Add lightweight ordered substeps to actionable items while keeping capture fast. |
| 2026-10-09 | [`v0.18.x`](planning/releases/V0.18.0.md) | **Richer Routine Scheduling** — Make recurring household work flexible enough for real life without building a calendar engine. |
| 2026-10-10 | [`v0.19.x`](planning/releases/V0.19.0.md) | **Shared Shopping Lists** — Make common shopping capture and completion fast, shared, and offline-friendly. |
| 2026-10-11 | [`v0.20.x`](planning/releases/V0.20.0.md) | **Staples & Replenishment** — Support recurring household supplies without becoming inventory management. |
| 2026-10-12 | [`v0.21.x`](planning/releases/V0.21.0.md) | **Household Modes (implemented candidate)** — Pause routine occurrences in temporary household modes without rewriting routine definitions. |
| 2026-10-13 | [`v0.22.x`](planning/releases/V0.22.0.md) | **Lightweight Planning Dates (implemented candidate)** — Add optional fixed civil dates to Items without reminders or calendar behavior. |
| 2026-10-14 | [`v0.23.x`](planning/releases/V0.23.0.md) | **Calendar Interoperability** — Let Kin exchange intentional dated household context with calendars using open formats. |
| 2026-10-15 | [`v0.24.x`](planning/releases/V0.24.0.md) | **Useful Household History** — Answer 'when did we last do/change this?' without creating surveillance. |
| 2026-10-16 | [`v0.25.x`](planning/releases/V0.25.0.md) | **Search & Filters (implemented candidate)** — Make accumulated household context findable locally and privately. |
| 2026-10-17 | [`v0.26.x`](planning/releases/V0.26.0.md) | **Pins & Quick Access (implementation candidate)** — Let households keep a few important things immediately reachable. |
| 2026-10-18 | [`v0.27.x`](planning/releases/V0.27.0.md) | **Household Playbooks** — Turn repeatable household situations into user-authored templates. |
| 2026-10-19 | [`v0.28.x`](planning/releases/V0.28.0.md) | **Local Reminders** — Provide restrained opt-in reminders for explicit dated/routine work. |
| 2026-10-20 | [`v0.29.x`](planning/releases/V0.29.0.md) | **PWA & Offline Install Polish** — Make Kin feel dependable as an installed household tool. |
| 2026-10-21 | [`v0.30.x`](planning/releases/V0.30.0.md) | **Home Reference Records** — Add small structured reference cards for household things people repeatedly need to look up. |
| 2026-10-22 | [`v0.31.x`](planning/releases/V0.31.0.md) | **Maintenance Records** — Track simple maintenance facts and next actions around household reference records. |
| 2026-10-23 | [`v0.32.x`](planning/releases/V0.32.0.md) | **Encrypted Attachments Foundation** — Support small private attachments without weakening Kin's encrypted/local-first boundaries. |
| 2026-10-24 | [`v0.33.x`](planning/releases/V0.33.0.md) | **Attachment UX & Lifecycle** — Make attachments understandable, removable, and resilient across sync/offline states. |
| 2026-10-25 | [`v0.34.x`](planning/releases/V0.34.0.md) | **Responsibility Ownership** — Allow explicit lightweight ownership without scoring household contribution. |
| 2026-10-26 | [`v0.35.x`](planning/releases/V0.35.0.md) | **More Adult Members** — Implementation candidate: four active adults, existing admission ceremony, and member-ID responsibility assignment. |
| 2026-10-27 | [`v0.36.x`](planning/releases/V0.36.0.md) | **Limited Household Members** — Introduce one constrained member class for teens/caregivers/limited participants. |
| 2026-10-28 | [`v0.37.x`](planning/releases/V0.37.0.md) | **Guest & Caregiver Access** — Support deliberately temporary household participation. |
| 2026-10-29 | [`v0.38.x`](planning/releases/V0.38.0.md) | **Modes & Member Context Polish** — Make temporary household context work cleanly with expanded membership without surveillance. |
| 2026-10-30 | [`v0.39.x`](planning/releases/V0.39.0.md) | **Portable Household Export v2** — Create a comprehensive, versioned portable household package covering the expanded product. |
| 2026-10-31 | [`v0.40.x`](planning/releases/V0.40.0.md) | **Restore & Device Migration UX** — Make moving Kin to a new browser/device understandable and testable. |

## Product arcs

### Oct 3–7 — Complete the foundation

`0.12–0.16`: lifecycle/deletion, recovery/continuity, coherent UX/UI, household areas and short reference notes.

### Oct 8–14 — Everyday usefulness

`0.17–0.23`: checklists, flexible routines, shopping, replenishment, temporary modes, lightweight dates and calendar interoperability.

### Oct 15–21 — Findability and repeatability

`0.24–0.30`: useful history, search, pins, playbooks, local reminders, PWA polish and household reference records.

### Oct 22–28 — Durable household knowledge and people

`0.31–0.37`: maintenance, encrypted attachments, ownership, more adults, limited members and temporary guests/caregivers.

### Oct 29–31 — Context and portability

`0.38–0.40`: expanded-member privacy polish, portable export and restore/device migration. Demonstrate the actually completed product and record remaining limitations at the end of the month.

## Current stabilization and deferred plans

The active readiness sequence is measured architecture/performance work,
cross-browser and physical-device acceptance, and then bounded Catch-up/search
context experiments using existing projection data. This sequence does not
activate a new version or persistent concept. Keep the remaining contracts as
proposals and reassess their numbering from evidence.

| Proposed release / contract | Follow-up purpose |
|---|---|
| [`v0.41.x`](planning/releases/V0.41.0.md) | **Mobile Experience & Passkey-First UX** — Implementation candidate ([v0.41.1](planning/releases/V0.41.1.md) corrects mobile photo/file attaching): passkey-first unlock with recovery as the fallback, clear create/join/add-device onboarding, context-sensitive capture, attachment previews, and phone-first item rows. Authorized after real-world mobile testing; not a published release. |
| [Backup Safety & Disaster Drills](planning/releases/BACKUP-SAFETY-DRILLS-PROPOSAL.md) | Deferred proposal (formerly numbered v0.41.0) — Turn recovery claims into routinely tested product behavior. Renumber after the feedback gate. |
| [`v0.42.x`](planning/releases/V0.42.0.md) | **Cross-Browser & Mobile Hardening** — Broaden confidence beyond the primary desktop development environment. |
| [`v0.43.x`](planning/releases/V0.43.0.md) | **Performance & Scale Closure** — Make the full feature set responsive within explicit household-scale bounds. |
| [`v0.44.x`](planning/releases/V0.44.0.md) | **Release-Candidate Stabilization** — Freeze feature scope and remove known correctness, accessibility, migration, and documentation gaps. |
| [`v0.45.x`](planning/releases/V0.45.0.md) | **Build Fest Release Candidate** — Retain the final validation checklist for a coherent, demoable pre-1.0 product; its scope and version are to be revisited after October. |

## Beyond October — `v1.0.0` Stable Kin Platform

Kin remains pre-1.0 until its readiness properties are satisfied. Preserve the existing gates: v0.10 local architecture/security, v0.11 durable service/deployment, v0.12 data lifecycle/deletion, v0.13 recovery/continuity and v0.14 coherent UX/UI. Any later capability must meet the same compatibility, privacy, accessibility and recovery standards. These are property gates, not arbitrary version-number gates.

A stable release establishes compatibility/support commitments, upgrade guarantees, documentation, final defect resolution and stable packaging. Stabilize what the preceding lines secured and refined; do not introduce another major architecture at v1.0. October 31 is a Build Fest demonstration target, not a forced `v1.0.0` deadline.

## Product scope boundary

The v0.11–v0.14 platform-completion lines retain their existing scope and two-adult household model. Areas, notes, calendar interoperability, reminders, attachments and broader membership enter only at their designated later planning lines, after their prerequisites and authority/privacy boundaries are settled. Do not pull these features into the platform bridge or treat their appearance here as implemented support.

Through the October plan, preserve the [product principles](PRINCIPLES.md) and [product boundaries](planning/PRODUCT-BOUNDARIES.md):

- No AI runtime, household-content interpretation or recommendation engine.
- No points, streak pressure, rankings, contribution percentages or spouse scoring.
- No covert location, presence or activity surveillance.
- No enterprise workflow builder, arbitrary RBAC, Gantt/sprint/project-management expansion.
- No general messenger, public social network or anonymous household sharing. Household chat (#104) is one room for the members of one household, beside Talk, decided in [ADR 0008](decisions/0008-household-chat.md) (#105): its receipts, typing and "online now" are visible, switchable, reciprocal and never kept as history.
- No forced `v1.0.0` on October 31.

## Scope discipline

Each roadmap item is future work unless explicitly marked as implemented.
v1.0.0 is gated by the final release checklist (#168): every blocker fixed,
the owner's [review-gate decisions](audits/V1.0_REVIEW_GATES.md), three green
CI runs, the reality check and acceptance matrix. Releases through `v0.0.12`
were documentation-only; v0.1.0 was the first coded release.

Preserve every existing tag. Every release follows the gates described in [agent guidance](../AGENTS.md) and the [release process](RELEASES.md); a date alone cannot bypass a release gate.

## After v1.0

Every v1.x release keeps reading the v1.0 formats
([V1.0-COMPATIBILITY](V1.0-COMPATIBILITY.md)). Work after v1.1.2
starts from GitHub issues. Household chat (#104), decided in
[ADR 0008](decisions/0008-household-chat.md) (#105), is the v1.2.0 minor
release. It was completed on `kin-testing` and merged into `kin-development`
through the v1.2.0 release PR. Each new capability is a minor release with the
stabilization patches described above. v1.3.0 closes the member identity and
device pairing epic (#218) and starts the usability epic (#261), whose tester
sessions (#262, #269) remain open. v1.4.0 adds the family fridge (#317), Meals
(#333), Simple view (#341), Talk later (#312), undo and redo (#315) and the
household helpers: share into Kin (#389), shopping mode (#403), store sections
(#411), list import (#452), This week (#416), the sitter page (#441) and taking
turns on routines (#428). v1.5.0 adds accounts with a key vault (#564,
ADR 0018: first run #557, passkey and backup code #560 and #571, new-device
sign-in #568, moving to an account #574, offline passkey unlock #551) and
each member's private space (#485, ADR 0019: the journal #496, Just for me
#510, reminders and settings #520, the private export #493), with the
finished home-screen shortcuts (#471) and app-icon count (#476). v1.6.0
makes Kin easier for someone who rarely uses apps (epic #603, ADR 0021: easy
mode #616, Help on every screen #620, household features #623, reports and
suggestions #630, #627 and #635, setting Kin up for someone #612, the
easy-mode sweep #638) and prepares Kin for Google Play (epic #527, ADR 0020:
the Android app, the privacy policy #541, the listing #540 and the release
runbook #545); the moderated session (#608) remains open.

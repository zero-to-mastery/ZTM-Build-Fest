# Changelog

This file records completed Kin releases. The `v0.0.x` releases are planning and documentation milestones; they do not represent implemented application features. The first implementation milestone remains `v0.1.0`.

## Unreleased — v0.11.0–v0.11.7 Durable Service & Deployment candidate

The implementation candidate with durable semantic validation, October planning
and startup diagnostics is tagged `kin-v0.11.7` for human review. Earlier candidate
tags through `kin-v0.11.6` are preserved.
These are review candidates, not published product releases.

### v0.11.0 — Durable Identity & Relay Foundation

Introduces SQLite server schema v1 and durable household identity, membership,
credential, trusted-device, authorization, sync-coordination and opaque relay
state. Event success is reported only after the transaction commits. Bounded
indexed reads and persisted relay/device sequences preserve opaque envelopes,
idempotency and cursor behavior across restarts.

### v0.11.1 — Transaction & Interruption Correctness

Makes migration transactional and fail-closed on interruption or unsupported
newer schemas. Adds on-disk rollback/corruption checks, transaction boundaries
for cross-service mutations and stale-writer compare-and-commit checks.

### v0.11.2 — Operations & Recovery

Adds readiness, graceful shutdown and an exclusive single-process service lock.
Adds `npm run backup` using SQLite's online backup API and `npm run restore`
with source validation, exclusive maintenance locking and offline replacement;
preserves the replaced database and any WAL sidecars.

### v0.11.3 — Privacy & Durable-Service Hardening

Hardens persistent record validation, bounded reads, corruption behavior,
error/log output, process restart behavior and backup/rollback documentation.
Tests cover migration interruption, newer-schema rejection, corrupt relay
data, stale-writer conflicts, backup/restore, lock exclusion and a spawned HTTP
server restart that reauthenticates and recovers accepted ciphertext and
sequence state. On Windows x64/Node 22.12 the full Node suite passed 157 tests
after `npm ci`, including all 83 server tests; the Rust, WASM, browser,
security-storage, security-UI, virtual-authenticator and version-consistency
gates also passed. npm reported zero vulnerabilities but warned that the
`better-sqlite3` install script is not covered by `allowScripts`; the installed
native binding loaded successfully. Linux/macOS and launch-workflow validation,
an independent security audit and production certification are not claimed.
Restoring an old backup can roll back revocation or key epochs.

### v0.11.4 — Pre-Merge Durability & Operations Corrections

Share canonical web-root guards between service startup and admin commands,
including symlinked missing ancestors, and prevent static routes from escaping
the web root. Expected stale-writer conflicts now roll back, return HTTP 409
and permit retry without poisoning the store; fatal storage errors still fail
closed. Lock errors include the exact path and safe manual recovery guidance.

Correct durable cursor encoding so bounded pulls can resume, reject missing,
empty and unsupported restore sources before replacement, and isolate the
passkey regression store from the default service database. Regression coverage
proves admin exclusion, cleanup, verified backups and preserved database/WAL/SHM
state. Schema v1, backup format and client/domain versions are unchanged.

Passed 181 Node tests (107 server), 118 Rust tests, formatting, Clippy, release
WASM, product/security-storage/security-UI/WebAuthn-PRF browser gates, npm audit,
version checks and PowerShell/POSIX launcher smoke tests. The POSIX launcher
used Windows Node through WSL; native Linux Node and macOS remain unverified.
See [the hardening evidence](docs/V0.11.0.md#pr-17-pre-merge-hardening-evidence-2026-10-03).

### v0.11.5 — Durable Semantic Integrity

Durable startup, readiness, backup and restore now share schema, SQLite and
Kin semantic validation. Cross-check normalized routing/authorization columns
against grant JSON, device JSON and canonical opaque envelopes; reject
impossible membership/device limits, credential ownership, sequence and
epoch/rotation state before readiness. Backup validates both source and copy;
restore validates read-only before replacement. No automatic repair or whole-
database tamper resistance is claimed. Expired grants, retained historical
authority and accepted certificate encodings remain supported. Strict input
identity checks prevent malformed grants/proposals from committing invalid state.

Passed 281 Node/real-WASM tests (207 server, 100 new regressions), 118 Rust tests
on both Windows and WSL, formatting, Clippy, release WASM, the product browser
gate, 313 security-storage assertions, 97 security-UI assertions and 18 virtual
WebAuthn/PRF assertions. npm ci/audit, version checks and PowerShell/POSIX
build/launcher smoke gates passed. POSIX used Windows Node through WSL;
native Linux Node and macOS remain unverified. Server schema v1, sync envelope
v1, client/domain formats and backup format remain unchanged. See
[semantic-integrity evidence and measurements](docs/V0.11.0.md#v0115-semantic-integrity-evidence-2026-10-03).

### v0.11.6 — Release Documentation & Code Clarity

Standardize historical release headings on the newer `vX.Y.Z` notation without
changing their release descriptions or grouping. Update the version checker to
recognize those headings and align current candidate metadata and documentation.
Clarify non-obvious code invariants and ownership with focused comments,
especially at the Rust/WASM boundary and in deterministic replay.

This patch adds no product capability or runtime behavior change. The last
published client version remains v0.10.3; server schema v1, canonical events,
replay protocols, local database/envelope versions and archive formats are
unchanged. Earlier validation evidence remains attached to its original version.

Passed 118 Rust tests and doc-tests, Rust formatting, 55 targeted server tests,
JavaScript syntax checks, version consistency and heading-format checks,
238 local Markdown file-link target checks and whitespace validation.
This was a bounded documentation/comment pass, not a full audit or a rerun of
the browser, cross-platform and security release gates.

### v0.11.7 — October Roadmap & Startup Diagnostics

Blend the October plan into the existing README and roadmap while preserving
project setup, milestone history and platform contracts. Target one small minor
line per day from v0.12.x on October 3 through v0.40.x on October 31; retain
v0.41–v0.45 as undated follow-up proposals. Add planning contracts, daily cadence,
product boundaries and handoff guidance without implementing future features.

Report listener startup failures with the attempted host/port, a bounded OS error
code and safe recovery guidance. Release the database process lock after both
asynchronous bind errors and synchronous listener configuration failures.
Launchers wait for `service_ready` before claiming readiness, and PowerShell
propagates a nonzero server exit. Document port conflicts and configuration
overrides without encouraging automatic port switching or database deletion.

Passed all 287 Node/real-WASM tests, including six startup regressions for an
occupied port, denied/unavailable addresses, unknown/malformed error codes and
synchronous configuration failure. Verified database-lock cleanup, valid reopen
and exclusion of private exception details from listener diagnostics.

The Windows PowerShell launcher built release WASM, reached `service_ready` and
served the app, health and readiness endpoints successfully with isolated test
storage. Version metadata, the 29 daily targets, local planning links and
whitespace checks passed. Browser/security and POSIX execution gates were not
rerun for this patch; previous results retain their original release attribution.

The published client remains v0.10.3; server schema v1, canonical events,
WASM/browser storage contracts and archive formats are unchanged. This patch
remains a review candidate; no v0.12 capability or broader certification is claimed.

## v0.10.3 — Bounded Storage/Archive Hardening & Architecture Closure

Page protected reads and bound decryption concurrency, remove redundant migration
and restore copies, and preserve exact comparison, full Rust replay and atomic
publication. KARC v1 remains the archive format: raw ciphertext stays in browser
buffers while Rust validates compact framing metadata. Legacy archives and ABI
entry points remain supported. Additional corruption and mid-operation lock
checks exercise fail-closed publication.

Archive restoration is intentionally local-only and grants no sync authority.
The [release record](docs/V0.10.0.md) contains same-harness before/after desktop
measurements, compatibility and the internal architecture/security review. No
independent audit, mobile certification, v0.11 redesign or v1.0 work is claimed.

Passed 118 Rust tests, 150 Node/real-WASM tests on both Windows and Linux,
313 security storage assertions, 97 security UI assertions, 18 virtual-authenticator
assertions, the complete product browser gate and PowerShell/POSIX launch workflows.
Maximum-history sampled renderer memory fell from 2.82 to 1.32 GiB; typical 10k
unlock measured 9% slower. KARC v1 archive sizes and canonical bytes are unchanged.

## v0.10.2 — Local Root Rotation & Recovery Lifecycle

Replace recovery protection with an independent random root and a new, re-entered
256-bit recovery key. Durable staging verifies every protected record, canonical
replay and restored sync key before publication. Interrupted replacement resumes
the same candidate; monotonic root versions and lock epochs reject stale tabs.
Existing PRF unlock wrappers are retired and must be re-added with authentication.
Old copied recovery wrappers cannot decrypt newly protected data; rotation cannot
erase previously copied plaintext, keys or backups.

Event/key database schemas remain 3/4. Rotated roots use manifest/local-envelope
v2 with authenticated root versions; original v1 remains readable. Canonical
events, replay protocols, sync-envelope v1 and KARC v1 remain compatible. See
[the release record](docs/V0.10.0.md) and [rotation contract](docs/ROOT-ROTATION.md).

## v0.10.1 — Security Lifecycle & Sync Recovery Correctness

- Keep cancelled security operations from changing a newer unlock's status, controls or busy state. Late completion cannot label an unlocked household as locked or remove its lock control.
- Verify a stable copy of a trusted device's public keys before opening its pinning transaction. Slow fingerprint hashing no longer lets IndexedDB commit before the pin is saved; conflicting pins still fail atomically.
- Recover interrupted key rotations when recipient packages expire or recipient keys change, retaining the proposed epoch key and reconciling accepted proposals after lost responses. Protect pending-rotation updates against stale tabs.
- Advance the static shell cache so offline clients receive the fixes. Canonical events, ABI protocols, encrypted envelopes, archive framing and database versions remain unchanged. No new product capability or dependency.

Passed 117 Rust and 140 Node/WASM/server tests, formatting, Clippy, release WASM build, version consistency, the complete product browser suite, 78 security UI assertions, 18 virtual-authenticator assertions, and encrypted storage/migration/pinning checks including 12 new rotation-storage assertions. Validation and remaining readiness work are recorded in [V0.10.0](docs/V0.10.0.md). Published as annotated tag `kin-v0.10.1` at `e65db23`; the release branch is pushed for PR review into `kin-development`. Merging remains separate.

## v0.10.0 — Portable Core + Local Data Security

Implemented and validated on the v0.10 development branch; the missing annotated tag `kin-v0.10.0` was restored at `2dc94f8` and pushed at the user's request. Startup now requires recovery or verified PRF unlock before loading protected history. A random local root encrypts complete event/context/outbox values and private sync material; independent credential wrappers avoid corpus re-encryption. Revision checks and a durable lock epoch prevent stale-tab wrapper resurrection and protected writes after lock. Drafts are memory-only.

Post-gate lifecycle review fixed a focus/visibility race in the brief interval between attaching an unlocked vault and binding its durable store epoch. Wake checks now wait for the encrypted store, epoch-bearing peer notifications distinguish a newer revocation from a delayed notification delivered after a valid re-unlock, and lock aborts in-flight PRF WebAuthn/server requests.

Migration preserves legacy data until exact-byte decryption and full Rust replay verify the replacement. Nonextractable legacy transport keys authorize encrypted successor keys through a signed, idempotent transition; original canonical events and relay envelopes retain their identity. Rust now owns all 17 household command encoders, command validation, canonical metadata extraction, bounded archive framing and import planning through the existing dependency-free manual ABI.

Encrypted archives restore into an empty installation with fresh local author identity; restored history stays local and does not recreate device trust. The service worker caches static shell assets only and supports offline recovery unlock. Event DB schema is 3, key DB schema 4, local envelope/archive/successor format 1; canonical protocols v1–v8 and sync envelope v1 remain compatible. See [V0.10.0](docs/V0.10.0.md) for actual validation counts, measurements, limitations and v0.11 handoff. The memory-only identity/relay service, lack of in-place local-root rotation, maximum-history latency and broader platform/security review remain explicit limitations.

## v0.9.3 — Recovery, Privacy, and Feedback Readiness

Completed the v0.9 recovery, metadata, logging, corruption, storage-bound, and UX audit. Added same-member trusted-device pairing, fingerprint-confirmed approval, exact-envelope retry after relay cursor reset, and explicit process-local acknowledgement semantics. An exact identity-binding retry remains idempotent at the 256-record capacity boundary; conflicting or new bindings remain rejected, and rejected batches do not partially commit. Canonical IndexedDB event bytes remain authoritative. The identity service and relay remain memory-only; there is no all-device recovery, durable remote history, independent security audit, or cross-browser certification. Ready for product feedback only after the complete release gates pass.

Final pre-merge correction: fixed provisioned epoch-key fingerprint calculation before raw-key zeroization, added cross-device fingerprint and conflicting-key regression coverage, and removed duplicate trusted-device pinning helpers.

## v0.9.2 — Offline Reconciliation and Conflict Semantics

Added the separate transport cursor/high-water, atomic remote canonical-event/replay/cursor commit, local device sequence and Lamport advancement, additive Rust v8 identity-binding interpretation, deterministic equal-time reducer order, and persistent exact-envelope outbox. Archive wins over an equal-time concurrent mutation from another device; accepted bytes remain stored and a later causally invalid mutation pauses replay. Catch-up remains arrival-ordered and independent of transport progress.

## v0.9.1 — Device Provisioning, Epochs, and Revocation

Added recipient-bound ECDH/HKDF/AES-GCM key provisioning, device-key fingerprint comparison, separate member/device/household keys, one-use grant handling, compare-and-advance epoch rotation, member/device revocation hooks, and historical-key entitlement rules. Same-member additional-device enrollment uses the existing pairing code/passkey approval flow. Revocation prevents future access but cannot erase prior keys or plaintext.

## v0.9.0 — Encrypted Event Sync

Added the v0.9 threat/key-lifecycle contract, versioned AES-GCM and ECDSA event envelopes, authenticated opaque push/pull relay, bounded process-local cursors, additive IndexedDB schema 2, and offline multi-device fixtures. Sync encrypts exact canonical Kin event bytes; the service receives no plaintext event semantics or content key. Relay state is in-memory and acknowledgements are not durable.

## v0.8.8 — Active-Member Slot Correctness

Count active memberships rather than retained historical member records when enforcing household capacity. After an adult leaves or is removed, the remaining adult can pair a replacement while the inactive historical membership remains stored. Invitation creation and final approval both enforce the two-active-adult limit, and a full-household approval fails before creating any member, device, credential, session, or confirmed pairing state.

## v0.8.7 — Pairing Security and State Hygiene

Bind pairing approval assertions to the authenticated adult's credential, eagerly remove every session for a revoked device, lazily prune expired sessions and terminal pairing capabilities, and normalize malformed WebAuthn/CBOR/COSE input into controlled verification failures. Clarify realistic signature-counter semantics and retain fresh-session behavior without adding product scope.

## v0.8.6 — Pairing Feedback-Gate Corrections

Use rejection sampling for valid, uniformly selected pairing-code characters; validate invitations before WebAuthn; and give claimed requests a separate 15-minute approval window. Add trusted-device-bound passkey reauthentication, action-bound fresh authentication for adult removal, terminal-claim recovery, early invitation-URL cleanup, HTTPS-aware Secure cookies, and bounded/pruned transient security state. No sync or new household scope is added.

## v0.8.5 — Auth Panel Text Contrast

Set the household authentication panel's text to the app's dark ink color so headings, form labels, explanatory text, and status messages remain readable against its light background. Button-specific and alert colors are unchanged. No authentication behavior or product capability changed.

## v0.8.4 — Pairing Creation Response Correctness

Return the initial `Pending` state from pairing creation so the initiating-adult UI can render a newly created code without dereferencing an absent state. Add an exact response-contract regression and defensive UI fallback for malformed or incomplete pairing status responses.

## v0.8.3 — Household Pairing Pre-Feedback Stabilization

Polish the two-adult journey with URL prefill, clipboard/native sharing fallbacks, readable selectable codes, quiet countdowns, semantic status/error regions, keyboard-native controls, forced-color styling, destructive-action explanations, and actionable passkey errors. Hide local household content on `/pair` before authorization, recover safely from stale claim cookies, reconcile security/recovery documentation, and retain the complete v0.7.x regression suite.

## v0.8.2 — Trusted Devices, Authorization, and Security UX

Make device trust inspectable and revocable, add logout with session-only semantics, define leaving and other-adult removal, revoke all target sessions/devices on membership removal, and prohibit the last active adult from leaving without a supported deletion/recovery path. Add an authorization matrix and actionable passkey, expiry, revocation, trust, and recovery messages without exposing household details before approval.

## v0.8.1 — Pairing Hardening and Failure Recovery

Separate membership approval from joining-device activation: after atomic approval, the joining adult must prove continued possession of the enrolled passkey before receiving a session. Lost-passkey, response-loss, duplicate approval, revoke/approve, server-time expiry, simultaneous invitation, replay, logout, and device-revocation paths fail closed or retry idempotently. Logout invalidates a session without conflating it with device trust.

## v0.8.0 — Household Pairing Foundation

Add the first two-adult household identity model, passkey registration and approval, a ten-minute single-use human-readable pairing code, `/pair` manual entry and invitation links, explicit Pending/Claimed/Confirmed/Expired/Revoked states, server-side attempt/rate limits, atomic membership confirmation, trusted-device inspection/revocation, privacy-safe audit events, and lifecycle tests. The same-origin service stores only a keyed code verifier and never logs codes. Existing local event protocol v1–v7 and IndexedDB schema 1 remain unchanged.

## v0.7.4 — Routine Stale-Action Correctness

Reject routine completion unless the latest occurrence is open, and reject reopen unless it is completed, even when the submitted period key remains current. Preserve existence, archive and period-key preflight checks and the existing stale-state error code. Add two-tab persistence regressions for stale completion and reopen. Harden the manual Wasm ABI so `kin_apply_events` accepts only the exact tracked allocation returned by `kin_alloc`, with expanded ownership regressions. Refresh pairing-planning status through the v0.8.0 checkpoint and update current release metadata. Protocol layouts, persisted event bytes and product capability remain unchanged.

## v0.7.3 — Routine Hardening & Polish

No capability added. Completed the v0.7.x ABI and parser boundary audit, maximum replay and Wasm memory-growth checks, protocol and allocation ownership review, local-only privacy review, and documentation reconciliation. The full hardening gate passed without changing protocol v7, IndexedDB schema 1, or earlier event bytes. See [V0.7.0](docs/V0.7.0.md).

## v0.7.2 — Routine Resilience & Accessibility

No capability added. Validated suspended-tab, midnight, focus and visibility reprojection; stale-tab convergence; failed-write rollback and retry; keyboard focus restoration; semantic routine controls; narrow reflow, forced colors, text spacing and reduced motion. The full Rust, bridge, launcher and Chrome gates passed. See [V0.7.0](docs/V0.7.0.md).

## v0.7.1 — Routine Correctness

No capability added. Audited mixed legacy/Routine replay, civil-date context validation, duplicate/conflicting IDs, logical ordering over wall-clock timestamps, cursor boundaries, historical compatibility and v7 malformed input. Passed 105 Rust tests plus the existing bridge and browser gates. See [V0.7.0](docs/V0.7.0.md).

## v0.7.0 — Routines

Added Daily and Monday-start Weekly Routines with create, complete/reopen current occurrence and terminal archive. Rust owns civil-date validation, deterministic period identity and replay; protocol v7 carries explicit local civil context without changing exports, old protocol bytes or IndexedDB schema 1. Atomic preflight rejects stale period actions instead of retargeting them. Human Routine actions participate in catch-up; timers/focus/visibility only reproject and create no facts. Native controls preserve drafts, keyboard focus and failed-command recovery. No reminders, calendar, assignments, streaks, framework, dependency or backend.

Release validation and remaining platform gaps are recorded in [V0.7.0](docs/V0.7.0.md). The first calendar/contract checkpoint is `f3065fd`; the release includes the end-to-end capability and its regression coverage.

## v0.6.3 — Summary Hardening & Polish

Fixed committed catch-up cursor recovery after a failed snapshot reload in commit `45ca041`: immediately send content-free peer invalidation, preserve the displayed summary, and offer a refresh-only retry without another cursor write. Added two-tab recovery coverage and explicit no-broadcast checks for quota/abort failures; corrected the raw copied-result test to use a v6 summary result. Revalidation passed 82 Rust tests, 31 Node/real-WASM tests, the complete Chrome runner (12 initial scenarios and 21 PASS groups), and the established release checks and PowerShell/WSL HTTP smokes. Moved the misplaced v0.6.2 validation paragraph to its proper section.

Hardening and polish added malformed v6 summary record/count/classification/UTF-8/length/trailing-byte coverage, every truncated v6 summary-result boundary, and a 10,000-event real-WASM v6 summary replay with memory-growth and copied-result lifetime checks. Completed the summary privacy and UI polish audit. Passed 82 Rust and 31 Node/real-WASM tests, fmt, Clippy, release WASM, version check, PowerShell/WSL build-run HTTP smokes and complete Chrome 154.0.8037.95 browser regressions. Firefox, Safari, macOS, native zoom, NVDA and VoiceOver remain unverified; no screen-reader certification is claimed. Full environment details are in [V0.6.0](docs/V0.6.0.md).

## v0.6.2 — Summary Resilience & Accessibility

No new capability. Added catch-up cursor quota/abort rollback and retry, repeated snapshot-read failure recovery, pending cursor-write reconnect, missed view-state notification recovery, both stale/new tab write orders, and Pulse timer refresh while the summary is visible. Extended keyboard, focus, semantic status, reflow, forced-colors, text-spacing and reduced-motion checks. Passed 81 Rust and 29 Node/real-WASM tests, fmt, Clippy, release WASM, version check, PowerShell/WSL build-run HTTP smokes, and complete Chrome 154.0.8037.95 browser regressions. Firefox, Safari, macOS, native zoom, NVDA and VoiceOver remain unverified. Full environment details are in [V0.6.0](docs/V0.6.0.md).

## v0.6.1 — Summary Correctness

No new capability. Added explicit empty/first/middle/latest cursor cases, first-occurrence handling for exact duplicate event IDs, conflicting-ID failure, exact 8/9-entry cap cases, and browser checks for mismatched/partial local cursor metadata. No production behavior change was required. Passed 81 Rust and 29 Node/real-WASM tests, fmt, Clippy, release WASM, version check, PowerShell/WSL build-run HTTP smokes, and complete Chrome 154.0.8037.95 browser regressions on Windows x64 (Rust 1.93.0, Node 22.12.0; WSL2 Ubuntu 22.04.5 POSIX validation). Native zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

Detailed validation evidence is in [V0.6.0](docs/V0.6.0.md).

## v0.6.0 — Since You Last Looked

Added a Rust-derived, eight-entry catch-up summary for Item, Handoff and Talk changes, with total/omitted counts and an explicit Caught up control. The local cursor is initialized at existing history on first run, stored in the existing `local_context` singleton, and advances transactionally through only the frozen snapshot boundary. Protocol v6 preserves explicit `as_of` and adds a stable event-ID cursor and structured summary result; v1–v5, event codes/bytes and IndexedDB schema 1 remain unchanged. Pulse is excluded from entries but may define the snapshot boundary. No read receipts, member tracking, actor attribution, summary history, analytics, AI, remote service, new household events, migration or dependency.

Passed 78 Rust and 29 Node/real-WASM tests, formatting, Clippy with warnings denied, release WASM build, version consistency, PowerShell and WSL build/run workflows (page and WASM HTTP 200), and the complete Chrome browser regression suite. Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.95; POSIX build/run via WSL2 Ubuntu 22.04.5. Catch-up keyboard/focus, 48px targets, 320px reflow, forced colors, increased spacing, reduced motion and 200% page-scale emulation passed. Firefox, Safari, macOS, native desktop zoom, NVDA and VoiceOver remain unverified; no screen-reader certification is claimed. Full evidence is in [V0.6.0](docs/V0.6.0.md).

## v0.5.3 — Pulse Hardening & Polish

Added every v5 request/header/envelope/payload and result truncation boundary, 10,000-event mixed replay, memory-growth and copied-result lifetime tests. Made numeric enum identifiers explicit and prefilled Change with the current capacity. Completed time/domain/privacy audit and 320px visual review. No new capability; the authorized Pulse line stops here. Passed 69 Rust and 28 Node/real-WASM tests, the complete Chrome browser suite, fmt/Clippy/version checks, both WASM builds and PowerShell/WSL build-run workflows. Accessibility modes and remaining unverified environments are recorded in [V0.5.0](docs/V0.5.0.md).

## v0.5.2 — Pulse Resilience & Accessibility

Restored capacity-selector focus when expiry hides an active Pulse control. Added late timer, simulated sleep/wake, focus/visibility, clock forward/backward, missed invalidation, original SET/CLEAR quota/abort retry, repeated refresh failures, supersession, rapid intent, reconnect/busy, native keyboard and accessibility-mode coverage. No new capability; evidence is in docs/V0.5.0.md.

## v0.5.1 — Pulse Correctness

Added exhaustive Pulse payload lengths, schemas, reserved/value codes, timestamp bounds, mixed entity invariance, exact v5 layouts, malformed results and combined count limits. Legacy byte fixtures remain unchanged. No new capability or production defect found; validation evidence is in docs/V0.5.0.md.

## v0.5.0 — Pulse

Added fixed actor-scoped capacity, set/replace/clear and explicit expiry. Rust owns rebuild_at(events, as_of); protocol v5 preserves v1–v4 layouts. Native controls and canonical timer/visibility/focus refresh reuse IndexedDB schema 1 and original-command retry. No migration, acknowledgement, analytics, identity inference, automation or dependency.

Validation evidence: [V0.5.0](docs/V0.5.0.md).

## v0.4.3 — Talk Hardening & Polish

Added every truncated v4 result-header/Talk-record boundary, malformed request headers and extreme lengths, 10,000-event mixed replay, and 10,000-Talk real-WASM growth with independent copied results across repeated success/error/empty calls. Retained explicit v3 Handoff truncation/trailing-byte coverage. Visual inspection found and fixed horizontal overflow caused by a 320px page minimum width when a desktop scrollbar consumes space; reflow assertions now compare scrollWidth with clientWidth. The corrected 320px screen preserves full input focus outlines and wrapping actions.

Passed 58 Rust tests and 19 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, version consistency, release WASM, PowerShell and WSL POSIX build scripts and build/run launchers (page and WASM HTTP 200), and complete browser regressions. Environment: Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.59; POSIX via WSL. Keyboard, all Talk lifecycle focus restoration, native focus order, semantics, busy/status/error, 48px targets, scrollbar-aware 320px reflow, forced colors, increased spacing, reduced motion and 200% page-scale emulation passed. Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

Architecture/product/privacy audit confirms Rust-only reduction; separate Item/Handoff/Talk semantics; immutable canonical IndexedDB schema-1 events; no migration; unchanged v1/v2/v3 contracts and explicit v4; content-free invalidation; textContent rendering; same-origin static requests; no framework/runtime dependency, analytics, AI, remote service, sentiment, scores, blame, identity inference, resolver attribution or response metrics. Resolved is workflow state only and claims neither agreement nor an objective solution. No remaining release-blocking defect was found in exercised environments. Cross-browser, assistive-technology and native-zoom checks remain validation gaps, not certifications. No additional UI feature was added. Duplication remains manageable, so no orchestration refactor was introduced.

## v0.4.2 — Talk Resilience & Accessibility

Expanded Talk browser checks for keyboard resolve/reopen/archive, native input-to-Add focus order, semantic headings/lists, labels, polite status/assertive errors, visible focus and 48px targets under forced colors. Added independent draft assertions and direct stale retries with missed invalidation, alongside repeated-refresh recovery. Retained delayed saves, reconnect, queued peer refresh, sessionStorage denial, quota/abort rollback, rapid retry once and supersession. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts/launchers (page/WASM HTTP 200), and complete browser suite in Windows x64/Chrome 154.0.8037.59/Node 22.12.0, POSIX via WSL. 320px, increased spacing, forced colors, reduced motion and 200% page-scale emulation pass; native zoom, Firefox, Safari, NVDA and VoiceOver remain unverified. No new product capability.

## v0.4.1 — Talk Correctness

Talk correctness audit passes the full lifecycle matrix, every truncated payload, overlong references, unsupported schemas, empty/oversized/invalid UTF-8 and blank text, exact v4 records, malformed status/reserved/count/length fields and combined entity limits. Exact pre-Talk writer/result fixtures remain unchanged. Browser tests verify event/counter rollback, retry once, metadata preservation and invalid-transition non-append. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts and both launchers (page/WASM HTTP 200), and the complete Chrome 154.0.8037.59 browser suite on Windows x64/Node 22.12.0; POSIX via WSL. Previously listed platform/assistive-technology gaps remain. No new product capability.

## v0.4.0 — Talk

- Added one-field topic capture, Open/Resolved lists, resolve, reopen and terminal archive. Resolution is workflow state only; no agreement, blame or verified-person claim is made.
- Added distinct Rust Talk types and schema-1 event codes 8–11, with explicit protocol v4. Protocols 1–3 and prior event bytes remain unchanged; older protocols reject Talk. IndexedDB stays schema 1 with no migration.
- Reused atomic storage, independent drafts, original-command retry, suspended-refresh recovery, content-free peer invalidation and safe rendering. No runtime dependency or remote service.

Validation evidence is recorded in [V0.4.0](docs/V0.4.0.md).

## v0.3.5 — Build & Run Convenience

### Improved

- Added project-local PowerShell and POSIX shell workflows that reuse the established WASM build scripts, then serve `projects/kin/web` on loopback port 8000.
- Updated the README and development instructions to use the one-command workflow.
- Preserved the existing build boundary, dependency policy, and stale-artifact failure behavior.

### Validation

- Passed `cargo fmt --check`, Clippy with warnings denied, 51 Rust tests, release WASM build, both existing build scripts, both new launchers, 13 Node bridge/real-WASM tests, version consistency, and the complete browser regression runner.
- Windows x64 used PowerShell 5.1, Rust 1.93.0, Python 3.13.14, Node 22.12.0, and headless Edge 154.0.4258.48. POSIX validation used WSL Ubuntu 22.04.5, Rust 1.93.0, and Python 3.10.12. Each launcher served the page and WASM asset successfully with HTTP 200.
- No product capability, event format, protocol, IndexedDB schema, or runtime dependency changed.

## v0.3.4 — Handoff Retry Recovery

### Fixed

- A failed canonical refresh could replace and lose an earlier failed save/action retry. Preserve the original command, intent and feedback through repeated refresh failures; restore it only after successful canonical replay. Recovery does not automatically append anything.
- Stale actions still clear against Rust-derived state. A newly submitted command supersedes the suspended retry. The shared fix also preserves Item retries and keeps newer capture drafts intact.
- Added a browser regression that failed before the fix, plus repeated-failure, add/action recovery, stale cross-tab acknowledgement/archive, Item retry and superseding-command coverage.

### Validation

- Passed 51 Rust tests, 13 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, release WASM build, both build scripts, version consistency and the full browser runner.
- Tested with Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59; POSIX build ran in WSL Ubuntu 22.04. Existing 320px/accessibility-mode, storage, protocol, CSP and same-origin regressions remain passing. Firefox, Safari, native desktop zoom, NVDA and VoiceOver remain unverified.
- No new product capability, persisted event change, IndexedDB migration, protocol change, or dependency. Earlier release tags remain unchanged.

## v0.3.3 — Handoff Hardening & Polish

- Added deterministic Handoff header/extreme-length checks, 10,000-event mixed replay, every truncated result boundary, trailing result rejection, and real WASM memory growth with repeated success/error/empty replay.
- Reconciled current product, protocol, storage, component, accessibility, roadmap and release documentation. Confirmed Rust remains the sole reducer, IndexedDB schema 1 is canonical, history is immutable, peer messages carry no content, and no runtime dependencies, remote services, identity claims or timing analytics were introduced.
- Passed 51 Rust tests, 13 Node bridge/real-WASM tests, formatting, Clippy, release WASM compilation, both build scripts, version consistency and the full browser suite (Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59; POSIX build in WSL Ubuntu 22.04).
- Native desktop 200% zoom, Firefox, Safari, NVDA and VoiceOver remain untested. The planned Handoff line stops here for user evaluation; v0.3.4 and v0.4.0 have not begun.

## v0.3.2 — Handoff Resilience & Accessibility

- Extended browser regression coverage for Handoff delayed saves, reconnect and queued peer refresh, newer draft ownership, sessionStorage denial, acknowledgement/archive write failures, abort rollback, and rapid retry exactly once.
- Verified stale acknowledgement/archive recovery even with missed invalidation, peer-action focus restoration, labeled input, semantic headings/lists, polite status, assertive errors, all busy controls, 48px targets, 320px reflow, forced colors, text spacing, reduced motion and 200% page-scale emulation. No product capability or domain rule changed.
- Passed 49 Rust tests, 11 Node bridge/real-WASM tests, formatting, Clippy, release WASM compilation, both build scripts, version consistency and full browser regressions (Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59; POSIX build in WSL Ubuntu 22.04). Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain untested.

## v0.3.1 — Handoff Correctness

- Added exhaustive Handoff payload truncation, exact reference lengths, schema rejection, extreme lengths, invalid Unicode, actor provenance, separate ID namespace, and exact result-layout regressions.
- Added malformed result-field recovery and Handoff-specific event/counter rollback, exactly-once retry, metadata mismatch and canonical-byte preservation tests. No new capability or contract change.
- Passed 49 Rust tests, 11 Node bridge/real-WASM tests, formatting, Clippy, release WASM build, both build scripts, version check, and the full browser regression runner (Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59; POSIX build in WSL Ubuntu 22.04). Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

## v0.3.0 — Handoff

### Added

- Dedicated short Handoff capture and needs-attention/recent lists, neutral acknowledgement, and terminal archival. Actor placeholders are not verified people; no named receipt or creator/acknowledger inequality is inferred.
- Rust-owned Handoff types, lifecycle, mixed replay and explicit protocol v3. Protocols v1/v2 remain unchanged and reject Handoff history/state. Existing event bytes and IndexedDB schema 1 remain unchanged.
- Independent tab draft ownership, atomic persistence/retry, content-free peer invalidation, inert text rendering, keyboard/focus/busy behavior. No framework, runtime dependency, or remote service.

### Validation

- Passed 46 Rust tests and 9 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, release WASM compilation, both build scripts and version consistency.
- Full browser regression suite passed on Windows x64, Node 22.12.0, headless Chrome 154.0.8037.59, including prior Today/Needs checks and Handoff lifecycle, mixed replay/reload, invalid-reference non-append, retries/drafts, cross-tab stale acknowledgement, keyboard/focus, 320px, forced colors, text spacing, reduced motion, page-scale emulation, CSP and same-origin requests. POSIX build ran in WSL Ubuntu 22.04.
- Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain untested. Page-scale emulation is not native desktop 200% zoom.

## v0.2.4 — Today + Needs Compatibility Fixes

### Fixed

- Protocol-v1 `KINS` responses now carry the requested v1 header, matching the unchanged active/completed record layout and zero reserved bytes. Protocol-v2 responses retain their v2 classification/status layout.
- Item busy state now disables every action control, including Archive beside Complete or Reopen. Compose and retry controls remain disabled until the pending operation finishes, with focus restoration preserved.
- Added exact-byte real-WASM ABI regressions for both versions, unsupported v1 state, repeated result/error buffer clearing, bridge decoding, and browser coverage for all busy controls and recovery. The focused adjacent audit found no further defect requiring a production change.

### Validation

- Passed 44 Rust tests, 8 Node bridge/real-WASM tests, `cargo fmt --check`, Clippy with warnings denied, version consistency, release `wasm32-unknown-unknown` compilation, and both PowerShell and POSIX WASM build scripts. POSIX validation ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- The Windows x64 browser runner passed in headless Chrome 154.0.8037.59 with Node 22.12.0: legacy replay, Today/Needs, complete/reopen/archive, pending busy controls, retries, draft ownership, cross-tab canonical refresh, malformed-storage preservation, 320px reflow, CSP/console, and same-origin requests. Existing forced-colors, reduced-motion, text-spacing, and 200% page-scale checks also passed.
- Native desktop 200% zoom, Firefox, Safari, NVDA, and VoiceOver were not tested. No product capability, persisted event change, IndexedDB schema change, or runtime dependency was introduced. Published `kin-v0.2.0`–`kin-v0.2.3` tags remain unchanged.

## v0.2.3 — Today + Needs Hardening & Polish

### Hardened

- Rechecked Rust-owned replay, protocol/event version boundaries, IndexedDB schema 1, immutable history, safe text rendering, same-origin-only runtime requests, content-free BroadcastChannel messages, and the absence of runtime dependencies or remote services.
- Added deterministic 10,000-event classified replay checks through native Rust and real WASM, plus valid/error/empty/repeated-call coverage for stale ABI output handling.
- Completed focused Today/Needs clarity and accessibility regressions without adding a product concept. `v0.3.0 — Handoff` remains future work.

### Validation

- Passed 44 Rust tests, 4 built-in Node bridge tests, `cargo fmt --check`, Clippy with warnings denied, version consistency, and both PowerShell and POSIX WASM release builds. The shell build ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- The Windows x64 browser runner passed in headless Chrome 154.0.8037.59 with Node 22.12.0. It covered v0.1 byte preservation, protocol errors/repeated calls, maximum 10,000-event replay, draft/action recovery, stale cross-tab actions, two-tab canonical replay, 320px, forced colors, reduced motion, increased text spacing, 200% page-scale emulation, CSP, and same-origin-only requests.
- Native desktop 200% browser zoom, Firefox, Safari, NVDA, and VoiceOver were not tested. The 200% check was Chromium page-scale emulation, not native desktop zoom; no screen-reader certification is claimed.
- No product capability, IndexedDB schema change, runtime dependency, framework, backend, or remote service was added.

## v0.2.2 — Today + Needs Resilience & Accessibility

### Improved

- Hardened complete/reopen/archive failures and retries; a domain-invalid retry now reloads canonical events and clears stale item intent instead of repeatedly presenting an unavailable action.
- Restored compose focus when a peer refresh replaces a focused item control and disabled retry controls while the app is busy.
- Extended browser coverage for text-only draft compatibility, action write failures/abort recovery, two-tab stale-action races with and without invalidation delivery, and keyboard lifecycle actions.
- Added forced-colors, reduced-motion, increased-text-spacing, 320px reflow, target-size/focus checks, and 200% Chromium page-scale emulation.

### Validation

- Passed 43 Rust tests, 4 built-in Node bridge tests, `cargo fmt --check`, Clippy with warnings denied, version consistency, and both PowerShell and POSIX WASM release builds. The shell build ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- The Windows x64 browser runner passed in Chrome 154.0.8037.59 with Node 22.12.0. It covered draft restoration/ownership, action failures and retries, stale cross-tab intent with and without invalidation delivery, keyboard/focus recovery, 320px reflow, forced colors, reduced motion, increased text spacing, 200% page-scale emulation, CSP, same-origin requests, and the event/storage compatibility regressions.
- Native desktop 200% browser zoom, Firefox, Safari, NVDA, and VoiceOver were not tested. The 200% check used Chromium page-scale emulation, not native desktop zoom; no screen-reader certification is claimed.
- No product capability, IndexedDB schema change, framework, or runtime dependency was added.

## v0.2.1 — Today + Needs Correctness

### Hardened

- Added exact malformed-length coverage for `ITEM_REOPENED` and `ITEM_ARCHIVED` payloads and a regression ensuring protocol v1 rejects state it cannot represent rather than dropping classification/status.
- Extended browser regressions to verify event and logical-time counter rollback on failed/aborted writes and exactly-once counter advancement on retry.
- Reconciled test vectors, traceability, and the current compatibility contract; no product capability or persistent schema changed.

### Validation

- Passed 43 Rust tests, 4 built-in Node bridge tests, formatting, Clippy with warnings denied, version consistency, and both PowerShell and POSIX WASM release builds.
- The Windows x64 browser runner passed in Chrome 154.0.8037.59 with Node 22.12.0, including exact v0.1 byte preservation, malformed lifecycle payloads, event/counter rollback and retry, metadata mismatch preservation, the 10,000-event cap, cross-tab replay, CSP, same-origin requests, keyboard submission, focus, and 320px reflow. The shell build ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- No product capability, IndexedDB schema change, framework, or runtime dependency was added.

## v0.2.0 — Today + Needs

### Added

- Added separate Today and Needs views, with new items defaulting to Needs and a native classification selector for Today.
- Added completion, reopening, and terminal archival intents. Archived items remain in event history and are hidden from ordinary views.
- Added explicit protocol v2 and schema-v2 `ITEM_ADDED` classification while preserving protocol v1, schema-v1 event bytes, and IndexedDB schema version 1. Legacy unclassified items normalize to Today.
- Extended text draft ownership to the submitted text-and-classification snapshot and added browser regressions for retry, reload, two-tab replay, and lifecycle actions.

### Validation

- Passed 41 Rust tests, 4 built-in Node bridge tests, `cargo fmt --check`, Clippy with warnings denied, version consistency, and both PowerShell and POSIX WASM release builds. Browser regressions passed on Windows x64 with Node 22.12.0 and Chrome 154.0.8037.59; the shell build ran in WSL Ubuntu 22.04 with Rust 1.93.0.
- Browser checks covered Needs-default and Today capture, synthetic v0.1 event replay with exact byte preservation, failed-write retries, text/classification draft ownership, completion in both views, reopen/archive, invalid-transition non-append, hidden tombstones after reload, cross-tab content-free invalidation, malformed-row preservation, keyboard submission, focus, busy state, 320px reflow, CSP, and same-origin requests.
- Forced-colors, 200% zoom, Firefox, Safari, NVDA, and VoiceOver were not tested for this milestone.
- No new IndexedDB schema, framework, runtime dependency, backend, or remote service was added.

## v0.1.5 — Final 0.1.x Stabilization

### Fixed

- Prevented a successful retry of an earlier failed add from clearing a newer compose draft. Draft clearing now belongs to the captured, successfully persisted submission, including delayed normal adds; retry still uses the original command.
- Retained failed-command retry feedback after a successful peer refresh and kept reconnects from restarting the engine or unlocking an in-flight save.
- Aborted synchronous IndexedDB write-request failures with their original storage-error guidance.
- Stopped the PowerShell build script before copying a stale WASM artifact when Cargo fails.

### Tests

- All 32 Rust tests, 3 built-in Node bridge tests, formatting, Clippy with warnings denied, the WASM release build, both build scripts, and version consistency passed. Injected Cargo failures stop both build paths before copying an artifact.
- Added a dependency-free browser regression runner covering normal add/clear, failed add with unchanged or edited draft, synchronous/asynchronous injected quota failures, repeated retry exactly once, commit/abort behavior, and delayed completion across reconnect.
- Browser checks also passed for startup, completion, reload/Rust replay, keyboard submission, draft restoration and sessionStorage denial, successful peer refresh retaining retry, two-tab content-free invalidation and canonical reload, malformed-row preservation, Unicode, inert script-like text, focus restoration/outline, 320px reflow, and busy-state cleanup.

### Validation

- Tested on Windows x64 with Rust 1.93.0, Node 22.12.0, and headless Edge 154.0.4258.48 through local CDP. Shell build validation used Git Bash on Windows. Page requests stayed same-origin; no uncaught errors or CSP violations occurred. The automatic favicon 404 is excluded from console assertions.
- Firefox, Safari, standalone Chrome, native browser zoom, NVDA, and VoiceOver were not tested for this patch. Quota failures were injected; the host disk was not filled.
- No new product capability or dependency was added. This closes planned 0.1.x stabilization; the next development target is v0.2.0.

## v0.1.4

### Fixed

- Preserved the original IndexedDB write failure cause so quota errors receive actionable retry guidance without losing the draft or changing the event log.

### Improved

- Refreshed same-origin peer tabs from the canonical IndexedDB event stream through Rust replay using content-free BroadcastChannel invalidations.
- Added cross-platform build and version-consistency tooling, an explicit WASM-focused Rust toolchain pin, and a same-origin Content Security Policy.
- Expanded malformed protocol, deterministic replay, storage retry, cross-tab, and accessibility regression coverage.

### Tests

- 32 Rust tests and 3 built-in Node bridge tests passed.
- `cargo fmt --check`, Clippy with warnings denied, `wasm32-unknown-unknown` release build, both build scripts, and the version-consistency check passed.
- Browser checks passed for add/complete/reload, keyboard submission, Unicode and inert rendering, malformed-row preservation, quota abort/retry, two-tab refresh, 320px layout, and same-origin requests.

### Validation

- Tested on Windows 10 x64 with Rust 1.93.0, Node 22.12.0, and headless Edge 154.0.4258.48 through local CDP; CSP loaded with no CSP violations. An automatic `/favicon.ico` request returned 404.
- Forced-colors, increased text spacing, and 320px reflow were checked in the integrated VS Code browser (Code 1.139.1, Electron 43.6.0, Chromium 150). Native 200% browser zoom, Firefox, Safari, standalone Chrome, NVDA, and VoiceOver remain unverified.

## v0.1.3

### Audited

- Confirmed JavaScript remains a browser adapter and renderer; Rust remains the only authoritative event validator and item-state reducer.
- Documented the event, identity, ordering, and protocol foundations that later capabilities can extend without implementing those capabilities.
- Confirmed no npm runtime packages, frontend frameworks, WASM helper crates, or third-party network dependencies are present.
- Rechecked local-only storage/requests, privacy-safe diagnostics, and the v0.0.10 community/security/support guidance.

### Validation

- Full Rust, bridge, WASM, reload, malformed-storage, Unicode, keyboard, and narrow-viewport regressions were run for the v0.1.x line.
- The release review records remaining platform and assistive-technology gaps and makes no certification claim for untested environments.

## v0.1.2

### Improved

- Preserved in-progress compose drafts across same-tab reloads with best-effort `sessionStorage`; successful persistence clears the draft.
- Restored keyboard focus after asynchronous add and completion actions and exposed initialization/save progress with `aria-busy`.
- Kept retryable startup feedback for WASM and IndexedDB failures without discarding stored household events.

### Validation

- Verified draft restore/clear, WASM failure and retry with focus restoration, add/complete focus continuity, status updates, reduced-motion preference, and 320px/360px/640px reflow in the browser.
- Confirmed a blocked `sessionStorage` does not prevent startup or saving; draft retention degrades without affecting the event store.
- Confirmed primary controls are at least 48px high. Testing used Windows 10 x64 with the integrated VS Code browser (Code 1.139.1, Electron 43.6.0, Chromium 150.0.7871.250).
- Screen-reader and non-Chromium browser testing remain unverified.

## v0.1.1

### Fixed

- Preserved leading U+FEFF and other Unicode text during UTF-8 validation while continuing to reject malformed lone surrogates.
- Closed IndexedDB connections when local-context initialization fails or a blocked open later completes.
- Rejected corrupted event metadata through deterministic integrity errors before lossy conversion or replay.

### Tests

- Added regression tests for BOM/emoji preservation, malformed surrogate input, and the exact UTF-8 byte limit.
- Verified invalid completion does not append, corrupted rows remain stored, concurrent tabs preserve contiguous event order, and rapid duplicate submission creates one event.
- Re-ran 24 Rust tests, 3 built-in Node bridge tests, formatting, Clippy, the WASM build, and browser reload checks.

## v0.1.0

### Added

- Delivered the local Household Heartbeat flow using native Web Components, Rust/WASM event validation and replay, and IndexedDB event persistence.
- Added and completed household items, with deterministic state reconstruction after reload.
- Added the manual versioned binary ABI, local identity placeholders, bounded protocol parsing, and regression tests for replay and malformed input.
- Added project-local build and static-serving instructions.

### Validation

- Rust unit and protocol tests passed; the `wasm32-unknown-unknown` release build succeeded.
- Browser checks passed for add, complete, reload, inert rendering of script-like text, keyboard submission, narrow layout, and same-origin-only requests.
- Windows 10 x64 was exercised using the integrated VS Code browser (Code 1.139.1, Electron 43.6.0, Chromium 150.0.7871.250). Firefox, Safari, standalone Chrome, and assistive-technology testing were not performed.

## v0.0.12

### Added

- Established a project-scoped changelog and documented how release entries are maintained.

### Changed

- Updated Kin's current release references through `v0.0.12`; `v0.0.9` remains the specification freeze and `v0.1.0` remains the first implementation milestone.

## v0.0.11

### Added

- Defined the general minor-release cadence: capability in `.0`, then correctness, resilience/accessibility, and hardening patches when meaningful work exists.

### Changed

- Corrected stale current-version references and confirmed that `v0.1.0` is the first implementation milestone.

## v0.0.10

### Added

- Added project-scoped Code of Conduct, security, support, contribution, issue-template, and pull-request guidance.
- Documented GitHub's discovery limitations for community files nested in the ZTM Build Fest monorepo.

## v0.0.9

### Added

- Completed the implementation preflight, accepted architecture decisions, canonical test vectors, and requirement traceability for the frozen `v0.1.0` scope.

## v0.0.8

### Added

- Documented contributor expectations, cross-platform development guidance, code style, release process, and privacy-safe debugging.

## v0.0.7

### Added

- Specified persistent-contract versioning, migration safety, portability, retention, and event-log evolution.

## v0.0.6

### Added

- Froze the initial implementation contract for the manual JS/WASM ABI, binary protocol, IndexedDB event store, components, tests, and accessibility.

## v0.0.5

### Added

- Specified household/member/device identity, pairing, cryptographic posture, threat model, and synchronization design.

## v0.0.4

### Added

- Defined the household domain, immutable event semantics, entity lifecycles, and deterministic state reconstruction.

## v0.0.3

### Added

- Documented initial UX flows, the release roadmap, and the first implementation specification.

## v0.0.2

### Added

- Established the technical foundation: architecture, event model, local-first direction, privacy posture, and dependency policy.

## v0.0.1

### Added

- Defined Kin's product foundation, intended users, principles, scope, and non-goals.

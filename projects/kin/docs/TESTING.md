# Testing Contracts

**Status:** v0.11.7 durable-service implementation candidate; awaiting human review. Earlier version sections are historical release gates. See [V0.10.0](V0.10.0.md) for prior milestone and patch evidence and [V0.11.0](V0.11.0.md) for the current service contract.

## v0.11 durable-service gate

Install the locked native dependency once, then run the service suite from the
repository root:

```powershell
npm ci --prefix projects/kin
npm run test:server --prefix projects/kin
```

The suite includes file-backed migration rollback and unsupported-schema tests,
corrupt relay-data fail-closed checks, competing stale-cursor writers, online
backup and verified offline restore, exclusive process/maintenance locks, and
a spawned HTTP service restart. The restart test verifies fresh passkey login
using a persisted trusted-device verifier, durable acknowledgement, exact
ciphertext recovery, idempotent retry/conflict behavior, and device-sequence
continuity. Use synthetic credentials and events only.

PR #17 hardening regressions also cover canonical admin/startup web-root guards
(including symlinked missing ancestors), static traversal/symlink isolation,
rollback and retry after stale-writer conflicts, fatal store failures, bounded
durable cursor pagination, actionable stale-lock errors, admin exclusion and
cleanup, invalid restore sources, and preservation of old WAL/SHM state. See
[V0.11.0](V0.11.0.md#pr-17-pre-merge-hardening-evidence-2026-10-03) for gate results.

Semantic-integrity fixtures first create normal API state, then directly mutate
synthetic SQLite databases while retaining physical/foreign-key validity.
They cover normalized JSON/envelope mismatches, impossible identity limits and
ownership, grant/package/rotation contradictions, relay/device sequences, audit
structure, failed startup, readiness before household access, and backup/restore
rejection before publication/replacement. Valid historical state and bounded
relay pages remain covered. See [v0.11.5 evidence](V0.11.0.md#v0115-semantic-integrity-evidence-2026-10-03).

The production smoke process also takes an exclusive service lock. A test or
operator restoring a database must stop that process first. The lock is
intentionally left behind after an unclean exit; verify process state before
manual cleanup. See [DEVELOPMENT](DEVELOPMENT.md) for backup/restore commands
and limitations.

## v0.10 security and portability gate

Run from the repository root after building the current WASM artifact. Browser
runners use isolated temporary profiles and synthetic text/credentials. They do
not bypass production recovery, storage encryption or WebAuthn verification.

```powershell
cargo fmt --manifest-path projects/kin/Cargo.toml -- --check
cargo clippy --manifest-path projects/kin/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path projects/kin/Cargo.toml
cargo build --manifest-path projects/kin/Cargo.toml --target wasm32-unknown-unknown --release
Copy-Item projects/kin/target/wasm32-unknown-unknown/release/kin.wasm projects/kin/web/wasm/kin_engine.wasm
node --test (rg --files projects/kin/server projects/kin/web -g '*.test.mjs')
python projects/kin/scripts/check_version.py
$kinBrowser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node projects/kin/scripts/browser-regression.mjs $kinBrowser
node projects/kin/scripts/security-storage-regression.mjs $kinBrowser
node projects/kin/scripts/security-ui-regression.mjs $kinBrowser
node projects/kin/scripts/passkey-regression.mjs $kinBrowser
```

The version check keeps the published Kin release anchors separate from an
unreleased durable-service package candidate; server-only work does not imply
a Rust/WASM product-version bump.

The storage runner includes legacy-key migration checks. Optional `--performance`
and `--maximum-payload` measure 10,000-event migration/unlock and encrypted archive
round trips. The WebAuthn runner uses a CDP virtual authenticator supporting PRF,
real browser ceremonies and the real server verifier; it is not physical hardware
or cross-platform certification. Preserve prior feature suites when changing
startup/draft expectations: security must not weaken domain, rollback or a11y checks.

## v0.10.1 correctness regressions

The same commands above include the patch checks. `security-operation-regression.mjs`
(called by the security UI runner) holds an old recovery unlock across lock and a
new unlock, then settles it both during and after the new operation. It also
holds an authentication-error metadata read across re-unlock. Verify the live
vault, lock control, busy state, disabled controls and feedback remain current,
and the old root is disposed.

The key-migration suite now delays fingerprint hashing for new, existing,
mismatched, conflicting and concurrently proposed trusted pins. It checks input
mutation during verification and locking before verification completes.

`server/rotation-recovery.test.mjs` uses real cryptographic packages and service
validation with controlled transport loss/expiry. It covers expired unaccepted
proposals, accepted lost responses, subsequent access changes, recipient key
succession/revocation, acceptance racing package refresh, competing proposals and
mismatched acknowledgements. The storage runner also exercises pending-rotation
compare-and-set and the retained rotation barrier in encrypted IndexedDB.

## Rust domain tests

### v0.10.3 bounded storage and corruption gate

`bounded-storage-regression.mjs` runs through the existing storage runner. It
checks 270 sparse ordered records with native pages ≤128 and crypto concurrency
≤32, duplicate routing rejection, decrypted index mismatch, cancellation between
batches, durable peer locks during 70-event migration/restore, exact source
retention and resume, lock after queued native restore writes, and duplicate
archive rejection before encryption. `encrypted-idb.test.mjs` checks both root
formats against wrong routing/AAD, unsupported versions, plaintext field leakage,
truncation and modified tags. Existing wrapper, KARC metadata/ciphertext,
canonical duplicate and malformed/version tests remain mandatory.

The storage runner now also forcibly terminates and reopens its isolated browser
profile at pre/post event-publication boundaries (four assertions), separately
from its four document-reload assertions. Synthetic recovery keys stay only in
the test host. The UI runner holds a real peer read while locking to verify that
numbered intent aborts the native transaction before the durable lock can queue
behind it. Existing same/current-epoch delayed-notification tests remain intact.

The full release gate additionally runs both project build/launcher workflows,
including PowerShell and POSIX shell HTTP/WASM smoke tests, native formatting and
warnings-denied Clippy/tests, complete Node/real-WASM/server tests, all product,
security and PRF browser runners, version/whitespace and Kin-only path checks.

### v0.10.2 root lifecycle gate

The established storage runner invokes `root-rotation-regression.mjs` and
`root-key-rotation-regression.mjs`, including durable phase interruptions,
quota/native abort, peer locks, stale manifest/root/capability rejection,
foreign journals, exact canonical/context/sync/outbox retention, restored private
keys/epoch secrets/pins, root 2→3, old copied wrapper isolation, and real document
reload before/after event publication. Node vault tests exercise candidate
generation failures, authenticated root versions and independent recovery roots.
The UI runner invokes `root-rotation-ui-regression.mjs` for re-entry confirmation,
replacement, cancellation, new-key resume, old-key rejection and offline recovery.

Optional `--performance --maximum-payload` now measures 1,000 representative,
10,000 short-text and 10,000 maximum-text events: migration, decrypt, Rust replay,
archive export/restore, exact canonical roundtrips, archive and serialized
encrypted-record bytes, origin storage estimates, and sampled Windows renderer
working set where available. Sampling includes retained synthetic fixture memory;
it is neither a precise database-file size nor a mobile measurement.

Before v0.1.0 is considered complete, cover at least:

1. `ITEM_ADDED` creates an active item with the specified ID, text, actor, and creation time.
2. Two distinct additions produce both items in deterministic creation order.
3. `ITEM_ADDED` followed by `ITEM_COMPLETED` derives a completed item.
4. Completing an unknown item returns the specified deterministic validation error and no partial state.
5. Reconstructing the same ordered stream repeatedly yields structurally identical output.
6. Exact duplicate event delivery is idempotent; reuse of an event ID with different bytes fails as an integrity error.
7. A second distinct completion event for an already-completed item is a valid no-op in state.
8. Malformed event envelope or payload fails safely.
9. Unsupported protocol and event-schema versions fail with stable error categories.
10. Cross-household input and bounds/length violations fail without partial state.
11. Reopen/archive payloads are exactly one item ID; every shorter or longer payload fails as malformed protocol data.
12. Protocol v1 cannot encode state that has Needs classification or archived status; it fails closed instead of dropping fields.

The Rust reducer must be testable without a browser or WebAssembly runtime. Use the standard Rust test harness; no third-party test framework is required.

The browser bridge's focused encoding/Unicode regression tests use Node's built-in test runner (no npm dependencies):

```text
node --test projects/kin/web/wasm/kin-engine.test.mjs
```

## ABI/protocol tests

Verify null/zero pointers, undersized and oversized buffers, overflow-safe range checks, zero-item results, stale-output reset between calls, correct result lifetime, memory growth handling, deterministic error status, malformed encoding, and the rule that input pointers are not retained after return.

## Browser-level validation

The browser regression runner uses Node 22+ built-ins and a local Chromium-family executable. Build WASM first, then run from the repository root (PowerShell example):

```powershell
node projects/kin/scripts/browser-regression.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
```

It starts a loopback static server and an isolated headless browser profile, runs against the shipped CSP and real Rust/WASM/IndexedDB, and removes its temporary profile afterward. It does not access the user's existing Kin database. No npm install is needed. The runner fails on assertion errors, uncaught browser errors, CSP errors, or third-party page requests; the automatic favicon 404 is ignored.

Regression cases include unchanged/edited drafts after failed add, exact original-command retry, rapid and stale retry clicks, delayed add completion, reconnect during a pending save, and peer refresh retaining a failed-command retry. Both synchronous and asynchronous quota categories are injected without exhausting disk space. A separate real transaction abort after request success verifies rollback and retry. The remaining checks cover the existing add/complete/replay, storage, cross-tab, Unicode, rendering, focus, and narrow-layout flows below. Automated focus checks assert focus ownership and a 3px outline; they do not certify screen-reader announcements or visual contrast.

The v0.2.3 regression suite retains Rust as the authoritative validator/reducer, IndexedDB schema 1 as the canonical event source, immutable source event bytes, and content-free BroadcastChannel invalidations. It covers complete/reopen/archive recovery, stale canonical state, focus continuity, accessibility modes, repeated WASM calls after failure/empty input, and 10,000-event replay/result bounds in native Rust and the browser.

Manually exercise or use a lightweight browser-native harness to verify:

- WASM loads and exports match the ABI contract.
- IndexedDB opens and event history reads in append order.
- Existing events load and Rust reconstructs state.
- An item can be added and then completed through UI commands.
- New capture defaults to Needs; selecting Today changes classification with one native control action.
- Schema-v1 legacy items normalize to Today; schema-v2 classification survives reload without modifying original stored bytes.
- Complete and reopen work from their appropriate states; archive creates a tombstone that remains in IndexedDB and stays hidden after reload.
- Refresh reconstructs exactly the same visible state.
- Repeated actions and replay do not duplicate/corrupt state.
- User-entered text renders safely as text.
- Storage/ABI failures reach an understandable error state without claiming success.
- A compose draft survives a same-tab reload and clears only after successful persistence; the draft is not written to the event store.
- Focus returns to a usable control after add, complete, reopen, and archive; `aria-busy` clears after success or failure.
- Complete/reopen/archive storage failures and transaction aborts preserve the prior state; retry applies exactly one event.
- If canonical state makes a retry invalid, reload the full event log through Rust, clear the stale retry, present the current state, and append nothing.
- Rebuild and serialize 10,000 synthetic classified events deterministically below the 64 MiB request/result limits; verify repeated WASM calls do not return stale state/error buffers.
- A quota-exceeded write preserves the event count, announces a storage-full message, exposes retry, and a later retry persists exactly one event.
- With two same-origin tabs open, a successful write in one invalidates the other; the peer reloads canonical events and reruns Rust replay. Verify the notification carries no event or household content.
- CSP smoke: load the page under its shipped same-origin policy and inspect the console for CSP violation messages.
- Accessibility stress: test forced-colors, text-spacing overrides, 320px reflow, 200% browser zoom, and visible focus around actions.
- No household-content, backend, analytics, or third-party network requests occur; serving local static assets from the application origin is expected.
- Browser console has no uncaught errors.
- Keyboard interaction, focus visibility, status announcements, and a narrow mobile viewport work.

## Cross-browser and assistive-technology checklist

The following platforms/assistive technologies are not certified by the Windows/Chrome regression run. Mark an item verified only after running it against a release build:

- [ ] Firefox desktop: startup, add/complete/reload, storage failure, CSP console, 320px reflow.
- [ ] Safari desktop: startup, add/complete/reload, storage failure, CSP console, 320px reflow.
- [x] Standalone Chrome desktop (headless): startup, add/complete/reload, storage failure, CSP console, 320px reflow.
- [ ] NVDA with Firefox or Chrome: labels, status/error announcements, completion, and focus restoration.
- [ ] VoiceOver with Safari: labels, status/error announcements, completion, and focus restoration.

Do not introduce an external test framework just for convenience. Record tested browser/runtime versions and manual steps in the release notes when implementation begins.

## Handoff

Coverage in protocol.rs, kin-engine.test.mjs, and scripts/handoff-regression.mjs (called by the browser runner) exercises mixed replay, lifecycle, legacy rejection, immutable storage, inert text, drafts/retries, and cross-tab canonical state.

## v0.3.1 correctness evidence

Handoff tests reject every shortened payload, overlong references, unsupported schemas, extreme lengths, invalid UTF-8 and whitespace-only domain text. Exact v3 result records and separate entity namespaces are checked. Actor provenance comes from envelopes; same and different acknowledging actors both succeed. Browser fault injection verifies event/counter rollback, retry once, and metadata mismatch preservation; Node tests reject malformed Handoff result fields and recover on the next call.

## v0.3.2 resilience and accessibility

The browser runner covers delayed Handoff persistence across reconnect/peer refresh, newer draft ownership, sessionStorage denial, acknowledgement/archive failure and abort retry, rapid repeated retry, and stale actions without invalidation delivery. Handoff semantics, focus, announcements, disabled controls and touch targets are checked under the existing accessibility modes. No screen-reader or native desktop zoom certification is claimed.

## v0.3.3 hardening evidence

Rust checks truncated Handoff request/event headers, reserved fields, extreme text lengths and a deterministic 10,000-event mixed projection. Real WASM tests reject every truncated Handoff result boundary and trailing bytes, observe memory growth during 10,000-Handoff replay, and verify independent host-owned results across success/error/empty/repeated calls. The complete earlier regression suite remains required.

## v0.3.4 retry recovery

User-authorized follow-up patch: a failed canonical refresh retains the original failed command and feedback in transient application memory. Repeated refresh failure offers refresh retry first; successful Rust replay restores the command retry unless canonical state invalidates it. No automatic append occurs on refresh recovery. New commands supersede suspended retries. Browser regressions cover Handoff add/acknowledge/archive, Item add, repeated failure, newer drafts, stale peer actions and supersession. This is not persisted household state or a new capability.

## v0.3.5 build and run workflow

Validate both launchers through the existing platform build scripts, confirm the server serves `web/` on loopback port 8000, and run the complete browser regression suite against the generated WASM. The launch workflow changes no application behavior.

## v0.4.1 correctness evidence

Talk correctness audit passes the full lifecycle matrix, every truncated payload, overlong references, unsupported schemas, empty/oversized/invalid UTF-8 and blank text, exact v4 records, malformed status/reserved/count/length fields and combined entity limits. Exact pre-Talk writer/result fixtures remain unchanged. Browser tests verify event/counter rollback, retry once, metadata preservation and invalid-transition non-append. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts and both launchers (page/WASM HTTP 200), and the complete Chrome 154.0.8037.59 browser suite on Windows x64/Node 22.12.0; POSIX via WSL. Previously listed platform/assistive-technology gaps remain.

## v0.4.2 resilience and accessibility evidence

Expanded Talk browser checks for keyboard resolve/reopen/archive, native input-to-Add focus order, semantic headings/lists, labels, polite status/assertive errors, visible focus and 48px targets under forced colors. Added independent draft assertions and direct stale retries with missed invalidation, alongside repeated-refresh recovery. Retained delayed saves, reconnect, queued peer refresh, sessionStorage denial, quota/abort rollback, rapid retry once and supersession. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts/launchers (page/WASM HTTP 200), and complete browser suite in Windows x64/Chrome 154.0.8037.59/Node 22.12.0, POSIX via WSL. 320px, increased spacing, forced colors, reduced motion and 200% page-scale emulation pass; native zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

## v0.4.3 hardening and final audit

Added every truncated v4 result-header/Talk-record boundary, malformed request headers and extreme lengths, 10,000-event mixed replay, and 10,000-Talk real-WASM growth with independent copied results across repeated success/error/empty calls. Retained explicit v3 Handoff truncation/trailing-byte coverage. Visual inspection found and fixed horizontal overflow caused by a 320px page minimum width when a desktop scrollbar consumes space; reflow assertions now compare scrollWidth with clientWidth. The corrected 320px screen preserves full input focus outlines and wrapping actions.

Passed 58 Rust tests and 19 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, version consistency, release WASM, PowerShell and WSL POSIX build scripts and build/run launchers (page and WASM HTTP 200), and complete browser regressions. Environment: Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.59; POSIX via WSL. Keyboard, all Talk lifecycle focus restoration, native focus order, semantics, busy/status/error, 48px targets, scrollbar-aware 320px reflow, forced colors, increased spacing, reduced motion and 200% page-scale emulation passed. Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

Architecture/product/privacy audit confirms Rust-only reduction; separate Item/Handoff/Talk semantics; immutable canonical IndexedDB schema-1 events; no migration; unchanged v1/v2/v3 contracts and explicit v4; content-free invalidation; textContent rendering; same-origin static requests; no framework/runtime dependency, analytics, AI, remote service, sentiment, scores, blame, identity inference, resolver attribution or response metrics. Resolved is workflow state only and claims neither agreement nor an objective solution. No remaining release-blocking defect was found in exercised environments. Cross-browser, assistive-technology and native-zoom checks remain validation gaps, not certifications. No additional UI feature was added. Duplication remains manageable, so no orchestration refactor was introduced.

## v0.5.0 Pulse

Pulse coverage is in rust/src/pulse_tests.rs, web/wasm/kin-engine.test.mjs and scripts/pulse-regression.mjs, called by the complete browser runner. All prior regressions remain; actual milestone evidence and gaps are in V0.5.0. See [V0.5.0](V0.5.0.md).

Optional local visual evidence: set `KIN_VISUAL_CHECK=1` when running the browser regression script. Screenshots are written only to ignored `projects/kin/target/pulse-active-320.png` and `pulse-change-320.png`. They contain synthetic regression data.

## v0.6.0 Since You Last Looked

`rust/src/catchup_tests.rs` and protocol tests cover summary selection, stable cursor lookup, missing-cursor failure, duplicate delivery, Pulse exclusion, actual through-boundary, ordering, eight-entry cap, total count, and exact v6 bytes. `web/wasm/kin-engine.test.mjs` runs the real WASM ABI for v1–v6 compatibility and summary decoding. `scripts/catch-up-regression.mjs`, called by the complete browser runner, exercises legacy first-run history, cursor initialization racing with append, an event arriving after render, stale-tab monotonicity, beyond-snapshot rejection, truncation/omitted count, explicit no-event marking, keyboard/focus, and cross-tab view-state invalidation. The existing Item, Handoff, Talk, Pulse, storage, retry, 10,000-event, CSP, same-origin, and accessibility-mode regressions remain required.

Do not claim Firefox, Safari, native desktop zoom, NVDA, or VoiceOver coverage unless those environments are actually exercised. Chromium 200% page-scale emulation is not native desktop zoom.

## v0.6.1 Summary Correctness

The correctness-only suite covers an empty event stream; cursor at first, middle, and latest event; missing cursor; first occurrence of an exact duplicate; conflicting event IDs; Pulse events between meaningful changes; exact eight/nine/many counts and omitted entries; summary order and through-boundary; append after render; stale tab writes; requested boundaries beyond the frozen snapshot; malformed/partial local metadata preservation; and strict v6 cursor/reserved fields. No capability was added.

## v0.6.2 Summary Resilience & Accessibility

The browser suite injects cursor quota failure and transaction abort, verifies event/cursor/logical-counter rollback and retry, preserves the displayed summary through repeated refresh failures, and keeps a pending mark busy through reconnect. It exercises cross-tab convergence after `view-state-changed`, recovery after a missed notification, both stale/new write orders, and Pulse expiry refresh while the summary remains visible. Keyboard/focus, semantic structure, feedback roles, target size, narrow reflow, forced colors, text spacing, reduced motion, and page-scale zoom remain part of the complete browser gate.

## v0.6.3 Summary Hardening & Polish

Run every truncated v6 result boundary and malformed summary count, kind, entity/classification combination, reserved byte, UTF-8 sequence, extreme length and trailing-byte check. Verify combined 10,000-entity plus summary bounds, a 10,000-event v6 summary-source replay, real WASM memory growth, and copied-result lifetime. Retain every previous Node, Rust, browser, storage, privacy, and accessibility regression.

## v0.7.0 Routines

Run `cargo test`, `node web/wasm/kin-engine.test.mjs`, `node web/wasm/routines.test.mjs`, and the complete browser runner after a release Wasm build. `rust/src/routine_tests.rs` holds independent v7 wire fixtures; `recurrence.rs` covers Gregorian calendar primitives. `scripts/routine-regression.mjs` exercises real IndexedDB/Wasm lifecycle, boundaries, stale keys, quota/abort/retry, cross-tab races and keyboard focus. Existing suites retain explicit legacy protocol fixtures. See [V0.7.0](V0.7.0.md) for the full matrix and actual release evidence.

## v0.9.3 Encrypted Sync Gate

Run from the repository root after the release WASM build:

```powershell
cargo test --manifest-path projects/kin/Cargo.toml
node --test projects/kin/web/sync/crypto.test.mjs
node --test projects/kin/server/pairing-service.test.mjs projects/kin/server/pairing-sync-keys.test.mjs projects/kin/server/sync-service.test.mjs projects/kin/server/sync-http.test.mjs projects/kin/server/sync-e2e.test.mjs
node --test projects/kin/web/wasm/kin-engine.test.mjs projects/kin/web/wasm/routines.test.mjs
node projects/kin/scripts/browser-regression.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
```

The release gate includes: exact canonical-byte encrypt/relay/decrypt roundtrip; ciphertext opacity; wrong-key, wrong-AAD/identity, modified nonce/tag/signature, wrong recipient, and expiry failures; same-member and new-member device enrollment; duplicate/mismatched provisioning retries; revocation and stale-session rejection; single-winner epoch CAS and the 128-epoch bound; 16-device/128-grant bounds; equal-Lamport delivery in different arrival orders; archive/concurrent-mutation conflict behavior; local clock advancement; exact-envelope retries after relay cursor reset; crash-safe remote event/replay/cursor commit; catch-up cursor independence; non-destructive v1→v2 IndexedDB migration; CSP, accessibility modes, and legacy v1-v7 compatibility.

Identity-binding relay tests cover the 256-record boundary: exact canonical retry succeeds at capacity, conflicting reuse and genuinely new overflow fail without mutation, exact duplicates within one request commit once, and mixed conflict/overflow batches remain atomic. The final available slot is accepted while the next unique binding is rejected.

The browser-native synthetic storage fixture uses an isolated database and the real release WASM. It verifies byte-preserving migration, idempotent encrypted retry, cursor rollback rejection, cross-order v8 state replay versus arrival-ordered catch-up, and retained-envelope requeue after process-local relay loss. Service restart tests explicitly assert that accepted relay ciphertext is lost and acknowledgement is not durable; local canonical history remains intact. These tests do not certify cross-browser behavior, assistive technology, physical multi-device behavior, production durability, or an independent cryptographic audit.

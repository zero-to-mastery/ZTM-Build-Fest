# v0.1.0 Requirement Traceability

**Status:** Current through v0.7.4 Routine Stale-Action Correctness; earlier version sections are historical contracts. See v0.6.0 below.

| Requirement                                        | Specification authority                                                                 | v0.1.0 validation                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Product stays small and nonjudgmental              | [PRODUCT](PRODUCT.md), [PRINCIPLES](PRINCIPLES.md), [UX](UX.md)                         | Scope review; fast-capture and language review.                                    |
| Rust owns household domain state                   | [ARCHITECTURE](ARCHITECTURE.md), [EVENTS](EVENTS.md), ADR 0002                          | Rust reducer/unit tests; verify JavaScript contains no duplicate reducer.          |
| Persisted events are immutable                     | [EVENTS](EVENTS.md), [VERSIONING](VERSIONING.md), ADR 0001                              | Replay and duplicate-event vectors.                                                |
| Event envelope/names and v0.1 subset               | [EVENTS](EVENTS.md), [V0.1.0](V0.1.0.md)                                                | Protocol decode tests and vectors 001–005.                                         |
| Invalid references fail deterministically          | [EVENTS](EVENTS.md), [STATE](STATE.md), [ABI](ABI.md)                                   | Vector 004; assert no partial output/state.                                        |
| Same ordered stream derives same state             | [STATE](STATE.md), ADR 0001                                                             | Vector 006 and repeated Rust reconstruction test.                                  |
| IndexedDB stores the event source of truth         | [STORAGE](STORAGE.md), ADR 0004                                                         | Append/read/reload browser test; verify no authoritative mutable projection store. |
| JS/WASM memory/protocol boundary is explicit       | [ABI](ABI.md), [IMPLEMENTATION](IMPLEMENTATION.md), ADR 0003                            | ABI ownership, bounds, malformed, and unsupported-version tests.                   |
| UI uses native Web Components/browser behavior     | [COMPONENTS](COMPONENTS.md), [ARCHITECTURE](ARCHITECTURE.md), ADR 0005                  | Browser command-flow and component boundary checks.                                |
| Local-first; no remote household content in v0.1.0 | [PRIVACY](PRIVACY.md), [V0.1.0](V0.1.0.md), ADR 0006                                    | Network inspection confirms no backend/analytics/third-party content request.      |
| User text remains data                             | [AGENTS.md](../AGENTS.md), [COMPONENTS](COMPONENTS.md), [THREAT-MODEL](THREAT-MODEL.md) | Vector 011; verify safe text rendering.                                            |
| Keyboard/mobile accessibility                      | [ACCESSIBILITY](ACCESSIBILITY.md), [TESTING](TESTING.md)                                | Keyboard, focus, status, zoom, and narrow viewport checks.                         |
| No runtime framework/dependency by default         | [AGENTS.md](../AGENTS.md), [IMPLEMENTATION](IMPLEMENTATION.md), ADR 0007                | Manifest/dependency review at release gate.                                        |
| Future migrations preserve data                    | [VERSIONING](VERSIONING.md), [MIGRATIONS](MIGRATIONS.md)                                | Migration tests when migration code is introduced; not a v0.1.0 feature.           |
| Export/deletion policy is explicit                 | [PORTABILITY](PORTABILITY.md), [RETENTION](RETENTION.md), [PRIVACY](PRIVACY.md)         | Documentation review now; no v0.1.0 export/delete behavior is claimed.             |

## v0.2.0 Today + Needs

| Requirement                                                         | Specification authority                                                       | v0.2.0 validation                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Fixed Today/Need classification; Needs is capture default           | [V0.2.0](V0.2.0.md), [DOMAIN](DOMAIN.md), [COMPONENTS](COMPONENTS.md)         | Rust schema-v1/v2 replay tests and browser capture/classification/reload checks.                                  |
| Legacy v0.1.x item remains visible in Today without rewriting bytes | [V0.2.0](V0.2.0.md), [VERSIONING](VERSIONING.md), [MIGRATIONS](MIGRATIONS.md) | Protocol-v1 history fixture and mixed-schema replay; compare canonical source bytes.                              |
| Protocol v1 remains unchanged; v2 carries classification/status     | [ABI](ABI.md), [VERSIONING](VERSIONING.md)                                    | Rust protocol-v1/v2 vectors, malformed v2 boundaries, and browser WASM replay.                                    |
| Rust owns complete Item lifecycle and deterministic projection      | [EVENTS](EVENTS.md), [STATE](STATE.md), [LIFECYCLES](LIFECYCLES.md), ADR 0002 | Rust transition matrix and browser complete/reopen/archive/reload checks.                                         |
| Archive is terminal and preserves event history                     | [LIFECYCLES](LIFECYCLES.md), [STORAGE](STORAGE.md), [RETENTION](RETENTION.md) | Invalid post-archive transitions append nothing; archived record survives reload and is hidden from normal views. |
| Draft completion belongs to exact text/classification submission    | [V0.2.0](V0.2.0.md), [ACCESSIBILITY](ACCESSIBILITY.md)                        | Browser delayed-save, failed-add, edited-draft, retry, and reconnect regression.                                  |
| IndexedDB remains schema 1 and BroadcastChannel content-free        | [STORAGE](STORAGE.md), ADR 0004, ADR 0006                                     | Browser transaction/reload/two-tab checks and schema/version inspection.                                          |
| Capture/actions remain accessible and mobile-usable                 | [ACCESSIBILITY](ACCESSIBILITY.md), [TESTING](TESTING.md)                      | Keyboard, focus, announcements, target/reflow checks at 320px; platform gaps reported.                            |
| Reopen/archive payloads require exact shape                         | [ABI](ABI.md), [EVENTS](EVENTS.md), [V0.2.0](V0.2.0.md)                       | Reject every payload length other than 16 bytes for both lifecycle kinds.                                         |
| Protocol v1 never loses unrepresentable current state               | [ABI](ABI.md), [VERSIONING](VERSIONING.md)                                    | A v1 result request for Need or archived state returns unsupported-version error.                                 |
| Event append and logical counter commit atomically                  | [STORAGE](STORAGE.md), ADR 0004                                               | Browser failure/abort keeps both event count and counter unchanged; successful retry advances both once.          |
| Metadata mismatch and storage limit fail without data loss          | [STORAGE](STORAGE.md), [VERSIONING](VERSIONING.md)                            | Browser preserves mismatched row bytes and rejects the 10,001st event without changing history/counter.           |
| Stale action retry is reconciled with canonical state               | [EVENTS](EVENTS.md), [STATE](STATE.md), [ACCESSIBILITY](ACCESSIBILITY.md)     | Two-tab archive race and missed-invalidation retry reload through Rust, clear stale intent, and append nothing.   |
| Keyboard focus survives action and peer rerender                    | [ACCESSIBILITY](ACCESSIBILITY.md), [TESTING](TESTING.md)                      | Keyboard action restores compose focus; peer refresh replaces a focused control without losing focus.             |
| Accessibility modes preserve mobile usability                       | [ACCESSIBILITY](ACCESSIBILITY.md)                                             | 320px reflow, forced colors, reduced motion, increased text spacing, and 200% page-scale emulation.               |
| 10,000-event replay remains bounded and deterministic               | [ABI](ABI.md), [STATE](STATE.md), [TEST-VECTORS](TEST-VECTORS.md)             | Native Rust and real WASM replay 10,000 classified items within 64 MiB and produce deterministic results.         |
| Repeated WASM calls do not leak stale output/error buffers          | [ABI](ABI.md), [TESTING](TESTING.md)                                          | Browser performs success, unsupported event, empty, and repeated success calls in sequence.                       |
| Local privacy/security boundaries remain intact                     | [ARCHITECTURE](ARCHITECTURE.md), [PRINCIPLES](PRINCIPLES.md), [ABI](ABI.md)   | Safe text DOM, CSP, same-origin-only requests, content-free invalidation, and no framework/dependency audit.      |

## v0.3.0 Handoff

Authority: [V0.3.0](V0.3.0.md), ABI, EVENTS, LIFECYCLES. Rust protocol tests cover typed projection, lifecycle, identity, deduplication, and mixed replay. Node tests cover actual WASM and v1/v2/v3 compatibility. Browser Handoff regressions cover persistence, drafts, retry ownership, inert rendering, neutral labels, and cross-tab stale intent.

## v0.3.1 correctness evidence

Handoff tests reject every shortened payload, overlong references, unsupported schemas, extreme lengths, invalid UTF-8 and whitespace-only domain text. Exact v3 result records and separate entity namespaces are checked. Actor provenance comes from envelopes; same and different acknowledging actors both succeed. Browser fault injection verifies event/counter rollback, retry once, and metadata mismatch preservation; Node tests reject malformed Handoff result fields and recover on the next call.

## v0.3.2 resilience and accessibility

The browser runner covers delayed Handoff persistence across reconnect/peer refresh, newer draft ownership, sessionStorage denial, acknowledgement/archive failure and abort retry, rapid repeated retry, and stale actions without invalidation delivery. Handoff semantics, focus, announcements, disabled controls and touch targets are checked under the existing accessibility modes. No screen-reader or native desktop zoom certification is claimed.

## v0.3.3 hardening evidence

Rust checks truncated Handoff request/event headers, reserved fields, extreme text lengths and a deterministic 10,000-event mixed projection. Real WASM tests reject every truncated Handoff result boundary and trailing bytes, observe memory growth during 10,000-Handoff replay, and verify independent host-owned results across success/error/empty/repeated calls. The complete earlier regression suite remains required.

## v0.3.4 retry recovery

User-authorized follow-up patch: a failed canonical refresh retains the original failed command and feedback in transient application memory. Repeated refresh failure offers refresh retry first; successful Rust replay restores the command retry unless canonical state invalidates it. No automatic append occurs on refresh recovery. New commands supersede suspended retries. Browser regressions cover Handoff add/acknowledge/archive, Item add, repeated failure, newer drafts, stale peer actions and supersession. This is not persisted household state or a new capability.

## v0.4.0 Talk

Authority: V0.4.0. protocol.rs tests lifecycle, identity, mixed replay and fail-closed downgrade. kin-engine.test.mjs tests real WASM. scripts/talk-regression.mjs runs inside the complete browser suite and covers atomic persistence, drafts, retries, repeated refresh failure, supersession and stale peers. See [V0.4.0](V0.4.0.md).

## v0.4.1 correctness evidence

Talk correctness audit passes the full lifecycle matrix, every truncated payload, overlong references, unsupported schemas, empty/oversized/invalid UTF-8 and blank text, exact v4 records, malformed status/reserved/count/length fields and combined entity limits. Exact pre-Talk writer/result fixtures remain unchanged. Browser tests verify event/counter rollback, retry once, metadata preservation and invalid-transition non-append. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts and both launchers (page/WASM HTTP 200), and the complete Chrome 154.0.8037.59 browser suite on Windows x64/Node 22.12.0; POSIX via WSL. Previously listed platform/assistive-technology gaps remain.

## v0.4.2 resilience and accessibility evidence

Expanded Talk browser checks for keyboard resolve/reopen/archive, native input-to-Add focus order, semantic headings/lists, labels, polite status/assertive errors, visible focus and 48px targets under forced colors. Added independent draft assertions and direct stale retries with missed invalidation, alongside repeated-refresh recovery. Retained delayed saves, reconnect, queued peer refresh, sessionStorage denial, quota/abort rollback, rapid retry once and supersession. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts/launchers (page/WASM HTTP 200), and complete browser suite in Windows x64/Chrome 154.0.8037.59/Node 22.12.0, POSIX via WSL. 320px, increased spacing, forced colors, reduced motion and 200% page-scale emulation pass; native zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

## v0.4.3 hardening and final audit

Added every truncated v4 result-header/Talk-record boundary, malformed request headers and extreme lengths, 10,000-event mixed replay, and 10,000-Talk real-WASM growth with independent copied results across repeated success/error/empty calls. Retained explicit v3 Handoff truncation/trailing-byte coverage. Visual inspection found and fixed horizontal overflow caused by a 320px page minimum width when a desktop scrollbar consumes space; reflow assertions now compare scrollWidth with clientWidth. The corrected 320px screen preserves full input focus outlines and wrapping actions.

Passed 58 Rust tests and 19 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, version consistency, release WASM, PowerShell and WSL POSIX build scripts and build/run launchers (page and WASM HTTP 200), and complete browser regressions. Environment: Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.59; POSIX via WSL. Keyboard, all Talk lifecycle focus restoration, native focus order, semantics, busy/status/error, 48px targets, scrollbar-aware 320px reflow, forced colors, increased spacing, reduced motion and 200% page-scale emulation passed. Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

Architecture/product/privacy audit confirms Rust-only reduction; separate Item/Handoff/Talk semantics; immutable canonical IndexedDB schema-1 events; no migration; unchanged v1/v2/v3 contracts and explicit v4; content-free invalidation; textContent rendering; same-origin static requests; no framework/runtime dependency, analytics, AI, remote service, sentiment, scores, blame, identity inference, resolver attribution or response metrics. Resolved is workflow state only and claims neither agreement nor an objective solution. No remaining release-blocking defect was found in exercised environments. Cross-browser, assistive-technology and native-zoom checks remain validation gaps, not certifications. No additional UI feature was added. Duplication remains manageable, so no orchestration refactor was introduced.

## v0.5.0 Pulse

Rust tests: actor independence, replacement/clear, expiry boundary, explicit-time determinism, dedup/conflict and legacy rejection. Real WASM: fixed encoding/replay and required time. Browser: persistence, original SET retry, repeated refresh recovery, timer expiry, cross-tab SET/CLEAR and reload. See [V0.5.0](V0.5.0.md).

## v0.5.2 resilience and accessibility evidence

Fixed focus restoration when expiry hides the focused active Pulse action: return to the native capacity selector. Added simulated suspension/missed timer and visibility return, delayed focus refresh, forward/backward wall-clock projections, late timer non-append, missed peer invalidation, original SET/CLEAR retries through quota/transaction abort and repeated refresh failure, supersession, rapid repeated intents and reconnect during busy save. Native keyboard tests exercise value/duration/Set/Change/Clear focus order and activation. Pulse labels, semantic heading, 48px targets and visible focus pass in forced colors; 320px reflow, increased spacing, reduced motion and 200% page-scale emulation pass with previous features retained.

Passed 67 Rust and 24 Node/real-WASM tests, fmt, Clippy, release WASM, version consistency, complete Chrome browser suite, PowerShell and WSL POSIX WASM builds and both build/run launchers (page/WASM HTTP 200). Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.59. Sleep and clock changes are deterministic browser fault injection, not a physical device suspend or OS clock modification. Firefox, Safari, native desktop zoom, NVDA and VoiceOver remain unverified.

## v0.6.0 Since You Last Looked

| Requirement                                                                 | Authority                                                               | Validation                                                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Rust owns summary meaning; actor IDs and entry timestamps are absent        | [V0.6.0](V0.6.0.md), [STATE](STATE.md), ADR 0002                        | Rust projection tests, real-WASM structured records, and browser text-only rendering.                 |
| Protocol v1–v5 remain unchanged; v6 retains explicit time and stable cursor | [ABI](ABI.md), [VERSIONING](VERSIONING.md), [V0.6.0](V0.6.0.md)         | Legacy byte fixtures and exact v6 request/result offsets.                                             |
| First run with existing history initializes at the tail atomically          | [STORAGE](STORAGE.md), [V0.6.0](V0.6.0.md)                              | Browser strips optional local fields, initializes at the tail, and checks event/counter preservation. |
| Only the rendered snapshot boundary may advance the cursor                  | [V0.6.0](V0.6.0.md)                                                     | Browser append-after-render race and beyond-snapshot rejection.                                       |
| Cursor advancement is transactional and monotonic                           | [STORAGE](STORAGE.md), [V0.6.0](V0.6.0.md)                              | Newer-then-stale direct IndexedDB writes; event count and logical time remain unchanged.              |
| Pulse is omitted from entries but included in the actual through-boundary   | [EVENTS](EVENTS.md), [V0.6.0](V0.6.0.md)                                | Rust, real-WASM and browser mixed-stream checks.                                                      |
| Summary is capped at eight and reports exact total/omitted counts           | [V0.6.0](V0.6.0.md), [UX](UX.md)                                        | Rust cap/order/count tests and browser omitted-copy assertions.                                       |
| Cross-tab view invalidation is content-free                                 | [STORAGE](STORAGE.md), [PRIVACY](PRIVACY.md)                            | Browser checks exact `{ type: "view-state-changed" }` and canonical convergence.                      |
| No read receipts, member tracking, activity timeline, or history browser    | [PRINCIPLES](PRINCIPLES.md), [PRIVACY](PRIVACY.md), [V0.6.0](V0.6.0.md) | Contract and UI surface audit; no event kinds or stores added.                                        |

## v0.6.1 Summary Correctness

No capability was added. Rust tests cover empty/first/middle/latest/missing cursors, duplicate/conflicting event IDs, Pulse interleaving, exact eight/nine/many truncation counts, ordering, and actual through-boundaries. Browser tests verify first-run append ordering, post-render event retention, monotonic stale-tab writes, beyond-snapshot rejection, and malformed/partial local cursor metadata preservation. v1–v5 byte fixtures and the complete prior browser suite remain required.

## v0.6.2 Summary Resilience & Accessibility

No capability was added. Browser validation covers quota/abort rollback and retry, refresh failures, pending-write reconnect, missed and delivered cross-tab invalidation, two stale/new cursor orderings, reload/focus refresh, and Pulse timer reprojection with the summary visible. Accessibility assertions cover semantic markup, native keyboard operation, logical focus, polite/assertive feedback, non-color status, 48px target, 320px reflow, forced colors, increased spacing, reduced motion, and 200% page-scale emulation. Platform/assistive-technology claims remain limited to environments exercised.

## v0.6.3 Summary Hardening & Polish

No capability was added. Real-WASM tests validate all truncated v6 summary/result boundaries, malformed counts/kinds/entity/classification/reserved/UTF-8/length fields, trailing bytes, combined entity-plus-summary output, a 10,000-event v6 replay, actual memory growth, and copied-result lifetime. The privacy and polish audit remains limited to the frozen product contract.

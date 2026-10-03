# v0.0.9 Implementation Preflight

**Status:** Current through v0.7.4 Routine Stale-Action Correctness; historical v0.0.9 record. At the time of this preflight, the review was planning-only and no functional application code was present or authorized. v0.1.0 implementation followed this Specification Freeze A in later commits.

## Review scope and method

Reviewed the current Kin instructions, README, and every existing planning document under `docs/`: PRODUCT, PRINCIPLES, ARCHITECTURE, DATA-MODEL, PRIVACY, UX, ROADMAP, DOMAIN, EVENTS, STATE, LIFECYCLES, IDENTITY, PAIRING, SYNC, CRYPTOGRAPHY, THREAT-MODEL, IMPLEMENTATION, ABI, STORAGE, COMPONENTS, TESTING, ACCESSIBILITY, VERSIONING, MIGRATIONS, PORTABILITY, RETENTION, DEVELOPMENT, CODE-STYLE, RELEASES, DEBUGGING, V0.1.0, plus this preflight set and decision records. `CONTRIBUTING.md`, README, and AGENTS.md were also checked.

The audit compared release scope, event names/envelope/immutability/identity, ordering and idempotency, invalid-event behavior, derived state, Rust/JavaScript responsibilities, storage and migration policy, identity separation, security/privacy claims, component/accessibility direction, dependencies, and the v0.1.0 release gate. Local documentation links and the current repository/tag state were checked as part of release validation.

## Contradictions found and resolved

1. **Planning completion moved from v0.0.6 to v0.0.9.** The earlier README/roadmap/AGENTS language said planning was complete at `.6`. The `.7`–`.9` releases are now explicitly documentation-only and `.1.0` remains first implementation.
2. **Event naming was inconsistent in early examples.** The canonical past-tense names `ITEM_ADDED` and `ITEM_COMPLETED` are used for the `.1.0` subset; older imperative names appear only as a disallowed naming example in EVENTS.md.
3. **The `.1.0` serialization decision was initially deferred until implementation.** It is now specified as ABI protocol version 1 in ABI.md; V0.1.0 points to that contract.
4. **README/roadmap previously treated contributor workflow as executable or omitted it.** At preflight time, DEVELOPMENT.md and CONTRIBUTING.md distinguished planned setup from commands that could run; README said no application existed.
5. **Data evolution/export/deletion was previously open-ended.** VERSIONING, MIGRATIONS, PORTABILITY, and RETENTION now separate the version axes and define non-destructive compatibility, migration failure, import validation, and deletion limitations.
6. **Debugging examples could have duplicated ABI error definitions.** DEBUGGING.md treats symbolic diagnostics as a future mapping to the existing numeric ABI status categories, not a replacement registry.

These resolutions update documentation without changing the product's scope or claiming the corresponding features exist.

## Consistency findings

- **Version scope:** v0.1.0 remains the first coded release; `.7`–`.9` are documentation-only.
- **Events/state:** Events are immutable, globally collision-resistant in intent, appended locally, and replayed deterministically. Exact duplicate event delivery is idempotent; same ID/different bytes and unknown references fail. Current household state is derived from events; snapshots/caches are disposable only.
- **Rust/JavaScript:** Rust validates domain events and derives state; JavaScript owns DOM, components, IndexedDB, ABI transport, and accessibility. Rust does not manipulate the DOM.
- **Storage/evolution:** IndexedDB holds canonical event bytes in `.1.0`; migration policy preserves source data and aborts safely. Export and retention are specified but unimplemented.
- **Identity/security:** Household, member, device, and credential are distinct. Passkeys are not content-encryption keys. No custom cryptography; revocation does not erase downloaded copies.
- **Privacy:** No encryption, passkeys, pairing, or sync is claimed as implemented. `.1.0` is local-only with no household-content/backend/analytics/third-party request.
- **UI/accessibility:** Minimal native Web Components, fast capture, keyboard and mobile support, semantic controls, safe text rendering.
- **Dependencies:** No framework/runtime dependency by default; no npm package tree, `wasm-bindgen`, or `serde` requirement.

## Accepted unresolved work outside v0.1.0

The precise multi-device conflict UX, cryptographic algorithm/key-recovery design, service metadata retention, remote deletion/backup windows, export encryption, and safe compaction policy remain open. They do not block the local-only v0.1.0 loop and must be decided before the respective sync/export/deletion capabilities ship. The `.1.0` ABI and IndexedDB contracts are specified; browser/OS versions actually tested can only be recorded after implementation.

## Specification Freeze A

> The planning documents now form the implementation baseline for v0.1.0.

Freeze A does not make documentation immutable. Implementation must not silently diverge. If coding exposes a necessary mismatch, stop that affected change, identify the contradiction and rationale, update the relevant specification/ADR, then implement against the revised decision.

## v0.1.0 readiness

The v0.1.0 scope remains limited to the local add-item, complete-item, reload/replay loop. Handoff, Talk, Pulse, pairing, passkeys, sync, encryption, routines, AI, and notifications remain excluded. Canonical specification vectors are in [TEST-VECTORS](TEST-VECTORS.md); requirement authority and future validation are mapped in [TRACEABILITY](TRACEABILITY.md).

**Readiness result at v0.0.9:** The specification was implementation-ready for the bounded v0.1.0 scope. Implementation had not begun at that historical point; it began after v0.0.12.

## Implementation handoff checklist

v0.1.0 is specification-ready when:

- [x] Product scope is clear.
- [x] Domain semantics are clear.
- [x] Event behavior is clear.
- [x] State/replay behavior is clear.
- [x] ABI and memory ownership are specified.
- [x] Protocol layout and versioning are specified.
- [x] IndexedDB storage/source-of-truth contract is specified.
- [x] Component boundaries are specified.
- [x] Tests and canonical vectors are specified.
- [x] Accessibility expectations are specified.
- [x] Privacy constraints are specified.
- [x] No unresolved architecture contradiction blocks the local-only v0.1.0 scope.

At the time, this readiness result did not mean implementation, testing, or release acceptance had occurred. The later implementation and release checks are documented in [V0.1.0](V0.1.0.md) and [CHANGELOG](../CHANGELOG.md).

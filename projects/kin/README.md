# Kin

> A private, lightweight household coordination app for the little things families need to know, remember, hand off, or discuss.

**Last published release: `v0.10.3` — Bounded Storage/Archive Hardening & Architecture Closure.** The `v0.11.7` durable-service implementation candidate is tagged `kin-v0.11.7` for human review; it is not a published release. Household events, metadata and private sync keys remain encrypted in browser storage. Startup remains locked until a verified recovery secret or supported passkey PRF unwraps the local root. Recovery protection can be replaced with a new random root and a newly confirmed recovery key. Protected reads use bounded batches, and KARC v1 archives avoid redundant ciphertext copies. Rust owns commands, canonical event codecs, replay and archive framing; browser APIs own cryptography, storage and authentication. Opt-in encrypted relay sync preserves canonical identity and exact retry envelopes.

The [v0.10 release record](docs/V0.10.0.md) describes recovery, migration, compatibility, measurements and validation. Root replacement preserves canonical history and sync keys, resumes after interruption using the new recovery key, and requires adding passkey unlock again afterward. Archives are intentionally local-only history recovery and do not restore sync authority. Maximum-history memory and latency remain desktop measurements; mobile readiness is not claimed. This line stops for human review. The v0.11 durable-service candidate awaits review; v0.12–v0.45 and eventual v1.0 remain planned. See the [roadmap](docs/ROADMAP.md). Upgrading v0.9.3 requires security setup and verified migration before the old plaintext dataset gains this protection.

## The problem

Household information gets scattered across memory, messages, calendars, sticky notes, verbal conversations, and assumptions. That makes small handoffs easy to miss and everyday coordination harder than it needs to be. The gaps can lead to "I thought you knew," "Why didn't you tell me?", "I thought you were doing that," or conversations happening at the wrong time.

Kin aims to make useful household context easier to share and find. It is not a promise to prevent conflict or fix relationships, and it will not decide who is right or measure anyone's contribution.

## Intended direction

Kin is intended as a private, lightweight shared household operating layer. Today and Needs views, lightweight classification, capture, completion, reopening, and archival are implemented locally. Handoff capture, acknowledgement, and recent context are implemented locally. Talk captures short topics for later, with Open/Resolved lists, resolve, reopen, and archive. Resolved is workflow state only, not agreement or an objective solution. Pulse adds fixed current capacity, set/replace/clear and explicit expiry, introduced in Rust protocol v5. Since You Last Looked shows at most eight recent meaningful household changes with an omitted-change count; Pulse is excluded. The user explicitly marks the displayed snapshot caught up. Values are context only, never scores or diagnoses. Routines support Daily/Weekly coordination without reminders, streaks, assignments or calendar UI.

The intended technical direction is Rust compiled to WebAssembly, native Web Components, vanilla JavaScript, and browser APIs, with a local-first start and no external framework unless a demonstrated requirement justifies one.

## October Build Fest plan

> Kin should help a household remember, coordinate, hand off, and recover context without requiring everyone to become a project manager.

The October plan builds on the existing product and technical foundation with one small, coherent capability per minor release, followed by meaningful correctness, resilience, accessibility, and hardening work. The [roadmap](docs/ROADMAP.md) and [planned release contracts](docs/releases/) define the scope; they do not describe implemented features or authorize release tags.

October 3–31, 2026 spans 29 days, matching the 29 planned minor lines from `v0.12.x` through `v0.40.x`. The first target is completing `v0.12.0` on October 3, followed by `v0.13.x` on October 4 and one minor line per day through `v0.40.x` on October 31. The platform work through `v0.16.x` is part of this daily plan. These are targets, not completion claims: the current `v0.11.7` candidate still awaits human review. If prerequisites or a day's acceptance criteria are not met, narrow the feature or move the dates. Create patches only for real stabilization work; never fabricate releases or tags to meet the calendar.

The month targets a coherent, demoable pre-1.0 build at `v0.40.x`. The `v0.41.x`–`v0.45.x` plans remain undated follow-up work after October for recovery drills, broader platform validation, performance, and release-candidate readiness. `v1.0` depends on readiness and human feedback, with no deadline forcing it onto October 31. AI runtime features, gamification, surveillance, and enterprise workflows remain outside this plan.

## Release history

- `v0.0.1` — Product definition and principles (`kin-v0.0.1`)
- `v0.0.2` — Architecture, event model, and privacy design (`kin-v0.0.2`)
- `v0.0.3` — UX flows and implementation planning (`kin-v0.0.3`)
- `v0.0.4` — Household Domain Specification (`kin-v0.0.4`)
- `v0.0.5` — Trust, Identity, and Synchronization Design (`kin-v0.0.5`)
- `v0.0.6` — Implementation Contract (`kin-v0.0.6`)
- `v0.0.7` — Data Durability & Evolution (`kin-v0.0.7`)
- `v0.0.8` — Developer & Contributor Experience (`kin-v0.0.8`)
- `v0.0.9` — Implementation Preflight (`kin-v0.0.9`)
- `v0.0.10` — GitHub Community & Project Documentation (`kin-v0.0.10`)
- `v0.0.11` — Implementation Cycle Handoff (`kin-v0.0.11`)
- `v0.0.12` — Changelog & Release History (`kin-v0.0.12`)
- `v0.1.0` — Household Heartbeat (`kin-v0.1.0`)
- `v0.1.1` — Core Correctness (`kin-v0.1.1`)
- `v0.1.2` — Resilience & Accessibility (`kin-v0.1.2`)
- `v0.1.3` — Household Heartbeat Hardening (`kin-v0.1.3`)
- `v0.1.4` — Household Heartbeat Maintenance (`kin-v0.1.4`)
- `v0.1.5` — Final 0.1.x Stabilization (`kin-v0.1.5`)
- `v0.2.0` — Today + Needs (`kin-v0.2.0`)
- `v0.2.1` — Today + Needs Correctness (`kin-v0.2.1`)
- `v0.2.2` — Today + Needs Resilience & Accessibility (`kin-v0.2.2`)
- `v0.2.3` — Today + Needs Hardening & Polish (`kin-v0.2.3`)
- `v0.2.4` — Today + Needs Compatibility Fixes (`kin-v0.2.4`)
- `v0.3.0` — Handoff (`kin-v0.3.0`)
- `v0.3.1` — Handoff Correctness (`kin-v0.3.1`)
- `v0.3.2` — Handoff Resilience & Accessibility (`kin-v0.3.2`)
- `v0.3.3` — Handoff Hardening & Polish (`kin-v0.3.3`)
- `v0.3.4` — Handoff Retry Recovery (`kin-v0.3.4`)
- `v0.3.5` — Build & Run Convenience (`kin-v0.3.5`)
- `v0.4.0` — Talk (`kin-v0.4.0`)
- `v0.4.1` — Talk Correctness (`kin-v0.4.1`)
- `v0.4.2` — Talk Resilience & Accessibility (`kin-v0.4.2`)
- `v0.4.3` — Talk Hardening & Polish (`kin-v0.4.3`)
- `v0.5.0` — Pulse (`kin-v0.5.0`)
- `v0.5.1` — Pulse Correctness (`kin-v0.5.1`)
- `v0.5.2` — Pulse Resilience & Accessibility (`kin-v0.5.2`)
- `v0.5.3` — Pulse Hardening & Polish (`kin-v0.5.3`)
- `v0.6.0` — Since You Last Looked (`kin-v0.6.0`)
- `v0.6.1` — Summary Correctness (`kin-v0.6.1`)
- `v0.6.2` — Summary Resilience & Accessibility (`kin-v0.6.2`)
- `v0.6.3` — Summary Hardening & Polish (`kin-v0.6.3`)
- `v0.7.0` — Routines (`kin-v0.7.0`)
- `v0.7.1` — Routine Correctness (`kin-v0.7.1`)
- `v0.7.2` — Routine Resilience & Accessibility (`kin-v0.7.2`)
- `v0.7.3` — Routine Hardening & Polish (`kin-v0.7.3`)
- `v0.7.4` — Routine Stale-Action Correctness (`kin-v0.7.4`)
- `v0.8.0` — Household Pairing Foundation (`kin-v0.8.0`)
- `v0.8.1` — Pairing Hardening and Failure Recovery (`kin-v0.8.1`)
- `v0.8.2` — Trusted Devices, Authorization, and Security UX (`kin-v0.8.2`)
- `v0.8.3` — Household Pairing Pre-Feedback Stabilization (`kin-v0.8.3`)
- `v0.8.4` — Pairing Creation Response Correctness (`kin-v0.8.4`)
- `v0.8.5` — Auth Panel Text Contrast (`kin-v0.8.5`)
- `v0.8.6` — Pairing Feedback-Gate Corrections (`kin-v0.8.6`)
- `v0.8.7` — Pairing Security and State Hygiene (`kin-v0.8.7`)
- `v0.8.8` — Active-Member Slot Correctness (`kin-v0.8.8`)
- `v0.9.0` — Encrypted Event Sync (`kin-v0.9.0`)
- `v0.9.1` — Device Provisioning, Epochs, and Revocation (`kin-v0.9.1`)
- `v0.9.2` — Offline Reconciliation and Conflict Semantics (`kin-v0.9.2`)
- `v0.9.3` — Recovery, Privacy, and Feedback Readiness (`kin-v0.9.3`)
- `v0.10.0` — Portable Core + Local Data Security (`kin-v0.10.0`)
- `v0.10.1` — Security Lifecycle & Sync Recovery Correctness (`kin-v0.10.1`)
- `v0.10.2` — Local Root Rotation & Recovery Lifecycle (`kin-v0.10.2`)
- `v0.10.3` — Bounded Storage/Archive Hardening & Architecture Closure (`kin-v0.10.3`)
- Earlier candidate: `v0.11.6` — Release Documentation & Code Clarity (includes v0.11.5 durable semantic integrity; not a published release)
- Candidate: `v0.11.7` — October Roadmap & Startup Diagnostics (awaiting human review)
- Planned: `v0.12.x` — Data Lifecycle, Retention & Deletion
- Planned: `v0.13.x` — Recovery & Household Continuity
- Planned: `v0.14.x` — UX/UI Consolidation
- Planned: `v0.15.x` — Household Areas
- Planned: `v0.16.x` — Household Notes & Reference Context
- Planned: `v0.17.x`–`v0.40.x` — Incremental household capabilities, portability, and device migration within the October plan; see the [daily roadmap](docs/ROADMAP.md)
- Planned after October, undated: `v0.41.x`–`v0.45.x` — Recovery drills, broader platform validation, performance, and release-candidate readiness
- Planned: `v1.0.0` — Stable Kin Platform, when readiness and human feedback support it
- See the [changelog](CHANGELOG.md) for the completed release history.

## Install, build, and run

Requirements: Rust/Cargo with the `wasm32-unknown-unknown` target, Node.js 22 or later, npm, and a modern browser with WebAssembly, Web Crypto, Web Locks, ES modules, Custom Elements and IndexedDB. Passkeys are needed for server identity/pairing; PRF support is optional because a user-held recovery secret is an explicit local unlock path. Use HTTPS outside localhost.

From the repository root in PowerShell:

```powershell
npm ci --prefix projects/kin
rustup target add wasm32-unknown-unknown
./projects/kin/run.ps1
```

The script builds the WASM module and serves the web app at `http://localhost:8000`. On macOS/Linux, run `sh projects/kin/run.sh` from the repository root.

The service database defaults to `projects/kin/.kin-data/kin.sqlite`; set
`KIN_DATA_DIR` or `KIN_DATABASE_PATH` to choose another location. Keep the data
directory outside `web/`, restrict access to the service account, and back it
up separately. Kin uses SQLite through the locked `better-sqlite3` dependency;
only Windows with Node 22.12 has been exercised in this implementation
candidate, so other platform/runtime combinations are not yet certified.

The service persists household identity, authorization metadata, opaque relay
events and synchronization state. Sessions and in-flight WebAuthn/pairing
ceremonies expire on restart, so members sign in again with a trusted device
and passkey. A successful event response means its SQLite transaction committed;
it does not mean a recipient received/read it or that a backup exists.

Create an online, integrity-checked database backup with
`npm run backup -- <destination>` from `projects/kin/`. Restore only while the
service is stopped using `npm run restore -- <backup-file>`; restore validates
the backup and preserves the replaced database and WAL sidecars with a
`.pre-restore-...` suffix. A stale service lock after a crash is not removed
automatically: verify the process is stopped before deleting
`<database-path>.service.lock`. Backups and preserved database copies contain
sensitive identity/routing metadata and encrypted envelopes; stale restores can
roll back revocations or key epochs. See [V0.11.0](docs/V0.11.0.md) for the
full operational and privacy boundaries.

First setup generates a recovery secret that must be confirmed and stored separately. Losing all unlock paths loses access; losing the browser profile also requires an encrypted backup. Drafts are memory-only and disappear on lock/reload. Encrypted archives restore exact history into an empty installation for local use; they do not recreate server identity or device trust. The static application shell supports offline recovery unlock after its first successful cache installation.

Sync is off until an authenticated adult enables it. The v0.11 implementation candidate persists identity, relay ciphertext, cursors and provisioning state in SQLite; sessions, incomplete pairing and passkey flows remain process-local and expire on restart. Device-token verifiers persist, but raw tokens and private keys do not. A new/replacement adult cannot receive pre-join epochs. Existing adults can pair another device after comparing fingerprints. Encryption does not protect a compromised unlocked runtime, origin, privileged extension or OS. This prototype has not received an independent security audit.

## AI usage

AI-assisted development tools are used for brainstorming, product planning, architecture exploration, documentation, implementation support, debugging, and testing. Kin has no AI runtime or analytics, and household data is not sent to an AI service. When sync is explicitly enabled, the service receives encrypted event envelopes and limited routing metadata, never plaintext household semantics or content keys.

## License

Kin is available under the [MIT License](LICENSE).

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [GitHub community files and monorepo limitations](docs/GITHUB-COMMUNITY.md)

Kin is nested in the ZTM Build Fest repository. Its community files and templates are kept inside `projects/kin/`; GitHub does not automatically apply nested `.github` templates or count them in the parent repository's Community Standards profile.

## Project documents

- [Routines release contract and test matrix](docs/V0.7.0.md)

- [Changelog](CHANGELOG.md)
- [Product vision](docs/PRODUCT.md)
- [Principles and non-goals](docs/PRINCIPLES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Conceptual data model](docs/DATA-MODEL.md)
- [Privacy](docs/PRIVACY.md)
- [Household domain](docs/DOMAIN.md)
- [Event contract](docs/EVENTS.md)
- [Derived state and replay](docs/STATE.md)
- [Entity lifecycles](docs/LIFECYCLES.md)
- [Identity and trusted devices](docs/IDENTITY.md)
- [Pairing](docs/PAIRING.md)
- [Synchronization design](docs/SYNC.md)
- [Cryptographic posture](docs/CRYPTOGRAPHY.md)
- [Threat model](docs/THREAT-MODEL.md)
- [v0.8.0 Household Pairing contract](docs/V0.8.0.md)
- [v0.9.0 Encrypted Event Sync contract](docs/V0.9.0.md)
- [Implementation layout and responsibilities](docs/IMPLEMENTATION.md)
- [JavaScript/WASM ABI](docs/ABI.md)
- [IndexedDB storage contract](docs/STORAGE.md)
- [Web Component contract](docs/COMPONENTS.md)
- [Testing contract](docs/TESTING.md)
- [Accessibility contract](docs/ACCESSIBILITY.md)
- [Persistent contract versioning](docs/VERSIONING.md)
- [Migration safety](docs/MIGRATIONS.md)
- [Portable household data](docs/PORTABILITY.md)
- [Retention and deletion](docs/RETENTION.md)
- [Development workflow](docs/DEVELOPMENT.md)
- [Code style](docs/CODE-STYLE.md)
- [Release process](docs/RELEASES.md)
- [Debugging and diagnostics](docs/DEBUGGING.md)
- [Implementation preflight](docs/PREFLIGHT.md)
- [Requirement traceability](docs/TRACEABILITY.md)
- [Canonical test vectors](docs/TEST-VECTORS.md)
- [Since You Last Looked release contract](docs/V0.6.0.md)
- [Accepted architecture decision: event-sourced household state](docs/decisions/0001-event-sourced-household-state.md)
- [UX flows](docs/UX.md)
- [Roadmap](docs/ROADMAP.md)
- [Build Fest daily cadence](docs/BUILD-FEST-CADENCE.md)
- [Platform foundation and early October sequence through v0.16](docs/BRIDGE-0.11-0.16.md)
- [Product boundaries for the October plan](docs/PRODUCT-BOUNDARIES.md)
- [Minor-release stabilization protocol](docs/RELEASE-LINE-PROTOCOL.md)
- [v0.11 Durable Service & Deployment implementation candidate](docs/V0.11.0.md)
- [Planned v0.12 Data Lifecycle, Retention & Deletion contract](docs/V0.12.0.md)
- [Planned v0.13 Recovery & Household Continuity contract](docs/V0.13.0.md)
- [Planned v0.14 UX/UI Consolidation contract](docs/V0.14.0.md)
- [Planned v0.15 Household Areas contract](docs/releases/V0.15.0.md)
- [Planned v0.16 Household Notes & Reference Context contract](docs/releases/V0.16.0.md)
- [Planned release contracts: October through v0.40 and undated v0.41–v0.45 follow-up](docs/releases/)
- [v0.1.0 implementation specification](docs/V0.1.0.md)
- [Handoff release contract and final validation](docs/V0.3.0.md)

- [Talk release contract and validation](docs/V0.4.0.md)

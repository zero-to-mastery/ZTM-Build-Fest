# AGENTS.md — Kin

This file contains standing instructions for AI coding agents and automated development tools working on **Kin**.

Read this file completely before making changes.

These instructions apply to every task unless the task explicitly states otherwise.

---

# Project

**Kin** is a private, lightweight household coordination application.

Kin exists to reduce everyday family friction caused by:

- missed information
- forgotten responsibilities
- poor handoffs
- unspoken expectations
- scattered household context
- difficult conversations happening at bad times

Kin is intended to become a shared daily operating layer for a household.

The core question is:

> What does our household need to know right now?

Kin is being created as an entry for **ZTM Build Fest**.

---

# Repository Location

Kin lives inside the ZTM Build Fest repository at:

```text
projects/kin/
```

This directory is the effective root of the Kin project.

Treat:

```text
projects/kin/
```

as if it were an independent repository.

---

# CRITICAL REPOSITORY BOUNDARY

Do not modify anything outside:

```text
projects/kin/
```

This is a hard requirement.

Never modify the parent ZTM Build Fest repository for Kin-specific work.

Do not modify:

```text
/README.md
```

at the Build Fest repository root.

Do not create Kin-specific files at the parent repository root.

Do not add parent-level:

- Cargo files
- package files
- lockfiles
- GitHub Actions
- editor configuration
- scripts
- documentation
- build configuration
- dependency manifests
- Kin assets

Before completing any task, inspect Git status and diff.

Every changed path must begin with:

```text
projects/kin/
```

If an unrelated parent-repository file was modified accidentally, revert that change before completing the task.

---

# Current Development Stage

Kin's last published release is `v0.10.3` — Bounded Storage/Archive Hardening & Architecture Closure. The `v0.11.7` Durable Service & Deployment implementation candidate (October Roadmap & Startup Diagnostics) is committed and tagged `kin-v0.11.7` for human review; the tag is not a published release. Preserve every published tag exactly. Root replacement follows [ROOT-ROTATION](docs/ROOT-ROTATION.md); archive recovery remains intentionally local-only and KARC v1 remains supported. Do not begin v0.12 or create/publish further release commits/tags without explicit authorization. The [forward roadmap](docs/ROADMAP.md) targets one minor line per day from v0.12 on October 3 through v0.40 on October 31, with v0.41–v0.45 as undated follow-ups and v1.0 dependent on readiness. No production certification, mobile readiness or independent audit is claimed. No automatic kin-main or kin-development merge. See [V0.10.0](docs/V0.10.0.md) and [V0.11.0](docs/V0.11.0.md) for actual evidence and limitations.

The pre-implementation releases are:

```text
v0.0.1
v0.0.2
v0.0.3
v0.0.4
v0.0.5
v0.0.6
v0.0.7
v0.0.8
v0.0.9
v0.0.10
v0.0.11
v0.0.12
```

All releases through `v0.0.12` are **planning and documentation releases only**.

No functional application code should be introduced during these versions.

Planning/specification through `v0.0.9` is complete; `v0.0.10` added project community documentation, `v0.0.11` recorded the implementation-cycle handoff and release discipline, and `v0.0.12` established the project changelog. `v0.1.0` is the first implementation release. Before implementation, read [V0.1.0](docs/V0.1.0.md), [PREFLIGHT](docs/PREFLIGHT.md), [TEST-VECTORS](docs/TEST-VECTORS.md), [TRACEABILITY](docs/TRACEABILITY.md), accepted ADRs under `docs/decisions/`, and the community/security policies. Do not allow features assigned to later versions to leak into v0.1.0.

The first implementation release is:

```text
v0.1.0
```

Unless the task explicitly advances Kin to `v0.1.0` or later, do not create application code.

---

# Planning Release Scope

## v0.0.1 — Product Foundation

Focus on:

- product definition
- problem statement
- product principles
- scope
- non-goals
- README
- licensing

No implementation.

---

## v0.0.2 — Technical Foundation

Focus on:

- architecture
- Rust/WASM boundary
- browser responsibilities
- event model
- privacy design
- local-first architecture
- future synchronization concepts
- dependency policy

No implementation.

---

## v0.0.3 — UX and Implementation Planning

Focus on:

- daily-use flows
- UX principles
- roadmap
- first implementation specification
- v0.1.0 acceptance criteria

No implementation.

---

## v0.0.4 — Household Domain Specification

Define domain entities, event semantics, deterministic state reconstruction, and entity lifecycles. Update related existing specifications for consistency.

No implementation.

---

## v0.0.5 — Trust, Identity, and Synchronization Design

Specify household/member/device/credential identity, pairing, device authorization and revocation, cryptographic posture, threat model, encrypted relay, offline expectations, and conflict classes.

No implementation.

---

## v0.0.6 — Implementation Contract

Freeze the v0.1.0 implementation scope and specify its project layout, manual JS/WASM ABI and protocol, IndexedDB contract, component boundaries, test contract, accessibility contract, and release gate.

The v0.0.6 implementation contract is an initial specification milestone; durability, contributor, and preflight planning continue through v0.0.9. The first coded milestone is v0.1.0; do not begin it until explicitly instructed.

---

## v0.0.7 — Data Durability & Evolution

Specify persistent-contract versioning, compatibility, migrations, portable export/import, retention/deletion, and event-log growth. Do not implement migrations, exports, or deletion.

---

## v0.0.8 — Developer & Contributor Experience

Document contribution expectations, intended cross-platform development workflow, code style, release process, and privacy-safe debugging. Do not add executable tooling or build code.

---

## v0.0.9 — Implementation Preflight

Audit and reconcile the specification, record established decisions, define canonical test vectors and requirement traceability, and freeze the v0.1.0 handoff. No implementation begins in this release.

---

## v0.0.10 — GitHub Community & Project Documentation

Keep the Kin README aligned with the ZTM Build Fest project requirements and provide project-scoped license, conduct, contribution, security, support, and reusable issue/PR templates. Document that nested community files are not automatically discovered by GitHub for the parent monorepo.

No functional application code, build tooling, or runtime dependencies.

---

## v0.0.11 — Implementation Cycle Handoff

Record the v0.1.x release cadence, confirm v0.1.0 as the first implementation milestone, and reconcile current-version references without changing the frozen implementation architecture or adding application code.

No functional application code, build tooling, or runtime dependencies.

---

## v0.0.12 — Changelog & Release History

Add a project-scoped changelog based on tagged release history and keep current-version documentation aligned. No functional application code, build tooling, or runtime dependencies.

---

# Product Philosophy

Kin should help people coordinate.

Kin should not judge people.

The application must never evolve into software that:

- decides which spouse is right
- assigns blame
- scores a relationship
- compares household contribution percentages
- ranks family members
- diagnoses relationship problems
- gamifies marriage
- encourages competition between partners
- covertly monitors household members
- tracks a partner without consent

Kin coordinates information.

It does not evaluate people.

---

# Daily-Use Principle

Every feature should be evaluated against:

> Would a tired parent holding a child actually use this?

Favor:

```text
tap
type a few words
tap
done
```

over elaborate data entry.

Do not turn ordinary household coordination into project management.

Avoid unnecessary:

- priorities
- tags
- projects
- subprojects
- complex categories
- mandatory descriptions
- administrative forms
- configuration screens

Fast capture is more important than exhaustive metadata.

---

# Core Product Areas

Kin is expected to evolve around the following concepts.

These are product directions, not necessarily currently implemented features.

## Today

The small number of things that matter to the household today.

## Needs

Things someone needs handled.

## Handoff

Context one household member needs to pass to another.

## Talk

Something important that should be discussed later rather than becoming an argument immediately.

## Pulse

Lightweight context about personal capacity.

Examples:

```text
Good
Okay
Drained
Rough day
Need quiet
```

Pulse is context.

It is not a mood score or relationship metric.

## Since You Last Looked

A concise event-derived summary of what changed.

Example:

```text
Since 8:14 AM

+ Milk added
✓ Electric bill handled
+ Dinner changed
! Weekend plans added to Talk
```

## Routines

Recurring household needs without turning Kin into a full calendar product.

---

# Initial Household Scope

The initial product should optimize for:

> One household with two adult members.

Do not prematurely introduce:

- child accounts
- grandparents
- babysitters
- extended family roles
- organization accounts
- teams
- administrators
- complicated role-based permissions

Additional household roles may be considered later.

---

# Technical Direction

Kin is intentionally centered on:

- Rust
- WebAssembly
- native Web Components
- vanilla JavaScript
- native browser APIs

The project should explore how far these technologies can go without external frameworks.

---

# Dependency Policy

Prefer:

- Rust standard library
- browser standards
- Web Components
- native JavaScript
- native Web APIs

Avoid dependencies unless there is a compelling technical reason.

Do not introduce dependencies merely for convenience.

Default exclusions include:

- React
- Vue
- Svelte
- Angular
- Solid
- Lit
- jQuery
- Tailwind
- Bootstrap
- Vite
- Webpack
- Rollup
- Parcel

Also avoid convenience WASM crates by default:

- `wasm-bindgen`
- `web-sys`
- `js-sys`
- `serde`
- `serde_json`

Do not interpret this policy as:

> Dependencies are inherently bad.

The policy is:

> Understand and use Rust and the web platform first. Add a dependency only when its value clearly outweighs the additional complexity and maintenance surface.

If a future task appears to require an external dependency, document why before introducing it.

---

# Architectural Boundary

The intended architecture is:

```text
Web Components
      ↓
Vanilla JavaScript
      ↓
Household event stream
      ↓
Rust / WebAssembly
      ↓
Derived household state
      ↓
Web Components
```

Keep responsibilities clear.

---

# JavaScript / Browser Responsibilities

Browser-side JavaScript owns:

- DOM access
- Web Components
- rendering
- user interaction
- browser lifecycle
- IndexedDB
- WebAuthn
- Web Crypto
- networking
- browser accessibility behaviors
- loading WebAssembly

Rust should not manipulate the DOM.

---

# Rust / WASM Responsibilities

Rust owns deterministic domain logic such as:

- household events
- event validation
- state transitions
- state reconstruction
- recurrence
- diffing
- event replay
- synchronization reconciliation
- local search/indexing where appropriate

JavaScript should not duplicate authoritative household-state logic merely because doing so is easier.

---

# Rust Must Have a Real Job

Do not add Rust simply because Kin is intended to use Rust.

When Rust code is introduced, it should own meaningful domain logic.

Bad justification:

> Use Rust because this is a Rust/WASM project.

Good justification:

> Rust deterministically reconstructs household state from an event stream and can later reuse the same logic for synchronization and conflict resolution.

---

# WebAssembly Direction

The initial planned compilation target is:

```text
wasm32-unknown-unknown
```

The project intends to explore a manual JavaScript ↔ WASM boundary instead of immediately using convenience bindings.

A future ABI may resemble:

```text
alloc(size)
dealloc(ptr, size)
apply_events(ptr, len)
result_ptr()
result_len()
```

These names are illustrative until implementation begins.

When implementing the ABI:

- document memory ownership
- document buffer lifetime
- isolate unsafe Rust
- avoid leaks
- avoid undocumented shared state
- expose a clean high-level JavaScript API over raw pointers

---

# Event-Oriented Architecture

Kin should be modeled around events rather than only mutable UI state.

Prefer:

```text
09:13 ITEM_ADDED "Buy milk"
11:42 ITEM_COMPLETED item-12
```

over treating this as the authoritative record:

```text
milk.completed = true
```

A conceptual event may include:

```text
Event
├── event_id
├── household_id
├── actor_id
├── device_id
├── timestamp
├── logical_time
├── kind
├── event_version
└── payload
```

Possible future event types include:

```text
ITEM_ADDED
ITEM_COMPLETED
ITEM_REOPENED
ITEM_ARCHIVED

HANDOFF_ADDED
HANDOFF_ACKNOWLEDGED
HANDOFF_ARCHIVED

TALK_ADDED
TALK_RESOLVED
TALK_REOPENED
TALK_ARCHIVED

PULSE_SET
PULSE_CLEARED

ROUTINE_CREATED
ROUTINE_OCCURRENCE_COMPLETED
ROUTINE_OCCURRENCE_REOPENED
ROUTINE_ARCHIVED

AGREEMENT_CREATED
AGREEMENT_REVISED
AGREEMENT_ARCHIVED
```

Do not implement event types before they are needed.

---

# Why Events Matter

The event model is intended to support:

- deterministic replay
- local persistence
- Since You Last Looked
- household history
- offline usage
- multiple devices
- synchronization
- conflict reconciliation
- recurring household behaviors

The event log should be treated as meaningful architecture, not unnecessary ceremony.

---

# Local-First Direction

Kin should begin local-first.

The expected early architecture is:

```text
Browser
   ↓
IndexedDB
   ↓
event stream
   ↓
Rust/WASM
   ↓
derived state
```

The application should remain useful without a server whenever practical.

---

# Future Multi-Device Direction

Kin will eventually need synchronization so two adults can use it from separate devices.

The planned direction is approximately:

```text
Parent A device
      │
      ├── passkey
      ├── household encryption key
      │
      ▼
encrypted household events
      │
      ▼
sync service
      │
      ▼
encrypted household events
      │
      ▼
Parent B device
```

The sync service should know as little about household content as reasonably possible.

Do not implement this architecture until its roadmap phase.

---

# Authentication Direction

Do not default to traditional email/password authentication.

The planned household identity direction is:

- create household
- invite partner
- QR code or short-lived pairing code
- trusted device
- passkey / WebAuthn
- device revocation

From the user's perspective, normal authentication should eventually feel like:

```text
Open Kin
↓
Face ID / fingerprint / device PIN
↓
Today
```

Do not prematurely implement authentication during local-only phases.

---

# Privacy Principles

Kin may contain highly personal household information.

Treat privacy as architecture, not marketing.

The long-term design should favor:

- local-first storage
- minimal server knowledge
- encrypted sync
- explicit trusted devices
- revocable access
- deliberate exports
- clear deletion
- no advertising
- no sale of household information
- no household-content analytics
- no unnecessary telemetry

Do not send household text to external AI systems by default.

---

# AI Policy

AI-assisted development may be used for:

- planning
- architecture exploration
- documentation
- coding assistance
- debugging
- testing support

Kin itself should not require an AI runtime merely because AI tools helped build it.

Do not implement features where AI:

- judges a relationship
- declares one partner correct
- diagnoses a partner
- assigns blame
- scores conflict
- interprets private household communication without explicit consent

If AI features are considered later, they must be optional and privacy-conscious.

---

# ZTM AI Disclosure

The ZTM Build Fest README requires disclosure of how AI was used.

Keep Kin's README accurate.

A suitable direction is:

> AI-assisted development tools were used for brainstorming, product planning, architecture exploration, documentation, debugging, and implementation support. Kin itself does not depend on an AI runtime, and household data is not sent to an AI service by default.

Update this wording if the actual project behavior changes.

---

# Accessibility

Accessibility is a baseline requirement.

Do not postpone it to a final cleanup phase.

When UI development begins:

- use semantic HTML first
- use native controls where possible
- provide labels
- preserve keyboard operation
- maintain visible focus
- maintain logical headings
- use sufficient contrast
- support zoom
- support narrow screens
- respect reduced motion
- avoid unnecessary ARIA
- test custom elements carefully

Prefer:

```html
<button>
  <input />
  <label> <form></form></label>
</button>
```

over recreating native controls.

---

# Web Components

Kin uses native Custom Elements rather than a component framework.

Possible future components may include:

```html
<kin-app>
  <kin-today>
    <kin-item>
      <kin-compose>
        <kin-handoff>
          <kin-talk>
            <kin-pulse></kin-pulse></kin-talk></kin-handoff></kin-compose></kin-item></kin-today
></kin-app>
```

Do not create a component solely to increase modularity.

A component should have a meaningful responsibility.

Use Shadow DOM where isolation provides value.

---

# Mobile-First UX

Kin is likely to be used most frequently on phones.

Design for:

- one-handed use
- large touch targets
- short forms
- low cognitive load
- quick entry
- interrupted interactions
- small screens
- tired users

Desktop support still matters, but mobile usability should be considered early.

---

# Security

Treat all household-entered content as untrusted input.

Do not render user-controlled text using unsafe HTML injection.

Prefer:

```js
element.textContent = value;
```

or explicit DOM construction.

Do not use:

- `eval`
- dynamically generated executable JavaScript
- unsafe HTML generated from household text

Future sync and authentication code should receive security review proportional to its sensitivity.

---

# Documentation Is Part of the Product

Keep documentation current as architecture changes.

Important documents may include:

```text
README.md
AGENTS.md
LICENSE
CONTRIBUTING.md
CODE_OF_CONDUCT.md
SECURITY.md
SUPPORT.md

.github/
├── ISSUE_TEMPLATE/
│   ├── bug_report.yml
│   └── feature_request.yml
└── pull_request_template.md

docs/
├── PRODUCT.md
├── PRINCIPLES.md
├── ARCHITECTURE.md
├── DATA-MODEL.md
├── PRIVACY.md
├── UX.md
├── ROADMAP.md
├── DOMAIN.md
├── EVENTS.md
├── STATE.md
├── LIFECYCLES.md
├── IDENTITY.md
├── PAIRING.md
├── SYNC.md
├── CRYPTOGRAPHY.md
├── THREAT-MODEL.md
├── IMPLEMENTATION.md
├── ABI.md
├── STORAGE.md
├── COMPONENTS.md
├── TESTING.md
├── ACCESSIBILITY.md
├── VERSIONING.md
├── MIGRATIONS.md
├── PORTABILITY.md
├── RETENTION.md
├── CONTRIBUTING.md
├── DEVELOPMENT.md
├── CODE-STYLE.md
├── RELEASES.md
├── DEBUGGING.md
├── GITHUB-COMMUNITY.md
├── PREFLIGHT.md
├── TRACEABILITY.md
├── TEST-VECTORS.md
├── V0.1.0.md
└── decisions/
      └── numbered accepted decision records
```

Do not allow implementation to drift significantly away from documentation without updating the relevant document.

---

# README Requirements

The Kin README must always accurately communicate:

- what problem Kin solves
- current project status
- current implemented features
- planned features
- installation/build instructions when applicable
- running instructions when applicable
- AI usage
- privacy posture
- license

Do not describe planned features as already implemented.

---

# Versioning

Use semantic versioning deliberately.

The intended early roadmap is:

```text
v0.0.1 — Product definition
v0.0.2 — Architecture and privacy
v0.0.3 — UX and implementation planning
v0.0.4 — Household Domain Specification
v0.0.5 — Trust, Identity, and Synchronization Design
v0.0.6 — Implementation Contract
v0.0.7 — Data Durability & Evolution
v0.0.8 — Developer & Contributor Experience
v0.0.9 — Implementation Preflight
v0.0.10 — GitHub Community & Project Documentation
v0.0.11 — Implementation Cycle Handoff
v0.0.12 — Changelog & Release History

v0.1.0 — Household Heartbeat
v0.2.0 — Today + Needs
v0.3.0 — Handoff
v0.4.0 — Talk
v0.5.0 — Pulse
v0.6.0 — Since You Last Looked
v0.7.0 — Routines
v0.8.0 — Household Pairing
v0.9.0 — Encrypted Sync
v0.9.3 — Encrypted Event Sync Stabilization
v0.10.x — Portable Core + Local Security
v0.11.x — Durable Service & Deployment (implementation candidate; awaiting human review)
v0.12.x — Data Lifecycle, Retention & Deletion (planned)
v0.13.x — Recovery & Household Continuity (planned)
v0.14.x — UX/UI Consolidation (planned)
v0.15.x — Household Areas (planned)
v0.16.x — Household Notes & Reference Context (planned)
v0.17.x–v0.40.x — Incremental household capabilities, portability and device migration (October targets)
v0.41.x–v0.45.x — Recovery drills, platform validation, performance and release-candidate readiness (undated follow-ups)
v1.0.0 — Stable Kin Platform (planned, readiness-driven)
```

This roadmap may evolve.

Do not implement a future version merely because its concept appears in documentation.

Follow the task's requested release scope.

## Release cadence

Use semantic `MAJOR.MINOR.PATCH` versions. Every minor release introduces a new product capability; a patch release does not introduce a new product capability.

For each approved minor capability, use this stabilization pattern when meaningful work exists:

```text
v0.N.0 — new product capability
v0.N.1 — correctness
v0.N.2 — resilience and accessibility
v0.N.3 — hardening and polish
```

After `.3`, stop and ask the user whether the minor release line is satisfactory before starting another feature. Additional fixes remain ordinary patch releases (`.4`, `.5`, and onward); never use four-part versions. Do not manufacture patches when there is no meaningful stabilization work. Each completed version receives its own annotated `kin-vX.Y.Z` tag on its validated release commit.

---

# Git Tagging and Version Milestones

Kin uses namespaced Git tags because it lives inside the multi-project ZTM Build Fest repository. Tag every completed Kin version, including planning, documentation, implementation, patch, and other milestone releases.

Use the `kin-` prefix for every tag. Names listed for releases after the current
implementation are guidance only, not evidence that a tag exists. Verify before
reporting a release; a roadmap-only task creates no tags.

```text
kin-v0.0.1
kin-v0.0.2
kin-v0.0.3
kin-v0.0.4
kin-v0.0.5
kin-v0.0.6
kin-v0.0.7
kin-v0.0.8
kin-v0.0.9
kin-v0.0.10
kin-v0.0.11
kin-v0.0.12
kin-v0.1.0
kin-v0.1.1
kin-v0.1.2
kin-v0.1.3
kin-v0.1.4
kin-v0.1.5
kin-v0.2.0
kin-v0.2.1
kin-v0.2.2
kin-v0.2.3
kin-v0.2.4
kin-v0.3.0
kin-v0.3.1
kin-v0.3.2
kin-v0.3.3
kin-v0.3.4
kin-v0.3.5
kin-v0.4.0
kin-v0.4.1
kin-v0.4.2
kin-v0.4.3
kin-v0.5.0
kin-v0.5.1
kin-v0.5.2
kin-v0.5.3
kin-v0.6.0
kin-v0.6.1
kin-v0.6.2
kin-v0.6.3
kin-v0.7.0
kin-v0.7.1
kin-v0.7.2
kin-v0.7.3
kin-v0.7.4
kin-v0.8.0
kin-v0.8.1
kin-v0.8.2
kin-v0.8.3
kin-v0.8.4
kin-v0.8.5
kin-v0.8.6
kin-v0.8.7
kin-v0.8.8
kin-v0.9.0
kin-v0.9.1
kin-v0.9.2
kin-v0.9.3
kin-v0.10.0
kin-v0.10.1
kin-v0.10.2
kin-v0.10.3
kin-v0.11.0
kin-v0.12.0
kin-v0.13.0
kin-v0.14.0
kin-v1.0.0
```

Never use ambiguous repository-wide tags such as `v0.0.1` or `v1.0.0`.

## Release sequence

Create a tag only after the release is complete and validated:

1. Complete the release scope and update its documentation.
2. Run checks appropriate to that release and inspect Git status and diff.
3. Commit the final release state and verify the working tree is clean.
4. Create an annotated `kin-vX.Y.Z` tag on that exact commit.
5. Push the commit and, when authorized, push the specific tag.

Do not tag a version at the beginning of its work. Annotated tags are required for formal releases, with concise, descriptive messages such as:

```text
Kin v0.0.4 — Household Domain Specification
Kin v0.1.0 — Household Heartbeat
```

Planning releases are real milestones and must be tagged. A version tag must point to the commit representing that version's completed state, so release snapshots can be compared in Git history.

## Tag integrity and version order

Treat a pushed tag as immutable. Never move, force-update, casually delete, or reuse a published tag. Correct a released mistake in a new commit and issue a patch version instead.

Before beginning a new version, verify the previous completed version has its matching `kin-vX.Y.Z` tag. If historical tags need repair, do so only when the task explicitly requests it. Keep the version in project documentation, release commit history, and tag history consistent.

## Release verification and reporting

A release is complete only when its scope and appropriate checks pass, its final commit exists, and the correct annotated Kin tag points to that commit. Verify whether the commit and tag were pushed; never claim a push that did not happen. Do not push unless the task authorizes it. If a push is not authorized, report the exact command needed.

Report each completed milestone with:

```text
Version: kin-vX.Y.Z
Release commit: <commit hash>
Tag: kin-vX.Y.Z
Tag status: created / pushed / requires user action
```

When manual publication is required, provide the specific command:

```text
git push origin kin-vX.Y.Z
```

---

# Scope Discipline

Do not "helpfully" implement future roadmap items during an earlier milestone.

For example:

When working on `v0.1.0`, do not also add:

- Handoff
- Talk
- Pulse
- passkeys
- sync
- encryption
- notifications

unless the task explicitly expands scope.

A small, complete milestone is preferable to an oversized incomplete release.

---

# Tests

Once implementation begins, every meaningful Rust domain behavior should have tests.

Prioritize tests for:

- deterministic state reconstruction
- event validation
- event replay
- invalid event handling
- recurrence
- diff behavior
- sync reconciliation

Browser functionality should also receive lightweight testing without automatically introducing a JavaScript test framework.

Prefer platform-native testing approaches where practical.

---

# Determinism

Given the same valid event stream, Kin's Rust engine should derive the same household state.

Determinism is a core property because future synchronization and diffing depend on it.

Avoid hidden state that makes event replay unpredictable.

---

# Error Handling

Do not silently ignore unexpected failures.

Errors should be:

- deterministic
- actionable
- appropriately surfaced
- safe for users

Examples include:

- malformed persisted event
- unknown event type
- invalid item reference
- corrupted WASM protocol data
- IndexedDB failure
- WASM initialization failure
- synchronization conflict

Do not expose sensitive internal information unnecessarily.

---

# Code Quality

Prefer:

- small focused modules
- explicit data flow
- descriptive names
- simple APIs
- documented invariants
- clear ownership
- minimal global state
- deterministic behavior

Avoid:

- giant files
- premature abstraction
- metaprogramming for its own sake
- duplicated state logic
- hidden mutation
- unnecessary unsafe Rust
- dependency-heavy convenience solutions

If unsafe Rust is required, isolate it narrowly and document why it is safe.

---

# Comments

Use comments to explain:

- invariants
- non-obvious decisions
- memory safety requirements
- protocol formats
- security considerations
- architectural tradeoffs

Do not add comments that merely restate the code.

---

# Git Discipline

Before completing any task:

1. inspect `git status`
2. inspect `git diff`
3. verify all changes belong to Kin
4. verify no unrelated ZTM files were modified
5. verify generated artifacts that should not be committed are ignored
6. verify documentation matches implementation
7. verify current version scope was respected

Never modify another Build Fest participant's project.

---

# Release Discipline

Do not claim a release is complete merely because code was written.

Before a coded release is considered complete:

- build it
- run tests
- manually exercise the primary flow
- check browser console
- inspect network behavior
- verify persistence where relevant
- check mobile layout
- verify accessibility basics
- review Git diff
- update documentation

A release should represent a functioning milestone.

---

# Planning Release Rule

Releases `v0.0.1` through `v0.0.12` are planning/documentation milestones only. `v0.1.0` is the first implementation release. Do not add functional application code while completing a planning release.

# DO NOT WRITE FUNCTIONAL APPLICATION CODE.

During `v0.0.1` through `v0.0.12`, acceptable changes include:

- Markdown documentation
- diagrams
- pseudocode
- architecture decisions
- UX flows
- domain, event, state, and lifecycle specifications
- identity, pairing, synchronization, cryptography, and threat-model documents
- implementation, ABI, storage, component, test, and accessibility contracts
- migration, portability, retention, contributor, development, style, release, debugging, and preflight specifications
- GitHub community policies and project-scoped issue/pull-request templates
- roadmap changes
- README
- license
- this AGENTS.md file

Do not create functioning:

- Rust modules
- WASM
- Web Components
- JavaScript application logic
- IndexedDB storage
- authentication
- backend services
- build tooling

---

# Agent Completion Format

When completing meaningful work, summarize:

## What changed

Concise description.

## Files changed

List meaningful Kin files.

## Decisions made

Document architectural or product decisions introduced.

## Validation

Explain what was checked.

## Deferred

Identify intentionally deferred work.

## Repository boundary

Confirm:

> All changes are confined to `projects/kin/`.

When still in the planning releases, also confirm:

> No functional Kin application code was introduced.

---

# When Requirements Conflict

Priority order:

1. safety and security
2. explicit task instructions
3. ZTM repository contribution requirements
4. this `AGENTS.md`
5. documented Kin architecture
6. convenience

If an explicit task intentionally changes an architectural decision, update the relevant documentation rather than silently diverging from it.

---

# Guiding Principle

Kin should make family life require **less remembering, less repeating, and less unnecessary friction**.

If a proposed feature makes Kin harder to use than simply sending a text message, reconsider it.

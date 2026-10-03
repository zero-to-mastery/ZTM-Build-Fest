# Contributing to Kin

Thanks for considering a contribution. Kin is an open-source project for lightweight household coordination. The current implementation is the local-first Today, Needs, and Handoff prototype; contributions should follow the frozen v0.3.0 contract and approved stabilization scope and preserve the project's privacy, accessibility, and repository-boundary requirements.

## Project purpose

Kin aims to make the household context people need to remember, hand off, or discuss easier to share. It should reduce friction, not judge family members or become another project-management system. The guiding feature question is: would a tired parent holding a child actually use this?

## Repository boundary

Kin lives inside the ZTM Build Fest monorepo at `projects/kin/`. Treat that directory as the Kin project root. Keep every Kin-specific change inside it; do not modify the parent README, repository configuration, or another participant's project. GitHub only discovers community files and issue/PR templates at the host repository root, so the nested Kin templates are reference files until Kin is extracted. Do not move them into the parent root.

## How to contribute

Small, focused changes are easiest to review. For a large feature or architectural change, open an issue or discussion first and explain the user problem, scope, trade-offs, privacy/accessibility impact, and release target. Update the relevant documentation alongside any architectural change. Patch releases must not introduce a new product capability, and the next minor feature requires explicit user approval.

Read the [Code of Conduct](CODE_OF_CONDUCT.md), [Security Policy](SECURITY.md), and [Support](SUPPORT.md). Before proposing a feature, ask:

- Would a tired parent holding a child actually use it?
- Does it simplify household coordination, or turn Kin into project management?
- Does it respect Kin's non-goals: no blame, relationship scoring, competition, or surveillance?

## Architecture and dependencies

Rust owns authoritative household events, validation, and derived state. JavaScript and browser APIs own the DOM, Web Components, storage, accessibility interactions, and networking when a future release introduces it. Rust must not manipulate the DOM; JavaScript must not duplicate the Rust reducer.

Prefer browser standards and the Rust standard library. A dependency needs a specific requirement, a meaningful benefit, an update/security plan, and an explanation of why a platform-native option is insufficient. Do not add a framework or runtime dependency for convenience alone.

## Privacy and security

Do not introduce household-content analytics, hidden telemetry, third-party tracking, plaintext remote synchronization, or external AI processing of household content by default. Treat household text and imported data as untrusted input; render it as text, never executable markup.

Changes touching WebAuthn, Web Crypto, synchronization, device authorization, key handling, HTML rendering, migration, or imported household data require extra scrutiny. Do not make claims of encryption, anonymity, deletion, or security beyond what has actually been implemented and reviewed.

## Accessibility

Accessibility is a baseline, not a polish task. Preserve semantic HTML, keyboard access, visible focus, mobile reflow, reduced-motion preferences, and clear labels/status feedback. See [the accessibility contract](docs/ACCESSIBILITY.md).

## Implementation stage

Planning through v0.0.12 was documentation/community-readiness work. The first functional implementation is v0.1.0 and follows its frozen contract. Read [AGENTS.md](AGENTS.md), [the changelog](CHANGELOG.md), and the current release documents before changing scope; later-version capabilities do not belong in the v0.1.x Household Heartbeat line.

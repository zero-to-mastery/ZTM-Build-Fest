# Constellation Agent & Maintainer Kit

This bundle is a project-operating guide for humans and coding agents working on **Constellation**.

## North star

> **The AI describes the universe; Rust builds the universe; the Web presents the universe.**

Constellation should remain a browser-native visualization platform whose semantic and computational core is increasingly expressed in Rust/WASM where Rust provides a real advantage: validation, domain modeling, deterministic graph compilation, persistent graph state, spatial algorithms, and correctness.

AI is an **optional authoring surface**, not the architecture.

## Read in this order

1. `AGENTS.md`
2. `docs/PROJECT-PRINCIPLES.md`
3. `docs/architecture/ARCHITECTURE.md`
4. `docs/architecture/RUST-WASM-BOUNDARY.md`
5. `docs/ai/AI-CONSTELLATION-SPEC.md`
6. `docs/ai/AI-IMPLEMENTATION-PLAYBOOK.md`
7. `docs/engineering/TESTING-AND-QUALITY.md`
8. `docs/engineering/SECURITY-AND-TRUST.md`
9. `docs/architecture/decisions/ADR-TEMPLATE.md`

## Current assumptions

Prepared against `mnichols08/constellation` as observed on 2026-10-03:

- v3 uses the bundled Rust/WASM engine.
- `@constellation/core` targets Node 22+ and browsers with WebAssembly.
- core has no runtime npm dependencies.
- `<constellation-view>` is framework-free and uses Shadow DOM.
- static SVG remains a first-class/default output.
- GitHub acquisition is separable from rendering/computation.
- public contracts are versioned.
- developer topology/profile output is evidence-oriented, not a job-title or ability judgment.

Update this kit when those assumptions change.

This is not a mandate to rewrite JavaScript in Rust. The objective is to make Rust **meaningful**, not merely prominent in a language chart.

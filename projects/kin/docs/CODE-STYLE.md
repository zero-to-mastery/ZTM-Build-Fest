# Code Style Contract

**Status:** Current through v0.7.4 Routine Stale-Action Correctness; conventions for the current implementation. Follow repository/tool defaults where they preserve clarity; this document is guidance, not a formatter configuration.

## Rust

Prefer:

- Descriptive domain types for event IDs, item IDs, event kinds, and validated payloads.
- Deterministic functions with explicit inputs and outputs.
- Explicit, stable error categories and actionable non-sensitive messages.
- Small modules with clear ownership boundaries.
- Standard library types and APIs before third-party crates.
- Minimal, narrowly isolated `unsafe`; document invariants and why each unsafe block is sound.
- Documented invariants for event replay, version decoding, and ABI memory ownership.

Avoid primitive soup, unnecessary generic abstractions, hidden mutation, nondeterministic map iteration in serialized state, cleverness over clarity, DOM/browser assumptions, and convenience dependencies without justification.

## JavaScript

Prefer:

- ES modules and `const` by default; use `let` only for reassignment.
- Native browser APIs and native Custom Elements.
- Explicit command flows with `CustomEvent` where components communicate.
- Safe DOM construction and text APIs for household/user-controlled content.
- Small browser adapters around Rust/WASM and IndexedDB.
- Clear handling of asynchronous storage, module loading, and error states.

Avoid global mutable business state, unsafe `innerHTML`, `eval`, framework-like abstractions built for their own sake, custom event-bus dependencies, and duplicate household reducers in JavaScript.

## CSS

Prefer mobile-first layouts, semantic class names, useful custom properties, responsive sizing, visible focus, sufficient contrast, and reduced-motion support. Keep component dimensions stable and support zoom/reflow. Do not require a CSS framework or encode meaning through color alone.

## Documentation maintenance

Update the relevant specification when event semantics, version compatibility, storage, ABI/protocol, privacy/security, accessibility, or release scope changes. Separate implemented behavior from planned and specified behavior. Architectural decisions should have an accepted ADR once the preflight set is created.

Status lines use the latest release reviewed, currently v0.7.4, rather than the release that last changed the contract. Historical release sections retain their original versions and evidence; future-design labels and ADR acceptance remain explicit. A current status does not imply new implementation or new validation.

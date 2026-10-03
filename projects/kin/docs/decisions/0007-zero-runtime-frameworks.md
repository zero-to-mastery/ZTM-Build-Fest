# ADR 0007 — Zero Runtime Frameworks by Default

Status: Current through v0.7.4 Routine Stale-Action Correctness; Accepted

## Context

The v0.1.0 product loop is intentionally small, and the project wants to understand Rust and modern browser capabilities before adopting dependencies.

## Decision

Use Rust, WebAssembly, HTML, CSS, vanilla JavaScript, Web Components, and browser APIs by default. Do not add a framework/runtime or convenience WASM dependency without a concrete requirement and documented trade-off.

## Alternatives Considered

Adopt a common frontend framework, bundler, serialization crate, or WASM binding immediately.

## Consequences

The runtime dependency surface stays small and the platform boundary remains explicit. Kin may need to implement some integration code itself; dependency choices can be revisited with evidence and a security/update plan.

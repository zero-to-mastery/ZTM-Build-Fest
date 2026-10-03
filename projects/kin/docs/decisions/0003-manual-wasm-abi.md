# ADR 0003 — Manual JavaScript/WASM ABI

Status: Current through v0.7.4 Routine Stale-Action Correctness; Accepted

## Context

The planned Rust domain engine must communicate with browser-owned JavaScript without giving Rust DOM or browser responsibilities. Convenience bindings would obscure the boundary while the initial interface is still small.

## Decision

Target `wasm32-unknown-unknown` and begin with a small explicit, versioned C-compatible ABI. JavaScript owns allocation/copying and browser integration; Rust validates bounded input and returns explicit result/error buffers.

## Alternatives Considered

Keep all domain logic in JavaScript, or adopt convenience bindings before their need is demonstrated.

## Consequences

Ownership, bounds, encodings, status codes, and protocol versions are visible and testable. The bridge is more manual and must be carefully reviewed. Revisit bindings only if a concrete requirement outweighs their cost.

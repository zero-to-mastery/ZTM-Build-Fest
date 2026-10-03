# ADR 0002 — Rust Owns Domain Logic

Status: Current through v0.7.4 Routine Stale-Action Correctness; Accepted

## Context

Kin needs one authoritative implementation of event validation, state transitions, and replay. Duplicating those rules in the browser would allow UI state and domain state to diverge.

## Decision

Rust/WASM owns deterministic domain validation and derived household state. JavaScript owns browser APIs, DOM, storage, lifecycle, and rendering; Rust does not manipulate the DOM.

## Alternatives Considered

Implement the reducer in JavaScript only, or maintain parallel Rust and JavaScript reducers.

## Consequences

The domain engine can be tested independently and has a single authority, while browser integration must cross a versioned ABI and handle its errors and memory ownership correctly.

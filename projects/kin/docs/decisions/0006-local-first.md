# ADR 0006 — Local-First Foundation

Status: Current through v0.7.4 Routine Stale-Action Correctness; Accepted

## Context

Household data is sensitive, and the first useful Kin loop should not depend on a remote service or account.

## Decision

Begin with local event persistence in IndexedDB and local Rust/WASM reconstruction. Remote sync, pairing, authentication, and encryption are later design/implementation concerns, not v0.1.0 features.

## Alternatives Considered

Make a server authoritative from the first release or require accounts before local use.

## Consequences

The initial prototype avoids sending household content to a service and can work offline, but does not provide cross-device sync, backup, or automatic recovery. Those capabilities require separate reviewed protocols.

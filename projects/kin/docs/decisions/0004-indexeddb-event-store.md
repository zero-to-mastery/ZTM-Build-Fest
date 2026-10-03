# ADR 0004 — IndexedDB Event Store

Status: Current through v0.7.4 Routine Stale-Action Correctness; Accepted

## Context

The first coded milestone should work without a backend and reconstruct household state after browser reload.

## Decision

Use browser-local IndexedDB to persist the ordered event log. Rust derives household state from that log; do not persist a second authoritative mutable state.

## Alternatives Considered

Require a server, use only transient memory/local storage, or persist a mutable item projection as the source of truth.

## Consequences

The prototype is locally useful and reloadable, but local data is tied to browser storage and remains subject to device compromise, quotas, schema evolution, and data-loss risk. Portability and non-destructive migrations are specified separately.

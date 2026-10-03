# ADR 0001 — Event-Sourced Household State

Status: Current through v0.7.4 Routine Stale-Action Correctness; Accepted

## Context

Kin must reconstruct household context after reload and may later need history, offline changes, and change summaries. A mutable UI snapshot alone cannot explain how a state was reached.

## Decision

Treat an append-oriented, immutable household event stream as the domain history. Derive current state by deterministic replay. Corrections are subsequent events, not edits to persisted history.

## Alternatives Considered

Persist only a mutable household snapshot; retain events only as optional audit metadata.

## Consequences

Replay and history are explicit and testable, but event schemas, storage growth, compatibility, and deletion require deliberate policy. Snapshots remain derived and disposable unless a later decision specifies otherwise.

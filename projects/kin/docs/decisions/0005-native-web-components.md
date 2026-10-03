# ADR 0005 — Native Web Components

Status: Current through v0.7.4 Routine Stale-Action Correctness; Accepted

## Context

Kin needs a small browser UI and should keep its technical foundation understandable without adopting a component runtime for a narrow initial flow.

## Decision

Use native Custom Elements/Web Components with semantic HTML and browser-native events. Components present state and dispatch user intent; they do not own the authoritative household reducer.

## Alternatives Considered

Adopt a UI framework or build a custom component/event runtime.

## Consequences

The initial UI uses platform capabilities and keeps dependencies low. Component boundaries, shadow-DOM behavior, accessibility, and browser support still need explicit testing.

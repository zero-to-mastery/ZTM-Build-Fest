# ADR-0001: AI Produces Semantic Intent; Rust Compiles It

- Status: Proposed
- Date: 2026-10-03

## Context

Natural-language authoring is useful, but exposing low-level scene/layout internals to a model creates a fragile contract and weakens deterministic computation.

## Decision

Introduce a versioned semantic `ConstellationSpec`.

AI may author/revise it through provider-neutral tools. Rust/WASM validates, normalizes, resolves, and compiles the spec before a scene may be applied.

The model cannot execute arbitrary code or mutate graph state directly.

## Why this layer?

Semantic compilation belongs in Rust because it establishes invariants, handles untrusted input, benefits from enums/newtypes, must be deterministic, is useful without AI, and feeds the existing Rust/WASM engine.

Provider communication remains JavaScript because it is replaceable network/platform integration.

## Alternatives

### Model emits concrete coordinates
Rejected as the primary contract because it couples the model to renderer/layout internals and weakens reproducibility.

### Model calls many imperative mutation tools
Rejected as the primary interface because validation/rollback becomes harder and hidden mutable state expands.

### Model emits semantic intent
Chosen because it is inspectable, versionable, testable, provider-neutral, and useful to non-AI clients.

## Compatibility

Additive initially. Existing configs/scenes continue to work.

## Security

All model output is untrusted and bounded. No mutation before validation. Repair attempts are limited.

## Testing

Schema round-trip, adversarial specs, deterministic compilation, fake tool flows, and preview/apply/cancel browser behavior.

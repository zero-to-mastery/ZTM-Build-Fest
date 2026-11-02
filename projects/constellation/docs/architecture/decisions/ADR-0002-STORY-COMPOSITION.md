# ADR-0002: Evidence-Ranked Story Composition

- Status: Accepted
- Date: 2026-10-10

## Context

Developer Semantic Graph v1 already records repository languages, topics,
authored project families, and explicit project relationships. Story candidates
currently project those records into bounded scenes, while the SVG renderer
draws connection geometry. A deterministic selection policy is needed so a
static story can show a useful, explainable subset of factual project links.

## Decision

Add an internal Rust Story Composition v1 operation that accepts bounded
project facts and existing explicit relationships. It returns deterministic,
evidence-referenced relationship records and suppression diagnostics. It does
not alter Semantic Graph v1, Scene v1, or Config v7.

The existing JS story-candidate layer remains responsible for producing the
three named candidate views and for passing their project subset into Rust.
JavaScript keeps provider access and orchestration; SVG remains responsible for
accessible static presentation. Rust does not measure browser text or mutate
manual geometry.

## Compatibility

This is an internal additive WASM operation. Existing scene generation,
user-authored positions and styling, and non-AI workflows remain supported.

## Testing

Native Rust and JS/WASM tests cover evidence correctness, limits, stable IDs,
input-order invariance, edge budgets, and parity between selected semantic
relationships and candidate-scene connections.

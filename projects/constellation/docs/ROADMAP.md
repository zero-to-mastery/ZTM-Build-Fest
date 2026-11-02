# Roadmap Guardrails

## Horizon A — Semantic core

- versioned ConstellationSpec;
- structured diagnostics;
- raw -> validated Rust conversion;
- explainable group/filter resolution;
- JSON Schema and fixtures.

## Horizon B — Stateful Rust

- persistent engine;
- typed node/repository IDs;
- retained adjacency;
- evidence indexes;
- explicit invalidation rules.

## Horizon C — Grounded, replaceable AI

- discovery tools;
- preview/validate/compile tools;
- provider-neutral JS adapter;
- fake provider;
- bounded repair.

## Horizon D — Studio authoring

- prompt entry;
- plan preview;
- Apply/Cancel;
- Undo;
- conversational revision;
- non-AI flows preserved.

## Horizon E — Computational Rust

Profile first, then consider shared spatial indexing, accelerated collision/refinement, Barnes-Hut repulsion, typed arrays, `f32`, Worker-hosted WASM, and SIMD.

## Horizon F — Semantic ecosystem

After the spec stabilizes: DSL, MCP, reusable recipes, local models, semantic diffs, explanation tools.

## Prioritization test

Prefer work that improves at least two of: user capability, correctness, explainability, performance, offline testability, architectural simplicity, or ecosystem extensibility.

Do not prioritize work merely because it increases Rust LOC or AI novelty.

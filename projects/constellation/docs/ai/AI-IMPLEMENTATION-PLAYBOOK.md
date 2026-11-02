# AI Implementation Playbook

## Phase 0 — Preserve baseline

- ensure core/package/browser tests pass;
- capture representative fixtures;
- record WASM/package size;
- record public API versions;
- keep an offline Rust/WASM fixture.

## Phase 1 — Semantic contract

Deliver versioned raw/validated spec types, Rust enums/newtypes, diagnostics, JSON Schema, and fixtures.

Do not integrate an AI provider yet.

## Phase 2 — Rust semantic compiler

Deliver group/filter resolution, relationship compilation, placement/layout intent compilation, and explainable evidence.

Same fixture + same spec should produce the same semantic result.

## Phase 3 — Persistent engine

Introduce an engine owning evidence, indexes, adjacency, spec state, and computed scene state. Keep compatibility wrappers where useful.

## Phase 4 — Provider-neutral tools

Expose discovery, preview, validate, and compile operations with bounded outputs.

## Phase 5 — JavaScript provider adapter

Use a small interface such as:

```ts
interface ConstellationModelAdapter {
  generate(request: ModelRequest, tools: ToolDefinition[]): Promise<ModelResult>;
}
```

Keep provider SDKs optional and outside Rust/core.

## Phase 6 — Bounded repair loop

Generate -> validate -> diagnostic -> optional repair -> revalidate -> stop at explicit limit.

## Phase 7 — Studio UX

Add prompt entry, semantic plan preview, Apply/Cancel, Undo, and conversational revision. Keep manual/guided flows.

## Phase 8 — Computational Rust improvements

Profile, then consider retained adjacency, evidence indexes, a shared spatial grid, accelerated collision/refinement, Barnes-Hut repulsion, typed-array hot paths, Worker-hosted WASM, `f32`, and SIMD.

## Phase 9 — Optional DSL/MCP

Only after the semantic contract stabilizes: textual DSL, MCP server, reusable recipes, local-model adapters, semantic diffs.

## PR sizing

Good PRs answer one architectural question.

Good:
- add raw/validated spec types;
- add diagnostics;
- add group preview;
- add retained adjacency;
- add fake model adapter;
- add Studio plan preview.

Bad:
- add AI, rewrite graph engine, change config version, migrate rendering, add workers, and redesign Studio in one PR.

## Epic completion signal

A user can load evidence, describe a constellation, let an optional model inspect bounded evidence, receive a spec, have Rust validate/compile it, inspect it, apply it, render through existing outputs, refine it, and reproduce the flow offline with a fake model.

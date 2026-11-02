# Architecture

## Dependency direction

```text
User prompt / UI
       |
       v
JS orchestration <----> optional AI provider
       |
       | semantic tools/spec
       v
Rust/WASM core
  - validated domain model
  - evidence indexes
  - semantic compiler
  - graph topology
  - layout/spatial engine
  - deterministic scene
       |
       v
Scene
  |                 |
  v                 v
static SVG/HTML   <constellation-view>
                  Shadow DOM + Web APIs
```

Source/GitHub acquisition stays outside the computational core.

## Ownership matrix

| Concern | Primary owner |
|---|---|
| Natural-language interpretation | AI adapter/model |
| AI provider SDK/network | JavaScript |
| GitHub acquisition | JavaScript/source adapters |
| Semantic schema | Rust-defined/versioned contract |
| Input validation | Rust |
| Evidence resolution | Rust |
| Graph topology/traversal | Rust |
| Layout/refinement | Rust |
| Persistent computational state | Rust |
| WASM bridge | wasm-bindgen/thin JS |
| Custom Element lifecycle | JavaScript |
| Accessibility semantics | HTML/Web Component |
| Presentation | SVG/CSS |
| Offline/service worker | Web platform |

## Contract layers

### Evidence layer
Observed or user-supplied facts: repository IDs/names, languages, topics, dates, roles, contribution/activity evidence.

### Semantic intent layer
`ConstellationSpec`: focus, groups, filters, relationships, clustering, ranking, placement intent, bounded style hints. No exact coordinates required.

### Compiled graph layer
Internal Rust representation: stable IDs, membership, edges, weights, constraints, adjacency, evidence references, layout inputs.

### Scene layer
Renderer-facing validated presentation data. Concrete coordinates belong here.

### Presentation layer
SVG/HTML/CSS/Web Component interaction.

## Acquisition vs computation

Given records/snapshot + config/spec, the Rust/core computation should work offline. This enables deterministic fixtures, CLI dry runs, browser use, alternate sources, and future local tools.

## Persistent engine direction

```rust
pub struct ConstellationEngine {
    evidence: EvidenceStore,
    graph: Graph,
    indexes: Indexes,
    current_spec: Option<ConstellationSpec>,
    current_scene: Option<Scene>,
}
```

Exact types may differ. The important rule is to reuse validated data and indexes across interactions.

## Compatibility strategy

When introducing a persistent engine:

1. add the engine;
2. implement new behavior there;
3. keep old free functions as wrappers;
4. migrate internal callers;
5. document deprecation intentionally;
6. remove compatibility only at a deliberate major boundary.

## Worker strategy

Prefer a Web Worker as the first concurrency boundary for expensive browser computation. Consider WASM threads/Rayon only after measurement justifies their deployment complexity.

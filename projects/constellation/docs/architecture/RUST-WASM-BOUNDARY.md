# Rust/WASM Boundary

## Goal

Increase Rust's architectural value, not merely its footprint.

## Move into Rust when

- logic has important invariants;
- input is untrusted;
- work is computationally expensive;
- persistent indexes/state reduce repeated work;
- deterministic behavior matters;
- domain types benefit from enums/newtypes;
- browser and Node need the same computation.

## Keep on the web side when

- work is DOM-centric;
- the browser already provides the abstraction;
- it is network/provider orchestration;
- moving it would only wrap JS APIs through `web-sys`;
- CSS/SVG solves it better.

## Prefer coarse boundaries

Good:

```text
JS -- spec/records/commands --> Rust engine
JS <-- scene/diagnostics/data -- Rust engine
```

Avoid chatty ping-pong calls.

## Serialization guidance

Use JSON/structured objects for config, specs, import/export, metadata, and debugging.

Consider typed arrays for hot bulk numeric data such as coordinates, edge pairs, and repeated scalar attributes.

Keep internal Rust memory layout private.

## Persistent state

Good retained state includes:

- adjacency;
- repository lookup;
- language/topic indexes;
- spatial grid/quadtree;
- current validated spec;
- prior layout positions;
- computed evidence.

Prefer explicit engine ownership over global/thread-local caches when practical.

## Spatial algorithms

Improve asymptotics before micro-optimizing arithmetic:

- retained adjacency instead of repeated edge scans;
- spatial partitioning for collisions/neighborhoods;
- Barnes-Hut or similar only if repulsion is a measured O(n^2) bottleneck;
- shared spatial infrastructure where useful.

## Numeric representation

`f32` may be enough for browser-scale geometry, but benchmark correctness, visual output, performance, and size before changing broadly.

## Concurrency progression

1. eliminate repeated work;
2. improve algorithms;
3. retain indexes/state;
4. reduce JS/WASM copies;
5. move heavy work to a Web Worker;
6. consider SIMD/threads when measurements justify them.

## ABI evolution

Prefer stable semantic package APIs over a stable low-level WASM ABI.

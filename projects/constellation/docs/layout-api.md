# Layout interface

`layoutScene(scene, options, context)` places scene nodes through the existing
engine. Nodes need stable `id` and repository-compatible `metadata` records.
The result contains `positions`, keyed by node ID, and the accompanying Rust
relationship result (`edges` with input-node indices and `total`). Returned
coordinates and edges are isolated from engine caches.

```js
import { createScene, layoutScene } from "@constellation/core";
const scene = createScene(
  "example",
  [{ full_name: "example/core", name: "core", language: "Rust" }],
  { referenceDate: "2026-09-01T00:00:00Z" },
);
const layout = layoutScene(scene, { arrangement: "galaxy" });
console.log(layout.positions["example/core"]);
```

Built-ins retain field, rings, orbital, force, profile, galaxy, solar-system and organization
arrangements. Developer Topology also returns inspectable profile evidence when
selected. The existing `nodeCap > 100` mode uses stable large-graph overview
coordinates. Existing artifact/organization adapters provide their coordinates to
the same Rust relationship engine; no Rust algorithms have been replaced by JS.

Context can supply an account, seed, reference timestamp, abort signal and the
pre-layout graph during compilation. Existing manual positions override generated
positions. Ring rotation, snapping, graph mode, selected relationship basis and
large-graph settings retain their current semantics. The compiler calls this
interface before refinement and scene serialization; SVG rendering does not
rerun layout. All supported layouts require the bundled WASM engine; the deprecated
non-WASM field fallback has been removed.

`layoutCapabilities(id, options)` reports the effective layout, requested layout,
maximum node count, manual-position, ring-snapping, deterministic-seed, animation,
refinement and WASM capabilities. Regular repository layouts support 100 nodes;
membership graphs support 256; stable overview supports 2,048. A node cap above
100 selects stable overview without changing the established compatibility rule.
Snapping metadata distinguishes initial layout snapping from editing/refinement.

`diagnoseLayout(scene, options, context)` returns capabilities and diagnostics.
Execution reports automatic overview selection and rejects unsupported graph sizes
or unavailable required WASM before computation. Metadata is returned as isolated
data. This remains the transitional 2.x contract; explicit host registration and
execution hardening precede the stable 3.0 contract.

## Trusted registration

```js
import { createPluginHost } from "@constellation/core";
const host = createPluginHost().registerLayout({
  id: "example-grid",
  apiVersion: 1,
  capabilities: {
    maxNodes: 100,
    manualPositioning: true,
    ringSnapping: false,
    deterministicSeed: true,
    animation: true,
    refinement: true,
  },
  layout(scene, options, context) {
    context.signal?.throwIfAborted();
    return Object.fromEntries(
      scene.nodes.map((node, i) => [
        node.id,
        {
          x: 80 + (i % 10) * 80,
          y: 50 + Math.floor(i / 10) * 40,
        },
      ]),
    );
  },
});
const scene = host.createScene("example", repositories, {
  layoutEngine: "example-grid",
});
```

Configs may select a registered `layoutEngine` and supply declarative
`layoutOptions`. They cannot name module URLs or execute code. Parsing validates
the reference shape; rendering requires registration in the trusted host. The CLI
and ordinary Studio do not automatically load external layouts.

`createLayoutHost()` also provides `register`, `describe`, `list` and `run` for
standalone embedding. Registries are per-host. Registered callbacks and capability
data are snapshotted, and callbacks receive isolated scene/options records plus
seed/reference/cancellation context. The callback synchronously returns exactly
one finite position per node; asynchronous layout work must be completed by the
host before synchronous scene rendering. Unsupported capabilities fail explicitly.

Rust constructs the relationship graph before the callback and recalculates its
geometry afterward. Manual positions override callback positions, and refinement
still uses Rust. The underlying Rust graph-size bounds also apply. This prepares
real extension boundaries for force/grid/radial packages without creating empty
packages or loading executable modules from config.

## Execution and caching

Signals are checked before layout, after diagnostics, before/after WASM, and after
trusted callbacks. Callbacks receive the signal and should check it during long
cooperative work. A synchronous WASM call cannot be interrupted mid-instruction;
hosts needing preemption should isolate computation in their own worker.

Deterministic registered layouts use an isolated, bounded per-host position cache
(8 entries and 4 MiB estimated bytes by default). `createLayoutHost` accepts
`maxEntries` and `maxBytes`; zero disables retention. Nondeterministic layouts and
non-JSON inputs are not cached. Results are cloned, failed/cancelled callbacks do
not populate the cache, and `clearCache` resets it. Plugin hosts expose
`layoutCacheStatistics` and clear layout caches with their other caches.

The top-level `layoutCacheStatistics()` reports the existing bounded engine caches
for scenes, projections, refinements and stable coordinates. These are shared
computational caches, not executable registries. `node scripts/benchmark-layout.mjs`
reports cold/warm built-in timings and cache counts for 100-node layouts and a
2,048-node stable overview. Tests cover cancellation, manual positions, returned
data mutation, large graphs, deterministic fixtures and external package usage.

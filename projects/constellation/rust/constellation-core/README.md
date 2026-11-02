# Constellation core

Shared Rust computation for the browser studio and Node.js generator. The prebuilt WebAssembly and generated bindings live in `src/wasm` at the repository root. See the root README for build commands.

Adapted from Mikey Nichols's public gists:

- Graph geometry, physics, traversal, and their original tests: https://gist.github.com/mnichols08/4f0dc93973ae00cabf76baa56bd78a4c
- Deterministic identity geometry and original tests: https://gist.github.com/mnichols08/e4a1080f19480abafa7f0249d16b0c3f
- Palette reference: https://mnix.dev/lab

`scene.rs` adds constellation layouts, language/topic intersections, balanced edge selection, and a spanning forest. Input is JSON containing already-filtered repositories in stable order; output contains positions, selected edges, primary-edge flags, and the total candidate count. Manual positions are applied after layout and before edge ranking. The force layout settles for a fixed 120 ticks; it never starts a browser animation loop. Dense graphs can still overlap, as documented by the source engine.

`profile_evidence.rs` owns the deterministic Developer Topology mappings, bounded Showcase role weights, normalized dimension scores, repository affinities and evidence reasons. `developer_profile` accepts only the already-loaded bounded snapshot; it performs no GitHub access. The `profile` scene arrangement uses those same affinities for placement and never changes graph edges. See `docs/developer-topology.md` for mappings and constraints.

`identity_geometry` preserves the gist's version-1 packed geometry format. The UI uses the account name or saved design seed and variation zero; this is a visual signature, not a security identifier. `identity_points` interleaves the four rings so each gets a point before any gets another. Additional capacity fills the widest gap on a least-populated ring, preserving coordinate prefixes through 256 nodes.

`projection.rs` groups the filtered public repository pool into language or topic nodes. `project_nodes` returns stable namespaced IDs, labels, and deduplicated repository memberships. It selects at most 100 categories by membership count, with deterministic label ordering for ties, and reports the full category count. `scene.rs` intersects these memberships when the connection basis is `repositories`, so category edges identify actual shared repositories. The UI retains colors and positions by node ID; they do not change graph membership.

`neighbors` and `shortest_path` receive only displayed real edges. Decorative bridges and rings cannot become graph relationships. Every returned Rust vector is copied and freed by wasm-bindgen; there are no persistent simulation handles for JavaScript to dispose.

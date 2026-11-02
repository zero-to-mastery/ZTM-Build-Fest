# Performance Budgets

Track what matters; avoid accidental regressions.

## Metrics

### Package
- core package size;
- Web Component entry size;
- raw `.wasm`;
- compressed `.wasm`.

The root build keeps `src/wasm/constellation_core_bg.wasm` as the Rust/WASM
build artifact and generates `src/wasm/inline.mjs` from that exact binary. The
Core package uses the inline artifact for both engine startup and standalone
HTML generation, so it does not ship a second raw copy of the same WASM bytes.
`node scripts/build-rust.mjs` regenerates both artifacts and
`node scripts/build-core.mjs` refreshes the package copy.

### Startup
- module import/init;
- WASM instantiation;
- first scene compute;
- first render.

### Computation
Use fixed fixtures such as 25, 100, 500, and upper-supported node counts.

Measure graph construction, semantic compile, layout, refinement, pathfinding, repeated neighbors, and group preview.

### Memory
Watch retained engine memory, duplicated JS/WASM copies, caches, scene copies, and spatial indexes.

## Optimization order

1. eliminate repeated work;
2. improve algorithmic complexity;
3. retain indexes/state;
4. reduce boundary copies;
5. move work off main thread;
6. tune numeric representation;
7. consider SIMD/threads.

Optimization PRs should include before/after measurements.

## Visual Storytelling composition baseline

Measured locally on Node.js 22.12.0 with the generated Rust/WASM engine, using
`scripts/benchmark-story-composition.mjs` (five iterations per size):

| Projects | v4.2 mean | v4.3 mean | Input | Output |
|---:|---:|---:|---:|---:|
| 6 | 0.214 ms | 0.211 ms | 1,048 B | 3,135 B |
| 12 | 0.697 ms | 0.609 ms | 1,932 B | 10,178 B |
| 128 | 33.613 ms | 34.527 ms | 16,371 B | 90,650 B |
| 512 | 428.497 ms | 452.851 ms | 64,360 B | 292,068 B |

Story Clarity v1 runs as a separate analyzer over composed scenes. Local
measurements on Node.js 22.12.0, five iterations per size:

| Projects | Analyzer mean | Input | Diagnostics | Suggestions | Output |
|---:|---:|---:|---:|---:|---:|
| 6 | 0.374 ms | 4,010 B | 18 | 9 | 3,138 B |
| 12 | 0.674 ms | 13,125 B | 94 | 14 | 13,568 B |
| 128 | 82.922 ms | 640,102 B | 256 (cap) | 129 | 90,973 B |
| 512 | 291.060 ms | 737,244 B | 256 (cap) | 256 (cap) | 54,447 B |

These local runs are directional single-machine measurements, not CI budgets.
The 512-project analyzer case approaches its 1 MiB input and output caps; normal
Profile Story export is limited to 12 projects. The 512-project composition
case is also a stress bound rather than an expected workload.

The 512-project stress case hits the 32,768 family-pair generation-work bound;
its latency is a stress bound, not the expected Profile Story workload. The
12-project candidate SVG in the v4.2 benchmark was 34,430 bytes with 24
composed edges. The v4.2 raw WASM was 545,123 bytes (748,281 bytes as base64
inline); the previous main baseline raw WASM was 450,637 bytes. v4.3 raw WASM
is 657,467 bytes (899,173 bytes inline), and the generated Core package totals
1,909,607 bytes. Browser startup and compressed WASM were not measured, so no
before/after startup or compression claim is made.

Evidence Navigation v1 (v4.4) adds a retained navigation index to the same WASM
module. The release profile now uses `codegen-units = 1`, which reduced the
binary by about 40 KB with no measured change to the layout, scene, refinement,
scaling, Graph Quality, Story Composition, or Story Clarity benchmarks
(`opt-level = "z"` was rejected: 10-25% slower composition and analysis). The
navigation module avoids generic sort, map, and serializer instantiations.
v4.4 raw WASM is 670,680 bytes (207,871 bytes gzip -9), against v4.3's 657,467
bytes (199,930 gzip). Standalone HTML strips leading indentation from its
embedded runtime; the 45-node export runtime is 1,039,944 bytes of its
1,048,576-byte budget. The generated Core package totals 1,966,297 bytes and
the Web Component entry 24,572 of 24,576 bytes. Both inline budgets have little
remaining headroom; the next feature that grows the WASM or embedded runtime
should first reduce it. Navigation latency is recorded in
[Evidence Navigation](../evidence-navigation.md) and measured by
`scripts/benchmark-evidence-navigation.mjs`.

Portfolio Artifact v1 remains in JavaScript and uses the existing Core renderer
and Web Crypto. On Node.js 22.12.0, one local run created and validated a
12-project artifact in 57.5 ms / 5.4 ms and a 100-project artifact in
65.1 ms / 9.4 ms. Asset bytes were 1,169,743 and 1,434,090 respectively; the
1.17 KiB manifest records five files. The generated standalone HTML embeds the
same 1,040,342-byte runtime and 670,680-byte WASM measured above. These are
single-machine diagnostics; artifact packaging adds no Rust/WASM bytes.

At the v4.7.0 release candidate, the generated Core package is 1,995,255 bytes
of its 2 MiB limit (about 100 KiB of headroom) and the Web Component entry is
24,572 bytes of its 24,576-byte limit. The consumer test requires the entry to
stay strictly below 24 KiB, so three bytes remain usable; lifecycle behavior
belongs in Core. The raw WASM is unchanged at 670,680 bytes.
One Chromium external-consumer fixture measured 313.6 ms from package import to
first component readiness, 0.9 ms for project plus relationship focus, 7.5 ms
for a 280px container resize and layout, and 2.5 ms for disconnect/reconnect.
These are one headless local sample; no comparative cold-cache baseline or
retained-memory profile was isolated.

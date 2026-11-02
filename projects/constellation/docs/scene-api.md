# Scene pipeline

The optional version-1 `scene.temporalStack` attachment references yearly Timeline
frames, stable local anchors and typed continuity bridges without changing Scene
API v1. [Temporal Stack](temporal-stack.md) documents validation and limits.

Inspect scenes without producing SVG:

```sh
node src/cli.mjs --username example --fixture repos.json --scene --explain
node src/cli.mjs --username example --fixture repos.json --scene-json --reference-date 2026-09-01T00:00:00Z --output scene.json
```

`--scene` reports counts, layer IDs, omitted-label diagnostics and, with
`--explain`, filter counts and bounded structured evidence. `--scene-json` emits canonical scene JSON. Both default
to stdout; explicit `--output` writes JSON, and `--dry-run` forces stdout. Neither
writes SVG, organization cache files or Action outputs. Fixture mode stays offline
unless configuration explicitly includes network source plugins. `--reference-date`
fixes the generation clock. `sceneStatistics(scene)` provides the same counts to
host applications; `pluginHost.createScene(...)` preserves registered source icons
and theme resolution without rendering.

Scene API v1 defines a serializable scene between graph/layout
computation and rendering. The existing `renderConstellation` API composes
`createScene` and `renderSceneSVG`, so CLI, Action, Studio and source plugins retain
their existing behavior. Rust/WASM still computes layout and refinement.

```js
import { createScene, renderSceneSVG, serializeScene } from '@constellation/core';

const scene = createScene('example', [
  { full_name: 'example/core', name: 'core', language: 'Rust', stargazers_count: 42 },
], { referenceDate: '2026-09-01T00:00:00.000Z', animate: false });
const fixture = serializeScene(scene);
const svg = renderSceneSVG(JSON.parse(fixture));
```

Scene records include version, kind, account/seed/reference-date metadata,
viewport, nodes, edges, labels, layers and identity geometry. Nodes own their
coordinates, radius, resolved color/glow/shape, source metadata, visibility and
optional trusted source icon descriptor. Edges reference node IDs and carry
relationship metadata, geometry and emphasis. Labels have plain text and computed
coordinates. These records contain no markup or executable callbacks.

The `presentation` record carries resolved legacy styling, graph summary and
temporal decoration data required by the compatible SVG renderer. This is a
required opaque block in Scene API v1: preserve it when round-tripping scenes.
Use the compiler to construct it rather than depending on undocumented fields.
Layer records drive phased composition; see [Scene layers](layers.md).

An optional `evidence` attachment uses Scene Evidence v1. It carries bounded
source, user-intent and derived node claims and does not change the Scene API
version. Older scenes without evidence remain valid. See
[Evidence and provenance](evidence-provenance.md).
Config v7 (and compatible v6) layer controls provide visibility, opacity and constrained ordering.

Time-lapse scenes contain a latest scene and historical frames for crossfade.
The SVG time-lapse adapter renders these precomputed frames without rerunning
layout. Existing growth/orbit semantics and reduced-motion fallbacks are preserved.
Historical values retain their existing evidence limitations.

`createScene` takes the same arguments and runtime callbacks as
`renderConstellation`. Icon callbacks run during compilation, and their data
descriptors survive serialization. Compilation isolates the returned data from
the caller's records. Supply a fixed `referenceDate` for reproducible fixtures;
the compatibility default still uses the current time.

`serializeScene` writes canonical JSON with sorted object keys and preserves the
semantic array order. `parseScene` reads that format and rejects invalid versions,
duplicate IDs, dangling edges, malformed geometry, invalid ordering, cycles,
non-finite values and executable/non-JSON records. `validateScene` returns
`{ valid, errors }` without throwing. Rendering validates the scene boundary too.
Identical inputs, seed and reference date produce stable IDs, ordering and
geometry regardless of engine cache state. The compatibility wrapper's implicit
current clock is intentionally not a reproducibility guarantee.

Scene v1 is a public, validated import/export boundary. Use `parseScene` for imported JSON and config parsing/migration for user settings. Rendering preserves XML escaping and the constrained source-icon renderer. Custom CSS is trusted styling and is restricted in the web component; see the security guide.

The regression fixture `test/fixtures/scene-svg-v2.json` stores SHA-256 hashes
captured from the original 2.0 renderer for nine fixed-date configurations. Tests
compare those bytes after scene JSON round trips, including motion, selection,
manual coordinates, refinement, hidden nodes and historical crossfade/growth.

## Scaling and memory

Run `node --expose-gc scripts/benchmark-scene.mjs` to measure compilation,
serialization, parsing and SVG rendering separately for 2,048 nodes. It reports
cold and warm timings, JSON/SVG byte counts, and retained heap after twelve
iterations and forced GC. Retention above 16 MiB fails the check; timing is
reported rather than used as a machine-dependent pass/fail threshold.

On the Windows/Node 22.12 development host, warm medians were approximately
33 ms compilation, 34 ms serialization, 21 ms parsing and 42 ms rendering. The
fixture produced 2.42 MB JSON and 1.80 MB SVG and retained about 0.29 MB after GC.
These are observations, not performance promises. Scenes intentionally copy
metadata for isolation; retain only the scenes an application actually needs.
The existing engine/source caches retain their bounded policies.

Large-scene regression tests check all 2,048 nodes, edge references, label bounds,
mutation isolation and round trips. Every example JSON config is also compiled
and round-tripped through a fixed-date offline scene. The external-consumer test
exercises scene APIs with the packaged WASM outside this repository.

Optional versioned `timeline`, `hierarchy` and `story` attachments compose precompiled scenes. `annotations` contains up to 32 plain text/x/y records. See their dedicated guides for bounds. Scene JSON rejects unsafe records and is limited to 32 MiB. Custom CSS remains trusted styling; see [security](security-model.md).

# Data pipeline

The pipeline is source → normalized records → transforms → graph → scene → renderer.
Existing GitHub acquisition,
organization scans and source API 1 still return repository-shaped objects;
compilation adapts them before graph construction. Rust/WASM remains responsible
for the existing graph projection and layout computations.

```js
import { normalizeRecords, createScene, renderSceneSVG } from '@constellation/core';
const result = normalizeRecords([
  { full_name: 'example/core', name: 'core', language: 'Rust', stargazers_count: 42 },
]);
const scene = createScene('example', result.records, {
  referenceDate: '2026-09-01T00:00:00Z', animate: false,
});
const svg = renderSceneSVG(scene);
```

A normalized record has `version: 1`, `type: "record"`, a stable `id`, display
`label`, semantic `kind`, numeric `metrics`, and isolated `attributes` containing
source metadata. Adapted GitHub records expose `metrics.stars`; missing or invalid
counts become zero. `source` identifies GitHub or the registered source/instance.
Temporal fields retain their evidence and are not synthesized as history.

`normalizeRecords` returns `{ records, diagnostics, statistics }`. Invalid records
are rejected with their input index and reason; duplicate IDs fail the pipeline.
An optional `onDiagnostic` callback receives rejection diagnostics. Records are
cloned so later mutations cannot affect source caches or callers. `toGraphRecords`
adapts normalized records into the existing graph interface without dropping source
metadata, manual identity or plugin provenance.

The legacy scene entry point defers duplicate-ID checking until after its existing
privacy/fork/repository filters. This preserves inputs whose repeated IDs belong
only to excluded records. The resulting graph still requires unique IDs, and
registered source loading retains its earlier collision checks.

`createScene` accepts either existing repository records or normalized records.
It reports loaded/rejected/normalized/graph/scene counts in `presentation.pipeline`.
Source API 1 remains unchanged: `pluginHost.load` returns its existing objects,
while `pluginHost.loadRecords` is an additive normalized adapter using the same
registration, namespace, cache and cancellation boundaries. Hosts must still
explicitly register executable source callbacks; config never loads modules.

## Declarative transforms

Config v6 accepts `transforms`, an ordered array of at most 32 stages. For example:

```json
{
  "version": 6,
  "transforms": [
    { "type": "filter", "field": "metrics.stars", "op": "gte", "value": 10 },
    { "type": "sort", "field": "metrics.stars", "direction": "desc" },
    { "type": "limit", "count": 20 },
    { "type": "derive", "field": "metrics.score", "expression": {
      "op": "add", "args": [{ "field": "metrics.stars" }, { "value": 1 }]
    } }
  ]
}
```

`applyTransforms(records, transforms)` returns isolated records and a per-stage
report with input/output/removal counts. Stages run before graph filters and
projection. Privacy and fork exclusions run before configured transforms during
scene compilation; grouping or mapping cannot undo those exclusions. Historical
snapshots are established before their transforms. Normal graph filters and caps
still apply after transformation. Studio inspects the actual resulting scene.

| Stage | Fields and behavior |
| --- | --- |
| filter | `field`, `op`, `value`; eq/ne, numeric gt/gte/lt/lte, in, contains, exists (no value) |
| sort | `field`, optional asc/desc `direction`; ties use stable record IDs |
| limit | nonnegative integer `count` |
| deduplicate | scalar `field`; keeps the first record, so sort first when needed |
| group | scalar `field`; stable group ID, summed stars, count and sorted member IDs |
| derive | writable `field` and `expression` |
| map | `fields` maps writable paths to expressions, evaluated against the original record |

Paths are `id`, `label`, `kind`, `metrics.NAME` or bounded `attributes.NAME` paths.
IDs cannot be overwritten. Expressions contain exactly a `field`, a scalar
`value`, or an `op` with `args`. Operations are add, subtract, multiply, divide,
min, max, coalesce, concat and lowercase. Division by zero and missing numeric
inputs yield null; use coalesce for derived metrics, which must be finite.
There is no eval, module loading, executable callback or JavaScript string syntax.
Expression nesting and argument counts are bounded, and prototype paths are rejected.

Grouping reports only supplied members and metrics; it invents no repository
architecture or historical data. The existing lower-level `graphNodes` function
continues accepting graph-ready repository records; use `toGraphRecords` after
explicit transforms when calling it directly.

## Visual mappings

Common mappings do not need expressions:

```json
{
  "version": 6,
  "mappings": {
    "size": "stars",
    "color": "language",
    "glow": "activity",
    "opacity": "age"
  }
}
```

Each channel also accepts a `field` or safe `expression`. Numeric channels specify
two-number `domain` and `range` arrays, optional linear/sqrt/log `scale`, and an
optional numeric `fallback`. Values clamp to the domain. Size ranges are 0.5–20
scene units; glow and opacity ranges are 0–1. Reversed output ranges are supported.
Color mappings accept a `categories` object of six-digit hex colors and optional
hex `fallback`, or `palette: "language"`. Missing values preserve the legacy style
unless a fallback is supplied. Explicit per-node colors retain precedence.

```json
{
  "mappings": {
    "size": { "field": "metrics.score", "domain": [0, 100], "range": [3, 12] },
    "color": { "field": "attributes.language", "categories": { "Rust": "#dea584" }, "fallback": "#888888" }
  }
}
```

Derived metrics remain available to mappings. `metrics.age` is elapsed days since
the supplied creation date at the fixed reference date. `metrics.activity` uses a
supplied metric or public-event score when available, otherwise the existing
updated-date recency proxy. It is not an invented historical activity count.
Mappings resolve into scene geometry/style; Rust refinement receives the resolved
radius. Zero-opacity markers are excluded from keyboard interaction. Existing
node size/color/glow options remain supported and unchanged without mappings.

## Diagnostics and caching

`constellation --scene --explain` reports loaded, rejected, normalized,
transformed, filtered, graph-node and scene-node counts, individual transform
stages, filter explanations and cache accounting. `--explain` alone retains its
legacy filter-only shape for ordinary configs and adds a `pipeline` report when
transforms or mappings are configured. Scene JSON itself contains deterministic
stage counts, not cache hits or wall-clock timings.

```js
import { createDataPipeline, createScene } from '@constellation/core';
const pipeline = createDataPipeline({ maxEntries: 16, maxBytes: 8 * 1024 * 1024 });
const result = pipeline.run(repositories, { transforms: [
  { type: 'limit', count: 20 },
] });
const scene = createScene('example', repositories, {
  referenceDate: '2026-09-01T00:00:00Z',
}, { pipeline });
console.log(result.statistics, pipeline.cacheStatistics);
pipeline.clear();
```

Caches belong to an explicit pipeline/host, have both entry and estimated-byte
bounds, and return isolated copies. Oversized and non-JSON inputs remain usable
without retention. Hosts expose `pipelineCacheStatistics`; `clearCache` clears
source and pipeline caches. Studio owns its own pipeline. There is no shared
mutable data registry. Already-aborted signals are rejected before cache access;
scene compilation also checks cancellation after callbacks.

Run `node scripts/benchmark-pipeline.mjs` for separate normalization, transform,
graph and scene/layout timings plus cold/warm pipeline measurements. On the
Windows/Node 22.12 development host, the 2,048-record fixture measured about 7 ms
normalization, 12 ms transforms, 3 ms graph construction and 55 ms scene/layout.
The cached pipeline measured 44 ms cold and 17 ms warm and retained an estimated
2.87 MB across two entries. These measurements are informational, not thresholds.

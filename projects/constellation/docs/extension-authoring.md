# Extension authoring

Use explicit trusted hosts. Config describes source instances, transform operations, theme references and layout options; it never imports executable modules.

```js
import { createPluginHost } from '@constellation/core';
const host = createPluginHost();
host.registerSource({
  id: 'projects', apiVersion: 2,
  async load({ signal }) {
    signal?.throwIfAborted();
    return [{ version: 1, type: 'record', id: 'compiler', label: 'Compiler', kind: 'project',
      source: { id: 'projects' }, metrics: { stars: 10, quality: 0.9 },
      attributes: { language: 'Rust', html_url: 'https://example.com/compiler' } }];
  },
});
const config = { plugins: { sources: [{ id: 'team', source: 'projects' }] } };
const { records } = await host.loadRecords(config, { account: 'example' });
const scene = host.createScene('example', records, { referenceDate: '2026-09-01T00:00:00Z' });
```

Plugin host API v2 owns registrations and cache lifetime. Source API v2 returns normalized records; Source v1 remains an adapter for `{ id, name, ...metadata }`. IDs become `source:instance:encoded-local-id`. Custom metrics survive normalization and can drive mappings. Reject bad responses; pass cancellation to fetch and use the injected `fetchImpl` for offline tests. Render hooks return validated paths, never markup. Do not put credentials in shared source options.

Layout API v1 implementations register with `createLayoutHost()` or `host.registerLayout()`. Declare graph limits, manual positioning, snapping, determinism, animation and refinement capabilities. Return complete finite positions keyed by node ID. Nondeterministic layouts bypass caches. See [layout authoring](layout-api.md).

Theme API v2 descriptors use `{ apiVersion: 2, id, version, preset }`. Version is the exact content release, independent of API version. Styling presets allow bounded palettes, opacity/glow and existing appearance choices; they cannot alter data sources or execute code. Existing descriptors without `apiVersion` are accepted as v1. See [source/theme details](plugins.md).

Test isolated hosts, duplicate IDs, invalid records, cancellation, cache refresh, fixed-date deterministic scenes, hostile metadata and external package loading. Use [renderer descriptors](renderer-api.md) for additional trusted artifact formats. Current stable contracts are listed in the [v3 migration guide](migration-v3.md).

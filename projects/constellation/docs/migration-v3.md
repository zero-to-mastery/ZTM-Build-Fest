# Migrate from Constellation 2 to 3

Constellation 3 keeps README SVG generation and adds scenes, layers, declarative data transforms/mappings, registered layouts, offline interactive HTML, a web component, timelines, hierarchy and stories. Existing v6 configs, legacy JSON and v1:–v5: design recipes remain readable. No account data must be migrated.

1. Change your workflow to `uses: mnichols08/constellation@v3`, or migrate its literal config block with the command below.
2. Save exported configs as version 7. Importing a version 6 config converts it without changing its visual options.
3. Browser deployments must serve the bundled WASM asset. The deprecated non-WASM rendering fallback has been removed.
4. Keep Source API v1 integrations as they are, or adopt normalized records with Source API v2. Register executable extensions in trusted application code.

```sh
node src/cli.mjs migrate --config constellation.config.json --output constellation-v7.json
node src/cli.mjs migrate --workflow .github/workflows/constellation.yml --output constellation-v3.yml
node src/cli.mjs validate --config constellation-v7.json
node src/cli.mjs build --username example --fixture repositories.json --config constellation-v7.json --dry-run --explain
```

Migration is offline, explicit output files are used, and repeated migration is idempotent. Workflow migration accepts official v1/v2/v3 major or numeric release references and literal JSON blocks. Custom action forks/SHAs and expression-based `config-json` need manual editing. The migration preserves JSON dollar escaping so CSS cannot become GitHub workflow expressions. The Action still defaults to SVG, uses the same inputs/output and publishes only when requested.

Config v7 finalizes the accumulated 2.x settings: layers, transforms, mappings, layout references/options and timelines coexist with existing recipes, themes, filters, positions and animation. Both flat exported configs and `{ version, account, options }` records are supported. Scene catalogs and stories are separate scene JSON artifacts; they are not packed into limited-size config/share URLs. Scene JSON is validated and capped at 32 MiB; config JSON retains its 250,000-character bound.

| Contract | Stable version | Compatibility |
| --- | --- | --- |
| Scene | 1 | Versioned JSON, stable IDs and deterministic compilation |
| Renderer | 1 | SVG/HTML functions plus trusted renderer descriptors |
| Layout | 1 | Existing built-ins and explicit per-host registration |
| Plugin host / Source | 2 / 2 | Source v1 adapters remain supported |
| Theme | 2 | Existing unversioned/API-v1 packs remain supported |
| Web component | 1 | Browser module, isolated properties, methods and events |
| Story | 1 | Declarative chapters with precompiled scenes |
| Config | 7 | Reads v6, legacy JSON and frozen v1:–v5: recipes |

Source v2 returns normalized Data Record v1 values (`id`, `label`, `kind`, `source`, finite `metrics`, JSON `attributes`). `loadRecords()` gives a consistently normalized collection; legacy `load()` preserves v1 repository-like nodes and v2 normalized records for compilation. Source instance namespacing remains unchanged. `json-feed` remains the legacy adapter; `json-records` accepts normalized JSON. Theme v2 adds explicit `apiVersion: 2`; `themePacksV2` provides built-in descriptors while `themePacks` retains legacy descriptors. Pack content versions remain independent of the API version.

The core ships WASM, so consumers need no Rust installation. Rebuild contributors need the pinned wasm-bindgen version used in CI. Browser hosts must support modules, WebAssembly, Web Crypto and standard modern DOM APIs; use HTTPS or localhost. If startup fails, Studio reports an accessible engine error. Restore the asset/MIME/CSP configuration rather than expecting a lower-fidelity fallback.

The final 2.x release is 2.9.3. Keep the `v2` tag there when moving `v3` to 3.0.0. Pin a numeric tag or commit when you need immutable behavior. Local release commits/tags do not publish packages or update remote GitHub tags until pushed.

See [architecture](architecture.md), [interactive HTML](interactive-html.md), [embedding](web-component.md), and [extension authoring](extension-authoring.md) for new integrations.

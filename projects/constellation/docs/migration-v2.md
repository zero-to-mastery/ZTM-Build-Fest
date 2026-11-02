# Migrating to Constellation 2

Version 2 consolidates the capabilities shipped in 1.6–1.9. It adds no new graph modes, source types or themes.

## Config format

New JSON presets, share payloads and generated workflow config use `version: 6`. The canonical file is a flat object with `version`, optional `account`, and settings. `layoutRefinement`, `plugins`, `themePack`, `nodeCap` and `simplifyAbove` use their existing field names. Missing settings retain the previous defaults; migration does not enable the large-graph overview or refinement.

Earlier JSON presets used `version: 1` (or no version); `v1:` through `v5:` are design recipes, not JSON schema versions 2–5. The importer expands those frozen recipes into materialized v6 settings. Their `designCode` and seed remain as reproducibility metadata. Old share URLs and version-1 presets are accepted automatically; new exports write v6. Existing account drafts/presets remain readable in browser storage. V1 consumers cannot read v6 JSON: keep original files if you need to roll back.

```sh
node src/cli.mjs migrate --config old.json --output new.json
node src/cli.mjs migrate --from v1:my-design --username octocat --output new.json
node src/cli.mjs migrate --from 'https://mnichols08.github.io/constellation/?user=octocat&design=v5:m000-y2026-f2012-example' --output new.json
node src/cli.mjs validate --config new.json
```

Omit `--output` to review the result on stdout, or use `--dry-run`. Migration is offline. For equivalence tests, render the old and migrated options against the same repository/event snapshots and reference date. Migration preserves manual coordinates, hidden nodes/labels, refinement intensity, ring rotations, source instance IDs and exact theme references. External theme packs must still be registered in the application host. Legacy CLI CSS remains available in v6; SVG markup continues to escape CSS as text.

## Workflows and Marketplace

```sh
node src/cli.mjs migrate --workflow .github/workflows/constellation.yml --output constellation-v2.yml
```

The workflow migrator updates `mnichols08/constellation@v1` (including exact v1 release tags) to `@v2` and migrates generated literal `config-json: |` blocks. File-based `config:` paths remain unchanged; migrate those JSON files separately if you want to save them as v6. For expression-based or single-line YAML config values, migrate the JSON separately and edit the action reference manually. The command rejects unsupported inline forms instead of guessing at YAML. Review and replace the original workflow after checking the output. Token, publish, output-branch and permission behavior remain unchanged.

The Action's name remains GitHub Constellation; `action.yml` describes v6 and legacy inputs. The v1 major tag must stay on the final compatible 1.x release. Publish the tested v2 release and opt it into Marketplace using the owner's release editor, as described in `.github/RELEASING.md`.

## Stable extension API

Core 2.x guarantees source API version 1 and the documented theme-pack shape. Existing 1.8–1.9 source loaders, node renderers and packs require no rewrites. Exact pack versions remain independent of core versions. See `docs/plugins.md` for the compatibility contract.

## WASM fallback deprecation

The browser's limited non-WASM field fallback is deprecated and emits a warning if WASM initialization fails. It remains available in 2.x; removal is reserved for the next major version. The CLI/Action already requires WASM. Keep both checked-in WASM files with the core package, rebuild using `npm run build:rust` followed by `npm run build:core`, and serve the binary with the appropriate MIME type. This release does not change the supported WASM rendering path.

These are the complete compatibility changes: v6 exports, a stable extension contract, and explicit fallback deprecation. Existing graph defaults, GitHub filtering, workflow inputs and saved-layout semantics remain unchanged.

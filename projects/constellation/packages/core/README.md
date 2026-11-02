# Core API

Constellation 5.0.0 exports stable Scene v1, Renderer v1, Layout v1, Plugin/Source v2, Theme v2 and Story v1 contracts. `CONFIG_VERSION = 7`; v6 configs and legacy recipes remain readable. `analyzeDeveloperProfile(snapshot)` calls the shared Rust/WASM evidence engine without fetching data. See [Developer Topology](developer-topology.md), [v3 migration](migration-v3.md), [scene API](scene-api.md), [renderers](renderer-api.md), [data pipeline](data-pipeline.md), [layouts](layout-api.md) and [extension authoring](extension-authoring.md).

`@constellation/core` is an ESM package for Node 22+ and browsers with WebAssembly. It includes its WASM binary and has no runtime npm dependencies. Build it with `npm run build:core`, then run `npm pack ./packages/core`. The package works without the CLI, GitHub Action, studio, or Rust toolchain. The generated package is committed so the Action needs no install step. Edit `src/`, then rebuild the package.

```js
import {
  renderConstellation,
  validateConfig,
  explainFilters,
  explainNode,
} from "@constellation/core";
const result = validateConfig({
  maxRepos: 45,
  layoutRefinement: { enabled: true, intensity: 5 },
});
if (!result.valid) throw new Error(JSON.stringify(result.errors));
const svg = renderConstellation("octocat", repositories, result.config.options);
const explanation = explainFilters(repositories, result.config.options);
```

`renderConstellation(account, repositories, options, { onDiagnostic }?)` returns SVG text. Supply public repository metadata (`name`, `full_name`, `language`, optional `languages`, `topics`, star counts and dates). For reproducible temporal layouts, provide `referenceDate`. The diagnostic callback receives `{ code, node, reason }` for omitted labels.

`validateConfig(objectOrJSON)` returns `{ valid, errors, config? }`. Errors contain `path` and `message`; valid configs contain `account`, `version` and normalized `options`. `parseConfig`, `serializeConfig`, and `normalizeConfig` retain the existing JSON preset format.

`explainFilters(repositories, options)` returns counts (`loaded`, `pool`, `included`, `rendered`, `omittedByGraphLimit`) and node ID lists (`excludedBeforeCategories`, `excludedByCategories`, `hidden`). Selection applies metadata filters and the project limit before language/topic filters.

`explainNode(scene, nodeId)` returns a deterministic summary of scene inclusion, position, attached evidence and visual mappings, or `null` when the node is absent. `explainVisual(scene, nodeId)` returns individual mapped appearance channels. `explainEdge(scene, edgeId)` uses explicit shared language, topic or repository metadata when present and otherwise says the reason is unavailable. Studio and offline interactive HTML use one shared pure explanation implementation. Scene Evidence v1 is optional and remains within Scene API v1; old scenes without it remain valid. Explicit `includeRepos` selection has user provenance; ordinary scene selection and filters have derived provenance. See [Evidence and provenance](evidence-provenance.md).

`buildSemanticHierarchy(scene, options?)`, `projectSemanticLevel(scene, level, options?)`, `expandGroup(scene, hierarchy, id)`, `collapseGroup(...)` and `explainGroup(hierarchy, id)` provide deterministic reversible project grouping. Grouped projections retain references to source node and edge IDs. See [Semantic Groups](semantic-groups.md).

`graphNodes`, `selectRepositories`, and `selectRepositoryPool` expose the existing projection and filtering steps. `rustAvailable` and `engineError` remain compatibility exports; successful initialization reports true/null, while missing WASM rejects module initialization. GitHub acquisition helpers remain available separately from rendering through `fetchRepositories` and `fetchRepositoryLanguages`.

CLI: `node src/cli.mjs validate --config settings.json` validates without fetching GitHub. Generation accepts `--dry-run` (compute without writing SVG, cache or Action outputs) and `--explain` (print the filter report and bounded structured Scene Evidence as JSON). Use `--fixture repositories.json` for offline runs.

Run `node src/cli.mjs --help` for flags or `--version` for the wrapper version. After `npm link` in the checkout, the same entry point is available as `constellation`. Validation exits 0 on success and 1 with actionable errors on stderr. An empty config is valid, but the `validate` command requires a file or inline config to avoid accidentally validating defaults. Use either `--config` or `CONSTELLATION_CONFIG_JSON`, never both.

```sh
node src/cli.mjs validate --config examples/active-developer.json
node src/cli.mjs --username octocat --fixture repos.json --config settings.json --dry-run --explain
```

`--explain` reserves stdout for one JSON report; the generated-file message goes to stderr. The `excluded` list associates each excluded project with metadata, selection or limit reasons. Dry runs can fetch data unless `--fixture` is supplied. They do not publish or modify output files.

Rebuild `packages/core` after source or WASM changes. A core tarball can be installed by path (`npm install ./constellation-core-3.2.0.tgz`). Package tests copy the built package outside the checkout and verify WASM initialization, rendering, validation and filtering there.

Interactive exports: `renderSceneHTML(scene, { title })` produces an offline HTML document. See [interactive HTML](interactive-html.md).

## Universe dimensions

`temporalStack.axis` supports `year` (default), `language`, `repository` and `topic`. Optional `layerValues` selects and orders dimensional layers. Config stays v7; v1 year attachments remain readable, while dimensional scenes use attachment v2 without a Timeline. See [Universe dimensions](temporal-stack.md).
Portable meaning can be created with Semantic Graph v1 adapters and projected to Scene v1; see [Semantic Graph](semantic-graph.md). `renderSemanticMarkdown(graph, { detail: 'standard' })` produces a bounded Markdown projection directly from a validated graph; see [Semantic Markdown](semantic-markdown.md). These optional layers do not change direct Scene generation.

`createPortableExport(graph)` creates deterministic graph JSON, standard Semantic Markdown, SVG, interactive HTML, and manifest strings from one validated graph. It performs no filesystem, DOM, network, or archive operations. See [Portable Embed and Export](portable-embed.md).

`createPortfolioArtifact(graph, { constellationVersion, scene? })` asynchronously creates the bounded v1 portfolio manifest and deterministic named assets with SHA-256 digests. Web Crypto is required. `validatePortfolioArtifact(manifest, files)` rechecks compatibility, Scene v1, trusted relative filenames, runtime entry markers, byte limits, and asset digests. Use `--format portfolio --output DIRECTORY` with the offline CLI to write a directory. See [Portable Portfolio Artifact v1](portfolio-artifact.md).

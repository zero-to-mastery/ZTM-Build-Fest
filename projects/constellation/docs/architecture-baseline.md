# Architecture baseline: 2.0.0

Recorded before the 3.0 transition on 2026-09-27. Root and core are 2.0.0;
source-json and themes have independent versions. Authoritative JavaScript lives
in `src/`; `scripts/build-core.mjs` follows imports from `core-api.mjs` and copies
the dependency closure, including WASM, into the checked-in core package.
`build-extensions.mjs` builds the independently versioned source/theme packages.

## Data and computation

GitHub REST/GraphQL acquisition feeds repository-shaped records. Organization
acquisition has bounded contributor scans and caching. The per-host plugin
registry explicitly registers trusted source callbacks and theme packs; JSON
configuration only selects registered identifiers. Source API 1 namespaces IDs,
clones metadata, propagates cancellation, rejects stale loads, and bounds caches
by entry count and estimated bytes. JSON feeds provide an offline-capable source.

`graphNodes` filters and projects repositories into repository/category/combined
or organization graphs. `engine.mjs` loads the same checked-in Rust/WASM module
in Node and browsers. Rust owns graph layout, identity geometry, projection,
refinement, graph traversal and stable overview coordinates. Existing JavaScript
artifact and organization arrangements supply manual coordinates to that engine.
The Rust `Scene` currently means positions and indexed edges, not a complete
visual scene. Engine caches are bounded. Browser fallback is deprecated; CLI
requires WASM.

## Rendering and configuration

`renderConstellation` currently combines validation, theme resolution, historical
filtering, graph construction, layout, refinement, label placement, SVG assembly,
selection and animation. History time-lapse wraps repeated renders. SVG is also
used by Studio editing tools through stable classes and data attributes.
These hooks, reduced-motion CSS, escaped XML, and seeded geometry must survive.

Config v6 is declarative, size/depth limited and validates known fields. Imported
CSS has restrictions; v6 trusted CSS still receives XML escaping. Config validation
currently calls rendering validators. Migration supports unversioned/version-1
JSON, frozen v1–v5 design recipes, share links and exported workflows. Themes are
validated styling data; trusted source node renderers return constrained icons.

## Applications and delivery

Studio is framework-free HTML/CSS/ES modules, with separate layout, design,
configuration, repository picker, history and organization controls. Preview data
is cached separately from visual edits. CLI supports generation, validation,
migration, offline fixtures, dry runs and filter explanations. The composite
GitHub Action sets environment inputs and invokes the same CLI with Node 22;
publication to an output branch is a separate optional script.

Examples use synthetic fixtures and generated galleries. Node's test runner
covers core, migrations, plugins, security, temporal output, CLI, package copying,
browser Studio behavior, scaling and SVG hooks. CI rebuilds Rust/WASM and core,
reruns tests, and runs the Action. Release instructions describe immutable version
tags and moving major tags; local release commits precede publication.

## Baseline verification

- 184 JavaScript tests passed, none skipped, including headless browser tests.
- 34 Rust tests passed with the locked offline dependency graph.
- WASM, core and extension builds passed; 15 gallery examples regenerated.
- Rust has an existing unused `Graph::resize` warning.
- Local npm uses Git Bash, which cannot start in the restricted sandbox. Direct
  Node/Cargo commands work; the full Node suite needs elevated child-process access.
- Pre-existing work: deleted `v1it8f7y-16hwiw6.png`, untracked `.vscode/` and
  `feature-roadmap.md`. These are outside the release changes.

## Transition constraints

Preserve v6 and source API 1 throughout 2.x. Separate graph/layout computation
from serializable scene records and renderers without duplicating Rust algorithms.
Retain the legacy renderer's SVG hooks and byte-level fixtures while extracting
its presentation logic. Do not publish a version until its tests, docs, package
build and generated examples pass. The requested roadmap remains sequential:
scene, layers, data pipeline, layouts, HTML, component, timeline, hierarchy, story,
then stable versioned 3.0 contracts and migration.

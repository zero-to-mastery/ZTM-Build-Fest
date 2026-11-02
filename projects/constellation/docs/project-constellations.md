# Project Constellations

A Project Constellation is a bounded map of repository artifacts at one Git ref. It records paths, supported package manifests, explicitly declared workspace membership, selected JavaScript or TypeScript static imports, and manifest-declared entry points. It does not infer architectural domains or inspect symbols.

## Core API

```js
import {
  createProjectConstellation,
  createProjectConstellationScene,
  createProjectConstellationHierarchy,
} from '@constellation/core';

const model = createProjectConstellation({ projectId: 'owner/repo', ref: 'main', commit, tree, contents });
const { scene } = createProjectConstellationScene(model);
```

`createProjectConstellation` is pure: `tree` contains `{ path, type, sha?, size? }` records and `contents` maps selected manifest/source paths to text. Source text is used transiently for import parsing and is never copied into the returned model. Stable IDs hash the repository identity and normalized path, independent of record ordering. The result carries the requested ref and optional commit SHA.

To open a project from an existing Scene v1 parent, call `createProjectConstellationHierarchy(parentScene, selectedProjectNodeId, model)`. It adds one child scene using the existing hierarchy API. The Web Component's hierarchy navigation provides the breadcrumb and Back behavior; the caller can load the returned hierarchy with `view.scene = hierarchy`.

Run `node scripts/benchmark-project-constellation.mjs` to measure normalization/graph construction, Scene adaptation, SVG, offline HTML, and serialized Scene size for 50, 128, and 256 input files. The current 100-node Scene cap means larger inputs report bounded/truncated output rather than expanding the renderer's graph limit.

## Nodes and relationships

Node kinds are `project-root`, `package`, `directory`, `module`, and `entry-point`. Workspace membership can be represented by a separate `workspace-member` relationship. `contains` follows repository path ancestry; `workspace-member` comes from a supported workspace declaration; `entry-of` comes from a package manifest pointing to a real tree file; and `imports` comes from a recognized literal relative JS/TS import, re-export, or `require()` whose target resolves to another represented module. Unresolved and external imports are omitted. No calls or runtime dependencies are inferred.

The Core model's edges each retain compact source evidence (`repository-path`, `manifest`, or `static-import`). `explainProjectStructuralNode` and `explainProjectStructuralEdge` return bounded path and relationship explanations. The Scene adapter reuses Scene API v1 renderers and retains the structural kind and source evidence in edge metadata. The Core model remains the canonical explanation attachment.

## Bounds and truncation

The Core normalizer counts availability from the complete validated tree before choosing its bounded inspection window. It deterministically prioritizes supported manifests, manifest-declared entry files when their manifest contents were supplied, JS/TS source files, then other files. The defaults are 500 file paths inspected, 128 directories included, 2 MiB combined content, 32 manifests read, 64 KiB per manifest, 128 KiB per source file, 500 parsed import statements, 100 graph nodes, 1,024 graph edges, three structural directory levels, and 512 characters per path. A single source file therefore cannot consume the combined content budget. The node cap aligns with the existing Core scene compiler's 100 repository limit. Invalid paths are ignored; unsupported inspected files are counted explicitly.

Statistics distinguish `filesAvailable` in the supplied repository tree from `filesInspected`; `manifestsAvailable` from `manifestsSelected` and `manifestsRead`; `sourceFilesAvailable` from `sourceFilesSelected` and `sourceFilesRead`; and `directoriesAvailable` from `directoriesIncluded`. Omitted counts are measured against repository-wide availability, not only the selected files. `truncated` is true when any relevant file, manifest, source, directory, byte, import, node, or edge coverage is bounded. For example, a public manifest-only scan with JS/TS files in the tree reports those sources as available but unread and does not claim complete import coverage.

The application GitHub acquisition helper (`src/github-project-structure.mjs`) is opt-in and separate from Core normalization. It requires the caller's existing session/request-cache fetch function so it reuses auth isolation, cooldowns, and cancellation policy. It makes three baseline requests (repository, commit, and complete recursive tree), then fetches at most eight supported manifests in anonymous/public mode. Authenticated mode may fetch at most 24 manifests and 16 manifest-declared entry files. It passes the complete bounded tree response to Core, even though only selected file contents are fetched. Tree blob sizes are used to skip content that exceeds the per-file limit; the combined decoded content limit still applies. Request cancellation is supported. A GitHub tree response that GitHub itself marks truncated is rejected rather than shown as complete. Rate limits are surfaced as an error; callers should keep already-loaded data available.

Package nodes point to a manifest path observed in the supplied tree, even when its contents were not read. The model retains the bounded selected manifest path inventory, and validation requires every package node's path to appear in that inventory and match its package directory. When a directory has more than one supported manifest, one is chosen deterministically (`package.json`, `Cargo.toml`, `pyproject.toml`, then `go.mod`). Workspace and entry relationships require successfully read declarations. No missing manifest path is guessed.

## Supported sources and limitations

Generic `package.json` workspaces and entry fields, including bounded conditional `exports`, are supported. Cargo `[workspace].members` arrays are read with a small bounded TOML rule and produce explicit workspace relationships. Cargo crates are represented as packages. `pyproject.toml` and `go.mod` are recognized as package manifest paths, but their syntax and dependencies are not interpreted in this release. JavaScript and TypeScript static relative imports are recognized; Rust module declarations, external package dependency expansion, universal language parsing, symbol graphs, and source viewers are intentionally deferred to v3.13.1 or later. Anonymous GitHub acquisition is intentionally shallow and manifest-focused. Local and imported tree snapshots can supply their own bounded `contents` map.

The model and its Scene adapter work offline after acquisition. SVG, offline HTML, and PNG continue to use the existing Scene renderers. No credentials or source text are placed in the model or scene. A user who wants a static artifact can serialize the adapted scene with the existing Scene API; project provenance and structural explanations remain available in the separate model.

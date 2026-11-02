# Hierarchical scenes

A node may reference another compiled scene or an explicit scene definition. Constellation does not infer repository architecture: supply the repository, technology, contributor or component data that supports each child view.

```js
import { createHierarchy, createScene } from '@constellation/core';
const options = { referenceDate: '2026-09-01T00:00:00Z' };
const root = createScene('example', repositories, options);
const scene = createHierarchy({ root: 'account', scenes: [
  { id: 'account', title: 'Projects', scene: root,
    links: [{ nodeId: 'example/compiler', target: 'compiler' }] },
  { id: 'compiler', title: 'Compiler technologies',
    definition: { account: 'example', records: suppliedTechnologies, options } },
] });
```

Every entry has a unique ID, title, and either a compiled `scene` or a declarative `definition` (`account`, `records`, `options`). Links name a node ID and a target scene ID; compilation stores the reference in `node.interaction.childScene`. Definitions use the existing transforms, mappings and Rust/WASM layouts. No executable module is loaded from a reference.

The serializable `hierarchy.version: 1` catalog contains scenes sorted by ID and a root ID. The enclosing scene is a copy of that root and provides ordinary static SVG fallback. Inputs are isolated, links must resolve, cycles are rejected, and compilation respects cancellation. Catalogs are bounded to 64 scenes, 16 levels and 16,384 aggregate nodes, including temporal frames.

Hierarchy datasets use the programmatic API or scene JSON rather than embedding large record collections into v6 share configurations. This keeps scene navigation distinct from source loading and preserves the existing config size/security boundary.

## Organization detail views

`createOrganizationHierarchy(account, repositories, options, { maxProjects: 24, ...runtime })` creates a project overview with child ecosystem scenes. Each child uses the selected repository’s supplied languages, topics, dependency metadata and verified contributors from `options.organizationData`. It reuses the existing organization graph and Rust layout, makes no API requests, and retains scan-coverage notes. Missing contributor scans remain missing; current participation does not imply historical tenure.

The root respects existing repository filtering and organization scope. Up to `maxProjects` (1–63) displayed projects receive detail links; others stay visible in the overview. Private repositories and their contributor references are excluded from the generated catalog. Metadata and API caching remain the responsibility of the existing source/organization loader. Internal components/packages require explicit source data and are never inferred from language names.

## Interactive navigation

Select a linked node, then choose **Explore this node** in its details. The view transitions to its child scene. Breadcrumb buttons return to an ancestor; Back moves to the parent and Home returns to the catalog root. Shared nodes interpolate using compiled geometry, with reduced motion disabling animation. Timeline controls remain available inside temporal children.

Standalone HTML stores a validated root-to-child path in a `constellation` URL fragment parameter. `shareURL()` returns the current deep link; reload and browser Back/Forward restore the referenced scene without fetching data. Invalid paths fall back to the root.

The component exposes `openChild(id)`, `back()`, `home()`, `shareURL()` and `scenePath`. By default its navigation is local to the instance. To enable browser history, set an element ID and the `history` attribute before rendering; its fragment key becomes `constellation.ID`. Other fragment parameters are retained. Scene changes dispatch `{ id, path, scene }` through `scene-change`.

## Bounds and navigation state

Validation rejects missing children, cycles and paths deeper than 16 levels, including shared branches and temporal references. Deep-link fragments are JSON path arrays encoded as URL parameters; paths must start at the declared root and follow actual node references. Malformed, oversized or missing-target links restore the root without fetching anything. IDs are data, never executable module names.

Navigation remembers camera, filter, theme, timeline frame and valid selection for at most eight recently visited scenes. `navigationCacheStatistics` reports the bound on the runtime. Returning to a cached scene restores its view without recomputing a layout. Breadcrumbs announce the current scene and receive keyboard focus after navigation; handlers and transitions are disposed with the host.

Run `node examples/hierarchy-demo.mjs` for an offline organization example, or `node scripts/benchmark-hierarchy.mjs` to check a 16-scene/2,048-node export. The reference artifact is about 4.3 MiB; the benchmark enforces a 16 MiB budget. Catalogs and precompiled markup remain bounded by the model limits.

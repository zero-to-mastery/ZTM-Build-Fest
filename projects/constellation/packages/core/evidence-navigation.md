# Evidence Navigation and Interactive Focus

Evidence Navigation v1 lets a visitor explore a constellation without Studio: select a project, see which projects relate to it and why, inspect a single relationship, and return to the overview. It works in standalone interactive HTML and in `<constellation-view>`. Static SVG is unchanged and needs no runtime.

## What counts as a relationship

Navigation explains only facts already recorded in [Semantic Graph v1](semantic-graph.md). The vocabulary is closed and matches [Story Composition](story-composition.md):

| Type | Evidence | Shown as |
| --- | --- | --- |
| `explicit-relationship` | a user-authored `project-relationship` edge | Explicitly related by the author |
| `authored-family` | both projects are `member-of` the same user-authored project family | Same project family (defined by the author) |
| `shared-language` | both projects `uses-language` the same primary language | Shared primary language |
| `shared-topic` | both projects `has-topic` the same repository topic | Shared repository topic |

Derived repository-owner groups describe a namespace, not a relationship, so they never create connections; navigation reports them as an informational diagnostic instead. Shared metadata is not presented as a dependency, collaboration, or chronology, and navigation produces no score or ranking of a developer. Connection order (more relationship types first, then canonical project ID) is a stable presentation order, not a judgment.

Every relationship carries evidence references: the shared node ID and label (language, topic, or family) when there is one, the semantic edge IDs that support it, and their provenance categories (`source`, `user`, `derived`).

## Core API

```js
import { evidenceNavigationGraphFromScene, createEvidenceNavigator, navigateEvidence } from '@constellation/core';
const graph = evidenceNavigationGraphFromScene(scene); // null when the scene has no portable semantic truth
const navigator = createEvidenceNavigator(graph);       // retained Rust index; build once per graph
const result = navigator.navigate('octo/compiler', 2);  // depth 1 (default) or 2
navigator.destroy();
```

`evidenceNavigationGraph(semanticGraph)` adapts any Semantic Graph v1 directly. It keeps identities, labels, provenance, and the four supporting edge kinds; descriptions, URLs, and evidence payloads stay in the source graph. `navigateEvidence(graph, projectId, { depth })` is the one-shot form. Navigation never modifies the graph, Scene, or config.

A result contains `version`, `status` (`ok` or `unavailable`), `project`, `depth`, `connections` (each with `projectId`, `label`, `path`, `relationshipTypes`, and `relationships[].evidence`), `secondDegree` (each with `via`, `viaCount`, a canonical `path` through the lexicographically first intermediate project, and the relationship types of both `hops`), `truncated`, and `diagnostics`. Diagnostics use stable codes: `unknown-project`, `not-a-project`, `no-supported-relationships`, `derived-groups-not-relationships`, `edges-without-supported-endpoints`, `connections-truncated`, `second-degree-truncated`, and `traversal-budget-exhausted`. Malformed input, unsupported request fields, invalid depths, and invalid IDs are errors; an unknown project is an `unavailable` result, not an exception.

## Determinism and limits

Results are independent of node and edge order. Graph input is bounded to 4 MB, 4,096 nodes, and 16,384 edges; requests to 8 KiB and depth 1–2. Each degree returns at most 256 projects, each relationship type at most 32 evidence references, and each second-degree project at most 16 listed intermediates (with the full `viaCount`). Second-degree traversal stops after 262,144 hub-member visits and reports `traversal-budget-exhausted`. The navigator caches at most 64 recent results.

## Interactive focus

Interactive HTML exports and `<constellation-view>` use Evidence Navigation for three focus levels:

- **Overview** shows the complete constellation.
- **Project focus** (select a project) highlights the project and the projects it has evidence-backed connections with, emphasizes drawn connections between them, and dims unrelated projects without removing them. The inspector keeps the existing project details (name, description, language, safe repository link, and *Why is this here?*) and appends a compact **Connections** list, a **Two steps away** disclosure computed only when opened, and **Back to overview**.
- **Relationship focus** (choose a connection, or click a drawn connection) narrows emphasis to the two projects and explains each reason with its origin, for example *Shared primary language: Rust · repository metadata* or *Same project family, defined by the author: Toolchain · author-defined*. The panel states that connections reflect shared repository metadata or author-defined links and are not verified dependencies.

Focus never moves projects, changes manual layout settings, or edits config, Scene, or the graph. Without a navigation graph (for example time-lapse or Temporal Stack scenes) selection keeps its previous behavior. Shift-select path tracing is unchanged.

## Keyboard, touch, and announcements

Selecting a project by pointer, Enter, or Space enters project focus; connection and project buttons in the inspector are native buttons with visible focus. **Escape** steps back one level wherever focus is in the view: relationship → project (keyboard focus returns to the connection you opened) → overview (keyboard focus returns to the project node). Escape in the overview does nothing, and focus is never trapped. Opening a relationship moves focus to its heading so the explanation is read next. Programmatic focus does not move keyboard focus.

The status region announces project focus with its connection count, relationship focus with its reasons, and the return to the overview. Inspector buttons and disclosure summaries are at least 44 px tall, and project nodes use their whole bounding box as the hit target. Dimming uses a short opacity transition that is removed under reduced motion.

## Shareable focus

Focus is mirrored into the URL hash as navigation state, separate from configuration: `#focus=<project ID>` and, for relationship focus, `&focus.with=<project ID>`. Values are canonical project IDs, are bounded to 512 characters, and are only ever compared against IDs in the loaded scene; they are never inserted as markup. Opening a link restores that focus. A missing or removed project, an unsupported relationship, an empty, duplicated, or malformed value, or a `focus.with` without `focus` returns to the overview, announces that the shared view is not available, and removes the focus parameters from the URL while keeping other parameters. A hash longer than 16,384 characters is never parsed: it is treated as an unreadable shared view, not as the overview, and the whole hash is cleared. User focus changes create history entries so Back and Forward replay them; programmatic changes replace the current entry. Other hash parameters, such as hierarchy navigation, are preserved.

Standalone HTML always enables shareable focus. `<constellation-view>` follows its existing opt-in: add the `history` attribute and a unique element `id`, and the component uses `#<id>.focus=…`. Without them it never reads or writes the URL.

## Web Component API

Web Component API v1 gains additive members: `focusProject(id, { focus })`, `focusRelationship(projectId, relatedId)`, `returnToOverview()`, and the `focusState` getter (`{ mode, project, related, connections }`, where `mode` is `overview`, `project`, `relationship`, or `path`). The view emits `focus-change` with `{ mode, projectId, relatedId, connections, source }` (`source` is `user`, `api`, or `history`). `selectNode`, `clearSelection`, `selection`, and `node-select` keep their existing behavior; selecting a project also enters project focus. An unknown or hidden project, or a pair without an evidence-backed relationship, throws a descriptive error.

## Performance

`node scripts/benchmark-evidence-navigation.mjs` measures index construction and query latency on synthetic graphs. Local run (Node.js 22.12.0, release WASM):

| Projects | Graph JSON | Index build | Depth 1 mean | Depth 2 mean | Depth 2 max |
|---:|---:|---:|---:|---:|---:|
| 12 | 12 KB | 0.7 ms | 0.13 ms | 0.10 ms | 0.36 ms |
| 128 | 105 KB | 2.3 ms | 0.60 ms | 1.27 ms | 1.35 ms |
| 512 | 415 KB | 8.4 ms | 1.76 ms | 4.86 ms | 7.42 ms |
| 2,048 | 1.66 MB | 34.3 ms | 3.14 ms | 6.64 ms | 9.54 ms |

`node --test scripts/benchmark-focus-browser.mjs` measures a standalone export in headless Chromium, from the focus call to forced layout (navigation, highlighting, and inspector rendering):

| Projects | Project focus mean / max | Relationship focus mean / max | Two steps away mean / max | Back to overview mean / max |
|---:|---:|---:|---:|---:|
| 12 | 1.2 / 1.4 ms | 0.7 / 1.0 ms | 0.7 / 1.0 ms | 0.5 / 0.7 ms |
| 100 | 5.1 / 5.5 ms | 2.7 / 3.2 ms | 4.1 / 6.0 ms | 2.9 / 3.7 ms |
| 256 | 7.8 / 14.2 ms | 4.2 / 7.1 ms | 7.7 / 9.9 ms | 4.4 / 6.6 ms |

The index is built once per scene; focus interactions run one depth-1 query, and the second degree is queried only when its disclosure is opened. These are single-machine measurements, not CI budgets.

# Semantic Groups

Semantic Groups adds a reversible project-level overview. A group is a view over existing project nodes; the canonical scene and its project evidence remain available for expansion.

Ordinary atlas scenes fit their initial viewBox to visible node and label bounds, keeping its original aspect ratio and leaving a bounded margin. This changes only the camera frame, not node coordinates or semantic relationships. Fixed compact, README, repository, and wide export profiles retain their established dimensions and density behavior. Interactive Fit uses the same visible-content bounds; Reset restores the original frame.

## Levels and exports

The semantic levels are `overview`, `groups`, and `projects`. `overview` and `groups` currently use the same grouped projection. In v3.12.1, Automatic detail uses camera scale to move through these levels without changing the underlying semantic hierarchy.

Set `semanticZoom` in Config v7 to choose automatic or fixed detail:

```json
{
  "semanticZoom": { "mode": "auto" }
}
```

`auto` starts in Groups detail, enters Projects above scale 1.8, and returns to Groups below 1.45. It enters the equivalent Overview projection below 0.68 and returns to Groups above 0.82. Scale is the initial viewBox width divided by current camera width. The gaps are hysteresis: small wheel or keyboard zoom changes near a boundary do not flicker between levels. These deterministic policy values are centralized in the browser runtime and are not Studio controls.

`{ "mode": "groups" }` locks grouped detail and `{ "mode": "projects" }` locks project detail; camera movement does not override either. Config v7 remains unchanged. Legacy `{ "enabled": true, "level": "groups" }` and `level: "overview"` normalize to Groups; legacy `enabled: true, level: "projects"` and any `enabled: false` normalize to Projects, matching the prior render behavior. Studio saves the new `mode` form.

Pass `{ semanticLevel: 'groups' }` to `renderSceneSVG` or `renderSceneHTML` for an explicit grouped export. Use `projects` for full project detail. A grouped SVG shows a distinct hexagon, its family/derived type and project count. Its accessible title identifies the compressed members. Static SVG generated with the `readme` export profile uses a bounded density pass; interactive HTML and the Web Component retain their normal Semantic Zoom behavior. README output with at least 30 visible projects selects Groups when groups exist unless Projects was explicitly requested.

## Project families

Add an optional `projectFamilies` object to config. Authored IDs are stable and remain unchanged by labels or style:

```json
{
  "projectFamilies": {
    "open-tooling": {
      "label": "Open Tooling",
      "members": ["owner/open.release", "owner/open.text", "owner/open.slug"]
    }
  }
}
```

Core emits `group:user:open-tooling`. Members absent from a filtered scene are ignored; a family is projected only when at least two members are present. A project cannot belong to more than one family in a projection. The authored label is preserved. Group evidence says “Defined by you.”

## Derived groups and trust

The v3.12.0 derived rule groups repositories with the same repository owner. Repository-owner grouping means repositories share the same owner namespace. It does not assert that the owner is a GitHub Organization. It requires at least two selected projects, must cover no more than 75% of the scene, and runs only through 256 projects. Derived repository-owner group identity is based on normalized owner identity, not the currently visible project membership. Its basis is `repository-owner:<owner>`; names, language similarity, topics and contributor overlap do not independently create groups. Scenes above 256 projects use authored families only. Weak metadata similarity stays ungrouped.

## Core API

`buildSemanticHierarchy(scene, options?)` returns the source scene, stable group records and project IDs. `projectSemanticLevel(scene, level, { hierarchy, expanded })` returns a separate scene projection. `expandGroup(scene, hierarchy, groupId)` and `collapseGroup(...)` return a new projection while retaining original project IDs and geometry. `explainGroup(hierarchy, groupId)` is the canonical structured explanation and returns the grouping basis, exact member count, bounded examples and characteristics computed from current member metadata.

Grouping basis explains why a semantic group exists. Characteristics describe member metadata and do not imply that they caused the grouping. User-authored project families remain authoritative user intent: their only grouping reason is “Defined by you.” The explanation does not infer why the author created a family. Derived groups explain that members share a repository owner. Shared repository ownership does not imply shared purpose, architecture, or organizational identity beyond the repository namespace. Characteristics count each visible member at most once per value, retain exact `count` and `total`, apply the five-language/eight-topic caps, then sort the combined list by count descending, kind and normalized value. At most eight member examples are returned.

Inter-group edges are created only from real scene edges whose endpoints project to different visible nodes. Aggregate edges retain up to 256 source edge IDs while preserving the complete underlying relationship count. Explanations report truncation from the total relationship count versus retained IDs. Shared language/topic reasons are included only when every represented edge carries that reason. Internal relationships are not drawn as self-loops.

The Core computations are deterministic JavaScript domain logic; they need no DOM, network, AI, or Rust computation. Existing WASM remains responsible for graph layout and traversal. Manual project geometry remains on the canonical scene; group positions use the member centroid and expanded members recover their original coordinates. No generated project record is written to source data.

## Evidence and interaction

Scene Evidence v1 accepts group subjects while keeping existing node attachments valid. The projected group has a user fact or bounded derived basis fact. Projected semantic explanations are bounded and validated when scenes are parsed; scenes without explanations remain valid. Group characteristics and aggregate relationship evidence use the same bounded secret-filtering policy as Scene Evidence. Aggregate relationship explanations preserve complete counts, retain at most 256 source edge IDs and show at most five deterministic examples that reference real source edges. Universal evidence is present on every represented relationship; partial/common evidence carries its exact count over the complete relationship total. Evidence counts are computed before reference caps and never imply that partial evidence caused the connection. SVG group descriptions remain concise.

Group characteristics are computed in Core when an explanation is requested or a semantic projection is built. The projection is reused across camera movement; theme and camera changes do not trigger characteristic recomputation. There is no cross-scene cache: the measured explanation work is small at the supported project limits, and avoiding retained cache state keeps canonical scene replacement isolated. `node scripts/benchmark-semantic-groups.mjs` reports hierarchy/projection, group/aggregate explanation and repeat explanation timings at 45, 256 and 2,048 projects.

For static README exports, group nodes are resized from member count within a bounded range; this size represents only member count. Aggregate edge visual weight reflects the number of represented source relationships, not dependency strength or project importance. Labels are prioritized deterministically: groups first, then focused or user-curated projects, then other projects. Width and visible-node density set the label budget; colliding low-priority labels are suppressed while their node titles remain available to assistive technology. The export-only layout refinement adjusts group positions without changing identities, memberships, evidence or source relationships.

The Web Component exposes `semanticLevel = 'auto' | 'groups' | 'projects'`, `expandGroup(id)`, and `collapseGroup(id)`. Switching to Auto evaluates the current camera immediately. When the canonical scene/data changes, semantic navigation resets to a safe grouped state and cancels pending camera decisions. Auto expansion opens the selected project's containing group first; without a selection, automatic project detail is limited to scenes of at most 256 projects. A selected group expands only when it has at most 128 members. Other groups remain collapsed. While already in Projects detail, selecting another eligible group or one of its projects hands local expansion to that group without changing semantic level. When detail collapses, a selected project maps to its containing group. When a group expands, its inspector context remains available without selecting an arbitrary child. Rebuilding a projection keeps the camera viewBox and logical focus; it never fits all nodes again.

Camera decisions run after a 140 ms quiet period, rather than rebuilding projections on every wheel event. Each actual transition emits `semantic-level-change` with `previous`, `current`, and `reason` (`camera`, `user`, `group-expand`, or `group-collapse`) when the level changes or a manual group action occurs. The live status announces actual level changes. Existing reduced-motion handling suppresses animation while retaining the same semantic transitions.

Grouped `renderSceneHTML` is a self-contained offline artifact with inline runtime/WASM and the existing CSP. It supports individual group expand/collapse when the source scene has at most 256 projects, is at most 256 KiB, has at most 32 groups, and the precomputed SVG states fit within a 4 MiB bound. Automatic mode also precomputes the project-level artifact within that same bound. Larger exports keep the grouped view and explanations, omit automatic project expansion, announce that the deeper offline artifact is unavailable, and make no network requests. Manual expansion and collapse remain available when their artifacts fit. Camera state and semantic parent context are preserved across replacements.

## Bounds and compatibility

- 2,048 source projects per scene (existing Scene API v1 bound).
- 256 family definitions and 256 total projected groups.
- 2,048 members per family and 32,768 configured member references in total.
- Derived repository-owner grouping disabled above 256 projects.
- 256 edge references per aggregate; full relationship count retained.
- Config remains v7; Scene API, Evidence and Web Component APIs remain version 1.

No repository file tree, dependency parsing, source nodes, AI grouping, or project-purpose inference is part of this release.

## Benchmark snapshot

`node scripts/benchmark-semantic-groups.mjs` measures hierarchy build, projection, expand/collapse, JSON sizes and offline HTML size on this implementation. One local run produced:

| Projects | Groups | Hierarchy | Projection | Expand | Collapse | Source JSON | Grouped JSON | Offline HTML |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 45 | 8 | 4.30 ms | 4.28 ms | 1.86 ms | 1.16 ms | 31,997 B | 19,284 B | 1,131,945 B |
| 256 | 8 | 1.56 ms | 4.73 ms | 5.47 ms | 4.32 ms | 173,491 B | 40,789 B | 1,838,356 B |
| 2,048 | 1 authored | 14.01 ms | 47.13 ms | 54.49 ms | 44.79 ms | 1,390,886 B | 1,438,516 B | 4,180,789 B |

The 2,048 project case deliberately disables derived grouping; the benchmark uses one authored family. Timings are a single local run and are diagnostic, not performance guarantees. At that maximum scene size a single partial family does not reduce serialized size, so grouped export should be chosen when the family meaningfully compresses the visible graph.

# Developer Atlas

Developer Atlas is a navigation layer over Semantic Graph v1. It keeps three concerns separate:

- **Semantic Graph** records what exists, including stable IDs, relationships, provenance, and Evidence v1.
- **Atlas State v1** records which developer, group, project, or structural node is open.
- **Scene v1** is the deterministic projection rendered for the current state.

Navigation does not write to the graph. Its fingerprint, canonical JSON, provenance, Evidence v1, and Semantic Markdown remain stable. Atlas state also stays separate from camera position and semantic zoom.

## Navigation

The levels are `developer`, `group`, `project`, and `structure`. Groups and projects are resolved by canonical IDs in the active graph. A project entered from a group keeps that group in its breadcrumb. A project opened directly from Developer has no invented group parent. Structural nodes use the IDs and parent relationships from an already available Project Constellation graph.

Back/Forward history is bounded to 32 entries and commits only after the new projection renders. On a semantic fingerprint change, the active route is validated against the new graph. A still-valid route and its entered group path are preserved; invalid history entries are removed. If the active project disappears, navigation falls back to its entered group when that group remains valid. If the group also disappears, it returns to Developer. A missing structural node falls back to its Project.

Presentation-only changes with the same semantic fingerprint preserve Atlas navigation. Account changes, imported graph replacement, and live/imported mode changes start at the new graph's Developer root. Breadcrumbs use labels only for display and retain canonical IDs for navigation. `serializeAtlasState` returns a small URLSearchParams value with `v=1`; it does not include graph contents, camera geometry, credentials, or source text. Navigation state remains separate from transient camera, selection, and keyboard focus.

## Context and evidence

Group context exposes the canonical group label, provenance, basis, members, relationships, and existing evidence. `user` groups remain user-authored and `derived` groups remain derived. Project context uses only metadata and relationships present in the graph. Structural context reports the existing structural node and edge facts. No job role, architectural importance, or other unsupported interpretation is inferred.

## Activation

Developer Atlas works in both live Scene and imported Semantic Graph workflows through Core and the Web Component. The Studio does not show Atlas navigation since v5.0.0. In live mode, Atlas uses the Semantic Graph derived from the canonical live Scene, then projects that graph for the current Atlas level. Presentation changes preserve the current Atlas route when the semantic fingerprint is unchanged. The canonical live Scene remains the source for semantic exports.

Live project structure is loaded only after an explicit bounded scan from Project context. Entering a Project does not make a GitHub request. A successful scan is converted to Project Semantic Graph v1 and opens Structure; a failed scan leaves the active Project and history in place. The current project's validated structure graph is reused when the user returns and explores it again. It is cleared when the project changes or semantic refresh cannot establish that the scanned ref is still current; returning to the Project then offers a fresh bounded scan.

The active group-to-project path is retained when valid, including when a project belongs to multiple groups. Saved project selections use canonical `owner/repository` identities; repository ordering and duplicate display names do not change which project is selected.

## Imported and offline graphs

Developer, group, and project navigation works from an imported Semantic Graph without GitHub access. A graph without Project Constellation data shows that structural detail is not included. It does not fetch structure automatically. Imported Project context does not show live scan controls.

Project paths are displayed as text. Raw source is not exposed. Private-source warnings already associated with Semantic Graph exports continue to apply.

## Web Component

For developer Semantic Graph inputs, `<constellation-view>` exposes the additive `atlasState`, `atlasBreadcrumbs`, `atlasContext`, `atlasShareState`, `navigateAtlasGroup(id)`, `navigateAtlasProject(id)`, `navigateAtlasStructure(projectGraph, nodeId)`, `atlasBack()`, `atlasForward()`, and `loadAtlasShareState(value, projectGraph?)` APIs. It emits `atlas-change` after successful navigation. Reassigning a graph with the same semantic fingerprint preserves the active route; a changed graph reconciles valid routes and history, while a different developer cannot inherit the previous developer's IDs. Existing Scene/config inputs keep their existing behavior.

Atlas navigation controls remain horizontally scrollable on narrow screens, expose full labels to assistive technology, use touch-sized controls, and move focus to the restored current breadcrumb after user navigation. Successful route changes are announced once; presentation-only rerenders do not announce a new route.

## Limits

Atlas is not Semantic Graph v2. It adds no semantic node or edge kinds, AI service, AST/function analysis, or call graph. Standalone export navigation and browser URL history are not required for the Web Component navigation contract.

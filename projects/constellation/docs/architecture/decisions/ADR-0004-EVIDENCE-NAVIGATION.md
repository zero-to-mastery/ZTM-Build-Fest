# ADR-0004: Evidence Navigation and Interactive Focus

- Status: Accepted
- Date: 2026-10-11

## Context

Interactive HTML and `<constellation-view>` already supported node selection,
dimming, a details panel, and shortest-path tracing over rendered SVG edges.
Rendered edges are a presentation choice: Story Composition, label budgets, and
group projection can omit or aggregate them. A visitor exploring a portfolio
needs to know which projects relate to a selected project and why, using the
factual relationships already recorded in Semantic Graph v1, independent of what
happens to be drawn.

## Decision

Add an internal Rust/WASM Evidence Navigation v1 index over Semantic Graph v1.

- Rust owns topology: it builds a retained, bounded index once per graph and
  answers per-project queries with direct connections, the evidence references
  (semantic node and edge IDs plus provenance) for each relationship type, an
  optional bounded second degree, stable ordering, and structured diagnostics.
- The relationship vocabulary is closed and matches Story Composition:
  `explicit-relationship`, `authored-family`, `shared-language`, `shared-topic`.
  Derived repository-owner groups are reported but never become connections.
- JavaScript adapts a Scene to Semantic Graph v1 (existing
  `semanticGraphFromScene`), strips it to identities and provenance, and passes
  the navigator to the shared interactive runtime. HTML export embeds the
  compact graph as inert JSON; the Web Component derives it in the browser.
- The runtime owns focus state (overview, project, relationship), DOM, keyboard,
  announcements, and URL state. Navigation state is separate from config,
  scenes, and Atlas State. Static SVG is unchanged and needs no runtime.

## Compatibility and limits

Additive: no public schema version changes. Config v7, Scene v1, Evidence v1,
Semantic Graph v1, Semantic Markdown v1, Project Constellation v1, Atlas State
v1, and Web Component API v1 are preserved. `selectNode` keeps its signature and
events; it now also produces an evidence-backed focus.

Bounds: 4 MB graph input, 4,096 nodes, 16,384 edges, 8 KiB requests, depth 1–2,
256 connections per degree, 32 evidence references per relationship type, 16
listed intermediates, and a 262,144-visit traversal budget. Results never depend
on record order. Navigation infers no expertise, dependency, collaboration, or
chronology and produces no score of a developer.

## Verification

Native Rust and WASM tests read one shared fixture and expected output. Browser
tests cover focus, keyboard, Escape and focus restoration, touch targets,
announcements, URL history, and invalid share state. WASM size and query latency
are measured by `scripts/benchmark-evidence-navigation.mjs`.

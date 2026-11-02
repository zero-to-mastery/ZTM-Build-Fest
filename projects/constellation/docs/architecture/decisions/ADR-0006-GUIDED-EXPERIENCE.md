# ADR-0006: Guided experience is browser orchestration

> Superseded by [ADR-0008](ADR-0008-STUDIO-REBUILD.md) (Studio rebuild, v5.0.0). Kept as history.

- Status: Superseded by ADR-0008
- Date: 2026-10-11

## Decision

Extend Guided Setup and Studio around the existing evidence-gated story
candidates. Browser JavaScript owns progress, story ownership, progressive
disclosure, and publishing setup. Rust keeps recommendation, composition, and
clarity computation. The same configuration, controls, and rendering pipeline
serve Simple and Advanced Studio; switching only changes DOM presentation.

Experience progress is a separate bounded per-account browser record linked to
the normalized configuration. It is not exported into Config v7, Scene v1, or
Semantic Graph v1. An unmatched or imported configuration retains manual
ownership; choosing Auto is explicit and recomputes from current evidence.

README previews display the SVG bytes produced by the existing target-width
renderer, also used for download. Presentation estimates remain advisory.
Publishing setup is not evidence of remote installation or publication.

## Compatibility

No public contract version changes, additional AI requirement, dependencies,
network requests on mode switching, or Rust/WASM module changes.

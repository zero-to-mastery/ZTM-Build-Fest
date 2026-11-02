# ADR-0005: Publication integrity stays in the Node publisher

**Status:** Accepted  
**Date:** 2026-10-11

## Context

Publication needs bounded manifest validation, artifact digest comparison, filesystem validation, Git branch updates, and GitHub Actions orchestration. The publisher already owns hashing, file access, and Git operations in JavaScript. The Rust/WASM artifact is tightly budgeted, especially in standalone HTML and the Web Component.

## Decision

Keep the internal publication manifest and comparison helper in the Node publication layer. Use SHA-256 from Node's crypto module, validate the fixed internal manifest fields and artifact bounds there, and never add publication metadata to Config or Scene schemas. GitHub Actions remains responsible for permissions, scheduling, checkout, and push. The generated artifact is validated before any output branch mutation.

Rust does not provide a concrete benefit for this small metadata comparison: it would add serialization and WASM surface, duplicate no hashing functionality, and would not own filesystem, Git, or network behavior. If publication rules later become shared computational domain behavior across native Rust and WASM consumers, revisit this decision with measured bundle and latency costs.

## Consequences

- The manifest is an internal sidecar and is bounded to 16 KiB.
- Missing evidence identity is `unknown`; it cannot prove that source data is unchanged.
- No-op decisions use the validated artifact's SHA-256 digest. Volatile metadata is not blindly stripped.
- Failed generation or validation does not write to the output branch; publication uses an isolated worktree and non-force push with bounded retry.
- Public Config, Scene, Evidence, and Web Component contracts do not change.

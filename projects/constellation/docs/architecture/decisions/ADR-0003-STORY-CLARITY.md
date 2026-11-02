# ADR-0003: Story Clarity Diagnostics

- Status: Accepted
- Date: 2026-10-10

## Context

Story Composition selects evidence-backed relationships, and Graph Quality
evaluates candidate structure. Static exports still need a bounded way to
diagnose presentation issues against the final scene at a concrete output size.
Candidate selection and presentation legibility are different responsibilities.

## Decision

Add an internal Rust/WASM Story Clarity v1 analyzer that accepts final project,
label, relationship, group, legend, and target-size geometry. It returns stable,
structured diagnostics and advisory constraints. It does not score or select
candidates, mutate scene geometry, measure browser fonts, or make claims about
the developer.

JavaScript adapts the validated scene for the analyzer and orchestrates target
sizes. Static SVG may apply bounded label and annotation visibility choices;
manually authored placements and labels retain precedence. SVG remains the
accessible, script-free presentation layer. Config v7, Scene v1, Evidence v1,
Semantic Graph v1, and the three existing candidates do not change.

## Compatibility and limits

The analyzer is an additive internal WASM operation. Inputs and outputs have
explicit byte and collection bounds. Identical semantic inputs are independent
of record order. Estimates are not presented as browser-exact typography.

## Verification

Native Rust and WASM integration fixtures cover bounds, stable ordering,
diagnostic IDs, and suggestions. Browser tests render compact and wide SVGs and
inspect actual text and legend geometry. Human comprehension remains a manual
evaluation item; automated geometry is not user research.

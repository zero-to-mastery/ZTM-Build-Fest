# Testing and Quality

## Rust unit tests

Cover semantic validation, normalization, evidence matching, topology, traversal, layout constraints, spatial indexes, and structured diagnostics.

## Property/fuzz testing

Target externally authored specs, nested filters, extreme numbers, duplicate/invalid references, oversized collections, and graph edge cases.

Properties:

- invalid input does not panic;
- limits are enforced;
- validated specs satisfy invariants;
- deterministic inputs produce deterministic semantic outputs.

## JavaScript tests

Cover provider translation, bounded repair, cancellation, error propagation, fake-model behavior, and orchestration.

## Package isolation tests

Test outside the checkout where practical:

- WASM initializes;
- package imports resolve;
- relative WASM assets load;
- core works without Rust installed;
- Web Component resolves against matching core;
- no source-tree dependency leaks.

## Browser tests

Cover component lifecycle, scene/config updates, keyboard selection, Shadow DOM events, accessible errors/status, reduced motion, stale/cancelled network behavior, and AI plan Apply/Cancel/Undo.

## Accessibility

Verify keyboard behavior, focus, naming, status/errors, non-color cues, and reduced motion.

## Determinism

For fixed evidence/spec/reference date/seed, semantic groups, topology, IDs, and deterministic coordinates should match within documented tolerance.

## Performance

Track small/medium/large fixtures for validation, compile, layout, refinement, repeated queries, WASM init, memory, and package/WASM size.

## AI tests without AI

CI must use deterministic fake adapters for valid spec, discovery calls, invalid-then-corrected spec, repeated invalid output, provider error, and cancellation.

## Security tests

Exercise oversized strings/arrays, malformed objects, NaN/infinity, invalid URLs, unknown IDs, nested structures, and script/CSS injection-like text.

## PR checklist

- [ ] tests updated;
- [ ] offline path works;
- [ ] schema/API changes documented/versioned;
- [ ] generated core/WASM rebuilt if needed;
- [ ] compatibility checked;
- [ ] accessibility checked;
- [ ] no live AI dependency in CI;
- [ ] no unbounded external allocation/loop;
- [ ] size/performance checked for material core changes.

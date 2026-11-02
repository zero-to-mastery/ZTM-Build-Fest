# AGENTS.md — Constellation Engineering Contract

Read this before modifying Constellation.

## Mission

Constellation turns developer/project evidence into interactive, explainable visual maps.

Preserve these qualities:

- browser-native and framework-independent;
- useful without AI;
- deterministic where reproducibility matters;
- accessible and progressively enhanced;
- explainable about where claims and visual mappings come from;
- Rust/WASM-backed where Rust materially improves correctness or computation.

## Architectural mantra

> **The AI describes the universe; Rust builds the universe; the Web presents the universe.**

### AI owns
- interpreting fuzzy natural-language intent;
- proposing semantic choices;
- using bounded discovery information;
- revising a proposed spec after structured validation errors.

### Rust owns
- validated domain types;
- semantic validation and normalization;
- evidence resolution;
- graph topology and traversal;
- persistent graph indexes;
- graph constraints;
- spatial/layout computation;
- deterministic scene construction;
- structured diagnostics.

### JavaScript owns
- model/provider networking;
- GitHub/browser networking;
- DOM integration;
- Web Component registration/lifecycle;
- service workers and browser APIs;
- orchestration between provider tools and WASM.

### HTML/CSS/SVG own
- semantic structure;
- controls/accessibility;
- rendering/presentation;
- responsive layout;
- theming;
- reduced-motion behavior;
- visual-only animation.

## Non-negotiable rules

1. **Do not make AI mandatory.**
2. **Do not expose raw WASM internals as the semantic AI contract.**
3. **Treat model output as untrusted input.**
4. **Do not let model output execute code.**
5. **Do not move browser responsibilities into Rust merely to increase Rust usage.**
6. **Do move computational/domain responsibilities into Rust when the benefit is real.**
7. **Preserve stable public contracts and migrations.**
8. **Keep deterministic behavior explicit.**
9. **Evidence is not evaluation.**
10. **Accessibility is part of correctness.**

## Before coding

Answer:

- What layer owns this responsibility?
- Is there already a stable contract for it?
- Is this semantic, computational, rendering, acquisition, or orchestration work?
- Does Rust provide a concrete benefit here?
- Does this alter config/schema/API compatibility?
- Can the behavior be tested offline?
- Can invalid input cause excessive allocation, panic, code execution, or state corruption?
- Does the change preserve non-AI workflows?

If ownership is ambiguous, add/update an ADR first.

## Expected workflow

1. Read relevant docs.
2. Find the canonical implementation location.
3. Add/update tests.
4. Implement the smallest coherent change.
5. Rebuild generated core/WASM artifacts when required.
6. Run relevant unit/integration/package/browser tests.
7. Update public docs when behavior changes.
8. Record long-lived architecture decisions in ADRs.
9. In the PR, explain layer ownership, compatibility, and tests.

## Rust rules

- Prefer typed IDs/newtypes over meaningful raw strings/integers internally.
- Prefer enums for closed semantic vocabularies.
- Reject NaN/infinity and bound external numeric values.
- Bound all externally controlled collection sizes.
- Avoid panics on externally authored data.
- Return structured errors at public boundaries.
- Separate raw serialization types from validated domain types when useful.
- Reuse retained indexes instead of rebuilding topology per interaction.
- Benchmark before low-level optimization.

## Web rules

- Prefer semantic HTML and platform APIs before libraries.
- Keep `<constellation-view>` framework-neutral.
- Do not make rendering depend on an AI SDK.
- Keep Shadow DOM APIs intentional and themeable.
- Respect reduced motion.
- Keep network acquisition cancellable and bounded.
- Never serialize secrets into configs, scenes, attributes, share links, or exports.

## Stop conditions

Stop and raise an architecture question if a change:

- makes AI a hard dependency;
- asks the model to author raw scene geometry as the primary contract;
- requires arbitrary generated code execution;
- breaks compatibility without a migration plan;
- moves DOM/browser responsibilities into Rust for language-percentage reasons;
- duplicates a canonical data model;
- makes claims beyond available evidence;
- removes accessibility behavior;
- introduces unbounded model/tool retry loops.

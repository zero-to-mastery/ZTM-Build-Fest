# Security and Trust Boundaries

Treat AI output, imported specs/configs, share parameters, remote documents, source metadata, user text/CSS, and tool arguments as untrusted.

## Model boundary

A model is a suggestion engine, not an execution authority.

It cannot bypass validation, mutate Rust memory directly, select arbitrary filesystem paths, access credentials through generic tools, or create unlimited loops.

## Spec validation

Reject/normalize unknown versions/enums, invalid/duplicate IDs, non-finite numbers, out-of-range values, excessive nesting/collections, and invalid references.

Validate before mutation.

## Resource limits

Define explicit limits for groups, relationships, filter depth, strings, repository results, preview results, source documents, and repair attempts.

## Secrets

Never serialize GitHub tokens, AI keys, OAuth secrets, or session tokens into WASM state meant for export, ConstellationSpec, Scene, SVG, share URLs, component attributes, or diagnostics.

## Generated text

Escape text for its target context. Do not inject model output through unsafe HTML APIs without deliberate sanitization.

## CSS

Keep advanced CSS explicitly user-authored. Do not silently generate/apply arbitrary AI CSS as part of semantic spec compilation.

## URLs

Validate schemes and contexts. Never interpret arbitrary model strings as executable URL schemes.

## Repair loops

Must have max attempts, cancellation, no mutation before success, bounded diagnostics, and no recursively expanding tool chain.

## Integrity

Observed facts, user declarations, and model interpretations must remain distinguishable.

## Denial of service

Rust memory safety does not prevent resource exhaustion. Watch O(n^2) algorithms, deep filters, huge strings, repeated recompilation, unbounded retries, and duplicate JS/WASM copies.

# AI Constellation Spec

## Purpose

`ConstellationSpec` is the semantic contract between ambiguous human intent and deterministic Constellation computation.

It should be usable by AI tool calls, JavaScript clients, a future DSL, presets/forms, tests, fixtures, and MCP/tool protocols.

AI is not required.

## Principle

> The model proposes meaning. Rust validates and compiles meaning.

The model should not normally produce raw coordinates, physics iterations, WASM internals, executable expressions, arbitrary JS/CSS, or direct mutation commands that bypass validation.

## Illustrative shape

```json
{
  "schema_version": 1,
  "focus": { "kind": "language", "value": "Rust" },
  "groups": [
    {
      "id": "systems",
      "label": "Systems work",
      "match": {
        "any": [
          { "language": "Rust" },
          { "topic": "wasm" },
          { "topic": "systems" }
        ]
      },
      "placement": "inner"
    }
  ],
  "relationships": [
    { "basis": "shared_topic", "strength": 1.0 },
    { "basis": "shared_language", "strength": 0.6 }
  ],
  "layout": {
    "kind": "radial",
    "cluster_by": ["topic", "language"]
  }
}
```

## Raw vs validated types

```text
external JSON / JsValue
        |
        v
RawConstellationSpec
        |
        | TryFrom + diagnostics
        v
ConstellationSpec
        |
        | semantic compilation
        v
CompiledGraphIntent
```

`ConstellationSpec` should represent only valid normalized states.

## Validation requirements

Validate schema version, enum values, IDs, duplicate IDs, numeric finite-ness/ranges, maximum counts, maximum string lengths, references, unsupported combinations, and nested filter depth.

Every externally controlled collection needs an explicit bound.

## Diagnostics

Example:

```json
{
  "code": "unknown_filter",
  "path": "groups[1].match.foo",
  "message": "Unknown repository filter: foo",
  "allowed": ["language", "topic", "role", "stars", "updated"]
}
```

Prefer stable code + path + message + optional bounds/allowed values.

## Grounding tools

Recommended provider-neutral operations:

- `list_languages()`
- `list_topics()`
- `find_repositories(filter)`
- `describe_repository(id)`
- `preview_group(group_spec)`
- `validate_spec(spec)`
- `compile_spec(spec)`

Outputs should be bounded and use stable IDs.

## Repair loop

```text
model proposes spec
       |
       v
Rust validates
       |
   invalid?
    /    \
  yes     no
  |        |
diagnostic compile
  |
  v
model may repair
```

Retry count must be bounded. No scene mutation occurs before validation succeeds.

## User control

Preferred Studio flow:

1. describe desired constellation;
2. model proposes spec;
3. Rust validates/previews;
4. UI explains groups/relationships/matches;
5. user applies;
6. change participates in Undo;
7. follow-up prompts create revised specs.

## Evidence integrity

Do not disguise model interpretation as repository fact. Distinguish observed evidence, user-declared roles, and AI-authored interpretation.

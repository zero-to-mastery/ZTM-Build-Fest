# Agent Workflow

## 1. Classify the change

Choose a primary category: source acquisition, semantic contract, Rust engine, WASM bridge, renderer, Web Component, Studio UX, AI adapter, packaging/build, or docs.

If a task spans more than two architectural categories, consider splitting it.

## 2. Find the canonical contract

Locate existing config, scene, Web Component, plugin/source/theme/layout, Rust serialization, and package-build contracts before editing.

Do not invent a second representation because finding the first was inconvenient.

## 3. State ownership

Write:

> This belongs in ___ because ___.

Examples:

> Rust, because it validates untrusted semantic input and establishes domain invariants.

> JavaScript, because it is provider-specific network orchestration.

> CSS, because it is purely visual state.

## 4. Work contract-first

Preferred order:

1. tests/fixture;
2. type/schema;
3. validation;
4. core implementation;
5. adapter;
6. UI;
7. docs.

## 5. Keep AI optional

Prove AI-related behavior with a hand-written spec or fake adapter before connecting a live provider.

## 6. Validate before mutate

Preferred:

```text
parse -> validate -> normalize -> compile -> apply
```

Avoid partial mutation followed by rollback.

## 7. Rebuild generated artifacts

When Rust/core changes require generated package/WASM output, rebuild it. Do not hand-edit generated glue.

## 8. Verify offline

Use fixture-based core/CLI paths, package isolation, fake-provider tests, and browser fixtures.

## 9. Report clearly

Summaries should list files changed, contract changes, compatibility, tests, limitations, and genuinely separate follow-ups.

## 10. Leave breadcrumbs

When discovering an architectural trap, fix docs, add a test, add an ADR, or add a targeted code comment.

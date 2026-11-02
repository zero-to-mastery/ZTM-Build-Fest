# ADR 0004: Derive portable projections from the canonical work

- Status: Accepted
- Date: 2026-10-24
- Decision issue: [#103](https://github.com/journey-to-code-org/open.blog/issues/103)
- Parent story: [#93](https://github.com/journey-to-code-org/open.blog/issues/93)
- Parent epic: [#92](https://github.com/journey-to-code-org/open.blog/issues/92)

## Context

open.blog publishes author-owned Markdown through content profiles and reusable
publishing capabilities. Native pages, feeds, and syndication destinations need
representations suitable for their readers without creating competing source documents
or implying that a destination can reproduce every interaction.

The existing domain already distinguishes a `Document`, a `Published work`, a
`Content profile`, a `Publishing capability`, a `Work identifier`, a `Reference`, and
`Work credit`. Portability must preserve these distinctions. In particular, a capability
describes authored semantics; a presentation widget is one way to edit or display them,
and a destination payload is one transport-specific encoding.

Authoring inputs, including Markdown, raw HTML, metadata, imports, and provider responses,
are untrusted. Private research and collaboration state must not become public merely
because a destination projection is requested.

## Decision

The canonical author-owned document and the existing parsed domain model remain the sole
editable source of truth. Portable HTML, Markdown, text, feed content, and destination
payloads are derived projections of that model. A projection must not create a second
document model, reparse generated HTML to recover semantics, or rewrite canonical content
to fit a destination.

Each publishing capability is evaluated according to its semantics, not its editor or
renderer widget. A destination policy declares the representation and fallback for that
capability and uses one of these portability levels:

- **Fully portable**: the portable representation preserves the capability's authored
  meaning and remains usable without open.blog's native interaction runtime.
- **Gracefully transformed**: a destination-specific or simpler representation preserves
  the essential content and attribution, while any material semantic loss is reported.
- **Canonical-only interaction**: no equivalent portable interaction is claimed. The
  output identifies the limitation and may direct readers to the public canonical work.

Projections preserve available semantic content, attribution, reference identity, source
provenance, and the canonical URL. A remote copy's URL or provider identifier does not
replace the canonical identity of the published work. A source path, source identifier,
work identifier, canonical URL, and remote destination identifier are distinct values;
adapters must not conflate them.

Only data explicitly eligible for public output may enter a public projection. Private
authoring, research, and collaboration state is excluded by default. Public research or
other private-derived context requires an explicit author-approved projection; its
selection does not expose the underlying private state.

Validation and projection failures are scoped to the affected source, capability, and
destination. They do not mutate canonical content or private state, and a failed
projection or preflight does not initiate a remote write. Remote mutations remain behind
the destination's explicit write policy; failures must not trigger writes to other
destinations or automatic remote deletion.

Existing native pages, feeds, and legacy posts retain their current behavior unless an
explicit migration or author-selected publishing change applies. This decision defines
contracts only; it does not introduce conversion code or production interfaces.

## Consequences

- Every output can be traced to the same parsed work while keeping authoring and portable
  delivery separate.
- Capability semantics remain stable even when editor widgets, themes, or destination
  payload formats change.
- Authors and tools can distinguish preserved behavior from intentional transformation
  and canonical-only interactions.
- Private state requires an explicit public projection, reducing accidental publication
  and cross-destination disclosure.
- Destination-specific conversion, diagnostics, and portable previews can be added in
  later slices without silently changing the canonical source.
- Legacy output stays compatible until a separately scoped migration is chosen.

## Domain language

The terms **Semantic representation**, **Portable representation**, **Portable fallback**,
**Portability level**, **Semantic loss**, and **Destination policy** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

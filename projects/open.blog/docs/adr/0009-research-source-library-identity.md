# ADR 0009: Keep research sources as distinct, stably identified records

- Status: Accepted
- Date: 2026-10-24
- Decision issue: [#32](https://github.com/journey-to-code-org/open.blog/issues/32)
- Parent story: [#17](https://github.com/journey-to-code-org/open.blog/issues/17)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Contract: [Research source library format](../specs/research-source-library.md)

## Context

Writers reuse the same sources across many posts: an ancient work, a modern critical
edition of it, a translation made from that edition, the manuscript a reading comes from,
and the specific pages being cited. Bibliography tools often flatten these into one
"item" with a type flag, which loses the difference between what was written, which text
was read, and which copy attests it. Later research features (passages #18, citations
#19, comparison #22, publication #24) and Shared Perspectives source descriptors all need
one stable identity to point at.

Contributor credits (ADR 0003) already describe who made a post. They are attribution,
not bibliography, and must not become a second way to cite a source. ADR 0004 requires
private research state to stay out of public output unless an explicit projection
approves it.

## Decision

The research source library is a private, versioned JSON document owned by
`openblog_core::source_library`. It holds an ordered list of records. Each record has an
author-assigned **source identifier** and exactly one **kind**: `work`, `edition`,
`translation`, `witness`, or `reference`. Kinds are never collapsed into one another:

- A **work** stands alone and has no `of`.
- An **edition** is `of` a work or a translation.
- A **translation** is `of` a work, needs a language tag, and may be `basedOn` the edition,
  witness, or translation it was made from; that text must belong to the same work.
- A **witness** is `of` a work, edition, or translation.
- A **reference** is `of` a work, edition, translation, or witness, never another reference,
  and alone may carry a **source location**. Pages need an edition, translation, or witness;
  folios need a witness.

Source identifiers are lowercase ASCII slugs of at most 64 bytes, unique across all kinds.
They do not derive from titles, and editing a record never changes its kind: changing what
a record is means creating a new record. The library does not remember identifiers of
removed records, so reusing one after removal is the caller's responsibility; retired-id
tracking can arrive with storage (#33) without changing this format. DOIs, ISBNs, ISSNs, URLs, and other
scheme-qualified **bibliographic identifiers** describe a record but never replace its
source identifier. Known schemes are checked offline; URLs must be absolute HTTP(S)
without credentials.

Creators on a record are descriptive names with an optional bibliographic role. A record
can never name a contributor, carry credit fields at any depth, or point `of` at a
contributor key, and a credit sidecar is rejected as a library. Credit sidecars stay closed to source
fields in the other direction.

The file is `{ "version": 1, "sources": [...] }`. Fields this release does not understand
are preserved verbatim at the library, record, creator, identifier, and location levels,
but may not reuse a defined field's name, and serialization is deterministic. The 4 MiB
limit applies to the canonical written form as well as to the text read, so every accepted
library can be saved, re-read, and shrunk. A newer version is refused rather than reinterpreted.
Parsing reports every problem at once as diagnostics scoped to the library, a record
index and identifier, and a field path. Validation is all-or-nothing: `upsert` and
`remove` change the in-memory library only when the result is valid, so a failed change
leaves it, and any file a caller would write from it, unchanged.

This decision defines the contract only. Storage location, atomic writes and stale-write
detection (#33), Admin management (#34), import and export (#35), citation formatting
(#19), and any public projection (#24, #63) are separate slices that build on it.

## Consequences

- Each research feature can point at exactly the entity it means, and edition-specific
  facts such as pages cannot silently attach to an abstract work.
- Unknown fields survive round trips, so a newer open.blog or another tool can add data
  without an older editor discarding it.
- Authors must create more records than a flat bibliography would ask for; Admin and
  import tooling are expected to create the common chains for them.
- The library is not content: the content loader ignores it, it never reaches pages,
  feeds, search, or exports, and making any of it public requires an explicit projection.
- Validation stays syntactic and offline. It never checks that an identifier resolves, that
  metadata is accurate, or that a source is authoritative.
- Numbers in unknown fields that exceed 64-bit integer or double precision are not
  guaranteed to round-trip digit-for-digit; tools should store such values as strings.

## Domain language

The terms **Source library**, **Source identifier**, **Work**, **Edition**,
**Translation**, **Witness**, **Reference**, **Bibliographic identifier**, and
**Source location** are defined in [`CONTEXT.md`](../../CONTEXT.md).

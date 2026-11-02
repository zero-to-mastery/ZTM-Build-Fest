# ADR 0168: The atlas query projection is derived from the public atlas alone and is one more listed artifact

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#72](https://github.com/journey-to-code-org/open.blog/issues/72)
- Parent story: [#27](https://github.com/journey-to-code-org/open.blog/issues/27)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0053](0053-knowledge-atlas-entries-keep-their-kind.md),
  [ADR 0054](0054-attributed-evidence-based-relationships.md),
  [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#query-projection)

## Context

B3 lets a reader open an author-approved explanation of a concept, person or work from an article
(#73, #74) and follow attributed relationships (#75). Those components and site search need
bounded page data, not the whole of `atlas.json`, and need to ask the same few questions of it:
what is this term, what does this entry say in brief, which relationships touch it, who asserts
each and on what. ADR 0058 left "B3.1 decides search" and said a query "cannot traverse outside"
the published projection because nothing else is published. This ADR makes that a rule the code
enforces rather than a property of where the data happens to live.

## Decision

- **One input: the public atlas.** `openblog_core::atlas_query::AtlasQuery::project` takes a
  `&PublicAtlas`, the site author's public name and the site's base path (ADR 0171), and nothing
  else: no private atlas, notebook, source library or other configuration. It
  therefore cannot name an unapproved entry, an unsourced or notebook-passage relationship, a
  relationship touching a private entry, or a source no published item cites. It also re-checks
  what it rests on instead of trusting it: every relationship joins two published entries, cites at
  least one source, every cited or attributing source is in the atlas's published sources, ids are
  slugs and unique, and every address is a root-relative address under `/atlas/`.
- **An allowlist again.** The query types name exactly what they carry. An entry: `id`, `kind`,
  `label`, `aliases`, `source` (a work's), `preview`, `previewClipped`, `url`, and the ids of the relationships that start
  (`out`) and end (`in`) there. A relationship: `id`, `kind`, `from`, `to` (the stored direction),
  `label`, `inverseLabel`, `assertedBy`, `confidence`, `standing`, `dissents` (a count), `evidence`
  (source id and locators), `uncertainty`, `uncertaintyClipped` and `url`; ADR 0171 adds the
  pages' own wording as text fields. A source: `id` and its
  public plain `text`. Datings, dissent text and entry summaries beyond the first paragraph are not
  copied: they stay on the pages and in `atlas.json`, which each entry and relationship links to.
  Adding a published atlas field publishes nothing here until it is added here.
- **Direction and sources survive.** A relationship is read `from` `kind` `to`; the reverse
  reading is `inverseLabel`, never a second assertion. The asserting party, its confidence and
  `standing` (`asserted` or `contested`, never agreed) and every cited source with its locators
  are kept, and `uncertainty` stays beside them.
- **One more listed artifact.** The file is `atlas-query.json`, written only while the site
  publishes its atlas (`knowledgeAtlas.publish`) and no other switch exists. With the atlas off no
  build reads the atlas and the output is byte for byte what it was. Its format is
  `openblog-atlas-query` version 1, and it has no `version` key, so it is never mistaken for private
  research. The publication-boundary manifest gains a projection, `atlas-query`, that lists every
  entry and relationship the file holds with the fields it copies; the build's last check refuses
  the file if it names an entry or relationship that the Atlas projection or the query projection
  does not publish, and the per-field text guard reads it with the other projection data. It is not
  a page, so it is not in the sitemap and search, feeds, `llms.txt` and portable exports are
  unchanged.
- **Deterministic.** Entries, relationships, sources and terms are sorted; nothing depends on
  time, locale, stored order or the platform. The same published atlas gives the same bytes.
- **Conservative and reversible.** Nothing here emails, publishes real people beyond what ADR 0058
  already publishes, or fixes a stored schema: the file is regenerated at every build and can be
  removed or reshaped by a later format version.

## Consequences

- #73, #74 and #75 read `atlas-query.json` (or call `AtlasQuery` in Rust) and cannot reach outside
  the published atlas; an id they do not find has no answer.
- Search can index `terms` and entry previews in a later task without a new publication decision.
- The preview in Admin ("What will be public") shows the query file's items beside the atlas's.

## Domain language

**Atlas query projection** is defined in [`CONTEXT.md`](../../CONTEXT.md).

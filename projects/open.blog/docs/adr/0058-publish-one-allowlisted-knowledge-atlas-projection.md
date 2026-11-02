# ADR 0058: Publish the approved Knowledge Atlas as one allowlisted projection, as pages and `atlas.json`

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#51](https://github.com/journey-to-code-org/open.blog/issues/51)
- Parent story: [#21](https://github.com/journey-to-code-org/open.blog/issues/21)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0044](0044-what-a-citation-makes-public.md),
  [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md),
  [ADR 0053](0053-knowledge-atlas-entries-keep-their-kind.md),
  [ADR 0054](0054-attributed-evidence-based-relationships.md),
  [ADR 0055](0055-private-knowledge-atlas-storage.md)
- Amends: [ADR 0055](0055-private-knowledge-atlas-storage.md) (a build now reads the atlas, only
  when the site opts in)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md)

## Context

ADR 0053 made approval the author's recorded consent for a publication projection and left the
projection to this slice. The atlas holds the author's unreviewed readings about real people, so
the public boundary must be a short explicit list, not a filter over the private record. Issue
#92 gives each public surface one projection that every representation reads, and B3.1 (#72)
will build a public query projection and components on top of what is published here, so the
artifact has to be reusable as data, not only as markup. Existing sites must build byte for byte
as before.

## Decision

- **Opt in per site, consent per item.** Publication needs both `"knowledgeAtlas": {"publish":
  true}` in `openblog.json` and per-item approval. While the switch is off (the default, and
  omitted from the written configuration) no build reads the atlas, so a site that never opts in
  is unaffected even by a damaged atlas, and a project that recorded approvals before this release
  publishes nothing until its author turns publication on. Turning it off withdraws everything at
  the next build. This is the conservative, reversible choice for output that names real people.
- **One projection, `PublicAtlas`.** `openblog_core::atlas_publication::PublicAtlas::project`
  takes the validated atlas and the source library, and nothing else; the notebook is not an
  input. It copies the entries `Atlas::projected` returns (approved) and the relationships it
  returns (`Atlas::is_projected`: approved, sourced, no notebook passage, both entries approved),
  then re-checks that every relationship joins published entries. The native pages and
  `atlas.json` are both rendered from that one value; no surface reads the private atlas.
- **An allowlist of fields.** Public types name exactly what is published:
  - entry: `id`, `kind`, `label`, `aliases`, `summary`, a work's `source`, `bounds.from` and
    `bounds.until`, and its canonical `url` (amended by
    [ADR 0095](0095-atlas-version-2-supersedes-bounds-and-keeps-datings-private.md): `bounds`
    no longer exists; [ADR 0099](0099-approved-datings-publish-through-the-atlas-projection.md)
    publishes projected datings in their own allowlisted `datings` list);
  - relationship: `id`, `kind`, `from`, `to` (the stored direction), `label` and
    `inverseLabel` (display words only), `assertedBy`, `confidence`, `evidence` (source id and
    public locators: kind, value, end), `uncertainty`, the derived `standing`, and
    `contestedBy` (each party, its evidence and note);
  - party: `kind` and its `source` or `name`;
  - source: the citation allowlist of ADR 0044 (`PublicReference`) and its plain-text rendering,
    for exactly the sources published items cite, attribute to or stand for.

  Visibility, the unsourced flag, notebook passage ids, unknown fields at every level, private
  entries, private relationships, relationships touching a private entry, notebook notes and
  sources nothing published uses have no place in these types. Adding a stored field publishes
  nothing until it is added here.
- **Contested is never consensus.** Each relationship carries `standing` (`asserted` or
  `contested`) and every dissent. Pages say "Contested: N recorded dissents" and list who disputes
  it and why; an asserted relationship says that no disagreement is recorded, which is not a claim
  that it is agreed. Confidence is labelled as how firmly the asserting party holds the claim.
- **Where it goes: both.** `/atlas/` lists published entries by kind; `/atlas/<id>/` shows an
  entry's prose and its relationships from and to it, each read in the stored direction, with
  attribution, confidence, cited references and locators, uncertainty and dissent, as semantic
  HTML that needs no JavaScript and no new stylesheet or script (amended by
  [ADR 0100](0100-the-public-timeline-is-a-progressive-ordered-list-with-relative-trails.md):
  when datings are published, `/atlas/` also carries the timeline and loads its one component). `/atlas.json` is the same
  projection as data: `{"format": "openblog-atlas-projection", "formatVersion": 1, "entries",
  "relationships", "sources"}`, compact, with root-relative URLs (prefixed with a site's base
  path) and `<`, `>` and `&` escaped so it can be embedded in a page. It has no `version` key,
  so it is never mistaken for private research. The index and entry pages join the sitemap;
  feeds, search, `llms.txt` and portable exports are unchanged (B3.1 decides search).
- **Deterministic.** Entries, relationships and sources are sorted by id, so the output does not
  depend on stored order; nothing depends on time or locale.
- **Withdrawal is an ordinary edit.** Clearing an item's approval (or an entry's, which withdraws
  every relationship touching it) removes it from the next build, whose stale-file pass deletes
  its page. The build never writes the atlas. While the site publishes its atlas, a saved Admin
  atlas change rebuilds the site at once and reports the outcome as `build`, so a withdrawal is
  live without waiting for another save.
- **Failures refuse before writing.** A published atlas is read through `atlas_store` exactly as
  Admin reads it. If it, the library or the notebook cannot be read or validated, the build and
  `check` stop before generating anything, naming the file and ids only, and the previous output
  stays as it was. `atlas` is a reserved path only while the atlas is published, so an existing
  page at `/atlas/` keeps working until then and is then refused with a message naming it.
- **Only a build that can read the atlas publishes it.** The atlas is private and Git-ignored,
  so a build from a clone (CI, a static host) finds none and would publish an empty `/atlas/`
  and `atlas.json`. Such a build is not refused, since an empty atlas is valid and the rest of
  the site is unaffected, but `build` and `check` warn whenever publishing is on and no atlas is
  stored, naming the file. The atlas is published by `openblog serve` and Admin, or by a local
  `openblog build` whose output is then uploaded. Committing the private atlas is not offered.
- **Guards.** The private-research guard still refuses atlas-shaped files in public inputs, and a
  new last check refuses to write any generated file shaped like private research. The leak
  corpus seeds a sentinel in every field and proves that approved fields reach only the atlas
  pages, `atlas.json` and the sitemap, that unknown fields and private items reach nothing, and
  that withdrawal removes them all.

## Consequences

- B3.1 (#72) can serve queries over `PublicAtlas` or `atlas.json` and cannot traverse outside it,
  because nothing else is published.
- B3.2 (#73) can link prose to an entry's `url` only when the entry is in the projection.
- A site that publishes its atlas reveals which sources the published relationships cite, as a
  citation does, and nothing about other research.
- The pages are English, like the rest of the generated chrome; references and locators use the
  English citation strings.

## Domain language

**Atlas projection** and **Atlas publication switch** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

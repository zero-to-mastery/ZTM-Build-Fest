# ADR 0212: The public paths value is an allowlisted, deterministic projection, and nothing reads a path yet

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#76](https://github.com/journey-to-code-org/open.blog/issues/76)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md),
  [ADR 0207](0207-a-reading-path-is-its-own-content-type-and-never-a-series.md),
  [ADR 0211](0211-a-path-names-only-published-items-and-a-missing-step-is-left-out-and-reported-to-the-author-only.md)
- Contract: [Reading paths](../specs/reading-paths.md#public-projection)

## Context

#77 (Admin), #78 (pages and progress) and #79 (discovery and export) all need the same reading
of a path: which steps, in what order, with what words. If each resolves a path itself they will
disagree about what is published. #76 defines the contract and the one value they share, and
nothing more.

## Decision

- **One value.** `PublicPaths::resolve(paths, targets)` gives `PublicPaths` (format
  `openblog-reading-paths`, version 1) and the author's diagnostics. Pages, the JSON file, search and
  export in later tasks are views of it.
- **An allowlist.** A path carries `slug`, `url` (`/paths/<slug>/`), `title`, `summary`, `listed` and `steps`.
  A step carries `position`, `kind` (`post` or `atlas`), `kindLabel`, `target`, `title`, `url`,
  `rationale`, `prerequisites`, `difficulty`, `optional` and `transition` (`relationship`, `label`,
  `why`, `follows`, `basis`). There is no author step id (ADR 0211). The title and address of a target are those of the published post or atlas entry,
  never the author's copy. Nothing else is copied, and a field added to a post or the atlas reaches
  paths only when added here.
- **Deterministic.** Paths are sorted by slug, steps keep the author's order, and nothing depends on
  time, locale, file order or the platform. The JSON embed escapes `<`, `>` and `&`.
- **Derived from published inputs only**, and so safe to regenerate and cheap to drop or reshape.
- **Not wired into a build yet.** This task adds no folder scan to `Site::load`, no page, no `paths.json`,
  no sitemap, feed or search entry, no `llms.txt` line and no Admin route. A site with or without a
  `content/paths` folder builds byte for byte as before.
- **An opt-in switch, off by default.** `readingPaths.publish` (omitted from the written
  configuration while off, like `knowledgeAtlas.publish`) decides whether the site publishes
  paths. `/paths/` is reserved only while it is on, so an existing page or post at `/paths/` keeps
  working until the author opts in, and a collision when it is on is refused by the build and
  therefore by `check`, naming the page or the post URL (`pages/paths.md`, `postPath`). While it is
  off, `check` warns when path files exist beside a page or post that would collide, so the author
  learns before switching it on. Editing paths in Admin (#77) needs no switch: a path can be
  curated and previewed before anything is published.
- **`listed`, a per-path flag, is in version 1.** A published path is published at its address;
  `listed` (default true, written only when false) says whether discovery may list it, and it is
  cheap to carry now and costly to add after #79's index exists. It never publishes or hides a
  path by itself: a draft stays unpublished, and an unlisted published path stays reachable by
  its address. Nothing reads it until #79.
- **One-way doors: none.** Nothing here sends, publishes real people's data or fixes a hosted
  schema. Every file format has a version, and the label list, bounds and public field list can
  change with a version.

## Consequences

- #77 validates a draft by calling `ReadingPath::parse` and `resolve` and shows the diagnostics.
- #78 renders the value and adds the artifact to the publication manifest.
- #79 indexes and exports the value and imports through `parse` with a dry run.
- Paths stay out of feeds and the canonical post order until a later task decides otherwise, and
  #79's criterion that discovery never reorders posts holds by construction.

## Domain language

**Public reading paths** is defined in [`CONTEXT.md`](../../CONTEXT.md).

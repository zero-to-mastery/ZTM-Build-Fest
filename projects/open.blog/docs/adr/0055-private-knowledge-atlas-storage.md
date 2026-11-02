# ADR 0055: Store the Knowledge Atlas as one private, revision-checked file beside the notebook

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#49](https://github.com/journey-to-code-org/open.blog/issues/49)
- Parent story: [#21](https://github.com/journey-to-code-org/open.blog/issues/21)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0010](0010-private-source-library-storage.md),
  [ADR 0035](0035-private-notebook-storage-and-admin-capture.md),
  [ADR 0037](0037-private-notebook-lifecycle-export-and-leak-guards.md),
  [ADR 0053](0053-knowledge-atlas-entries-keep-their-kind.md),
  [ADR 0054](0054-attributed-evidence-based-relationships.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md)

## Context

ADR 0053 and 0054 defined what the atlas holds and left storage to this slice. The atlas
points into the source library (work entries, evidence, attribution) and the notebook
(evidence passages) and must copy neither. It holds the author's unreviewed readings of
who influenced whom, so it needs the notebook's privacy and corruption guarantees, not a
weaker copy of them.

## Decision

- **One private file, the notebook's safeguards.** The atlas is
  `.openblog/private/research/atlas.json`, owned by the CLI's `atlas_store`. It reuses the
  library's containment (real directories only, no symlinks), a SHA-256 **atlas revision**
  that every change names, a lock file, and a temporary-file-then-rename write through
  `fsutil::replace_file`, with reads retried through `fsutil::retry_transient` so a
  scanner's brief hold on Windows is not reported as damage. A symlinked, non-regular,
  oversized (4 MiB), non-UTF-8, damaged or newer-version file is reported with its path and
  never replaced. A refused, failed or interrupted change leaves the stored bytes unchanged,
  creates no directory, and leaves no temporary file behind.
- **Validated against the other stores as stored.** Every read parses the atlas with
  `openblog_core::knowledge_atlas` against the stored library and the stored notebook (itself
  read against that library). A damaged library or notebook blocks atlas changes without
  touching any file, because the atlas cannot be checked against it.
- **Narrow change operations.** `create_entry`, `update_entry`, `remove_entry`,
  `create_relationship`, `update_relationship` and `remove_relationship` each name the
  revision. Create refuses an id any entry or relationship uses; update refuses an unknown
  one; an entry keeps its kind. Diagnostics are the core's, scoped to collection, id and
  field, and never repeat authored text. Removing a concept that notes link to succeeds and
  returns the notes whose link became unresolved (ADR 0053).
- **Deterministic index.** `Atlas::index` builds sorted lookup tables (entries by kind,
  relationships by entry, users by source, users by passage) from file order alone. Nothing
  is indexed on disk; every read recomputes it, so it can never be stale.
- **No Admin routes yet.** The Admin atlas workspace (#50) adds routes over these operations
  behind the existing session, CSRF and deny-by-default seams, with the notebook's 409 and 422
  shapes. Until then the file is edited by hand or by tests, and `openblog check` is the
  author-facing reader.
- **`openblog check`.** A stored atlas is validated with the library and notebook, its
  summary is printed, and approved relationships the projection would leave out are printed
  as non-blocking `notice:` lines naming ids only. A missing atlas is not mentioned.
- **Hosted durability.** The hosted editorial workspace allow-list includes exactly
  `.openblog/private/research/atlas.json` with the library's 4 MiB text limit; its lock and
  temporary files are never carried.
- **Never public.** The file is outside content, static, theme and output directories, so no
  build, feed, search index, `llms.txt`, portable export, source export or publish reads it,
  and approval opens no surface until the projection (#51) exists. The private-research guard
  now recognises an atlas by structure (typed entries, or attributed relationships with known
  kinds) as well as notebooks and bundles, so a copy saved into `content/`, `static/` or a
  theme stops the build, `serve`, `check` and publish, naming only its path. Regression tests
  seed every field, including approved items, with sentinels and prove none reaches the built
  site, feeds, search, `llms.txt`, portable or source exports, other Admin views, public
  routes, commits or the asset version.

## Consequences

- An atlas edit costs one extra read of the library and notebook; all three are at most
  4 MiB and parsed in memory.
- A hand edit that breaks the atlas blocks atlas changes, and blocks removing sources and
  passages, until it is repaired (ADR 0056); ordinary library and notebook edits continue.
- The Admin workspace (#50) and the publication projection (#51) build on `atlas_store` and
  `Atlas::projected` rather than reading the file themselves.

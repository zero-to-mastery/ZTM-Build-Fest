# ADR 0010: Store the source library as one private, revision-checked file

- Status: Accepted
- Date: 2026-10-24
- Decision issue: [#33](https://github.com/journey-to-code-org/open.blog/issues/33)
- Parent story: [#17](https://github.com/journey-to-code-org/open.blog/issues/17)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0009](0009-research-source-library-identity.md)
- Contract: [Research source library format](../specs/research-source-library.md)

## Context

ADR 0009 defined the source library's format and its all-or-nothing validation, but left
open where the file lives, how concurrent Admin tabs and command-line tools avoid
overwriting each other, and what happens when a write is interrupted or the stored file is
damaged. The library is private author research. ADR 0004 requires that kind of state to
stay out of pages, feeds, search, and exports, and builds must stay deterministic and
offline without a database.

open.blog already keeps private per-project state below `.openblog/private/`, which
`openblog init` adds to `.gitignore`, and Admin preferences already use revision-checked,
atomic file replacement.

## Decision

The library is one JSON file at `.openblog/private/research/sources.json`, owned by the
CLI's `source_store` module. It is outside the content, static, theme, web, and output
directories, so no build reads it (amended by [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md):
a build reads it, through these same checks, only when a post that opts in to citations cites
something, and publishes only the cited references' public description), and the build never
copies anything inside `.openblog/` even when a static or theme directory is configured to
contain it or a symlink points into it.

- **Containment.** The path is fixed. Every existing component below the project root must
  be a real directory or file, never a symlink or junction, so the library cannot be read
  from or written to `static/`, another project, or anywhere else. Source identifiers are
  validated slugs and never become paths.
- **Revisions.** A read returns a **library revision**: the SHA-256 of the stored bytes, or
  of the empty library while no file exists. Every create, update, and removal names the
  revision it was based on and is refused as a conflict when the file has changed since,
  including by a hand edit.
- **Atomic writes.** Changes run under a lock file beside the library. The edited library
  is validated by `openblog_core::source_library`, written in canonical form to a new
  temporary file, flushed, and renamed over the old file. A refused, failed, or interrupted
  change leaves the stored bytes unchanged; temporary files an interrupted write left
  behind are never read and are removed by the next successful write. A lock left by a
  crashed process blocks writes, never reads, with a message naming the file to remove.
- **Damaged or newer files.** Malformed JSON, invalid UTF-8, files over 4 MiB, invalid
  records, and newer format versions are reported with source-scoped diagnostics and are
  never replaced by a write; the author repairs or upgrades them first. There is no silent
  reset to an empty library.
- **Indexes.** Lookups by identifier, kind, and dependent record are derived in memory from
  the canonical file (`SourceLibrary::index`) and never stored, so they cannot drift from
  the library or reach output it does not.
- **Create versus update.** Create refuses an identifier already in use and update refuses
  one that is not, so a typo cannot silently replace or invent a record.
- `openblog check` validates a stored library and reports its diagnostics; it creates
  nothing when there is no library.

## Consequences

- The library is private to the machine by default. Authors who want it versioned in Git
  must deliberately stop ignoring it; making that a project setting is a separate,
  reversible change.
- One file keeps a change atomic without a database, at the cost of rewriting the whole
  library (at most 4 MiB) on every change.
- A damaged library blocks research edits until it is repaired by hand, rather than risking
  the loss of records the parser could not read.
- The store keeps no history beyond the current revision and does not remember removed
  identifiers; both can be added later without changing the file format.
- Admin management (#34), import and export (#35), and any public projection (#24, #63)
  read and write only through this store.

# ADR 0217: Reading paths travel as one deterministic export and an import that checks everything before writing anything

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#79](https://github.com/journey-to-code-org/open.blog/issues/79)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0208](0208-a-path-is-one-versioned-plain-text-json-file-written-canonically-and-never-loses-a-field.md),
  [ADR 0213](0213-reading-paths-are-curated-through-one-admin-route-family-with-revision-checked-atomic-canonical-writes.md)
- Contract: [Reading paths](../specs/reading-paths.md#export-and-import)

## Context

An author moves paths between sites, keeps a backup or shares a route. Paths are already plain files, but
copying a folder gives no check, no report and, if it goes wrong halfway, a half-copied folder.

## Decision

- **One file.** `openblog paths export` writes `openblog-reading-paths-export` version 1: the paths
  sorted by slug, each entry the slug and the path's canonical text (ADR 0208). Rationale, every
  transition's relationship and reason, and fields this release does not define travel exactly. The same paths
  give the same bytes, with `\n` line ends. Drafts are left out unless `--drafts`, so an export is never a
  surprise copy of unfinished work. It needs no build and no hosted service.
- **Import is a plan first.** `openblog paths import <file>` reads the whole file, checks each path with the
  same parser as a hand-edited file plus the rules Admin adds, and says what it would `create`, `replace` or
  leave `unchanged`. It writes nothing unless `--write`.
- **All or nothing.** Any problem (a bad file shape or version, an invalid or repeated slug, a path the parser
  refuses, a stored path that differs, a stored file that does not parse, too many paths) means nothing is
  written, including the valid paths in the same file. With `--write` the paths are written under the content
  lock one atomic rename at a time, and if one write fails the earlier ones are put back as they were.
- **Conflicts are explicit.** A stored path that differs from the imported one is a conflict unless
  `--overwrite`; a stored file that does not parse is always one. Importing the same export again is
  `unchanged`.
- **Problems are scoped and never echo.** A problem names the path file and the step id, never the text it
  found. Import reads at most 16 MiB, refuses `..` and symlinks, and each path is held to the file limits.

## Consequences

- Export then import is lossless and idempotent, so it can be used as a backup and a restore.
- A hosted deployment in workspace mode refuses `--write` like every other CLI content mutation.
- Admin does not yet offer export or import; the CLI is the only surface.

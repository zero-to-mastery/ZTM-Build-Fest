# ADR 0089: Alignments are a private store that locks after claims and guards what it uses

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#53](https://github.com/journey-to-code-org/open.blog/issues/53)
- Parent story: [#22](https://github.com/journey-to-code-org/open.blog/issues/22)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0056](0056-one-lock-order-and-cross-store-research-guards.md),
  [ADR 0071](0071-private-claims-storage-checked-against-the-saved-draft.md),
  [ADR 0072](0072-claims-take-their-lock-after-the-atlas-and-guard-their-sources.md),
  [ADR 0088](0088-passage-alignments-record-correspondence-never-equivalence.md)
- Contract: [Passage alignments format](../specs/passage-alignments.md)

## Context

Alignments (ADR 0088) point into the source library (sources and interpretations) and the
notebook (passages), and nothing points into them, like the claims file. They could live inside
the notebook or the library, but either would tie a comparison's revision to every unrelated
passage or source edit, and the notebook's export bundle is a passage-and-note format. A removal
elsewhere that left a member dangling would make the alignments unreadable and block every later
change to them.

## Decision

- **One private file.** Alignments live in `.openblog/private/research/alignments.json`, owned
  by `alignment_store`, which repeats the claims store's rules: an absent file reads as empty and
  reading creates nothing; every change names the revision (SHA-256 of the stored bytes) it was
  based on and a stale one is a conflict; the edited set is validated by
  `openblog_core::alignment` against the stored library and notebook and written to a temporary
  file that `fsutil::replace_file` renames over the file; a refused, failed, or interrupted write
  leaves the file byte for byte. Symlinks, directories, non-UTF-8, and files over 4 MiB are
  reported, never replaced, and messages name the alignments file and ids, never authored text.
- **One order: atlas, claims, alignments, notebook, library.** An alignments write takes the
  alignments lock, then the notebook lock, then the library lock, and holds all three while it
  reads, validates, and renames. It never takes the atlas or claims lock, and their writers never
  take the alignments lock. Every writer takes its locks in this one order, skipping those it
  does not need, so no two writers can wait on each other. A future store that depends on
  alignments takes its lock before them.
- **Readers hold the writer out.** A source or interpretation removal reads the alignments file
  under the library lock, and a notebook change reads it under the notebook lock; every
  alignments write holds both for its whole critical section, so those reads are stable.
- **Guards.** `source_store::remove` refuses a source an alignment uses as a member (present or
  absent), as evidence, or as attribution; `source_store::remove_interpretation` refuses an
  interpretation an alignment aligns; and `notebook_store::remove_passage` refuses a passage a
  member or evidence names. Each refusal is `still-used` or `still-linked` and names the
  alignment ids. An alignments file that cannot be read blocks these removals, because they
  cannot be shown to be unused, but not other edits.
- **Edits that would break a valid file are refused.** Every notebook change, and every library
  update or CSL import, re-validates an alignments file that was valid before against the
  changed store and refuses the change if it would become invalid (for example, re-pointing a
  reference so an evidence page locator turns ambiguous).
- **Admin API, check, and sync.** `GET`, `POST`, `PUT`, and `DELETE /admin/api/research/alignments`
  sit behind the session, CSRF token, and deny-by-default router, cap a change at 256 KiB, need
  the revision, answer a conflict with `409`, the latest revision, and the stored copy, and
  invalid input with `422` and alignment-scoped diagnostics. `openblog check` validates a stored
  file, prints its notices, and summarizes counts; a missing file is not mentioned. The hosted
  workspace allow-list carries the exact path at the library's 4 MiB limit and nothing beside
  it. Controls arrive with the comparison workspace (#54).
- **Never public.** No build, feed, search index, export, or public route reads the file, and a
  copy in `content/`, `static/`, or a theme, or a generated file shaped like it, stops the build
  naming only the path.

## Consequences

- Removing the last use of a source, interpretation, or passage takes two steps: change or
  remove the alignment, then remove the record.
- Alignment writes serialize with notebook and library writes but never with atlas or claims
  writes.
- A comparison's revision changes only when its alignments change.

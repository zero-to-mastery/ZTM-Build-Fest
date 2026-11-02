# ADR 0035: Store the notebook as one private, revision-checked file and capture into it through narrow Admin APIs

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#37](https://github.com/journey-to-code-org/open.blog/issues/37)
- Parent story: [#18](https://github.com/journey-to-code-org/open.blog/issues/18)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0010](0010-private-source-library-storage.md),
  [ADR 0011](0011-admin-source-library-management.md),
  [ADR 0034](0034-private-passages-and-research-notes.md)
- Contract: [Research notebook format](../specs/research-notebook.md)

## Context

ADR 0034 defined the notebook's contents and left storage, revision checks, Admin routes
and capture UI to a later slice. Authors need to quote a passage, say where it sits, link
a source and note a thought without leaving the draft they are writing, and the stored
notebook must stay as private and as hard to corrupt as the source library it points into.

## Decision

- **One private file, the same safeguards.** The notebook is
  `.openblog/private/research/notebook.json`, owned by the CLI's `notebook_store`. It reuses
  the library's containment (real directories only, no symlinks), SHA-256 **notebook
  revision**, lock file, temporary-file-then-rename write, and refusal to replace a damaged,
  oversized or newer-version file. A refused, failed or interrupted change leaves the stored
  bytes unchanged and creates no directory.
- **Validated against the library as stored.** Every read and change parses the notebook
  with `openblog_core::research_notes` against the current source library. A change holds
  the notebook lock and then the library lock, always in that order, so a save cannot
  interleave with a library change. A source that disappeared by hand edit fails the save
  with an entry-scoped `unknown-source` diagnostic rather than silently dropping research,
  and a damaged library blocks research changes without touching either file.
- **A source in use cannot be removed.** `source_store::remove` asks the notebook
  (`Notebook::entries_using_source`) while holding the library lock and refuses with a
  `still-used` diagnostic naming the entries. A notebook that cannot be read also blocks
  removal, since it cannot be shown to be free of references. Archiving a source is
  unaffected, because archived records still resolve.
- **Narrow Admin routes, deny by default.** `GET /admin/api/research/notebook`,
  `POST`/`PUT`/`DELETE /admin/api/research/passages` and `/research/notes` sit behind the
  Admin session and CSRF checks like every other route. Requests are JSON, at most 256 KiB,
  and always name the notebook revision. A request entry is read by `Passage::from_json` or
  `ResearchNote::from_json`, which apply exactly the rules for a stored file. Create refuses
  an id in use by any entry; update refuses an unknown one. Responses are `no-store`.
- **Failures are scoped.** A stale revision is `409` with `conflict: true`, the latest
  revision, and the newer stored copy of the entry. Invalid entries are `422` with
  diagnostics naming the entry and field, never repeating quoted or noted text. Nothing is
  written on any failure. Admin never merges silently: after a conflict it reloads and keeps
  the draft, and the author saves again (amended by ADR 0036: the author first chooses the
  stored copy or keeps the draft, and a removed entry can only be discarded).
- **Removal diagnostics name the caller's entries.** Removing an entry reports problems at
  the positions in the notebook the caller holds, as the library already does.
- **Hosted durability.** The hosted editorial workspace includes exactly
  `.openblog/private/research/notebook.json`, with the library's 4 MiB text limit, beside
  `sources.json`.
- **Capture in two places, one form.** The Research tools gain **Notebook** (`#/research`)
  to browse, edit and remove entries, and the post editor gains **Capture research**, a modal
  dialog prefilled with the selected text. Both use one form: a source chosen from the
  library, the quoted text, optional language and locators (`kind: value`, ranges written
  `kind: value to value`), and an optional first note. Ids are generated (`passage-3`) and
  never edited. Escape or Cancel closes the dialog and returns focus, with the selection, to
  the editing surface; Save does the same. Capturing never changes the draft or marks it
  unsaved. If a passage saves but its follow-up note is refused, the form continues as a note
  linked to that passage so a retry cannot quote the passage twice.
- **Text only.** Excerpts, notes, titles and server messages reach the page only as text
  nodes, never markup. The quoted text is sent exactly as typed.
- **Never public.** The file is outside content, static, theme and output directories, so no
  build, feed, search index or export reads it. Regression tests prove it against the built
  site (pages, feeds, search), the source exports, the content tree and the asset version.
  `openblog check` validates a stored notebook and says nothing when there is none.

## Consequences

- A conflict costs the author one extra Save press but never loses a draft or overwrites a
  concurrent change (amended by ADR 0036: the author also chooses which copy to continue with).
- Removing the last use of a source takes two steps: remove the research, then the source.
- Taking two locks per change serialises notebook saves with library changes; both are short.
- Citation insertion, a public excerpt projection, and any concept registry remain
  separate decisions.

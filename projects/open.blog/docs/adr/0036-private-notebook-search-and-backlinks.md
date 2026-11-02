# ADR 0036: Search and link the private notebook from stored data, with an explicit question state

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#38](https://github.com/journey-to-code-org/open.blog/issues/38)
- Parent story: [#18](https://github.com/journey-to-code-org/open.blog/issues/18)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0035](0035-private-notebook-storage-and-admin-capture.md)
- Contract: [Research notebook format](../specs/research-notebook.md)

## Context

A notebook is only useful if the author can find things in it: the passage quoted last
month, every note about an edition, the questions still waiting for an answer. Search over
private research has three risks. A stored index can drift from the files after a hand edit,
an archive, or a removal, so backlinks silently lie. A search feature can become a second
path out of the private directory. And a search hit that repeats stored text into logs or
error messages leaks what the notebook keeps out of them.

## Decision

- **No stored index.** `openblog_core::research_search` is a pure function of a validated
  notebook and the source library it points into. Every Admin request reads the files and
  computes the answer, so results and backlinks are correct after any safe edit, archive,
  removal, or hand repair by construction. Searching never writes.
- **Deterministic matching.** Words are folded (Unicode lowercase, whitespace runs collapsed,
  Greek final sigma folded) and all must appear. A match in author prose or the quoted text
  scores 3, in an id or concept 2, in a source name or locator 1; hits are ordered by score,
  then by notebook order (passages before notes). The query is bounded (200 characters, 16
  words) and refuses control characters. No dependency is added, so diacritics are not folded
  and composed and decomposed forms are not unified; the author searches the characters they
  stored. At most 100 hits are returned and `total` still counts every match.
- **Four filters.** `source` matches a source and everything that is an edition,
  translation, witness or reference of it (an `of` chain, bounded). `locator` matches a
  locator kind, including `x-` kinds. `concept` and `state` select notes. A note takes on the
  source and locator kinds of the passages it links, so filtering by an edition finds the
  thoughts written about it. Archived sources are always searchable and filterable.
- **An explicit open-question state.** A question note may carry `status`: `open` or
  `resolved`. Absent means open, and absent stays absent when the file is rewritten, so
  existing notebooks round-trip byte for byte. An observation may not carry one. A state is the
  author's own marking; nothing checks whether a resolved question was answered.
- **Backlinks.** For a passage: the notes that link it. For a concept: the notes that carry
  it. For a source: passages that quote it or anything under it, notes that name it, and notes
  that link such a passage, each with its relation and the edition or witness it goes
  through. An unknown source or passage is an error; an unused concept is simply empty.
- **Broken links are shown, not fatal.** A link whose target is missing is listed in
  `broken` and marked `missing` on the hit, so damage is visible instead of hiding results.
  A notebook read from disk is already validated, so this is a safety net.
- **Failures are scoped and write nothing.** A bad filter is a `422` with a diagnostic on
  `q`, `source`, `locator`, `concept` or `state`, never repeating stored text. A damaged
  notebook is reported with its path and is not searched around. No match is an ordinary
  empty result.
- **Private by construction.** `POST /admin/api/research/search` and `/research/backlinks`
  take a small JSON body (at most 16 KiB) and sit behind the Admin session and CSRF checks like
  the rest of the notebook API, and respond `no-store`. They are `POST` although they only read:
  search text and concept ids are private research, and a `GET` query string is recorded by
  hosting proxies' access logs. Nothing is written.
  Hits carry bounded plain-text context (a snippet around the first match, passage previews,
  source labels, locators) that the page shows only as text. Nothing in the build, feeds,
  site search or exports reads the notebook, so nothing here can reach public output.
- **Admin.** The Notebook view gains source, locator, concept and question-state filters
  beside text search. While any is set the lists give way to results with their context; the
  selected entry lists its backlinks, read fresh from the stored notebook. A question's state
  is edited with the note.

### Amendments to ADR 0035

- **Conflicts never overwrite silently.** After an edit conflict the capture form blocks
  saving until the author chooses the stored copy or keeps the draft, in which case the draft
  rests on the newer copy (unknown fields carry over). If the entry was removed meanwhile the
  draft can only be discarded.
- **Source edits cannot damage the notebook.** `source_store::update` and `import_csl` check
  the stored notebook against the edited library under the library lock and refuse with a
  `still-used` diagnostic naming the source (for an import, every record whose kind or `of`
  changed) when it would turn a locator ambiguous (for
  example re-pointing a reference from an edition to its work). A notebook that was already
  unreadable does not freeze library edits.

## Consequences

- Search cost grows with the notebook (at most 4 MiB), recomputed per request; that is fast
  enough for a single author and removes a class of staleness bugs.
- Semantic search, embeddings, cloud search and automatic answering stay out of scope.
- Folding diacritics or normalizing Unicode forms would need a dependency or a table, and is a
  separate decision.

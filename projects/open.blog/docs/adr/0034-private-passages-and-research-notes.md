# ADR 0034: Keep quoted passages and research notes as private, separately typed entries

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#36](https://github.com/journey-to-code-org/open.blog/issues/36)
- Parent story: [#18](https://github.com/journey-to-code-org/open.blog/issues/18)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0009](0009-research-source-library-identity.md),
  [ADR 0010](0010-private-source-library-storage.md)
- Contract: [Research notebook format](../specs/research-notebook.md)

## Context

The source library says what a source is. Writers also need to keep what they read and
what they thought: an excerpt, exactly where it sits in a particular edition or
manuscript, and their own observations and questions about it. Three risks shape the
format. A quotation stored beside the author's prose can later be mistaken for it, and
rendered, indexed, or credited as the author's words. A note that carries a visibility
switch invites a path to publication that bypasses review. And a locator such as "page 40"
means nothing without knowing which edition's pages are meant (ADR 0009), while locators
vary too much across disciplines for a closed list.

ADR 0004 requires private research state to stay out of public output unless an explicit
projection approves it.

## Decision

The notebook is a private, versioned JSON document owned by
`openblog_core::research_notes`: `{ "version": 1, "passages": [...], "notes": [...] }`.
Passages and notes share one identifier space of immutable lowercase slugs, so any entry
can be pointed at by its id alone and an id is never reused for another kind of entry.

- **Passages hold other people's words.** A passage has a `source` (a source-library id), a
  `locators` list, and an `excerpt` object. The excerpt text is stored exactly as quoted,
  Unicode included: no trimming, normalization, or markup interpretation. It is a distinct
  object from every field of author prose and is the only place quoted text lives. A passage
  never changes its source; quoting another source is a new passage.
- **Notes hold the author's words.** A note is an `observation` or a `question` with a
  `text`, and may link to `passages`, `sources`, and `concepts`. Source and passage links
  must resolve; concept ids are checked for shape only because no concept registry exists
  yet. A note can be linked to nothing.
- **Locators are compound and open.** A passage may carry up to eight ordered locators, each
  with a `kind`, a `value`, and an optional `to` for a range, so "folio 12r, lines 4-7" is
  two locators, not one string. Kinds are the source library's location schemes plus
  extension kinds written `x-` and a lowercase slug (`x-stephanus`); anything else is
  refused so a typo does not become a new kind. Kinds are never merged: a page is not a
  folio is not a canonical reference. Pages must address an edition, translation, or witness
  and folios a witness; a reference resolves through its `of` chain to decide.
- **Everything is private, with no switch.** `visibility` is written as `private` on every
  entry. Reading refuses any other value, so no entry can carry a flag that a later feature
  might treat as consent. Making research public is a separate projection (ADR 0004) that
  copies approved text into content; it never edits this file.
- **Credits stay out.** `credit`, `credits`, `contributor`, and `contributors` are refused
  on entries and at the top level.
- **Validation is all-or-nothing and scoped.** Parsing reports every problem as a diagnostic
  scoped to the collection, entry index and id, and field path, and never repeats quoted or
  noted text in a message. `upsert_*` and `remove_*` change the in-memory notebook only
  when the result is valid; removing a passage is refused while a note links to it, and
  `entries_using_source` lets a caller refuse to remove a source that research still uses.
  Unknown fields are preserved verbatim at every level but may not reuse a defined name,
  and serialization is deterministic. The 4 MiB limit applies to the written form too. A
  newer version is refused rather than reinterpreted. Text may not contain control
  characters (notes and excerpts may use `\n` and tabs) or Unicode bidirectional
  override and isolate controls.

This decision defines the contract only. Storage, revision checks and atomic writes
(following ADR 0010), Admin and capture UI, citation formatting, and any public excerpt or
note projection are separate slices. Until storage exists, nothing reads or writes a
notebook file, and the content loader, build, feeds, search, and exports cannot see one.

## Consequences

- A quotation can never be rendered or credited as author prose by accident: it lives in a
  differently named object that no prose consumer reads.
- There is no implicit publication path; any future one must be an explicit projection and
  will have to pass through reviewable, deliberately written code.
- Authors can address real-world locators (folios, canonical numbering, timestamps) without
  waiting for a format change.
- Library removal and notebook removal are checked by different files; the storage slice
  must check both before deleting a source.
- Concept links are unvalidated beyond their shape until a concept registry is decided.
- The format does not judge whether an excerpt is accurate, authoritative, or permitted to
  be quoted; those remain the author's responsibility.

## Domain language

**Notebook**, **Passage**, **Quoted excerpt**, **Locator**, and **Research note** are
defined in [`CONTEXT.md`](../../CONTEXT.md).

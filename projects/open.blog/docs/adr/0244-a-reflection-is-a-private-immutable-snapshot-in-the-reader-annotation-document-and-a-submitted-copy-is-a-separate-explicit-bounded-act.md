# ADR 0244: A reflection is a private, immutable snapshot in the reader-annotation document, and a submitted copy is a separate, explicit, bounded act

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#216](https://github.com/journey-to-code-org/open.blog/issues/216)
- Parent story: [#207](https://github.com/journey-to-code-org/open.blog/issues/207)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0237, ADR 0238, ADR 0239, ADR 0240, ADR 0243, ADR 0109, ADR 0113
- Serves: [#233](https://github.com/journey-to-code-org/open.blog/issues/233), [#234](https://github.com/journey-to-code-org/open.blog/issues/234)
- Contract: [Reader annotations](../specs/reader-annotations.md#interpretation-history)

## Context

A reader's reading of a work changes. To see how, they need to keep earlier readings beside later ones,
privately, without the site learning a behavioral history. The local annotation document (ADR 0237)
already is the reader's private, bounded, validated, exportable and erasable store, so history extends it
rather than forking it. Submitting a reflection for public consideration already has a path (the Third
Perspective submission, ADRs 0109 and 0113, moderated by RD12); history must reuse that path and must never
turn local text into public state by any other route.

## Decision

- **One more list in the same document.** The document gains `reflections`, and its version becomes 2.
  Version 1 documents are read as version 2 with no reflections (`migrateDocument`); a version 1 file that
  holds `reflections` is refused (`unknownField`), a newer version is `unsupportedVersion`, and the document is
  always written as version 2. Reflection ids share the one id space of the document.
- **A reflection is a snapshot.** `{ id, kind: "reflection", work, revision, target, label?, text, provenance,
  revises?, submissions?, createdAt, updatedAt }`. The work is its site and path and the target a passage
  target of any kind (ADR 0238), the revision is the revision of the page the reader read, and the text is the
  reader's own, under the rules and 10,000-character bound of a note (ADR 0240). The words, target and revision
  never change; a new reading is a new snapshot. Only `label` (the reader's own, a title under the title rules)
  and `submissions` change after it is made. At most 500 reflections.
- **History is a line.** `revises` names an earlier reflection on the same work that was made no later. A
  reflection is revised at most once (`branchedHistory`), may not revise itself, and may not dangle. Deleting
  one snapshot reconnects the line around it. Nothing is inferred about what changed or why.
- **Stale state is derived.** `assessReflections` resolves each target like a highlight (ADR 0077) and adds
  `articleChanged` (the page's revision is no longer the one read, or `null` when the work cannot be loaded).
  A snapshot is never rewritten when its article changes.
- **Provenance is a plain word about this device**: `written` (made here) or `imported` (arrived in a file,
  set by the importer whatever the file said). It claims nothing about the reader's identity or beliefs, and it
  does not take part in deciding whether two copies of a record are the same.
- **Private by construction.** `privacy.scope` stays `reader-private`. The default export (notes omitted) holds
  no reflections at all and says how many it left out; including notes includes reflections. A file that says its
  notes are omitted but holds reflections is refused. Nothing in the build, Admin, a feed or the hosted service reads
  them, and nothing is requested or stored on the server by keeping, comparing or deleting them.
- **The submitted-copy boundary.** `prepareSubmissionCopy` builds, without sending or saving anything, a copy in
  the Third Perspective submission shape and runs it through that form's own reader
  (`readThirdPerspectiveSubmissionJson`), so it has the same bounds (4,000 characters), refusals and later
  pending-by-default moderation. It requires the reader's own `consent.publish: true` and the site the page is on;
  it refuses a quotation target and another site's work. The copy holds the work path, revision, target, words and
  what the reader chose to say (category, name, consent) and nothing else: no id, label, provenance, history,
  submission record, dates or other snapshot. `markSubmitted` is a separate call made after the reader sent it; it
  appends `{ at, channel }` (`hosted` or `copy-and-send`, at most 20) and changes nothing else. The local original is
  never converted into, or marked as, a public thing; it stays reader-private and deletable.
- **Import.** Reflections merge like other records (same id and content is the same record; a conflict keeps
  what is saved unless the reader chooses the file's), a following reflection is re-pointed at the earlier one it
  now reaches, and a merge that would branch a history or break a limit is refused whole.
- **Out of scope here.** The comparison view (#233), the export, delete and submit controls (#234), cloud sync
  and any inference about what a reader believes.

## Considered options

- **A separate document or storage key.** Rejected: it would double the size, export, erase and unreadable-data
  rules the reader already understands, and make a "clear all" incomplete.
- **Editing a note in place and keeping diffs.** Rejected: a diff is a claim about what changed; immutable
  snapshots keep exactly what the reader wrote.
- **Marking a reflection "submitted" before the send.** Rejected: only the reader knows a send happened; the
  mark is a second, explicit step.

## Consequences

- An older page that meets a version 2 document treats it as unreadable and never overwrites it (ADR 0241).
- The document's 4 MiB bound is shared by notes and reflections.
- #233 and #234 consume one validated shape and have nothing to decide about identity, privacy or the boundary.

## Domain language

**Reflection snapshot**, **Interpretation history** and **Submission record** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

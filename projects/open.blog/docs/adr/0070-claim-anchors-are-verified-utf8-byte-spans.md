# ADR 0070: Claim anchors are UTF-8 byte spans that are checked, never repaired

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#44](https://github.com/journey-to-code-org/open.blog/issues/44)
- Parent story: [#20](https://github.com/journey-to-code-org/open.blog/issues/20)
- Builds on: [ADR 0068](0068-claims-and-evidence-links-record-the-authors-reading.md)
- Contract: [Claims and evidence links format](../specs/claims-evidence.md)

## Context

A claim may be a span of the draft. Drafts change, and a silently moved anchor would attach
evidence to different words than the author chose.

## Decision

- **Anchor is byte offsets plus the recorded text.** `anchor` is `{start, end, text}` with
  `start` and `end` UTF-8 byte offsets into the post's *anchor text* and `text` the exact bytes at
  that span when recorded. It is the author's own draft prose, not a quotation. The contract
  requires `start < end` and `end - start == text.len()`. A claim without an anchor is a statement
  claim.
- **Anchor text is the body, LF only.** Offsets index the post body after a leading byte-order
  mark and the front matter are removed, as `frontmatter::parse` yields it, with every CRLF folded
  to LF and then any leading line breaks (CR or LF) dropped. Admin's save
  (`frontmatter::compose`) writes `---` and one blank line before the body and trims the body's
  leading line breaks, and Admin's editor counts from the first character after them, so dropping
  them here is what keeps a hand-written post without that blank line and the same post re-saved
  by Admin at identical offsets. `claims::anchor_text(source)` produces exactly this text; Admin selections, checks and
  tests all use it, so a selection and a later check can never disagree about offsets. Anchor
  `text` keeps `\n` only: a carriage return (like any other control character except tab) is
  refused. Editing the front matter never moves an anchor.
- **Check, do not repair.** `Anchor::check(draft)` returns `Verified` (text at the offsets),
  `Moved { start }` (occurs exactly once elsewhere: reported, never rewritten), `Stale` (gone) or
  `Ambiguous` (several occurrences, offsets wrong). Occurrences are counted overlapping, so
  "ha ha" in "ha ha ha" is ambiguous, and the search stops at the second. Offsets inside a
  multi-byte character never panic. #45 refuses to save a link on a stale or ambiguous range and leaves the draft and claims
  file unchanged.
- **Storage is deferred.** The planned private file is
  `.openblog/private/research/claims.json`, owned by a later store with the atlas store's
  revision-checked, lock-and-rename writes and the hosted allow-list (now ADR 0071). This task
  defines the core types, validation and canonical JSON only, so no site output or file changes.
  Failures are diagnostics scoped to collection, id and field and never repeat authored text.
- **Edits are all-or-nothing.** `upsert_*` and `remove_*` validate the whole edited set exactly as
  a file is read and leave it unchanged on any problem. An unknown field cannot shadow a defined
  one; unknown fields otherwise round-trip.

## Consequences

- Admin and CLI share the same checks (#46), and a source-mode edit round-trips losslessly.

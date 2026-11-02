# ADR 0078: Feedback provenance records the revision a reader saw, when, and only consented identity

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#80](https://github.com/journey-to-code-org/open.blog/issues/80)
- Parent story: [#29](https://github.com/journey-to-code-org/open.blog/issues/29)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0076](0076-passage-targets-are-section-anchors-with-quoted-context.md),
  [ADR 0077](0077-targets-resolve-as-current-reanchored-or-stale.md),
  [ADR 0034](0034-private-passages-and-research-notes.md)
- Coordinates with: [#81](https://github.com/journey-to-code-org/open.blog/issues/81) (hosted
  transport), [#211](https://github.com/journey-to-code-org/open.blog/issues/211) (participation
  and moderation policy), [#225](https://github.com/journey-to-code-org/open.blog/issues/225)
  (moderation inbox)

## Context

Feedback is only fair to the author and the reader if it says which text the reader saw. A
correction to a sentence the author has since fixed is a different thing from one to the current
text. The existing hosted comments store a path and a name; B5 and the Third Perspective work
extend that seam (#81, #211) rather than adding another comment system. Reader identity must not
be published without consent, the record must stay apart from the author's private research, and
static reading must keep working without any hosted service.

## Decision

- **The record** (`FeedbackProvenance`, versioned JSON):

  ```json
  {"version":1,"work":"/posts/tides/","revision":"p1:…","target":{…},
   "seenAt":"2026-10-26T09:58:00Z","receivedAt":"2026-10-26T10:00:00Z",
   "channel":"hosted","attribution":{"name":"Ada","publishName":false}}
  ```

  - `work`: the post's site-relative path, validated like the hosted comments' paths.
  - `revision`: the passage revision of the page the reader saw (ADR 0076).
  - `target`: the passage target (ADR 0076).
  - `seenAt`: when the reader saw the page, by the reader's own clock; optional, untrusted, and
    never later than `receivedAt`. A receiver drops a later value instead of storing it.
  - `receivedAt`: stamped by the receiver (the hosted function, or the author entering a message
    by hand), never taken from the reader. Times are canonical UTC (`…Z`, whole seconds).
  - `channel`: `hosted` or `manual` (the e-mail or copy fallback when there is no endpoint).
  - `attribution`: an optional name and an explicit `publishName` agreement, false by default.
    Agreement without a name is refused rather than read as anonymous.
- **Nothing else about the reader.** No address, e-mail, device, cookie or account is part of the
  record, and unknown fields are refused, so identity cannot ride along. Whether contact details
  are collected for a reply, and how long anything is kept, is the participation policy's
  decision (#211), stored apart from this record.
- **One public projection.** `public(document)` is the only form that may reach a page, feed or
  export: the work, the revision the reader saw, the day it was received, whether the passage is
  stale, its current section (or, when stale, its old section only while that still exists), the
  quoted text only while the work still publishes it, and the name only with the reader's
  agreement. The quoted text is the `exact` text resolution verified in the section at the
  resolved location (sections are named by index, since anchors can repeat); it is never read
  again by anchor. The reader's clock, the time of day, the channel and an unpublished name never
  appear. A stale passage is never re-quoted, so text an author removed is not republished by a
  revision note.
- **Separate from research.** Feedback provenance is reader data, never a research note,
  notebook passage or citation, and this module never reads or writes the notebook. The notebook
  in turn refuses reader-feedback fields (`attribution`, `receivedAt`, `seenAt`) with a
  `reader-feedback` diagnostic, the way it refuses contributor credits, so the two cannot be
  merged by accident. Accepting feedback still needs a separate author edit (#83).
- **No hosted service required.** The record, its validation and its projection are pure Rust,
  and the target code also runs in the browser. #81 stores records through the existing Netlify
  function and Supabase seam, pending by default; without it, the canonical page and the author's
  manual entry still produce the same record. This task changes no database schema and no page.
- **Scoped failures.** Every record is read on its own; a bad record is refused with a field
  code and a message that never repeats what the reader wrote, and nothing else changes.

## Consequences

- Moderation (#83, #225) can show "seen on revision p1:… on 26 October, passage still current /
  moved / changed" for every item.
- A later version can add fields (for example a feedback kind from #81 or a decision from #208)
  by raising `version`; this one refuses what it does not know.
- Supabase columns for these fields are #81's one-way door; this contract keeps them plain
  (text, timestamps, a boolean) so the migration can be additive.

## Domain language

**Feedback provenance**, **Reader attribution** and **Public provenance** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

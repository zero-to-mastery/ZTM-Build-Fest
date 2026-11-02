# ADR 0077: A passage target resolves as current, re-anchored or stale, and never silently retargets

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#80](https://github.com/journey-to-code-org/open.blog/issues/80)
- Parent story: [#29](https://github.com/journey-to-code-org/open.blog/issues/29)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0076](0076-passage-targets-are-section-anchors-with-quoted-context.md)

## Context

A target is made against one revision of a post and read against another: when a moderator
reviews feedback (#83), when a revision note is published (RD6), when a reader's local annotation
is shown again (#84). The text may be unchanged, moved, reworded, duplicated or gone. Permanent
anchoring cannot be guaranteed and silent retargeting is out of scope (#80): pointing feedback at
text the reader did not see is worse than admitting the passage changed.

## Decision

Resolution is a pure function of the target, the revision the reader saw (or none) and the
current passage text. It returns exactly one of:

- **Current**: the reader saw this very revision and the text is where the target says (for a
  quote: `exact` at `start` in the named section with its context; for a section: the anchor,
  and the digest when given).
- A **work** target (the whole post) is always current while the post exists, whatever revision
  the reader saw, and points at no section.
- **Re-anchored**: the reader saw another revision (or an unknown one), and the identical text
  was found again, uniquely, as the same passage. It may have moved, even to another section.
- **Stale**, with a reason and whether the target's section still exists (context for an honest
  message, never a location):
  - `quoteNotFound`: the quoted text is nowhere in the post;
  - `contextChanged`: the quoted text is there, but none of its context is;
  - `ambiguous`: more than one place matches equally well;
  - `sectionRemoved`: a section target whose anchor and text are both gone;
  - `sectionChanged`: a section target whose section is there with different text;
  - `unverified`: a section target without a digest, seen at another revision.

Rules for quotations seen at another revision:

1. A candidate is an occurrence of `exact`, compared code point for code point, that starts and
   ends on character boundaries, so a quotation never matches part of `é` written as `e` plus a
   combining accent, or one person of an emoji family.
2. A candidate counts as the same passage only if its context still agrees on at least one side:
   at least 8 characters (or the whole side, if shorter) of `prefix` end right before it, or of
   `suffix` start right after it; an empty side agrees only if the candidate is also at the
   section's edge. Identical words in a new context are not the same passage.
3. Candidates are ranked by how many context characters agree, then by being in the target's
   section. A unique best candidate re-anchors; a tie is `ambiguous`. The position hint never
   breaks a tie across revisions.

A resolved location names its section by document index and anchor, because anchors can repeat.

Section targets with a digest resolve to the named section if its digest is unchanged; if the
anchor is gone or now holds other text, the one section elsewhere with the same digest (a heading
renumbered from `notes-2` to `notes-3`, say) re-anchors; otherwise they are stale.

Every resolved location points at exactly the quoted text: callers can and the tests do check
`text_at(location) == exact`.

## Consequences

- A moderator, revision note or annotation can always say either "this passage, still here" or
  "the passage you commented on has changed" without guessing.
- Two equally plausible places produce `ambiguous`, which asks a person to look; a later task may
  let an author re-target explicitly, which is a new, recorded target, never a silent change.
- Resolution never mutates anything, so a failure is confined to the one target that caused it.
- The search is linear in the post's length times the quotation's (at most 500 characters), small
  enough for a build, an Admin request or a browser.

## Domain language

**Target resolution** is defined in [`CONTEXT.md`](../../CONTEXT.md).

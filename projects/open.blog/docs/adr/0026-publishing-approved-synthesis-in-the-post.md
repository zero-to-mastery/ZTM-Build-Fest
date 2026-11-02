# ADR 0026: Publishing approved synthesis in the Post

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#180](https://github.com/journey-to-code-org/open.blog/issues/180)
- Parent story: [#150](https://github.com/journey-to-code-org/open.blog/issues/150)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

Synthesis items (ADR 0024) are approved per item and gate publishing (ADR 0025), but the assembled
Post carried none of them. ADR 0023 settled that a shared reflection has no projection of its own.

## Decision

- The synthesis is Markdown appended to the Post body by `assembly::assemble`, after the authors'
  sections, so the page, RSS, JSON Feed, portable output and search read it as ordinary content.
  `assembly::conversation_markdown` is the single producer. The combined preview renders that same
  string with the same production renderer, so the preview shows the markup readers get. Items
  still awaiting approval are shown in the preview in a separate, labelled block that is never
  published.
- Shape: one `##` heading ("Continuing the conversation"), then a `###` heading per kind that has
  at least one approved item, in the fixed order agreement, difference, question, application,
  uncertainty, then a `####` "Speaking for ..." heading per item with the item's prose beneath.
  A kind with nothing approved has no heading and an empty synthesis adds nothing at all.
  Items are not ranked, paired or compared, so a difference does not privilege a side, and nothing
  says "agreed", counts approvals or lists approvers: attribution is the only signal.
- Anchors are `continuing-the-conversation`, `conversation-<kind>` and `conversation-<kind>-<n>`
  (n counts within the kind in publication order). They carry no item ids, so reordering across
  kinds changes none and no internal identifier is published.
- Only an item that `is_approved()` (every attributed author approved its current digest) is
  included, evaluated at assembly time after the real gate has passed; the gate also blocks while
  any item awaits approval, so an unapproved, withdrawn or edited item has no path in.
- Safety: item prose is held to the section rules (no raw HTML, no active link or image address,
  no heading attributes, no construct that changes how a neighbour renders, checked with and
  without smart punctuation) and additionally may not contain a heading of level 1 to 4, which would break the outline under the generated headings. Violations
  refuse the publication as `UnsafeMarkup` with the approved text unaltered. Display names in the
  attribution are backslash-escaped, so they stay text.
- Feeds: because the synthesis is body Markdown, it reaches full-content RSS and JSON Feed,
  portable HTML/Markdown/text, `llms` files and the search index. Tests check these for internal
  ids, approver wording and withdrawn or stale text. Summary-only feeds carry only the ordinary
  excerpt, which can begin with body text. Portable output is settled in ADR 0028, and the item and anchor rules in ADR 0027.
- Labels are English constants in the core. Item prose and names publish in any script.

## Consequences

- A failure in assembly changes nothing, as for any Post (ADR 0022).
- Localizing the labels and theme-specific styling remain later work.

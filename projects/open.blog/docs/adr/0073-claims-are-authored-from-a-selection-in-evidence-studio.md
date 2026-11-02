# ADR 0073: Author claims from a selection in Evidence Studio, with opposing evidence side by side

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#45](https://github.com/journey-to-code-org/open.blog/issues/45)
- Parent story: [#20](https://github.com/journey-to-code-org/open.blog/issues/20)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0057](0057-accessible-atlas-authoring-and-a-text-first-explorer.md),
  [ADR 0069](0069-contradicting-evidence-is-never-hidden-or-published-alone.md),
  [ADR 0070](0070-claim-anchors-are-verified-utf8-byte-spans.md),
  [ADR 0071](0071-private-claims-storage-checked-against-the-saved-draft.md)
- Contract: [Claims and evidence links format](../specs/claims-evidence.md)

## Context

Authors select words in a draft, call them a claim, and attach the passages they have saved. The
controls have to work from the keyboard and with a screen reader, show contradicting evidence as
prominently as supporting evidence, and never imply that the software judged the evidence.

## Decision

- **Claims live in Evidence Studio, beside the post.** The post editor's Evidence pane has a
  "Claims and evidence" section for the open post; the writing toolbar has a "Claim" button that
  opens it and starts a claim from the current selection. A post that has never been saved shows
  only how to start. Nothing else in Admin changes.
- **A selection becomes an anchor the server confirms.** In Markdown mode the textarea selection
  is converted to UTF-8 byte offsets of the anchor text (CRLF folded, leading newlines dropped as
  a save drops them and the server's anchor text drops them, surrounding spaces trimmed). In
  visual mode, which shows formatted text, the selection must lie inside one visual block; the
  selected words are looked for only in that block's Markdown source (spaces matching any
  whitespace run) and used only when they occur there exactly once (overlaps counted). Searching
  the whole draft could anchor "big cave" from "The *big* cave" to a later plain "big cave".
  Otherwise the author is asked to select them in Markdown. The editor then asks the server to
  check the anchor against the saved draft it was made in, and opens the claim form only on
  `verified`. Unsaved changes are never sent as the draft: the author is told to save first.
- **The claim form** takes the statement in the author's words (prefilled with the selected
  words), an optional uncertainty note and an approval box whose hint says approval is consent for
  that claim only and can always be withdrawn.
- **The link form names the relation, with no default.** A fieldset of three radio buttons
  (supports, contradicts, contextualizes) starts unselected; saving without one is refused at
  that fieldset with the reason that a citation alone asserts none. Evidence is a notebook passage
  (which fills in its source and locators) or a library source, with optional locators, then
  rationale, confidence ("as you hold it"), uncertainty, what the author has checked (review
  state) and approval. Client checks only point at the control to fix; the server decides.
- **Supporting and contradicting evidence sit side by side and are never netted.** Each claim
  lists "Supporting (n)" and "Contradicting (n)" as two equal columns (one column on narrow
  screens, supporting first only by reading order), then "Contextualizing (n)". Counts are three
  separate figures in words. Links keep file order inside each column; nothing is ranked, scored,
  collapsed or hidden. Approved support that the projection holds back says so.
- **Anchor status is words, with a way to re-anchor.** Each anchored claim says verified, moved,
  stale or ambiguous. A moved claim offers "Re-anchor to its new position", which saves the
  offsets where its words now are (the server verifies them). A stale or ambiguous claim offers
  "Re-anchor to the selected words" and disables "Link evidence" with the reason, so evidence
  never attaches to words the author did not choose. Nothing is re-anchored automatically.
- **Conflicts keep the draft; removals can be undone.** A `409` blocks saving until the author
  chooses "Use the stored copy" or "Keep my draft"; keeping the draft rests it on the stored copy
  so fields added elsewhere survive. Removing a claim or link offers a focused "Undo" that saves
  the removed record again under the current revision (refused, as any save, if it no longer
  fits).
- **Accessible by construction.** Every control has a label, the relation is a fieldset with a
  legend, buttons that act on one item name it in their accessible name, status changes are
  announced politely and errors as alerts tied to the control (`aria-invalid`), focus moves to
  the form, then to the saved claim's heading. Text is built with DOM nodes only, so hostile
  statements, rationale and passage previews stay text. Styles keep focus visible, targets at
  least 44px, long words wrapping, and add no motion.

## Consequences

- An author must save a post before anchoring claims in new words, and re-anchor claims after
  rewriting their words; the editor says both plainly.
- The same component can later be shown outside the post editor (for example to list every
  claim) without changing the API.

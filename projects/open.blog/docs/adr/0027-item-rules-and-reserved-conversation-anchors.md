# ADR 0027: Item rules and reserved conversation anchors

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#180](https://github.com/journey-to-code-org/open.blog/issues/180)
- Parent story: [#150](https://github.com/journey-to-code-org/open.blog/issues/150)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

ADR 0026 appends generated headings with fixed anchors to the Post body and holds item prose to
the section safety rules. Review found three gaps: an author's own heading (by text or explicit
`{#id}`) could duplicate or take over a generated anchor, an item's `######` directly under the
generated `####` skipped a level, and item save accepted Markdown that publishing then refused,
with a refusal that blamed "a section".

## Decision

- Exactly the generated anchors are reserved: `continuing-the-conversation` and
  `conversation-<category>` or `conversation-<category>-<n>`, where the category is one of
  `agreement`, `difference`, `question`, `application` and `uncertainty`. A heading whose explicit
  id or text slug is one of these is refused, in a section (`AssemblyError::ReservedSectionAnchor`,
  its own refusal so Admin can tell the author to rename the heading rather than remove markup)
  and in an item (`ItemRule::ReservedAnchor`). The rest of the `conversation-` prefix stays free,
  so a heading such as "Conversation starters" is fine.
- Under the generated levels 2 to 4, an item's first heading must be level 5 and each following
  heading goes at most one level deeper than the one before (`ItemRule::Outline`). Levels 1 to 4
  are never allowed in an item.
- `synthesis::check_item_markdown` is the single implementation. It runs when an item is added or
  edited (`SynthesisError::Rule`), so authors learn early, and again at assembly, so items stored
  before the rule cannot publish. The stored-set validity check stays lenient, so an older set
  still loads and the author can edit the offending item.
- A refusal caused by an item is its own `AssemblyError::UnsafeConversationItem(ItemRule, ItemRef)`.
  `ItemRef` is the item's category and ordinal (Admin says "the second question"), never its text.
  When the whole body fails the isolation check but the sections pass alone, the item is blamed.
  Both Admin messages name the rule (`ItemRule::describe`, which holds no author text) and say it
  is a continuing-conversation item. Raw HTML, an unsafe address or a neighbour-reaching
  construct is `ItemRule::Markup`.
- Nothing is changed on any refusal.

## Consequences

- The page, preview and every export have each generated anchor exactly once.
- An item may still carry its own `{#id}` on a level 5 or deeper heading; ids are not
  de-duplicated across authors on the native page, which is existing behaviour for sections too.

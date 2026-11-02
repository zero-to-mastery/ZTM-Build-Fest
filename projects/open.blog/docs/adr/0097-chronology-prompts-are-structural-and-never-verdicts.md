# ADR 0097: Chronology prompts are structural, scoped and never verdicts

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#57](https://github.com/journey-to-code-org/open.blog/issues/57)
- Parent story: [#23](https://github.com/journey-to-code-org/open.blog/issues/23)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0074](0074-evidence-gaps-are-prompts-in-the-shared-finding-contract.md),
  [ADR 0094](0094-temporal-relationships-are-relative-datings-never-inferred.md),
  [ADR 0096](0096-the-chronology-index-orders-every-dating-for-display-only.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#chronology-index-and-prompts)

## Context

ADR 0094 records contradictory datings rather than refusing them, and leaves detecting them to
the chronology index as a structural, non-authoritative warning. An author benefits from hearing
that a death is dated before a birth, or that two relative datings order the same works both
ways round: it is often a slip in a year or an era. But a tool that says which date is right, or
that two people dated close together must have known each other, makes exactly the historical
claim the atlas refuses to make.

## Decision

- **A prompt names datings that cannot all hold as recorded.** Each check compares only stated
  values, and only says "cannot hold" when no reading of the stated precision allows it: the
  latest day one dating allows ends before the earliest day the other allows can begin. An open
  end never ends; a decade or century covers all its years; circa does not move a point; months
  and days count only when both points state the same calendar (or neither), otherwise years
  do. Overlapping, open, unknown and relative datings never fail an absolute comparison.
- **The checks.** Within a person: a death dating before a birth dating (`death-before-birth`);
  an `active` dating wholly outside the person's life (`outside-lifetime`). Within a work: a
  publication before a composition (`publication-before-composition`). Across an asserted
  `authored` relationship: a composition wholly after the author's death
  (`composition-after-death`) or before their birth (`composition-before-birth`). On an asserted
  `authored`, `member-of`, `participated-in` or `developed` relationship: its own `span` dated
  wholly outside the person's life (`outside-lifetime`). A person's `span` is their lifetime and
  bounds their life with birth and death. Relative datings: two that order the same two aspects
  both ways round, or one inside the other while also wholly before or after it
  (`opposed-relative`); three or more aspects ordered in a loop (`relative-cycle`); and a
  relative dating that the absolute datings of the two aspects it orders disagree with
  (`relative-against-dates`, one prompt per relative dating, counting the other pairs).
- **Only recorded links are followed.** A prompt across entries needs a relationship someone
  asserted, or a relative dating someone asserted. `influenced`, `responds-to` and other kinds
  that can outlive a person are never measured against a life. Datings close in time are never
  compared, grouped or linked, and nothing creates a dating, an order or a relationship.
- **Prompts, never verdicts.** A message names the dating ids, the aspects and owning ids, and
  each dating's stated value at its own precision ("not after c. 410 BCE", "the 380s BCE",
  "4th century BCE"), says that as recorded they cannot both (or all) hold, and asks the author
  to check the values against the cited evidence. When the datings come from different parties
  it adds that a recorded disagreement can stay side by side. It never says which dating is
  right, wrong or likely, never hides, changes or ranks one, and repeats no label, note, party
  name, locator or unknown field.
- **Scoped and non-blocking.** A `ChronologyPrompt` has a code, the collection, position and id
  of the entry or relationship that owns the dating it starts from, that dating's field
  (`dates[1]`), every dating it is about (that one first) and the message. Prompts are sorted by
  owner id, then datings, then code, then message (so two relationships naming the same author
  never fall back to file order), and at most 1,000 are listed (`unlisted` counts the rest).
  They never make the atlas invalid, never block a save or a build, and leave every file
  unchanged.
- **Where they appear.** `openblog check` prints each prompt as a `notice:` line beside the
  atlas's other notices, and adds to the atlas summary how many datings were indexed and how
  many prompts were found, only when the atlas has datings. Builds do not run the checks and
  publish nothing from them. Admin shows them with chronology exploration (#58).

## Consequences

- An author learns about likely slips without the atlas taking a side in a scholarly dispute.
- Some real contradictions are not prompted (a death before a lifetime span begins, implicit
  constraints chained through birth and death) because every prompt must point at datings that
  someone recorded against each other; adding a check is an additive change to this list.
- The finding contract of evidence gaps (ADR 0074) and the chronology prompts stay separate:
  prompts are about the atlas file and are scoped like its notices.

## Domain language

**Chronology prompt** is defined in [`CONTEXT.md`](../../CONTEXT.md).

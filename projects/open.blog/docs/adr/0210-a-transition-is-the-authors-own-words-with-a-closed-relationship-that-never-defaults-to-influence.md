# ADR 0210: A transition is the author's own words with a closed relationship that never defaults to influence

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#76](https://github.com/journey-to-code-org/open.blog/issues/76)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0054](0054-attributed-evidence-based-relationships.md),
  [ADR 0170](0170-queries-are-exact-lookup-and-a-bounded-trail-that-infer-nothing.md)
- Contract: [Reading paths](../specs/reading-paths.md#transitions)

## Context

The story wants paths that "explain why each step follows without falsely asserting direct
influence", and #78 requires that a transition never imply a relationship stronger than the
author wrote. The atlas (ADR 0054) already refuses to infer influence from chronology and requires
evidence for it. A reading path is a looser editorial device, and the easiest way for it to
overclaim is a sequence read as "this led to that".

## Decision

- **Every step after the first has a transition, with the author's text.** `transition.why` is
  required, non-blank plain text of at most 600 characters. The first step has none, because there is
  nothing for it to follow, and a transition on it is refused. A published path with a missing
  transition is refused; a draft may be unfinished. The text is the author's alone: nothing
  generates, completes or rewords it, and AI output enters only as text the author accepts.
- **A transition follows the nearest required step.** A step marked `optional` is a side step a
  reader may skip. So that skipping is coherent, a step's transition describes how it relates to
  the nearest earlier step that is not optional (its *followed step*), not necessarily the one just
  above it: after an optional step the next step still follows the last required one, and two
  optional steps in a row follow the same required step. Whatever optional steps a reader skips,
  every shown step is read after the step its transition is about. This is enforced where it can
  be: the first step is never optional (it is where everyone starts), the `influenced` check below
  reads the followed step, and the public value says which step is followed (`follows`, a
  position). How a page lays that out (#78) follows the data.
- **A closed relationship label with no default.** `transition.relationship` is required, and a
  missing one is refused rather than filled in. The values are `next`, `background`, `builds-on`,
  `contrasts-with`, `responds-to`, `applies` and `influenced`. Each reads as a sentence about this
  step and the step it follows ("Builds on the step it follows"), and `next` says in its words that
  no further relationship is claimed. `background` is the one that points backwards: this step gives
  background for the step it follows (a glossary entry or a person met after the article that
  assumed them), which keeps it distinct from `builds-on`, where this step extends the one before. It is the neutral choice, and the only one an author reaches for
  when the honest answer is "it simply comes next".
- **Influence is between two atlas entries, on a published relationship, exactly.** `influenced`
  requires `basis`, the id of an approved Knowledge Atlas relationship of kind `influenced`, which
  already carries its asserter, evidence and uncertainty (ADR 0054). Only the atlas states
  influence, so `influenced` is allowed only when the step and the step it follows are both atlas
  entries; between posts, or a post and an entry, the file is refused when read. At resolution the
  relationship's `(from, to)` must equal `(followed entry, this entry)` exactly: a reversed or
  unrelated relationship does not hold, and nothing is read loosely because an end is a post.
  A relationship with recorded dissent (`standing` contested) is not carried: showing "Was
  influenced by" over a contested influence would overclaim, so it does not hold either, and the
  author is told to use another label. (We refuse rather than carry `standing` into the public
  value: it keeps the public value a plain claim the atlas stands behind, and is reversible by
  adding a field later.) Order, dates and a shared tag never suffice.
- **When the claim does not hold the path is withheld, not softened.** A transition is never
  rewritten to another label, and never dropped alone, because a step with no transition would
  show the reader where something was removed (ADR 0211). The author gets a diagnostic naming the
  step and the reason.
- **A basis belongs to `influenced` alone.** On any other label it is refused when the file is
  read, so no label carries a relationship id it does not state.
- **A transition is only about adjacent steps.** A transition does not relate a step to a later one,
  and when the step it follows is not shown the path is withheld (ADR 0211). No score,
  strength, "path shows" or transitive reading exists.
- **Not a claim of fact.** A path states what an author recommends reading and why. Surfaces say so
  in the author's voice; nothing here asserts truth, consensus or authority.

## Consequences

- #78 can print the relationship label and the author's sentence with no further wording of its own,
  and its Previous and Next never say more than the label does.
- An author who wants to say "this shaped that" must cite a published relationship, which keeps the
  atlas the one place influence is evidenced.
- A closed list means a new label needs a version bump, which is the point.

## Domain language

**Path transition** is defined in [`CONTEXT.md`](../../CONTEXT.md).

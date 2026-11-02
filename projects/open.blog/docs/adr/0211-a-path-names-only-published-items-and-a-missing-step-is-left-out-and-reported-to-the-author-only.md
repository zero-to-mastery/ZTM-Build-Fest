# ADR 0211: A path names only published items, and a missing step is left out and reported to the author only

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#76](https://github.com/journey-to-code-org/open.blog/issues/76)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md),
  [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md),
  [ADR 0172](0172-an-article-links-a-term-to-an-atlas-entry-only-where-the-author-writes-an-atlas-link-and-only-if-the-entry-is-published.md)
- Contract: [Reading paths](../specs/reading-paths.md#resolution-and-missing-steps)

## Context

A path file is written by the author and may name a post that is later deleted, kept as a draft or
scheduled, or an atlas entry that is private, withdrawn, or never existed. The path file itself is
public content, but a published page, feed or export must never reveal that an unpublished item exists,
what it is called or what it says, and a missing step must not break the rest of the path.

## Decision

- **One input for what exists.** `PublishedTargets` holds the posts the build publishes in
  production and the public atlas's entries and influence
  relationships (the one value ADR 0058 and ADR 0168 allow). Resolution reads nothing else: no
  private atlas, library, notebook or draft, so there is nothing to leak a title or text from.
  `PublishedTargets::from_site` applies production visibility itself (`Site::is_published`: not a
  draft, not dated after the time the site was loaded for) and does not rely on what `Site::posts`
  holds, because Admin and preview loads include drafts and scheduled posts there. A site loaded
  without a time cannot tell scheduled posts apart, so Admin loads with one.
- **A missing step is left out only where that leaves no trace.** A step whose target is not in
  `PublishedTargets` is not in the public value, and positions are renumbered among the shown steps.
  That is safe when the step is last, or optional and not the step a shown step follows (ADR 0210):
  the reader gets a shorter, complete path. It is not safe otherwise.
- **A transition never describes a step the reader does not see, and never goes missing.** When a
  shown step's followed step (ADR 0210) is left out, or its `influenced` claim does not hold, the
  whole path is withheld with a diagnostic. The first draft of this ADR dropped that one
  transition, which let a reader see exactly where something was removed (a step with no "why"
  among steps that all have one). Withholding is conservative and reversible: republish the post
  or fix the claim and the path returns with no edit. It means every shown step after the first has
  a transition, which is tested over every combination of availability.
- **The public value carries no author-chosen step id.** An id like `step-3` beside `step-5` would
  show a gap even with transitions intact, and #78 does not need it: a step is named by its kind and
  target, which are unique in a path and public by definition. Diagnostics, which are for the
  author, keep ids.
- **A path with fewer than two shown steps is not published**, with a diagnostic. A draft path is
  not published and is not reported as a problem.
- **The public value is silent about what was left out.** It carries no count, flag or placeholder
  for a missing step, because "a step is hidden" is itself information about unpublished work.
- **Diagnostics are for the author.** Each names the path, the step id and the target id the author
  wrote, in one sentence, and never a title or text of the target. A private entry, a draft, a scheduled
  post and an id that never existed produce the same sentence, so a diagnostic cannot be used to
  probe for what exists. Diagnostics go where the author's warnings already go (`check`, build
  warnings, Admin) and never into a page, feed, export, log of the public site or error shown to a reader.
  Wiring them is the work of #77 to #79; this contract fixes their kinds (`StepUnavailable`,
  `TransitionDropped`, `PathWithheld`) and wording.
- **Scoped, and never destructive.** One path's problem leaves every other path and the site as
  they were, and resolution writes no file: the canonical path file is not edited to remove a
  missing step. The author fixes the source.
- **Nothing here is a new research projection.** A path holds author-written public text and
  published addresses and approves no private item, so it adds no switch to the publication boundary.
  Text an author pasted from private notes is still caught by the build's private text guard on
  generated output. When #78 renders paths it lists the new artifact in the manifest like ADR 0168's.

## Consequences

- Deleting or unpublishing a post degrades every path through it safely and tells the author.
- A reader cannot tell a path was ever longer, which is the cost of not leaking.
- Republishing the post restores the step with no edit.
- Withholding a whole path for one missing required step is blunt; Admin's diagnostics (#77) say
  which step, so the author sees the cause at once.

## Domain language

**Path step** is defined in [`CONTEXT.md`](../../CONTEXT.md).

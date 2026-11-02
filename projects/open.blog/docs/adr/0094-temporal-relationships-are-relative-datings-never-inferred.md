# ADR 0094: Temporal relationships are asserted relative datings, never inferred from dates

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#56](https://github.com/journey-to-code-org/open.blog/issues/56)
- Parent story: [#23](https://github.com/journey-to-code-org/open.blog/issues/23)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0054](0054-attributed-evidence-based-relationships.md),
  [ADR 0093](0093-uncertain-dates-are-attributed-datings-at-their-stated-precision.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#chronology)

## Context

Much historical chronology is relative: scholars argue that the Republic was composed after
the Phaedo without agreeing on either year. That is a claim about order in time, made by
someone on some evidence, and it can be disputed. ADR 0054 deliberately has no "preceded" or
"contemporary of" relationship kind and no code path that creates an edge from dates, because
"earlier, therefore influential" is exactly the inference the atlas must never make. Relative
chronology still needs a home, and relationships themselves can need dates ("member of the
Academy from 387 BCE").

## Decision

- **A temporal relationship is a relative dating.** `{"relative": {"order": "before" |
  "after" | "during", "entry": id, "aspect": aspect}}` is a date form: the dated aspect happened
  before, after or during another entry's aspect. It is a dating like any other, so it is
  attributed, cited or explicitly unsourced, has a confidence, and competes side by side with
  other datings, including an opposite relative dating by another party.
- **Relationship kinds do not change.** ADR 0054's closed set stays as it is, with no
  chronology kinds. A relative dating never creates, implies, strengthens or ranks a
  relationship; `Atlas::relationships_of` is unchanged by it, and `Atlas::datings_of` lists the
  relative datings that point at an entry separately.
- **Checked against the atlas.** The target must be an entry (an id naming a relationship is
  refused), the aspect must be one that entry's kind has, `during` needs an aspect that lasts,
  and a dating cannot be relative to the aspect it dates. A target without datings of its own
  is valid: relative chronology often exists without absolute dates.
- **Contradictions are recorded, not refused.** Opposed relative datings, or a relative dating
  that disagrees with absolute ones, are valid when different parties assert them. Detecting
  them is the chronology index's structural, non-authoritative warning (#57), never a
  validation rule and never a verdict.
- **Relationships can be dated.** A relationship's `dates` hold `span` datings of when it held.
  They date the relationship; they are not evidence for it and do not change its standing.
- **Nothing is inferred.** No code creates a dating from another dating or from a relationship,
  and no code creates a relationship from dates or from temporal proximity.

## Consequences

- ADR 0054's consequence that chronology can be added "without reinterpreting any edge" holds:
  relationships read exactly as before.
- The chronology index (#57) can build before/after constraints from relative datings and warn
  about cycles or conflicts, always naming the parties and dating ids involved.
- A relative dating to a private entry is never published (ADR 0095).

## Domain language

**Relative dating** (the atlas's only temporal relationship) is defined in
[`CONTEXT.md`](../../CONTEXT.md).

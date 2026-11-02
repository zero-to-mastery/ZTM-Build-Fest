# ADR 0136: A section states its contributor, and credits that drift attribute nothing

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#223](https://github.com/journey-to-code-org/open.blog/issues/223)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0031](0031-sequential-and-side-by-side-presentation.md),
  [ADR 0033](0033-portable-equivalents-of-every-reflection-layout.md),
  [ADR 0126](0126-an-attributed-section-is-an-ordinary-section-target-with-a-reserved-anchor-and-a-digest.md),
  [ADR 0128](0128-only-the-bound-contributor-who-wrote-a-section-may-answer-as-its-author.md)

## Context

ADR 0126 pairs the k-th distinct author name in a shared reflection's body with the k-th credit in
its sidecar. A review found that this misattributes instead of failing closed when the credits are
edited afterwards: a body MINA, JOE, MINA with credits `[joe, mina]` still has two names and two
credits, so MINA's section is attributed to `joe`, and `joe` could then answer as MINA. The count
and the order are the only things checked, and the order can change in the post editor after
publication.

## Decision

- **A section can state its contributor.** `compose_bound` writes one extra class,
  `ob-turn-by-<registry key>`, on each turn's section when the assembly knows the binding's
  contributor id. The key is already public (it is in the credits sidecar), is written only if it
  is a well-formed registry key, and is only a class: no inline style, script, data attribute or
  position, so the layout contract of ADR 0031 holds. `Arrangement::parse`, the exact inverse of
  `compose`, reads it back, and the other projections ignore it. A body composed with no keys is
  byte for byte what `compose` has always written.
- **A bound body is paired by what it states.** Every turn must state a key, the same name must
  state the same key every time, and the distinct keys in order of first appearance must equal the
  sidecar's credits exactly. Anything else, including some turns bound and some not, attributes
  nothing and counts every turn as unattributed. Reordering or dropping a credit afterwards
  therefore fails closed instead of moving a section to another author. No registry name is
  compared, because a participant's display name need not be the registry name (a pen name is
  fine).
- **An older body is paired by the committed registry.** A body composed before this decision
  states no keys, and a rewritten body would change existing posts, so it is not rewritten. Its
  k-th distinct name must equal, after trimming, the public name the committed contributor registry
  (`openblog.json` `contributors`, the same names the byline shows) gives the k-th credit's key. A
  credit missing from the registry, or a renamed key, attributes nothing. That registry is
  committed and public, so a CI or static build checks it without any private record.
- **Admin refuses a credits edit that would unattribute a shared reflection.** Saving a post whose
  sections are attributed now, with credits that would attribute none, answers `422` with the rule
  and writes nothing. The refusal is only for shared reflections whose body parses as an
  arrangement; ordinary posts and credit edits that keep the attribution are unchanged.

## Considered options

- **Compare only the registry's names, for every body.** Rejected as the only rule: it would
  attribute nothing to a post whose display names legitimately differ from the registry's, and it
  ties attribution to a name that can be edited. It remains the rule for older bodies.
- **Bind the key in the credits sidecar.** Rejected: the sidecar's version 1 has a closed shape that
  other tools read, and it is the file that drifts.

## Consequences

An existing shared reflection keeps its published output byte for byte; it attributes by the
registry name check until it is assembled again, and a new one is bound. No existing post's output
changes.

# ADR 0069: Contradicting evidence is never hidden, and support is never published alone

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#44](https://github.com/journey-to-code-org/open.blog/issues/44)
- Parent story: [#20](https://github.com/journey-to-code-org/open.blog/issues/20)
- Builds on: [ADR 0054](0054-attributed-evidence-based-relationships.md),
  [ADR 0068](0068-claims-and-evidence-links-record-the-authors-reading.md)
- Contract: [Claims and evidence links format](../specs/claims-evidence.md)

## Context

Showing only the sources that agree with a claim misleads readers even if every link is accurate.
The format also must keep private material private by default.

## Decision

- **Private by default.** `visibility` is `private` unless the author writes `approved`, on claims
  and on links separately. Approval is consent for one item.
- **Order is file order.** Accessors return links in stored order and counts per relation. No
  helper sorts, ranks or collapses relations, so contradiction cannot be pushed out of view or
  netted against support.
- **Support is never published while contradiction is withheld, and this is a projection rule.**
  An approved `supports` link on a claim that has any contradicting link that is not approved is
  valid, stays out of every public projection, and is reported as a non-blocking notice
  (`ClaimSet::notices`, code `undisclosed-contradiction`). The author approves the contradicting
  link too, and the support is projected again. Private rationale stays private either way; the
  projection (#47) decides rationale separately.
- **An approved link on a private claim is a projection rule too.** It is valid, never projected,
  and reported as a notice (`private-endpoint`), as for atlas relationships (ADR 0053).
- **Why not refuse.** Refusing these made withdrawing consent impossible: setting a contradicting
  link or a claim back to private, or adding a new private contradicting link after support was
  approved, was rejected, and a hand edit that did the same made the file unreadable, blocking
  every later change. Approval on an item is consent only for that item; whether it is published
  also depends on others, so withdrawing approval elsewhere is an ordinary edit that withdraws
  what depends on it, and approving again restores it. The outcome is still conservative: the
  projection publishes strictly less, never more.
- **Validation keeps only rules about an item's own fields.** An approved link may not carry a
  private notebook `passage` (as in ADR 0054); it cites source and locators. A `suggested` claim
  cannot be approved, and a `suggested` link only once `reviewState` is `reviewed`, so an
  assistant's suggestion is never published as the author's reading. These are refused.
- **Projection helper.** `is_projected` is true only when the link and its claim are approved, the
  link carries no passage, and, for `supports`, every contradicting link on the claim is
  approved. `projected_links` gives the same answer for the whole file in one pass: the claims
  with a withheld contradiction are found once, so a large file is checked in linear time.
- **Leak guard.** A claims file is recognised by structure (`claims` with `post` and `statement`,
  `links` with a typed `relation` and evidence object) and added to the structural check build
  guards already use for notebooks and atlases, so a copy in `content/`, `static/` or a theme is
  refused without echoing its text.

## Consequences

- #47 may rely on these invariants and only needs an allowlisted field copy.

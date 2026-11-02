# ADR 0149: The publication review is a view of the research-completeness contract

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#194](https://github.com/journey-to-code-org/open.blog/issues/194)
- Parent story: [#189](https://github.com/journey-to-code-org/open.blog/issues/189)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0123](0123-the-research-review-before-publication-adapts-todays-findings-to-the-completeness-contract.md),
  [ADR 0124](0124-review-acknowledgements-are-a-private-revisioned-file-of-keys-and-fingerprints.md),
  [ADR 0146](0146-one-research-completeness-contract-with-one-owner-per-check.md),
  [ADR 0147](0147-acknowledgements-never-resolve-a-finding-and-go-stale-when-it-changes.md)
- Amends: ADR 0146 (the matrix gains the rows below, and a fourth gate)

## Context

Story A8 shipped the review before publication (#62) while the research-completeness contract
(#191) was still on a branch, so `openblog_core::publication_review` carried its own copy of the
contract: the same validators, checks, categories, gates, finding shape, fingerprint,
acknowledgement record and order, written a second time, with an adapter in front. ADR 0123 said
#194 would replace the converters with the contract's and keep the rows it added. Both copies
now exist in one tree. Two models of "which validator owns this code, may it be acknowledged and
what does its fingerprint hash" are two places for a code to drift: a code added to one would
not be acknowledgeable, ordered or fingerprinted the same in the other, and a stored
acknowledgement could be valid in Admin and refused by the command line.

## Decision

- **One source of truth: the contract consumes nothing, the review consumes the contract.**
  `research_completeness` owns the validators, checks, categories, outcomes, gates, finding
  shape, matrix, fingerprint, order, `Acknowledgement`, `AcknowledgementSet` (the stored file),
  `acknowledgeable` and the report. `publication_review` keeps only what is specific to the
  moment before publishing: the groups (what the build refuses first, then advisory findings by
  outcome), the `applies` flag, and the text and JSON of a review. Its old names
  (`ReviewFinding`, `ReviewEntry`, `Acknowledgement`, `Validator` and the rest) are aliases of
  the contract's types, so Admin's JSON, the stored acknowledgements and their fingerprints do
  not change by one byte. The contract was chosen over the review as the base because it is
  the one that was written from every validator's emitters, tests each matrix row against them,
  and carries the facts every fingerprint is built from; the review was an adapter by its own
  ADR. Nothing was deleted that a validator relied on: the converters, `unreadable`,
  `from_context_link` and `blocks_publication` moved to the contract with their tests.
- **`acknowledgeable` is derived, not listed.** An acknowledgement is accepted, stored and
  applied only when the matrix has an advisory row for its validator and code. The review's
  hand-written list of advisory codes is gone, so a code cannot be in one and not the other. A
  record the matrix does not allow is never applied and never counted (a stored file holding
  one is refused whole); this is the review's behaviour, which the contract now has too.
- **Rows added to the matrix**, exactly the table of ADR 0123, so acknowledgements stored by the
  Admin flow keep their keys:

  | Kind | Row | Owner and mapping |
  | --- | --- | --- |
  | validator | `publication-context` | `context_links::review_context_links` |
  | check | `context-link` | owned by `publication-context` |
  | code | `context-link-unpublished` | `context-link`, `public-boundary`, `detected`, advisory; fact: the address |
  | code | `file-unreadable` | one row under each of `library-integrity`, `notebook-integrity`, `atlas-integrity`, `claims-integrity` and `alignments-integrity`, owned by that file's validator, `integrity`, `detected`, `refuses`; no facts |

  The unsafe web address finding reuses `citation-identifier-unpublished` with the facts
  `[key, scheme, value]`, whatever form the address is unsafe in; it needs no row of its own.
  Each added row has one owner, a gate and a test that runs its real emitter
  (`tests/research_completeness.rs`): the context-link check, `unreadable` for each file, and the
  citation review for an address with a token.
- **A fourth gate, `withholds`.** A8's `stale-approval` notice (a comparison whose approval no
  longer holds) leaves only that comparison out of the next build. It does not stop a post or a
  build, and it cannot be acknowledged, because acknowledging would not publish it. The gate
  joins `advisory`, `refuses-when-published` and `refuses`; the row is `stale-approval` under
  `alignment-places`, `locator`, `needs-review`. It is the one row that is not detected and not
  advisory; the contract's test says so by name.
- **Fingerprints did not change.** Both copies hashed the same key, related objects and facts
  with the same digest, and a test pins one value computed independently of either, so no stored
  acknowledgement goes stale at the unification.
- **Blocking is the report's one scope-dependent word.** For one post about to be published, a
  citation the build refuses once published blocks. For the whole site, a post that is not
  published yet only warns, so only a failure of a file the build reads blocks
  (`ReviewScope::Post` and `ReviewScope::Site`). Findings, order, counts and acknowledgements
  are identical in both.

## Consequences

- There is one place to add a code, one table that says whether it can be acknowledged, and one
  fingerprint. The compiler still refuses an unmapped variant.
- A8's tests, Admin routes and stored files are unchanged; the review's JSON is byte for byte what
  it was.
- The contract's text and the review's text can no longer disagree, which #194 relies on.

## Domain language

**Finding gate** and **Finding acknowledgement** are defined in [`CONTEXT.md`](../../CONTEXT.md).

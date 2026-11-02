# ADR 0147: Acknowledgements never resolve a finding and go stale when it changes

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#191](https://github.com/journey-to-code-org/open.blog/issues/191)
- Parent story: [#189](https://github.com/journey-to-code-org/open.blog/issues/189)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0074](0074-evidence-gaps-are-prompts-in-the-shared-finding-contract.md),
  [ADR 0146](0146-one-research-completeness-contract-with-one-owner-per-check.md)
- Coordinates with: [#62](https://github.com/journey-to-code-org/open.blog/issues/62),
  [#194](https://github.com/journey-to-code-org/open.blog/issues/194)

## Context

Some prompts are legitimately permanent: a whole-work source needs no locator, and a doubt with
no source behind it stays a doubt (ADR 0074). RW9 lets an author acknowledge a subjective review
without turning it into an automated pass, and requires that acknowledgement never relabels a
finding resolved. An acknowledgement must also stop applying when the thing acknowledged
changes, for example when another located citation appears or a dating's stated value is
edited, or an author could acknowledge once and never see a new problem under the same name.

## Decision

- **What an acknowledgement is.** An `Acknowledgement` records the finding's validator, code,
  object kind, file (`path`), id and field (its key) and the finding's `fingerprint` when it was
  acknowledged. The file is part of the key because a post-scoped finding names no id: without
  it, acknowledging `abstract-missing` on one post would mark another post's acknowledged.
  It holds no note, no person and no time, so it has nothing private to leak. Its JSON refuses
  unknown fields, so a stored record cannot claim more (there is no `resolved`).
- **The fingerprint.** A 128-bit BLAKE2s digest, as 32 hexadecimal characters, of the key, the
  related objects and the finding's structured, position-free `facts`: the ids, keys, locators,
  identifiers and stated values its validator reports for that code. The message is never an
  input. Messages embed positions (`citation-location-review` lists line numbers,
  `claim-anchor-moved` names a byte offset), so hashing them made an acknowledgement go stale
  whenever a paragraph was added above, and any copy edit to a message template would have
  staled every acknowledgement at once. Lines, columns and indexes are left out for the same
  reason. Each validator states its facts beside its message, and they are never serialized:

  | Finding | Facts |
  | --- | --- |
  | `citation-location-review` | each located citation's key and locators in its canonical `[@key, ...]` form, in reading order; not the lines |
  | `citation-syntax`, `citation-unresolved` | the citation diagnostic's code and key |
  | `citation-identifier-unpublished` | the key, scheme and value |
  | `citation-reference-incomplete` | the key (the missing detail is the key's field) |
  | `doi-invalid`, `license-url-invalid` | the stated value |
  | `footnote-unresolved` | the footnote label |
  | `reference-link-review` | the reference's own text |
  | `doi-link-non-preferred` | the link |
  | `claim-anchor-moved`, `-stale`, `-ambiguous`, `claim-evidence-missing` | nothing beyond the key; no byte offset |
  | `claim-post-missing` | the post slug the claim names |
  | `claim-support-only`, `claim-contradiction-undiscussed` | the supporting or contradicting link ids |
  | link findings | the link's source; for `claim-passage-archived` the passage; for `claim-location-unreviewed` the source, the link's locators, and its passage with that passage's locators; for `claim-rationale-missing` the source and relation |
  | atlas and claims `private-endpoint`, `undisclosed-contradiction`, `unpublished-datings` | the private claim, entry or dating ids they name |
  | `stale-locator` | the member's locators, the passage and the passage's locators |
  | `archived-member` | the archived passage or source |
  | chronology prompts | each dating's id, aspect and stated date |
  | `withheld-rights`, `withheld-length` | the version's rights status and license and the place's locators |
  | `source-review` findings | the cited keys and locators, identifier comparison keys, source and version ids, volume counts and the quotation's own text each code names (ADR 0148) |
  | refusing errors | nothing beyond the key: they cannot be acknowledged |

  So inserting a line above a located citation keeps its acknowledgement current, and citing a
  different locator, re-locating a passage, archiving a source or changing a dating's stated
  value makes it stale.
- **Only advisory findings can be acknowledged.** `Acknowledgement::of` returns nothing for a
  finding whose gate refuses something: integrity and privacy failures are fixed, never
  acknowledged. A stored acknowledgement that names one is not applied.
- **Matching in a report.** `CompletenessReport::new` marks an advisory finding `current` when
  an acknowledgement has its key and fingerprint, and `stale` when an acknowledgement has its key
  but a fingerprint that fits no finding now in the report under that key. An acknowledgement
  of one of two findings that share a key (two undefined footnotes in one post) leaves the other
  unacknowledged, not stale.
- **Never resolved.** An acknowledged finding is still listed, still has its outcome and is still
  counted in `found`; `acknowledged` counts the current acknowledgements of each outcome
  separately. A stale acknowledgement counts for nothing. A finding disappears only when its
  validator no longer reports it, because the record now holds what was missing.
  Acknowledgements that match no advisory finding are counted as `unmatchedAcknowledgements`, so
  a store can tidy them up; they are never shown as resolutions.
- **The report is versioned.** `CompletenessReport` serializes as `version` 1, `findings` (each
  finding with its `fingerprint` and any `acknowledgement`), `counts` (`detected`, `potential`,
  `needsReview`, each `found` and `acknowledged`) and `unmatchedAcknowledgements`. There is no
  total, score or readiness field.
- **Storage is #194's.** Where acknowledgements are kept (a private file beside the research
  files, read through the existing authorization and CSRF seams) is decided with the report that
  shows them. Nothing here writes, and nothing stored can reach a public artifact.

## Consequences

- An author can set aside a prompt they have considered, and see it again as soon as it says
  something new.
- Acknowledging is reversible: removing the record restores the finding's unacknowledged state.
- Because neither the key nor the fingerprint holds a position or the message, an
  acknowledgement survives edits elsewhere in a post and changes to message wording, and because
  the fingerprint holds the facts, it does not survive a change to what the finding is about.
- A validator that adds a code must state its facts; a finding with none is fingerprinted by its
  key and related objects alone.

## Domain language

**Finding acknowledgement** and **Finding fingerprint** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

# ADR 0074: Evidence gaps and provenance prompts are findings, never verdicts

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#46](https://github.com/journey-to-code-org/open.blog/issues/46)
- Parent story: [#20](https://github.com/journey-to-code-org/open.blog/issues/20)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0050](0050-offline-citation-checks-and-portable-bibliography-exports.md),
  [ADR 0069](0069-contradicting-evidence-is-never-hidden-or-published-alone.md),
  [ADR 0070](0070-claim-anchors-are-verified-utf8-byte-spans.md),
  [ADR 0071](0071-private-claims-storage-checked-against-the-saved-draft.md)
- Amends: ADR 0071's "no build reads the file" (a build now reads it for the author's findings
  only)
- Contract: [Claims and evidence links format](../specs/claims-evidence.md)

## Context

Claims and evidence links record the author's reading of their sources (ADR 0068). An author
also needs to see what that record lacks: a claim with no evidence, contradicting evidence the
post may not address, a link resting on an archived source, a location nobody has checked. A
check that said "supported" or "well evidenced" would claim what software cannot know, and a
score would hide contradicting evidence inside a number, which ADR 0069 forbids. Citation checks
already report `EvidenceFinding`s (ADR 0050) to `openblog check`, builds and Evidence Studio; a
second, differently shaped report would let the three surfaces disagree.

## Decision

- **One review, in the shared finding contract.** `openblog_core::claim_review::review_claims`
  reads a valid claims file beside the saved drafts (`claims::anchor_text`), each post's path,
  the source library and the notebook, and returns `EvidenceFinding`s with the same `code`,
  `outcome` (`detected`, `potential`, `needs-review`), `source` (`path`, `field`), `message`
  and `repair` as citation findings. A finding about a claim also carries `object`
  (`{claim, link?}`), so Evidence Studio can show it beside that claim; other findings omit it.
- **The findings.** Each names the property checked in its message and the human action in its
  repair:

  | Code | Outcome | Field | When |
  | --- | --- | --- | --- |
  | `claim-post-missing` | detected | `claims[id].post` | no saved post has the claim's slug |
  | `claim-anchor-moved` | detected | `claims[id].anchor` | the words occur once, elsewhere |
  | `claim-anchor-stale` | detected | `claims[id].anchor` | the words no longer occur |
  | `claim-anchor-ambiguous` | detected | `claims[id].anchor` | several occurrences, offsets wrong |
  | `claim-suggestion-unreviewed` | needs-review | `claims[id].origin`, `links[id].reviewState` | a suggested claim, or a suggested link not yet reviewed |
  | `claim-evidence-missing` | potential | `claims[id]` | no evidence link of any relation |
  | `claim-support-only` | needs-review | `claims[id].uncertainty` | the author marked the claim uncertain, yet every link supports it |
  | `claim-contradiction-undiscussed` | needs-review | `claims[id].uncertainty` | contradicting links and no note on how the post addresses them |
  | `claim-source-archived` | needs-review | `links[id].evidence.source` | the link rests on an archived library source |
  | `claim-passage-archived` | needs-review | `links[id].evidence.passage` | the link points to an archived notebook passage |
  | `claim-locator-missing` | potential | `links[id].evidence.locators` | no location, own or from its passage |
  | `claim-location-unreviewed` | needs-review | `links[id].reviewState` | a location nobody has recorded checking |
  | `claim-rationale-missing` | potential | `links[id].rationale` | the link does not say why the author reads it so |

  "Contested" means what the author recorded, not what software infers: an uncertainty note on
  the claim. Unresolved sources and passages need no finding because the file cannot hold them
  (validation refuses them); archived ones are the provenance that can still go stale.
- **Gaps and prompts, never verdicts.** No message says a claim or source is true, false,
  correct, verified, authoritative, strong or weak; there is no score, and outcomes are counted
  apart, never combined. The anchor findings say they compare text positions only, the location
  finding says open.blog checked only the locator's form and fit, and `claim-support-only` says
  that nothing needs to change if the doubt does not come from a source. Admin's anchor status
  "verified" is shown as "In place", with the same caveat.
- **Deterministic order, resolved by recording what was missing.** Claims in file order; for
  each, post or anchor, suggestion, missing evidence, support only, undiscussed contradiction;
  then its links in file order, each with suggestion, archived source, archived passage, missing
  location, unchecked location, missing rationale. A finding disappears when the author records
  what was missing (an uncertainty note, a rationale, a locator, a review state, a re-anchor).
  There is no separate dismissal state to store or leak.
- **Scoped, and safe to print.** A finding's `path` is the post it is about (relative to the
  content folder, as citation findings), or the claims file when the post is missing; its
  `field` names the record and property. Findings name ids, slugs, relations and counts only and
  never repeat a statement, rationale, uncertainty note, anchor text or passage. Reviewing reads
  and never writes, locks or creates anything.
- **The same findings on every surface.** `openblog check` prints them as `evidence` lines with
  the other evidence findings, followed by a summary counting each outcome apart. `openblog
  build` (and the Admin and `serve` rebuilds that share it) reads the claims file only for this
  report and prints the same lines on stderr; nothing from the file reaches the output, a build
  without the file (CI, a static host) reports nothing, and a file that cannot be read is one
  warning naming the file and never stops the build. Admin's `GET /admin/api/research/claims`
  and every claims change response return `findings`, the identical list in the identical order,
  and Evidence Studio lists each claim's findings under it with the next action, and a summary
  for the post.
- **Projection notices stay notices.** `private-endpoint` and `undisclosed-contradiction`
  (ADR 0069) describe what a future publication withholds, not a gap in the evidence, and keep
  their own `notice:` lines.

## Consequences

- An author can work down a claim's findings to a record that names its sources, locations and
  reasons, without open.blog ever saying the claim is right.
- A new gap is one more code and one more row here; the contract, order and surfaces do not
  change.
- Some prompts are legitimately permanent (a whole-work source needs no locator; an uncertainty
  with no source behind it). Their outcome is `potential` or `needs-review`, never `detected`,
  and their repair says when nothing needs to change.

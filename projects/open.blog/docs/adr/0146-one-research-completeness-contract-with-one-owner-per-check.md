# ADR 0146: One research-completeness contract maps every research check, and each check has one owner

- Status: Accepted, amended by [ADR 0149](0149-the-publication-review-is-a-view-of-the-research-completeness-contract.md)
- Date: 2026-10-26
- Decision issue: [#191](https://github.com/journey-to-code-org/open.blog/issues/191)
- Parent story: [#189](https://github.com/journey-to-code-org/open.blog/issues/189)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0002](0002-research-profile-and-evidence-capability.md),
  [ADR 0050](0050-offline-citation-checks-and-portable-bibliography-exports.md),
  [ADR 0069](0069-contradicting-evidence-is-never-hidden-or-published-alone.md),
  [ADR 0074](0074-evidence-gaps-are-prompts-in-the-shared-finding-contract.md),
  [ADR 0092](0092-publish-approved-comparisons-as-one-rights-gated-projection.md),
  [ADR 0097](0097-chronology-prompts-are-structural-and-never-verdicts.md)
- Coordinates with: [#62](https://github.com/journey-to-code-org/open.blog/issues/62),
  [#193](https://github.com/journey-to-code-org/open.blog/issues/193),
  [#194](https://github.com/journey-to-code-org/open.blog/issues/194),
  [#195](https://github.com/journey-to-code-org/open.blog/issues/195)

## Context

Research checks have grown one feature at a time. The research-profile audit, citation checks
and evidence gaps share `EvidenceFinding` (ADR 0050, ADR 0074). The atlas, claims and alignments
files report `AtlasDiagnostic` errors and notices, the chronology index reports
`ChronologyPrompt`s, the notebook and source library report their own diagnostics, and the
comparison projection marks withheld wording. Each has its own codes and its own surfaces
(`openblog check`, build warnings, Evidence Studio, Admin). RW9 wants one readiness report
(#194, presented through #62's grouping) and new diagnostics (#193). Without one contract the
report would become a second validator, two checks could report the same condition under
different names, and nothing would say which outcomes may stop a build.

## Decision

- **One contract, core only.** `openblog_core::research_completeness` describes every research
  check as a `CompletenessFinding`: the owning `validator`, the `check`, the validator's own
  `code`, a `category`, the validator's own `outcome` (`detected`, `potential`, `needs-review`,
  the existing `EvidenceOutcome`), a `gate`, a `scope`, `related` objects, the validator's own
  `message`, and a `repair`. Converters (`from_evidence`, `from_atlas_diagnostic`,
  `from_chronology_prompt`, `from_note_diagnostic`, `from_source_diagnostic`,
  `from_comparisons`) map existing output in. No existing code, message, order, JSON field or
  surface changes; nothing prints the contract yet.
- **Each check has exactly one owner.** A check is one property of the research record, and
  `Check::owner` is a function, so no check can have two owners. A matrix row's validator is
  always its check's owner, because the row is derived from the check. The code tables are
  generated from exhaustive matches, so a new code in any existing enum does not compile until it
  is mapped, and once mapped it is in `matrix()`. Presentations (Admin, the CLI, build logs,
  #62's grouping and #194's report) gather findings and own no check.

  | Validator | Entry point | Checks |
  | --- | --- | --- |
  | `research-profile` | `research::audit_document` | `work-structure`, `reference-section`, `work-identifier` |
  | `citation-review` | `citation_review::review_citations` | `citation-syntax`, `citation-resolution`, `reference-completeness`, `location-review` (ADR 0050's four classes) |
  | `claim-review` | `claim_review::review_claims` | `claim-anchoring`, `evidence-relation`, `evidence-provenance`, `evidence-location` |
  | `source-library` | `SourceLibrary::parse` | `library-integrity` |
  | `notebook` | `Notebook::parse` | `notebook-integrity` |
  | `atlas` | `Atlas::parse`, `Atlas::notices` | `atlas-integrity`, `atlas-projection` |
  | `chronology-index` | `ChronologyIndex::of` | `chronology-consistency` |
  | `claims` | `ClaimSet::parse`, `ClaimSet::notices` | `claims-integrity`, `claim-projection` |
  | `alignments` | `AlignmentSet::parse`, `AlignmentSet::notices` | `alignments-integrity`, `alignment-places` |
  | `comparison-projection` | `PublicComparisons::project` | `comparison-rights` |
  | `source-review` (ADR 0148) | `source_review::review_post`, `source_review::review_library` | `identifier-compatibility`, `version-identity`, `quotation-location`, `citation-consistency` |

  The RW9 hand-off checks map one to one: missing reference `citation-resolution`, reference
  completeness `reference-completeness`, identifier `identifier-compatibility`, locator
  `location-review`, imprecise quotation `quotation-location`, version or translation
  `version-identity`, citation consistency `citation-consistency`, evidence relation
  `evidence-relation`, rights `comparison-rights`, unresolved claim `claim-anchoring`. #193
  adds its codes to `source-review`'s four checks and to nothing else; a condition an existing
  check already reports (a cited PMID's form, an unresolved key) stays with that check.
- **Categories group, never rank.** `integrity`, `public-boundary`, `structure`, `reference`,
  `identifier`, `version`, `locator`, `citation`, `claim-anchor`, `evidence`, `provenance`,
  `chronology`, `rights`. A category is a property of a code, so a check can span several (the
  library's integrity check reports identifier, locator and version codes).
- **The matrix of advisory codes.** Every code below is advisory: nothing is refused on it.

  | Validator | Code | Check | Category | Outcome |
  | --- | --- | --- | --- | --- |
  | research-profile | `doi-invalid`, `license-url-invalid` | work-identifier | identifier | detected |
  | research-profile | `abstract-missing` | work-structure | structure | detected |
  | research-profile | `references-missing` | work-structure | reference | detected |
  | research-profile | `footnote-unresolved` | reference-section | reference | detected |
  | research-profile | `reference-link-review` | reference-section | reference | needs-review |
  | research-profile | `doi-link-non-preferred` | reference-section | identifier | potential |
  | citation-review | `citation-identifier-unpublished` | citation-resolution | identifier | potential |
  | citation-review | `citation-reference-incomplete` | reference-completeness | reference | potential |
  | citation-review | `citation-location-review` | location-review | locator | needs-review |
  | claim-review | `claim-post-missing`, `claim-anchor-moved`, `claim-anchor-stale`, `claim-anchor-ambiguous` | claim-anchoring | claim-anchor | detected |
  | claim-review | `claim-suggestion-unreviewed` | evidence-relation | provenance | needs-review |
  | claim-review | `claim-evidence-missing`, `claim-rationale-missing` | evidence-relation | evidence | potential |
  | claim-review | `claim-support-only`, `claim-contradiction-undiscussed` | evidence-relation | evidence | needs-review |
  | claim-review | `claim-source-archived`, `claim-passage-archived` | evidence-provenance | provenance | needs-review |
  | claim-review | `claim-locator-missing` | evidence-location | locator | potential |
  | claim-review | `claim-location-unreviewed` | evidence-location | locator | needs-review |
  | atlas | `private-endpoint`, `unpublished-datings` | atlas-projection | public-boundary | detected |
  | claims | `private-endpoint`, `undisclosed-contradiction` | claim-projection | public-boundary | detected |
  | alignments | `stale-locator` | alignment-places | locator | needs-review |
  | alignments | `archived-member` | alignment-places | provenance | needs-review |
  | chronology-index | all eight prompt codes (ADR 0097) | chronology-consistency | chronology | needs-review |
  | comparison-projection | `withheld-rights`, `withheld-length` (a place's `withheld` value) | comparison-rights | rights | detected |
  | source-review | `identifier-conflict` | identifier-compatibility | identifier | potential |
  | source-review | `identifier-shared`, `identifier-on-work` | identifier-compatibility | identifier | needs-review |
  | source-review | `volume-missing`, `volume-unknown` | version-identity | locator | detected |
  | source-review | `translator-missing`, `witness-unidentified` | version-identity | version | potential |
  | source-review | `version-unspecified` | version-identity | version | needs-review |
  | source-review | `quotation-locator-missing`, `passage-locator-missing` | quotation-location | locator | potential |
  | source-review | `quotation-location-broad` | quotation-location | locator | needs-review |
  | source-review | `citation-same-identifier` | citation-consistency | citation | potential |
  | source-review | `citation-versions-mixed` | citation-consistency | citation | needs-review |
  | publication-context | `context-link-unpublished` | context-link | public-boundary | detected |
  | alignments | `stale-approval` (gate `withholds`, never acknowledgeable) | alignment-places | locator | needs-review |

  The review before publication (ADR 0123) added `publication-context` and its check
  `context-link`, and ADR 0149 moved them here with `file-unreadable`, a `refuses` code of each
  private file's integrity check for a file that cannot be read or projected at all.

- **Gates: only deterministic integrity and privacy failures refuse.** `citation-syntax` and
  `citation-unresolved` (citation-review, citation and reference, detected) are
  `refuses-when-published`: a post that publishes them is refused, a draft only warns
  (ADR 0049). Every error of the source library, notebook, atlas, claims and alignments files is
  `refuses`, outcome `detected`, under that file's integrity check. The atlas, claims and
  alignments files share one code enum, so the matrix lists each file's codes explicitly and an
  error has a row only under the files that report it (`cycle` is the atlas's, `anchor-mismatch`
  the claims file's, `missing-original` the alignments file's). Their categories: privacy
  failures (`contributor-credit`, `not-private`, `reader-feedback`, `private-reference`,
  `invalid-visibility`) are `public-boundary`; locator codes (`unknown-locator-kind`,
  `invalid-locator`, `ambiguous-locator`, `ambiguous-location`, `missing-locator`) are
  `locator`; `invalid-identifier` is `identifier`; version lineage (`kind-changed`,
  `unresolved-relationship`, `invalid-relationship`, `ambiguous-relationship`,
  `relationship-cycle`, `wrong-source-kind`) is `version`; `source-changed` and
  `conflicting-attribution` are `provenance`; `missing-evidence` and `evidence-conflict` are
  `evidence`; `anchor-mismatch`, `stale-anchor` and `ambiguous-anchor` are `claim-anchor`;
  `invalid-date`, `aspect-kind` and `duplicate-dating` are `chronology`; everything else is
  `integrity`. A `potential` or `needs-review` finding is always advisory, so no subjective
  judgement can block anything. A fourth gate, `withholds`, is for the one condition that leaves
  a single item out of a build without stopping it: a stale approval (ADR 0149).
- **Scoped to one object.** A `scope` names one object kind (`post`, `claim`, `evidence-link`,
  `source`, `interpretation`, `passage`, `note`, `entry`, `relationship`, `dating`, `alignment`,
  or a whole private file: `source-library`, `notebook`, `atlas`, `claims-file`,
  `alignments-file`) with the `id`, `index`, `path`, `line`, `column` and `field` the validator
  reported. A post is named by its path. A link finding relates its claim; a chronology prompt
  relates every dating it names, in its order; a withheld place relates its version (and its
  interpretation). A detail the validator did not report stays absent: nothing is filled in,
  and a finding whose validator gives no repair takes its check's next action. A finding about
  imported metadata names the import's own record and field; it never supplies a missing detail.
  When two records disagree (#193), the finding is scoped to one and relates the other, and
  neither is changed.
- **Prompts, never verdicts.** Messages are the validators' own, which name ids, fields, counts
  and stated values and never repeat statements, notes, excerpts, labels or unknown fields. The
  contract's own words (each check's property and action, each category's meaning) never say
  true, correct, verified, credible, authoritative, agreed, ready or fit, and there is no score,
  total, pass or "resolved" field: each outcome is counted apart.
- **One deterministic order.** By path, object kind, id, index, line, column and field, then
  category, outcome, validator, check, code, message, related objects, repair and gate. The order
  is total and depends only on the set of findings, never on the order validators ran in. Exact
  duplicates (the same validator's finding reached twice, as when a check and a rebuild both
  run) collapse to one; findings that differ in validator, code or object are never merged, so
  the atlas's and the claims file's `private-endpoint` notices stay two findings.
- **Author-only.** The contract is a private, in-memory description for authenticated Admin and
  local CLI output. It is never written into the static build, a feed, a portable export or a
  public projection, and no public renderer reads it.

## Consequences

- #194 builds one report from the converters and shows the same codes in the same order on
  every surface, without validating anything itself; #62 groups that report.
- #193 knows where each new diagnostic belongs, and #195's corpus can check every row.
- A new code is one arm in its table; the compiler refuses an unmapped variant.
- Not mapped, because they are not research checks: accessibility findings, portability and
  capability diagnostics, and media-moment quotation notices (co-author review of a shared
  publication). `CitationDiagnostic`s are not a separate family: citation-review already reports
  each as `citation-syntax` or `citation-unresolved`, and a published post's refusal is the same
  condition. The build's unpublished-datings warning is the atlas's `unpublished-datings`
  notice, one condition with one owner.

## Domain language

**Research completeness finding**, **Finding category**, **Owning validator** and **Finding
gate** are defined in [`CONTEXT.md`](../../CONTEXT.md).

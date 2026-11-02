# ADR 0112: Third Perspective shapes map mechanically onto B5's targets and provenance and RD12's policy when they merge

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#210](https://github.com/journey-to-code-org/open.blog/issues/210)
- Parent story: [#201](https://github.com/journey-to-code-org/open.blog/issues/201)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0109](0109-third-perspectives-are-reader-reflections-with-optional-prompts-and-four-distinct-stages.md),
  [ADR 0110](0110-submission-consent-is-an-append-only-record-and-anonymous-display-keeps-provenance.md),
  [ADR 0111](0111-third-perspective-lifecycle-and-its-one-public-projection.md)
- Coordinates with: B5 ([ADR 0076](0076-passage-targets-are-section-anchors-with-quoted-context.md) to [ADR 0083](0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md)) and
  RD12 ([ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md) to [ADR 0108](0108-retention-runs-from-a-dry-run-and-quotas-keep-only-hourly-digests.md)), both now on main
- Applied: 2026-10-26, when B5 (v0.33.0) and RD12 (v0.36.0) were merged into this branch

## Context

Third Perspectives reuse B5's passage targets and feedback provenance and RD12's participation
kinds and moderation state machine, but neither branch is on main. This contract has to compile
on main now and become a mechanical change, with no format change, once both merge.

## Decision

`openblog_core::third_perspective` carries minimal shapes with the same ids and JSON. At merge,
each is replaced as follows; stored records and submissions keep their JSON, parsed value for parsed value (object key
order aside, which JSON does not define).

| Here (main) | After B5 / RD12 merge | Mapping |
| --- | --- | --- |
| `KIND_ID`, `KIND_LABEL` | `participation::ParticipationKind::ThirdPerspective` | `KIND_ID == ThirdPerspective.id()`, `KIND_LABEL == label()`; keep the constants as those calls. A test asserts both. |
| `PerspectiveTarget` | `passage_target::PassageTarget` | `Work` = `PassageSelector::Work` with no section; `Section { section, digest }` = `PassageSelector::Section { digest }` with `section`. Make it a checked wrapper: `TryFrom<PassageTarget>` refusing `PassageSelector::Quote` with `targetNotAllowed`; `from_value` becomes `PassageTarget::from_value` plus that check. `TARGET_VERSION` = `PASSAGE_TARGET_VERSION`. The JSON is already B5's, field for field; key order may differ, because B5 embeds the target as a `serde_json` value with alphabetical keys. |
| `TargetStatus` | `passage_target::Resolution` | `PassageDocument::of_post(..).resolve(&target, Some(&copy.provenance.revision))`: `Current(location)` and `Reanchored(location)` → `TargetStatus::Current { section: location.section }`; `Stale(stale)` → `TargetStatus::Stale { section_present: stale.section_present }`. Add `impl From<&Resolution> for TargetStatus`. |
| `ReaderAttribution` | `feedback_provenance::ReaderAttribution` | Same fields and JSON; replace with a re-export. Name rules are the same (B5's `MAX_READER_NAME_CHARS`, whitespace collapsed, no control or bidirectional characters). |
| `Channel` | `feedback_provenance::FeedbackChannel` | Same ids (`hosted`, `manual`); re-export. |
| `Provenance`, `is_work_path`, `is_passage_revision` | `feedback_provenance::FeedbackProvenance`, B5's `is_work_path`, `passage_target::is_passage_revision` | The `provenance` object is B5's record, the same JSON key order aside (a test pins its keys and compares parsed values). Store `FeedbackProvenance` with the target checked as above; `FeedbackProvenance::public` is not used, because `ApprovedResponse` is this kind's projection. |
| `ModerationState` | `moderation::ModerationState` | Same six variants and ids; re-export. |
| `ModerationFacts` | `moderation::ItemFacts` plus the stored `approved_consent` | `state`, `revision`, `approved_revision` and `content_retained` are `ItemFacts` fields of the same names; `approved_consent` is stored with the approval (below). Add a constructor from `&ItemFacts` and the consent number. |
| `shown: bool` | `participation::effective_mode(config, post, ParticipationKind::ThirdPerspective)` | `shown = mode.shows_approved()`. `approved_response` then implies RD12's `moderation::is_public(item, mode)`, and adds the consent, work and name rules. |
| `ApprovalRequest::moderator` | `moderation::AuditEvent::actor_id` from the `Actor` | The inbox resolves the actor through RD12, calls `ModerationPolicy::decide` with `Approve`, and before applying it calls `check_approval` with the actor id; both results go in one write. |
| `ConsentOutcome::Withdraw` | `moderation::ModerationAction::Withdraw` by `Actor::Submitter` | Hosted copies only. Apply in the same write as the consent record. |
| `ConsentOutcome::RemoveAndPurge` | `moderation::ModerationAction::Remove` by a site Admin, then purge of the text | Manual copies only: RD12 accepts a withdrawal or clarification only from `Actor::Submitter`, and only a receipt makes a reader one. Apply the Remove and the purge in the same write as the consent record. |
| `SubmittedCopy::clarify` | `moderation::ModerationAction::Clarify` | Hosted copies only (a manual copy is refused with `clarificationUnavailable`). Same write; RD12's `superseded_revision` is the replaced text, which is not kept as a publishable revision. |
| `ConsentChoices::clarification` | `moderation::Submission::clarification_consent` | Record 1 sets it at admission; the stored `clarification_consent` then follows the consent in effect, so a reader who later declines can no longer be asked. |
| `Stage` | `moderation::ModerationState` and `ItemFacts::content_retained` | Unchanged: a pure view over RD12's facts. |

**Storage, a one-way door this task does not open.** No table, column or migration changes here.
The conservative mapping for #221 is one `openblog_feedback` row per copy (B5's [ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md), whose
`kind` and `status` columns check only the id's shape): `kind` = `third-perspective`; `work`,
`revision`, `target`, `body`, `seen_at`, `received_at`, `channel`, `reader_name` and
`publish_name` from the provenance as received; `details` = `{"category"?, "intake",
"consents"}` (the contract keeps `details` within that 16 KiB bound: `details_bytes`
is checked when a consent change is recorded and when a record is read, and a worst case of 80
four-byte-character names and a 4000-character body is a tested round trip; the 50-record count
alone does not guarantee it, because names repeat); `status` from RD12. The approval's
revision and consent number, and RD12's version and revision counters, need the additive columns
RD12 and #226 introduce. Until then nothing is stored, and the static site is unchanged.
([ADR 0113](0113-third-perspectives-are-one-feedback-row-submitted-through-the-one-route-with-a-receipt.md)
opens this door for #221 with exactly this mapping, adding `revisedAt` to `details` and one
nullable `approved_consent` column.)

## As applied

With B5 and RD12 on main, the table above is applied:

- `KIND_ID` and `KIND_LABEL` are gone; `third_perspective::KIND` is
  `ParticipationKind::ThirdPerspective`, and its `id()` and `label()` are the id and label.
  `ApprovedResponse::kind` is that kind, serialized as its id.
- `PerspectiveTarget` wraps a `PassageTarget`: `TryFrom<PassageTarget>` refuses a quotation
  with `targetNotAllowed`, `From<PerspectiveTarget> for PassageTarget` gives it back, and
  `from_value` refuses a `quote` kind before B5 reads its fields, so the error codes stay as
  they were.
- `TargetStatus` is `From<&Resolution>`.
- `ReaderAttribution`, `Channel` (B5's `FeedbackChannel`), `Provenance` (B5's
  `FeedbackProvenance`), `is_work_path`, `is_passage_revision` and the version and length
  constants are re-exports. A stored copy's provenance is B5's record, checked by B5 and then
  by the target restriction.
- `ModerationState` is RD12's. `ModerationFacts` keeps the stored `approved_consent` and adds
  RD12's `clarification_asked`, and `ModerationFacts::from_item(&ItemFacts, approved_consent)`
  builds it. `approved_response` and `featured` take the kind's `ParticipationMode`
  (`effective_mode(..)`) and show only while `mode.shows_approved()`, never while a
  clarification request asked about the current text, so a response is always one RD12's
  `is_public` allows.
- A hosted copy's `Intake::Hosted` digest is the digest of RD12's reader receipt
  ([ADR 0107](0107-reader-receipts-deletion-requests-and-anonymous-abuse-reports.md)): the
  reader withdraws, clarifies and changes consent through that receipt, and a revocation on a
  hosted copy is RD12's receipt withdrawal (`openblog_erase_feedback` with a withdrawal), which
  purges the text at once. A manual copy has no receipt: revoking it is a site Admin's `Remove`
  and a purge, and it cannot be clarified.

## Considered options

- **Merge B5 and RD12 into this branch first.** Rejected: neither is on main, and this contract
  must stand alone.
- **Different ids or JSON now, converted at merge.** Rejected: any stored or in-flight record
  would need migrating; identical ids and JSON make the merge a type substitution.

## Consequences

- The merge replaces type definitions with re-exports and adds the two `From` conversions; the
  state fixtures and tests keep passing unchanged, because they pin ids and JSON, not the type
  paths.
- If RD12's revision changes a state id or the kind's target shape, this table is the place to
  update.

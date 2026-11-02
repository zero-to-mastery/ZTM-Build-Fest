# ADR 0110: Submission consent is an append-only record, and anonymous display never means anonymous provenance

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#210](https://github.com/journey-to-code-org/open.blog/issues/210)
- Parent story: [#201](https://github.com/journey-to-code-org/open.blog/issues/201)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0109](0109-third-perspectives-are-reader-reflections-with-optional-prompts-and-four-distinct-stages.md),
  B5's feedback provenance ([ADR 0078](0078-feedback-provenance-records-the-revision-seen-and-consent.md))
- Coordinates with: [#214](https://github.com/journey-to-code-org/open.blog/issues/214) (RD14
  feature consent), [#222](https://github.com/journey-to-code-org/open.blog/issues/222) (receipts),
  [#211](https://github.com/journey-to-code-org/open.blog/issues/211) (withdrawal and retention)

## Context

A Third Perspective may be published only with the reader's explicit consent, attributed as the
reader chooses or anonymously. Consent must say what the reader agreed to publish and must be
revocable. RD14 adds feature consent bound to an approved revision. At the same time moderation
must never hold an anonymous item: someone has to be able to act for the submitter (withdraw,
change consent, answer a clarification), and every decision has to say who made it.

## Decision

- **Consent records.** A submitted copy keeps every `SubmissionConsent`, oldest first, numbered
  from 1; the last is in effect. Each record says:
  - `publish`: agreement to publish the reflection on the canonical page once approved. A
    submission without it is refused and nothing is kept.
  - `attribution`: B5's `{"name":…,"publishName":…}`. The name is private to moderation; it is
    shown only while `publishName` is true. Agreement without a name is refused.
  - `clarification`: agreement to be asked to clarify (RD12's clarification consent).
  - `featureRevision`: the text revision the reader agreed an editor may feature, if any.
  - `givenAt`: when the record took effect.

  Record 1 is the consent received with the submission, at `receivedAt`, and its attribution is
  the provenance's. Records are in time order. A record stores the name only when it differs from
  the record before (record 1 and the provenance share theirs; an empty string clears it), so a
  long name is not repeated. A history holds at most 49 records plus a final revocation, and a
  stored copy never serializes past 32 KiB, nor its `details` (category, intake and records) past
  16 KiB (B5's bound); stored copies that break any rule are refused when read, never repaired.
- **Reserved room.** Revoking must always be possible and narrowing must always take effect, so a
  change that widens, renames or agrees to more (a new clarification or feature consent) is
  refused with `consentLimit` once the history would pass 46 records (the last three slots
  are kept for narrowing and the last for revocation) or come within 1 KiB of either size bound.
  A change that only narrows may use the narrowing slots and needs only 256 bytes of room; a
  revocation needs none. At most three narrowing steps are ever left (hide the name, decline
  clarification, decline a feature), which is why three slots are kept.
- **Changing consent** (`SubmittedCopy::revise_consent`), by the submitter as the server proves
  them (ADR 0111):
  - **Narrowing takes effect at once**, in any state whose text is kept: hiding the name,
    declining clarification, declining a feature. The public projection follows immediately.
  - **Widening the name waits for a decision.** Showing a name, or a different name, is accepted
    only while the copy is pending or awaiting clarification, and an approval binds the consent
    record the moderator saw (ADR 0111). After approval, rejection or removal it is refused
    (`wideningAfterDecision`): the reader can withdraw and submit again. Even a stored record
    that widens after approval is never shown, because the projection shows a name only when the
    approved and the current consent agree on it.
  - **Feature consent binds to one revision**: the approved revision, or before a decision the
    current one. A clarification that replaces the text leaves an older feature consent
    uncovering the new text until the reader renews it. Approval alone never features anything.
  - **Revoking publication is withdrawal, and final.** It is recorded as a last record with
    `publish: false`, no shown name and no feature; while pending, in clarification or approved it
    asks the caller to apply RD12's `withdraw` in the same write (whose text is purged at once). A
    rejected or removed copy records it too, and can then never be approved again. Nothing follows
    a revocation, and a withdrawn copy accepts no change.
  - **A manual copy has no submitter.** RD12 lets only `Actor::Submitter` withdraw or clarify, and
    a reader becomes a submitter only through a receipt, which a manual copy (entered by an Admin
    user for a reader who wrote in another way) does not have. So for a manual copy, revoking
    publication is recorded as above but asks for a site Admin's `Remove` followed at once by a
    purge of the text (`ConsentOutcome::RemoveAndPurge`, in the same write), and a manual copy
    cannot be clarified (`clarificationUnavailable`; `can_clarify` is false). Narrowing a manual
    copy is an ordinary recorded change.
  - A change identical to the consent in effect, or dated before it, is refused, and nothing
    changes. Revocation never depends on anything else a change says.
- **Anonymous display, never anonymous provenance.** Whatever the reader shows publicly, the
  submitted copy always keeps:
  - B5's provenance record, the same JSON key order aside (B5 embeds the target as a
    `serde_json` value with alphabetical keys): work, the passage revision the reader saw, target,
    the reader's optional clock, `receivedAt` stamped by the receiver, channel and the attribution
    as received;
  - its **intake**: for a hosted copy the digest (64 lowercase hexadecimal digits) of the private
    receipt the reader holds, never the receipt itself; for a manual copy the Admin user who
    entered the reader's message. A copy without exactly the intake its channel needs is refused.

  Every approval names its moderator (ADR 0111), so neither side of a moderation decision is
  anonymous. Nothing else about the reader is kept: no e-mail, address, device, cookie or account
  field exists, and unknown fields are refused. Whether to collect contact details for a reply is
  left to a later version of the format.

## Considered options

- **Mutable consent fields on the item.** Rejected: an inbox could not tell which consent a
  moderator approved, and a revocation would leave no trace for retention.
- **Re-moderation for every consent change.** Rejected: hiding a name or declining a feature must
  never wait for anyone.
- **Allow adding a name after approval.** Rejected: a moderator never reviewed it, and a name can
  itself be abusive or impersonate someone. Withdraw and resubmit is the conservative path.
- **Fully anonymous submissions with no receipt.** Rejected: nobody could withdraw, answer a
  clarification or change consent, and moderation could not trace abuse.

## Consequences

- A manual copy whose reader wants to answer a clarification can only be removed and entered
  again; the conservative choice, since no one else may speak for the reader.
- RD10.2 (#221, [ADR 0113](0113-third-perspectives-are-one-feedback-row-submitted-through-the-one-route-with-a-receipt.md)) issues the receipt whose digest is the intake, and uses it to prove the
  submitter for consent changes, clarification answers and withdrawal.
- RD14 (#214) builds feature placement on `featureRevision` and the editorial
  `FeatureSelection`.

## Domain language

**Submission consent**, **Intake** and **Moderation provenance** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

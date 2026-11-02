# ADR 0176: Featuring a reflection is an editorial selection of one approved reflection, with the reader's own consent

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#214](https://github.com/journey-to-code-org/open.blog/issues/214)
- Parent story: [#205](https://github.com/journey-to-code-org/open.blog/issues/205)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md),
  [ADR 0110](0110-submission-consent-is-an-append-only-record-and-anonymous-display-keeps-provenance.md),
  [ADR 0111](0111-third-perspective-lifecycle-and-its-one-public-projection.md),
  [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0167](0167-a-readers-credit-is-opt-in-bound-to-the-text-it-was-agreed-for-and-shown-only-in-the-link-view.md)
- Coordinates with: [#229](https://github.com/journey-to-code-org/open.blog/issues/229) (curation),
  [#230](https://github.com/journey-to-code-org/open.blog/issues/230) (public section)

## Context

RD14 shows selected reflections again in a community section of the page they are about. RD10 already
has what that needs: a reader's consent history with a `featureRevision` (ADR 0110), an editorial
`FeatureSelection` and `FeaturedPublication` (ADR 0111) and a versioned public file of approved
reflections (ADR 0115). RD12 already decides who may approve and what is public. The risk is a second
system beside them: a new state, a new store, or a notion of "featured" that quietly replaces consent.

## Decision

- **Featuring is not a moderation state.** It is an editorial act on a reflection the one policy has
  already approved and the one projection already shows. RD12's machine gains no state, action, role,
  audit action or hosted column. A reflection that is not approved, shown and about this work cannot be
  featured, and one that stops being so stops being featured (ADR 0178).
- **Neither approval nor publication features anything.** A reflection is featurable only when the
  reader's consent in effect agrees to feature exactly the approved text revision (`featureRevision`,
  agreed with the submission or later by the reader's own receipt). The agreement is separate from
  agreeing to publish, from showing a name and from being asked to clarify. An Admin user cannot
  grant it, widen it or assume it.
- **The reader's paths exist, and are built with the curation task (#229).** The submission form has an
  unticked "An editor may feature my reflection in a community section" choice, whose hint says it is
  separate from publishing, covers only this text, is the editors' choice and that copies already
  published may remain. The reader's receipt has a `feature` action, allowed while the reflection is
  pending, in clarification or approved: it appends a consent record (an agreement for the revision the
  reader sees, or a decline) and raises the version, so a moderator or Admin acting on an earlier view is
  refused. It is hosted-additive: consents already live in `details`, every reader already knows
  `featureRevision`, and there is no schema change. The receipt also says feature-specific wording when
  the reader withdraws: a feature and a shown name stay in the site's history. A reader with no hosted
  service can still tick the choice in the copy-and-send text.
- **A selection is a reference.** `FeatureRecord` holds the published reflection's id and post, the
  text revision agreed, a digest of that text, the day it was featured
  and the editor's optional note, and no name. It holds none of the reader's words: the page reads them
  from the published reflection (ADR 0115), so everything that takes a reflection off (withdrawal,
  deletion, removal, a hidden kind) takes its feature off without a second copy to forget.
- **Only a site Admin user chooses.** `FeatureRecord::new` needs a valid Admin user name and then
  checks, against the hosted copy, that the one projection shows it now, that the consent agrees to its
  approved revision, and that the published file holds the same text and the same shown name (a name the reader hid since
  is republished first). Each
  failure is a stable code (`notShownNow`, `consentMissing`, `consentForOtherRevision`,
  `publishedDiffers`, `invalidEditor`) and nothing is written.
- **Featured is a place, not a promotion.** A feature has exactly one placement: the community section
  of the canonical page of the work the reflection is about (ADR 0180). Where else the reflection may
  appear does not change: feeds, portable copies, search and `llms` files still carry no reflection
  (ADR 0115).

## Considered options

- **A `featured` flag on the hosted row.** Rejected: it is a hosted schema change that cannot be
  undone for sites that adopt it, and the static page would need the service to know what is featured.
- **Copy the reflection into the feature record.** Rejected: a second copy of the words would outlive a
  withdrawal unless every path remembered it.
- **Treat approval as consent to feature.** Rejected: the reader agreed to publication on the page they
  wrote about, not to being selected and put forward again.

## Consequences

- RD10's first-draft `FeatureSelection`, `FeaturedPublication` and `SubmittedCopy::featured` (ADR 0111)
  had no caller and a second, weaker version of the check; they are removed, and `feature_covers` stays.
  Admin's standing, the feature itself and the page all ask the one projection
  (`PublishedPerspective::response_in`).
- Curation (#229) and the page (#230) read and write one file and call this module; they need no new
  hosted route to decide what may be featured.

## Domain language

**Feature consent**, **Feature record** and **Community section** are defined in
[`CONTEXT.md`](../../CONTEXT.md).

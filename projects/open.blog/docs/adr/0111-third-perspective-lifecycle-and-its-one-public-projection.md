# ADR 0111: A Third Perspective's lifecycle runs on the one moderation state machine, with one public projection

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#210](https://github.com/journey-to-code-org/open.blog/issues/210)
- Parent story: [#201](https://github.com/journey-to-code-org/open.blog/issues/201)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0109](0109-third-perspectives-are-reader-reflections-with-optional-prompts-and-four-distinct-stages.md),
  [ADR 0110](0110-submission-consent-is-an-append-only-record-and-anonymous-display-keeps-provenance.md),
  RD12's moderation state machine ([ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md)), B5's target resolution
  ([ADR 0077](0077-targets-resolve-as-current-reanchored-or-stale.md))
- Coordinates with: [#225](https://github.com/journey-to-code-org/open.blog/issues/225)
  (moderation inbox), [#222](https://github.com/journey-to-code-org/open.blog/issues/222)
  (status and portable fallback), [#214](https://github.com/journey-to-code-org/open.blog/issues/214)
  (featured reflections)

## Context

RD12 defines one moderation state machine for every participation kind: pending, clarification,
approved, rejected, removed and withdrawn, with approval bound to the text revision. A Third
Perspective adds what that machine does not know: the reader's consent records, an approval that
must also bind the consent it reviewed, the target's standing in a work that keeps changing, and
the rule that a reader's reflection is never shown as an author's perspective, including on a
group-authored work.

## Decision

- **Lifecycle stages** (`Stage`), each a moderation state, never a parallel machine:

  | Stage | RD12 state | Public |
  | --- | --- | --- |
  | `local` | none: the site holds nothing | no |
  | `submitted` | pending | no |
  | `clarification` | clarification | no |
  | `approved` | approved | while the projection below allows |
  | `rejected` | rejected | no |
  | `removed` | removed | no |
  | `withdrawn` | withdrawn | no |
  | `deleted` | any state, text purged by retention | no |

  RD12 decides every transition, grant and retention step. This module adds checks the caller runs
  in the same write; any error means nothing changed.
- **Moderation decision.** A decision is RD12's transition and audit event. For a Third
  Perspective, an approval (`SubmittedCopy::check_approval`) also needs: a named moderator (the
  audit's actor id; an empty or blank id is refused as `anonymousModerator`), a pending copy, the
  reader's publication consent in effect, and the text revision and consent record the moderator
  reviewed (`staleRevision`, `staleConsent` otherwise). It returns the `ApprovalBinding`
  (revision, consent record, moderator, time) stored with RD12's approve transition.
- **Revision.** The text changes only by answering a clarification request
  (`SubmittedCopy::clarify`, alongside RD12's `clarify`): the answer replaces the text as the
  next revision, the replaced text can never be approved, and an approval of an older revision
  publishes nothing. Consent changes (ADR 0110) never change the text revision.
- **Withdrawal and deletion.** Revoking publication asks for RD12's withdrawal; a withdrawn copy
  is never public and its text is purged at once. Once retention purges the text, name and
  consent records, the stage is `deleted` whatever the state, nothing can change, and only the
  audit trail remains.
- **The one public projection** (`SubmittedCopy::approved_response`). An approved response exists
  only when every condition holds: the kind is shown on the post (RD12's mode `locked` or `open`),
  the copy is approved at its current revision, its text is kept, the approved consent record and
  the consent in effect both allow publication, and the work is the one the copy is about. It
  holds exactly:
  - `kind` (`third-perspective`) and `role` (always `reader`);
  - `work`, `about` (`work` or `section`), and for a section its heading id now;
  - `stale`: the section the reader wrote about has since changed or gone (its old heading id is
    kept only while that section still exists, as B5 does for public provenance); a whole-work
    reflection is never stale;
  - `earlierRevision`: the reader read an earlier revision of the work, so a page can say so;
  - the optional `category`, the plain-text `body` and the day it was `received`;
  - `name`, only while the approved and the current consent show that same name, and never when it
    matches a name the work credits (an author, a member or the group). The comparison is how a
    reader would see the names: both sides drop invisible and default-ignorable characters (zero
    width and joiner characters, word joiner, soft hyphen, variation selectors, tags) and combining
    marks, fold accented Latin letters to their base letter (Latin-1 and Latin Extended-A, so
    `José` and a decomposed `Jose` + acute meet), collapse whitespace and ignore case. The
    check is a conservative hint, not identity: it errs toward hiding a name. The inbox sees that match (`name_matches_credit`) so a moderator can ask the reader.

  It has no field for provenance, intake, consent records, moderation state or reasons, revision
  numbers, ids, the reader's clock, the channel or an unpublished name, so no renderer can show
  them. Its accessible heading is "Third Perspective from a reader" or "Third Perspective from
  Mina, a reader": never an author's or a group's.
- **Where it may appear.** Approved responses are a reader layer on the canonical page, shown
  apart from the authors' sections and after them, never inside the Post, its credits,
  "Continuing the conversation", feeds, portable HTML or Markdown, search or `llms` files. Portable
  copies carry only a canonical participation link (#222, #92's canonical-only interaction).
  Pending, clarification, rejected, removed, withdrawn and deleted copies are never counted or
  shown, and nothing ranks or orders responses by popularity.
- **Featured publication** (`SubmittedCopy::featured`) exists only while the approved response
  does, when an Admin user chose that approved revision (`FeatureSelection`) and the reader's
  consent in effect covers featuring exactly it. RD14 decides placement, context and what a later
  withdrawal does to a featured copy.
- **State fixtures** (`crates/openblog-core/tests/fixtures/third-perspective-states.json`) pin
  the stage and the exact public projection, or its absence, for pending, clarification,
  approved (anonymous, private name, shown name, manual intake), withdrawal, revoked consent,
  revised consent (hidden, added, changed before approval), deletion, rejected and removed content,
  clarified revisions, hidden kinds, another work, stale articles (updated work, current, moved,
  changed and removed sections), group-authored works (names matching a member or the group,
  and a distinct reader name) and feature consent (covering, missing, for a replaced revision,
  revoked, removed copy).

## Considered options

- **A Third Perspective state machine.** Rejected: one machine serves every kind (ADR 0102); the
  kind adds checks, not states.
- **Re-check a stale section target by quoting it.** Rejected: a stale target is never re-quoted,
  so text an author removed is not republished; the projection only says that it changed.
- **Show a reader's chosen name even when it matches an author.** Rejected: on a group-authored
  work it would present a reader's reflection as a member's perspective.

## Consequences

- The inbox (#225) shows a Third Perspective with its consent in effect, the consent number and
  revision it would approve, and the credit-name hint; it calls `check_approval` before RD12's
  `approve`.
- Pages (#222) render `ApprovedResponse` and nothing else of a copy.

# ADR 0064: Capturing media moments in Admin Studio

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#175](https://github.com/journey-to-code-org/open.blog/issues/175)
- Parent story: [#149](https://github.com/journey-to-code-org/open.blog/issues/149)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Builds on: [ADR 0017](0017-own-draft-routes-and-private-draft-storage.md),
  [ADR 0021](0021-combined-review-preview.md),
  [ADR 0025](0025-storing-authorizing-and-approving-shared-synthesis.md),
  [ADR 0062](0062-media-moments-locate-attributed-quotations-and-observations.md),
  [ADR 0063](0063-media-moments-stay-private-until-revealed-and-bind-into-approval.md)

## Context

ADR 0062 and 0063 define media moments and the rules that keep them private and bound into
approval, but nothing stored them, routed them, sealed them or showed them. Contributors need to
capture, edit, order and follow moments from their own contribution in Admin Studio, with a
working link even when an embed is missing, and without exposing anyone's words early.

## Decision

- **Storage.** One private file per publication,
  `.openblog/private/collaboration/moments/<publication>.json`, beside the drafts and the
  synthesis. It is read in full and refused when malformed, never treated as empty, so a bad file
  cannot drop a proposed moment from the binding. Writes are compare-and-swap against the text that
  was read, through the same atomic replace as the drafts, in the request's content transaction.
- **Authorization.** A new `AuthorizationAction::EditMoments` targets the requester's own
  participant. Only Contributors hold it, and only for themselves, because a moment proposed for
  the piece makes its owner a required approver, which an Editor cannot be. Readers, Editors,
  coordinators and site owners who do not also contribute get the same not-found as an unknown
  publication. The moment authors passed to `MomentSet` are the participants who hold the grant now.
- **Routes.**
  - `GET collaboration/moments?publicationId=` returns the requester's own moments, the moments
    other authors revealed to them (through `MomentSet::revealed`, against the owner's latest
    draft revision the requester may read), the reflection's sources with their normalized links,
    and the set revision.
  - `POST collaboration/moments` applies one `change` (`add`, `edit`, `remove`) against
    `expectedRevision`. The body denies unknown fields, so it cannot name a participant, a link or
    a visibility flag. A stale revision or a lost write race is 409; a malformed or rule-breaking
    moment is 422 naming the field (`source`, `locators`, `quotation`, `speaker`, `language`,
    `observation`, `content`, `rights`) and never repeating the text; every refusal about a moment
    or a publication the requester may not touch is one 404. A published reflection refuses
    changes with 409. A stored change reconciles approvals in the same transaction.
  - Each moment carries its server-derived `link` (`href`, `atTime`) and a plain `location`
    (`location_text`), so the client never builds a URL.
- **Sealing on offer.** When a writer offers a draft revision (`PUT collaboration/reveal/ready`
  with a revision), the route seals their proposed moments to that revision after the offer is
  stored. The offer is the writer's act of sharing under both the voluntary and the all-ready
  rule, so it fixes what goes with the revision even when the reveal completes later. The seal is
  written once per revision, as ADR 0063 says: an offer of a revision that was already sealed
  shares no later moment edit, and the response says so (`momentsShared: false`). Sealing after the
  offer fails closed: if it cannot be written, the moments stay private, and the response says that
  instead (`momentsShared: null` with a `momentsNote` asking the writer to offer the revision
  again), so a storage failure is never mistaken for the write-once case.
  - A seal does not raise the set's revision. Seals are not something a participant edits or sends
    back, so an offer never makes the revision the writer's panel holds stale; the file's
    compare-and-swap still refuses a seal written over a concurrent change.
  - After a successful offer the panel reads the moments again, keeping anything typed, so
    moments others revealed meanwhile appear.
- **One subject everywhere.** The stored set is loaded wherever the approval subject is built: the
  combined preview, approving and withdrawing, approval reconciliation, the approval rule view and
  the publish and schedule gate. Reconciliation also drops the moments and seals of anyone who no
  longer holds the grant, in the same transaction as the author-set change.
- **Preview.** An author's proposed moments are part of their contribution. Another author's part
  counts as shown only when its latest revision is readable and the owner's moments are sealed to
  it; otherwise the whole part is the uniform placeholder and no approval token is issued, so
  nobody can approve moments they have not seen. Moments the reader may see are listed in the
  preview document, after the sections, as escaped text and observations through the production
  renderer, labelled as covered by approval and not yet published.
- **Gate.** `assemble` refuses with `UnresolvedMoment` while a proposed moment no longer fits its
  source, checked only once approvals are met. The gate still publishes no moment: rendering is
  #177, so canonical content and public output stay unchanged.
- **Admin panel.** The shared draft panel gains a "Moments in the sources" section for
  contributors, following the continuing conversation's idioms: labelled controls, a status line,
  one alert that takes focus on failure and marks the field, focus returned to the control just
  used, typed text kept across refusals, conflicts and reloads, and a confirmation before removing.
  The client reads typed times exactly as the server does (seconds or `h:mm:ss`, optional
  fraction) and refuses malformed ones before sending; the server stays the authority. Moments
  list by the source's place in the reflection, then by time, then in the order made. A link opens
  the source at the moment where the provider allows it, the original address otherwise, and a
  source with no address keeps the location as text.

## Consequences

- Moments work without any hosted service; they are private files like the drafts.
- A writer with no proposed moments still gets a seal at each offer. That records that nothing
  went with the revision, so moments added later wait for a newer revision.
- Editing a moment's source is not offered: a moment keeps its source for life (ADR 0062). The
  panel edits one location and keeps any further locators the moment already has.
- Rights guidance is #176 and rendering approved moments is #177.

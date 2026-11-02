# ADR 0063: Media moments stay private until revealed with a draft, and bind into approval

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#174](https://github.com/journey-to-code-org/open.blog/issues/174)
- Parent story: [#149](https://github.com/journey-to-code-org/open.blog/issues/149)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Builds on: [ADR 0016](0016-private-contribution-revisions-and-mutual-reveal.md),
  [ADR 0020](0020-approval-snapshots-bound-to-exact-content.md),
  [ADR 0021](0021-combined-review-preview.md),
  [ADR 0024](0024-shared-synthesis-items-without-a-consensus-requirement.md),
  [ADR 0062](0062-media-moments-locate-attributed-quotations-and-observations.md)

## Context

A moment holds prose: an observation and a quotation. In a shared reflection, three rules govern
prose:

- It stays private to its author until a reveal shares one exact draft revision (ADR 0016).
- The review preview shows only latest revisions the reader may read (ADR 0021).
- An approval binds the exact content it covers (ADR 0020).

Moments must follow the same rules. Otherwise they become a way to read another author's words
early, or to publish words nobody approved.

## Decision

- **Storage shape.** Each shared publication has one `MomentSet`, kept beside its drafts and
  synthesis. The set has:
  - a version and a set revision;
  - a `moment-N` counter, and a set with an id ahead of the counter does not load;
  - at most 100 moments.

  A stored set is checked in full on load and denies unknown fields. It is at most 4 MiB, which is
  more than a full set at every limit, and a change that would write more is refused.
- **Intent.** Each moment is either `private` (the default) or proposed for the `publication`. Only
  the owner ever sees a private moment. It never enters a binding, a preview or an output, so it can
  carry a quotation whose rights are unknown. A publication moment cannot.
- **Seals tie moments to a revealed draft revision.** A reveal shares the owner's draft revision N,
  through an exchange commit or a voluntary offer. At that point the caller seals the owner's
  publication moments to N: the seal is a digest of exactly those moments' own content (id, owner,
  source id, locators, every quotation field, observation and intent). It leaves out the source's
  title, link and type. A seal is never rewritten, so a seal over the source would hide every
  moment revealed on a source as soon as someone corrected it. A source change still stales
  approvals through the binding frame, below.
  - Another author sees the owner's publication moments only while both of these hold: the caller
    has checked through `DraftSet::view` that they may read the owner's latest revision N, and the
    seal for N still matches the moments as they are now.
  - A seal is written once per revision and only moves forward. An edit made after a reveal
    therefore stays private until a newer revision is revealed, just as a draft edit after a commit
    does.
  - Every other case returns the same empty list, so the answer reveals nothing. That covers an
    owner with no moments or only private ones, an edit since the reveal, an older readable
    revision, and a removed owner.
  - `is_sealed` tells a preview whether the owner's part is complete for a reader.
- **Authorization and concurrency.**
  - Only authors act. Anyone else is `Denied` for every call, reads included.
  - Only the owner edits or removes a moment. Another author's moment and a missing id give the
    same `Denied`.
  - Every change names the set revision the caller read, and a mismatch is `Stale`. Sealing is
    not such a change: it leaves the revision as it was.
  - A change is applied to a copy and kept only when it is valid and storable, so a refused call
    changes nothing.
- **Approval binding.** `binding_frame` returns a count, then one digest per publication moment in
  order. Each digest covers the moment's owner, its source and that source's public title, link and
  type, its locators, its quotation with speaker, rights and provenance, and its observation. The
  frame holds no prose, names or links.

  `assembly::with_subject`, the one builder of the approval subject, takes the publication's
  `MomentSet` after the synthesis and appends the frame after the synthesis frame. It also adds
  every owner of a publication moment to the subject's attributed authors, so each of them must
  approve the piece under every policy. As a result, each of these stales every standing approval:
  - any change to a publication moment;
  - proposing a moment for the piece, or withdrawing one;
  - a change to the source a moment shows.

  A set with no publication moments binds exactly as before, so existing approvals are unchanged.
  `assemble` and `preview::build` take the set too and pass it through; there is no second entry
  point that leaves moments out, and a caller that has not loaded them passes an empty set.
- **Reconcile.** `reconcile` drops the moments and seals of anyone who is no longer an author.
  Restoring the author does not restore either.

## Consequences

- This task adds core types, validation and tests only. No route, storage file, panel, preview,
  gate or renderer reads moments yet, so canonical content and public output are unchanged. Later
  tasks (#175 to #177) will:
  - store the set with the same compare-and-swap writes as drafts;
  - route changes through `SharedPublication::authorize`, open to Contributors for themselves, as
    `EditSynthesis` is;
  - call `seal` from the reveal routes;
  - load the stored set into the preview, the approval routes and the publish gate, which pass
    an empty set until then;
  - refuse to publish while `unresolved` reports anything;
  - render approved moments through the ordinary post pipeline.
- Suppose an owner commits revision N to an exchange that is then cancelled. The seal for N keeps
  its first digest, so an owner who edits moments before offering N again must save a new revision
  to share the edit. This is the conservative choice.
- A participant who wrote no draft cannot reveal moments, so a later preview treats their
  publication moments as an unshared part.

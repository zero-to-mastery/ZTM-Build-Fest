# ADR 0016: Contribution drafts are append-only revisions revealed only by mutual exchange

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#162](https://github.com/journey-to-code-org/open.blog/issues/162)
- Parent story: [#146](https://github.com/journey-to-code-org/open.blog/issues/146)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0005](0005-shared-publication-language.md) deferred per-draft revisions, and
[ADR 0014](0014-record-level-authorization-and-publish-gate.md) leaves reveal and edit routes to
later work. Without a defined revision and reveal model, a route could expose a draft early, let a
late edit slip into a reveal, or leak a draft's existence through a distinguishable error.

## Decision

- A contribution draft belongs to one participant and changes only by appending a numbered,
  immutable revision. A save names the revision the caller last saw (0 to create); any other
  number is `Stale`, and a failed save changes nothing.
- A revision is identified by contribution id, number, author participant, timestamp, and a
  Blake2s digest over author, contribution, number, and exact Markdown. That stamp carries no
  prose, so it can appear in lists, logs, and conflict messages. Debug output never prints prose.
- Visibility is server-enforced by `DraftSet::view`. The owner reads the latest revision. Anyone
  else reads only the exact revision committed to a revealed exchange that lists them, and only
  while the draft is not withdrawn.
- Reveal is a mutual exchange of two or more participants, each committing one exact revision of
  their own draft. Nothing is visible until the last member commits; then every member can read
  every committed revision in the same mutation. A pending exchange can be retracted or
  cancelled by any member and exposes nothing, so an interrupted reveal is safe. A solo
  participant has no exchange. Edits after a commit stay private.
- Reveal never equals approval. The draft set holds no approval state and never touches the
  collaboration contract; approvals still bind one contract revision (ADR 0014).
- Withdrawal hides a draft from everyone else, cancels its pending commitments, and blocks new
  revisions. Revisions are retained for the owner; a copy already read cannot be recalled.
- Every refusal about someone else's draft is the same `Denied`, except that a save that is not
  creating (nonzero expected revision) answers `Stale` for a foreign id exactly as for a missing
  one. Draft and exchange ids are unique across the set and compared ignoring ASCII case, so a
  create over a taken id is refused; that collision, never content, is the only thing a
  participant can learn about an id they do not own. Persisted data is revalidated on load (digests, ownership, exchange consistency)
  and unknown fields are rejected.

## Relationship to the contract's contributions and reveals

`DraftSet` is the authority for draft content: who may read or edit a draft, and when it is
revealed. `contract.contributions` and `contract.reveals` ([ADR 0005](0005-shared-publication-language.md),
[ADR 0014](0014-record-level-authorization-and-publish-gate.md)) stay what they were, a role and
layout vocabulary, and no longer grant access to draft content. They are not written by `DraftSet`,
and a mutual reveal never edits them. Therefore:

- A draft route calls `SharedPublication::authorize` for the requester's role on the Publication
  or on their own Participant target, then asks `DraftSet`. `ViewRevealed` and "Own or revealed"
  are not consulted for draft content.
- "Edit contribution: Own or revealed" in the specification is narrowed for draft content: only
  the owner appends revisions, even after a draft is revealed. To respond to a revealed draft,
  an editor saves a draft of their own.
- Draft ids are not required to appear in `contract.contributions`. A later story that links
  drafts to the contract must do so by an explicit, revision-checked decision.

ADR 0005's statement that drafts have no revision of their own is amended: draft content has
numbered revisions in the `DraftSet`; the contract still approves as a whole revision.

## Consequences

- Later routes call `SharedPublication::authorize` first, then this module, inside the same
  revision-checked transaction that stores the set. Storage and routes are separate work.
- Public output, feeds, exports, and canonical content never read a `DraftSet`.

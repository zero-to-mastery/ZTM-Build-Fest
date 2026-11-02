# ADR 0018: A coordinator-chosen reveal policy, per-revision readiness, and a placeholder comparison

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#164](https://github.com/journey-to-code-org/open.blog/issues/164)
- Parent story: [#146](https://github.com/journey-to-code-org/open.blog/issues/146)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0016](0016-private-contribution-revisions-and-mutual-reveal.md) defined the mutual exchange but
nothing let a participant start one, and [ADR 0014](0014-record-level-authorization-and-publish-gate.md)
left the reveal route deny-by-default. Readers of a comparison must never learn more than reading
each draft would allow.

## Decision

- The draft set holds a reveal policy, defaulting to `independent`: nothing is ever revealed.
  `voluntary` reveals among any two or more participants who mark a revision ready, and only those.
  `allReady` reveals only when every participant who currently holds the draft grant is ready.
- A new action `SetRevealPolicy` targets the publication and is held by Site owners and
  Coordinators. It reads no draft. A coordinator who is not a drafter can set the policy and sees
  the policy only.
- Marking ready names one exact revision of the caller's own draft and goes through
  `EditDraft`. The offer is private and can be replaced or taken back at any time before the reveal
  commits. When the policy condition is met, the same write turns all offers into one revealed
  exchange (ADR 0016 semantics), so every member reads every committed revision at once or nobody
  does. Edits after an offer or reveal stay private. Withdrawing a draft takes back its offer.
- Changing the policy clears every standing offer and reveals nothing itself, so a policy change
  cannot expose prose that was offered under another policy. Offers cannot exist under
  `independent`, and stored data that says otherwise fails to load.
- Participant removal: the route computes the active drafters through `authorize` on each binding.
  A removed or downgraded participant neither counts toward `allReady` nor joins a reveal. Their
  earlier offers and any reveal already committed are untouched, and a copy already read cannot be
  recalled.
- `voluntary` visibility is derived at read time and never stored or merged. A publication has one
  author set, made up of the participants the maintainer (site owner or coordinator) added, and it
  never splits into groups. Under `voluntary`, a reader V may read participant T's draft only when
  the policy is `voluntary`, V and T differ, both are active, both hold a standing ready offer, and
  T's draft is not withdrawn. V then sees exactly the revision T marked ready, matched on
  participant and contribution, never a later unmarked revision or a different contribution. The
  reason is that a stored circle had to be merged and carried over across removals, which could hand
  one person's prose to people it was never offered to; deriving it from the standing offers means
  nothing is stored that could outlive its meaning. A participant who marks a newer revision ready
  moves the shared revision forward. Retracting readiness, withdrawing, being removed, or a policy
  change that clears the offers ends the visibility, and a participant who becomes active again
  while the offer still stands rejoins the author set. Marking ready returns "revealed" only when
  another active participant has a standing offer. Exchanges created by `allReady`, by the explicit
  open and commit API, or stored by v0.21.0 keep their old meaning: they are never pulled into
  voluntary visibility and never feed it. `DraftSet::view` and `DraftSet::compare` take the active
  list so the comparison goes through the same check.
- The comparison lists every contract participant in contract order with their display name. Each
  slot is the caller's own latest revision, a revision revealed to the caller (decided by
  `DraftSet::view`), or a placeholder that is identical for missing, unrevealed, withdrawn and
  unknown drafts. A placeholder says only whether that participant has offered a revision. Prose,
  names and metadata are JSON strings; a client renders them as text, never as markup.
- Routes: `GET /admin/api/collaboration/reveal`, `PUT .../reveal/policy`, `PUT .../reveal/ready`.
  All need the Admin session, writes need CSRF and strict JSON, every refusal is the same 404, and
  writes use the revision-checked draft store (409 on a race, nothing changed). Manual exchange
  creation and `POST .../contribution/reveal` still have no route. No browser panel ships here.

## Consequences

- Reveal never approves anything and the contract is untouched.
- Publication approval and group-safe state beyond this model stay with later stories.

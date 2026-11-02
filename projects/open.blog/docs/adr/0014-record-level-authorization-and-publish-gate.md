# ADR 0014: Authorize every collaboration operation through the record, and gate publishing on approval

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#160](https://github.com/journey-to-code-org/open.blog/issues/160)
- Parent story: [#145](https://github.com/journey-to-code-org/open.blog/issues/145)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Contract: [Shared perspectives collaboration contract](../specs/shared-perspectives-collaboration.md#authorization-policy)

## Context

[ADR 0006](0006-collaborator-identity-binding.md) defines the role matrix and
[ADR 0013](0013-publication-scoped-invitations.md) adds invitations. Admin handlers each built
their own authorization context, so a new operation could forget a field or skip the check, and
the matrix said that a publish grant does not bypass participant approvals without any code
enforcing it.

## Decision

- `SharedPublication::authorize` is the only way a handler asks whether the signed-in Admin
  account may perform an action. It takes the account, the current identities, the action, and
  the target, and reads the policy, the contract, and the publication id from the record itself.
  Listing and inviting use it.
- A collaboration route with no handler is unrouted and answers `404`, so a new operation is
  denied until it is added and authorized. Every denial is the same private error and never says
  whether the record, the account, or the target was the problem.
- `SharedPublication::authorize_publish` requires the publish grant first, then requires that
  every participant who owns a contribution has approved the contract's current revision. Site
  ownership alone never publishes unapproved prose. Only a requester who holds the grant learns
  that approvals are missing (`PublishError::Unapproved`); anyone else gets `Denied`.
- Pending, revoked, expired, and declined invitees hold no binding, so they hold no grants; a
  disabled account, a removed registry key, or a removed participant stops a binding from acting.

## Consequences

- Later routes (contribution edit, reveal, approve, schedule, publish, remove, export) call
  `authorize` or `authorize_publish` inside the same transaction as their write.
- Exact-revision consent recording and the transactional publication gate stay separate work;
  this decision only makes the publish check refuse what is not yet approved.

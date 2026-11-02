# ADR 0013: Invite collaborators with hashed, single-use, publication-scoped tokens

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#159](https://github.com/journey-to-code-org/open.blog/issues/159)
- Parent story: [#145](https://github.com/journey-to-code-org/open.blog/issues/145)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Contract: [Shared perspectives collaboration contract](../specs/shared-perspectives-collaboration.md#authorization-policy)

## Context

[ADR 0006](0006-collaborator-identity-binding.md) makes an explicit binding the only source of
collaboration access, and says invitations must create bindings and bind the account that
accepts. [ADR 0007](0007-private-shared-publication-records.md) keeps each publication in one
private record. A site owner or coordinator now needs a way to bring another signed-in writer
into a publication without editing files, without email, and without any identity implying
another.

## Decision

An invitation lives in the publication's own record, in an optional `invitations` list, so the
participant, the binding, and the invitation outcome change in one atomic write and a failure
leaves everything as it was. Records without the list still load.

An invitation names the Admin account and the contributor registry key it is for, the roles it
grants, and an expiry of 1 to 30 days (default 7). The inviter must hold the `Invite` action
(site owner or coordinator) and may only grant roles they could grant through role management, so
a coordinator never creates or withdraws a site-owner invitation. The account must be active and
the key must exist, and neither may already be bound or already have a pending invitation. A
record keeps at most 100 invitations; finished ones are forgotten oldest first to make room.

The token is `<publication-id>.<256 random bits as hex>`. It is shown once, when the invitation
is created or reissued, and is never stored or logged: the record keeps only a domain-separated
BLAKE2s hash of the whole token, so the hash is bound to one publication. Redeeming hashes the
presented token and compares it against every stored hash in constant time without stopping at
the first match. A token that is wrong, belongs to another publication, is spent, expired,
revoked, or is for another account all give the same answer, so a probe learns nothing about
which. Token secrets have enough entropy that guessing is infeasible, and attempts are also
limited to five per signed-in account per window before a lockout, refunded on success.

Accepting is done by the invited account itself and needs both the token and the registry key the
invitation names, so a token never binds another identity silently. It adds one participant
(`participant-N`, a new ID that no contribution, reveal, or approval can reference), one binding
with the invited account, key, and roles, and advances both revisions. This is the same
outcome as a policy replacement that adds one binding, and it obeys the same rules: the account
and key are unused, the participant is new, and the roles were authorized when the invitation
was issued. It re-checks that the inviter still holds that authority, so removing a coordinator's
account or key, or demoting them, makes their unanswered invitations fail closed. The display
name comes from the registry entry, never from the request.

States are pending, accepted, declined, revoked, and expired. Expiry is read from the clock, and
the stored state is updated the next time the record is written. Revoking and declining clear
the hash. Reissuing withdraws a pending invitation and creates a fresh one for the same account,
key, and roles in one write, so the old link stops working at once. Removing an Admin account
(or adding one under a name that was used) withdraws that name's pending invitations, and a
pending invitation keeps its registry key from being removed, for the same reason bindings do.

Nothing is sent. The inviter copies a link, `/admin/#/shared/accept/<token>`, and passes it on
themselves. The token appears in a URL fragment, which browsers do not send to the server, and
the page sends it only when the invitee chooses to accept or decline. Responses that carry a
token are marked `no-store`.

## Alternatives considered

- **Email the link.** This was rejected as a one-way door: it contacts real people, needs
  deliverability and abuse handling, and was out of scope for the issue.
- **A separate invitations file.** Accepting would then need two writes that a crash could split
  into a binding with a still-valid token. One record avoids that.
- **Accept through the generic policy replacement.** Replacement is requested by a coordinator or
  owner, not by the invitee, so it could not bind the accepting account. Acceptance applies the
  same rules from the invitation instead.
- **Let any link holder accept as whoever is signed in.** This would let a leaked link bind the
  wrong account, so the invitation names the account and the acceptor must be it.

## Consequences

- A token is shown once. A lost link is replaced by reissuing, not recovered.
- An invitation for an account that does not exist yet cannot be created; the site owner adds the
  account first (`openblog user add`). Public sign-up stays out of scope.
- The inviter sees the invited account name and key in the list. No other participant's data,
  hash, or draft appears in any invitation response.
- Member removal and role changes after joining belong to member management (#161).

# ADR 0015: Member management changes sign-in access, never credit

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#161](https://github.com/journey-to-code-org/open.blog/issues/161)
- Parent story: [#145](https://github.com/journey-to-code-org/open.blog/issues/145)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Builds on: [ADR 0006](0006-collaborator-identity-binding.md),
  [ADR 0013](0013-publication-scoped-invitations.md),
  [ADR 0014](0014-record-level-authorization-and-publish-gate.md)

## Context

Once people have joined a shared publication, a site owner or coordinator needs to see who has
access, change roles, and end access, from Admin Studio. Two things are easy to confuse. A
binding says which signed-in account may act and with which roles. A participant in the
collaboration contract carries the name, drafts, reveals, and approvals that credit work.

## Decision

Member management edits bindings only. Changing roles rewrites one binding's roles. Removing a
member deletes that binding. The participant, their contributions, reveals, approvals, and
display name are never touched, so credit for what someone wrote survives losing access, and the
contract revision does not move. The Admin view explains the two ideas in separate sentences and
the removal confirmation states which of them changes.

Both operations take the policy revision the requester last loaded. A mismatch is a conflict
(409) and changes nothing; the view reloads the current list and keeps the person's place.
Authorization is checked before staleness, so a requester who may not manage the record learns
nothing about its revision.

Role changes reuse the existing policy replacement rules (`replace_from_json`), so only a site
owner can grant or strip `siteOwner`, a coordinator cannot touch a site owner, and the last
current site owner cannot be demoted or removed. Removal uses the `RemoveMember` grant on the
participant. Every failure to authorize, and every unknown participant, gives one answer (404).

Listing members is limited to the `Invite` grant (site owner or coordinator) and returns, per
member, the sign-in account, contributor key, roles, what the requester may do, whether the
participant has credited work, and whether the account or profile still exists. A binding whose
account or profile is gone is shown with a plain-text warning. No invitation hash, token, or
draft text appears.

Removal frees the account and contributor key, so the person can be invited again; accepting a
new invitation creates a fresh participant rather than reviving the old one, which keeps earlier
credit attached to the earlier participant.

Nothing is emailed or otherwise sent to the person whose access changes.

## Consequences

- Removing someone is reversible only by a new invitation, which is why the view asks first.
- A removed person's earlier drafts stay in the record, credited to them, and are not visible to
  the new participant if they return.
- Changing roles never changes who is credited; the Contributors registry stays the place to edit
  credit details.

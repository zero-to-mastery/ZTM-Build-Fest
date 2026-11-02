# ADR 0051: Groups use the same invitation seam, and membership changes are audited

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#186](https://github.com/journey-to-code-org/open.blog/issues/186)
- Parent story: [#152](https://github.com/journey-to-code-org/open.blog/issues/152)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Builds on: [ADR 0013](0013-publication-scoped-invitations.md),
  [ADR 0015](0015-member-management-separates-access-from-credit.md),
  [ADR 0018](0018-reveal-policy-readiness-and-comparison.md),
  [ADR 0025](0025-storing-authorizing-and-approving-shared-synthesis.md)

## Context

Invitations, bindings, and the role matrix were written for any number of participants, but
nothing recorded who changed whose access, and the group case had no tests beyond three people.

## Decision

Groups are not a new mode. Every participant joins through the existing invitation seam (copy
link, never email); the participant cap (`MAX_PARTICIPANTS`, counting pending invitations) is the
only bound, and there is no pair-only path. One publication keeps one author set (ADR 0018).

Records gain an optional `audit` list, absent when empty, so no stored record needs migrating.
Each entry has an increasing sequence number, a time, the acting participant, an event (invited,
invitationRevoked, joined, rolesChanged, removed), the subject participant or invitation ID, and
the roles before and after. Entries never hold a token, account name, contributor key, display
name, or prose. At 500 entries the oldest is dropped. Sequence numbers are never reused, so a
gap in `seq` (an oldest kept entry above 1) shows that entries were dropped; readers must not
treat the trail as complete history. Submitting the roles a member already holds, in any order,
is a no-op: no entry and no new revision, so nobody can write false entries by resubmitting
someone else's roles. Eviction remains possible through real changes, which are each recorded
against the person who made them. Site owners and coordinators (the `Invite`
grant) read it, newest first, in the member list response; everyone else gets the same 404 as
for the member list. The record is private, so nothing reaches public output.

The audit entry is written in the same record write as the change, so a refused change leaves no
entry and no partial state. Role changes and removals take the current time from the caller.

Authority cannot be orphaned: the last current site owner (account, registry key, and participant
all still resolving) cannot be demoted or removed, so a stale owner never counts. Ownership moves
by promoting a second owner and then demoting the first. Duplicate bindings (account, registry
key, participant ID in any case) are refused when inviting, accepting, replacing the policy, and
loading a record.

Every role change or removal still reconciles approvals and the synthesis author set in the same
transaction, as before (ADR 0020, ADR 0025): a person who loses draft or synthesis authority
loses attribution, and approvals that no longer match are dropped.

## Consequences

- Revoking a member's account outside this flow (account deletion) is not audited; it has no
  acting participant.
- The cap of 100 participants is generous; a lower product limit can be set later without a
  migration.
- The stored record limit (`MAX_SHARED_PUBLICATION_BYTES`, 1 MiB) sits above the pretty-printed
  record at every other bound at once: a full group with the longest names and keys, every
  source, every invitation and a full audit trail, about 600 KiB. The old limit (512 KiB) was
  smaller than that, so ordinary use could write a record that then no longer loaded and the
  reflection disappeared from Admin. The store now also refuses to write a record over the limit,
  leaving the previous one in place (#188).
- Organizations, billing, and email delivery stay out of scope.

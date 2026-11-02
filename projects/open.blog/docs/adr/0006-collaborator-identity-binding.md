# ADR 0006: Bind Admin users to participants explicitly and authorize per target

- Status: Accepted
- Date: 2026-10-24
- Decision issue: [#154](https://github.com/journey-to-code-org/open.blog/issues/154)
- Parent story: [#145](https://github.com/journey-to-code-org/open.blog/issues/145)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Contract: [Shared perspectives collaboration contract](../specs/shared-perspectives-collaboration.md#authorization-policy)

## Context

open.blog already has three identities that look alike. An Admin user signs in with a password and
gets a CSRF-protected session. Today every Admin user can edit every post. A contributor registry
entry in `openblog.json` describes a person who can be credited on a work, and a work-credit
sidecar makes that person a Contributor for one work
([ADR 0003](0003-contributor-identity-and-orcid-provenance.md)). A Participant is a stable ID
inside one shared publication's collaboration contract
([ADR 0005](0005-shared-publication-language.md)).

Shared publications need private drafts, reveals, and approvals. If any of these identities
implied another, a registry edit could grant access, a login could expose another person's draft,
or a role could stand in for consent or authorship. Invitations (#159), role enforcement on draft
operations (#160), and protected drafts (#162 and #163) all need one decision about who may do what.

## Decision

A publication's authorization policy holds explicit bindings. Each binding ties one Admin username
and one contributor registry key to one participant ID, and gives that binding one or more
publication-scoped roles: site owner, coordinator, contributor, editor, or reader. Bindings are
one-to-one within a publication. Nothing else grants collaboration access. A registry entry, an
Admin login, a participant record, and a work credit each grant nothing on their own.

Every request is authorized again against server-side facts: the session's Admin user, the
current users file, the current registry keys, and the policy and contract that the caller loaded
from the publication record in the same transaction as the change. The check itself takes no
revision and cannot tell a stale policy from a current one, so loading both in that transaction
and letting an optimistic revision conflict fail the request is a caller obligation. A binding
whose account was removed, whose contributor key was renamed, or whose participant left the
contract stops working without a separate revocation step, and it no longer counts as the site
owner a publication must keep. Admin usernames and registry keys are names, not stable account
identifiers, so a binding would come back to life if its name were reused. Removing an account or
renaming a registry key must therefore also remove that name's bindings, or the name must never be
reused. Nothing stores a binding yet, so this is a caller obligation that the first persisted
policy (#156) must enforce. The binding fields use the same identifier rules as the systems they point at. The Admin username rule now
lives in `openblog-core` and the CLI uses it when it creates an account, so the two cannot drift
apart. A name hand-edited into the users file outside that rule can sign in but can never be
bound, which fails closed.

Each action takes one target kind: the publication, a participant, or a contribution. The request
names only the target ID. Ownership and reveal recipients come from the contract. A request that
names another participant's draft is therefore treated as a request about that participant's
draft, whatever the caller claims. The role matrix in the contract spec is the complete list of
grants, and every other combination is denied. The main rules are:

- Only the owning participant may reveal a draft or submit their own approval.
- Viewing a revealed draft is checked against that draft's reveal list.
- An editor may edit a draft revealed to them but never becomes its author or approves it.
- Site owners and coordinators manage membership and may request scheduling and publication.
  They cannot read unrevealed drafts. A coordinator cannot remove a site owner, and nobody can
  remove the last site owner.
- Changing a binding or its roles is the `ManageRoles` action on that participant. A site owner
  may manage any binding. A coordinator may manage only bindings that neither hold nor gain
  `siteOwner`, so a coordinator can never grant, strip, or take over the site owner role.

Policy replacement is whole-policy and revision-checked, and it carries the requester: the
requester must hold `ManageRoles` on their own binding and on every binding the replacement adds,
changes, or removes, and a policy that has a current site owner must keep one.

Replacement edits roles, not identities. A kept binding keeps its Admin user, registry key, and
participant, so nobody can rebind a participant to another account or move their own binding onto
someone else's participant. A new binding cannot reuse an account or registry key that a current
binding holds, and cannot name a participant that the contract already links to a draft, a reveal,
or an approval. A participant removed from the policy therefore cannot be re-bound to a different
account later either. Without these rules a coordinator or site owner could become another
participant and then read, reveal, and approve that person's private draft. The core check
enforces all of this, so a membership route cannot escalate by replacing the policy directly.

Roles authorize requests and nothing more. A grant creates no authorship, Work credit, reveal, or
approval, and publishing authority does not bypass exact-revision consent (#166 and #168).
Parsing, replacement, and denial return one error that names no identity.

## Alternatives considered

- **Derive access from the contributor registry.** This was rejected because editing
  `openblog.json` would then grant login-backed access, and public credit would become an access
  control.
- **Give every Admin user access to every shared publication.** This matches how posts work today,
  but it breaks protected drafts and gives no way to tell a co-writer from a site operator.
- **Check participant-level targets supplied by the caller.** This was the first draft. It let a
  caller label a request as its own while editing another participant's draft. It also left reveal
  checks to every delivery path.

## Consequences

- Invitations must create bindings explicitly through policy replacement on behalf of the
  inviter, and bind the account that accepts. Replacement already refuses a `siteOwner` grant
  from an inviter who does not hold it.
- A first policy is loaded with `from_json`, which takes no requester. Whoever creates a
  publication's first policy outside the Admin (for example by editing its stored record)
  decides its first site owner; every later change goes through replacement.
- Every Admin route for shared publications must build the context from the session and stored
  state, never from the request body, and authorize each draft it lists or delivers.
- The version 1 contract has no publication ID of its own. The policy and the contract must be
  loaded from the same publication record until the collaboration artifact (#156) carries both.
- Site owners and coordinators may need a way to recover an abandoned draft, or to re-bind a
  participant whose account was removed or whose registry key was renamed. Replacement refuses
  both, so either would need a separate, audited decision rather than a wider role.
- The decision is reversible while no collaboration state is persisted. Adding a role or action
  starts from no access because the matrix denies anything it does not list.

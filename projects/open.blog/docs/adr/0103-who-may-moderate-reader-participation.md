# ADR 0103: The site Admin and in-scope coordinators moderate; contributing authors read and respond; readers act only on their own items

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#211](https://github.com/journey-to-code-org/open.blog/issues/211)
- Parent story: [#203](https://github.com/journey-to-code-org/open.blog/issues/203)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0006](0006-collaborator-identity-binding.md),
  [ADR 0014](0014-record-level-authorization-and-publish-gate.md),
  [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md)

## Context

Today one secret moderates hosted comments: the Admin's `OPENBLOG_ADMIN_API_KEY`. Collaborative
works add publication coordinators and contributing authors bound to a shared publication by its
authorization policy (ADR 0006), and #203 asks that role checks distinguish the site Admin, a
publication coordinator and a contributing author. Admin users themselves have no roles: ADR 0006
lets every Admin user edit everything, so a co-writer signed in to Admin is indistinguishable from
the site's owner unless moderation looks at the work being moderated. Readers have no accounts, yet RD10 and RD14
need a reader to answer a clarification or withdraw their own submission.

## Decision

- **Actors** (`openblog_core::moderation::Actor`) are established by the server, never claimed by
  a request:
  - *Public*: anyone using the public submission path.
  - *Submitter*: the item's own submitter, proven by the server (a reader's private receipt, which
    a transport adds with #226, or the author's session for an author response).
  - *Site Admin*: the hosted moderation token, or an Admin session acting on a work that is not
    part of any shared publication in which that account holds a binding (consistent with ADR
    0006), including an item without a work.
  - *Coordinator*: an Admin session acting on a work of a shared publication in which it is bound
    as coordinator or site owner, for that publication's works only.
  - *Contributing author*: an Admin session acting on a work of a shared publication in which it
    is bound as contributor (and neither coordinator nor site owner), for that publication's works.
  - *System*: the retention job.

  An Admin session's actor therefore depends on the work it acts on, and one resolver decides it
  per item: `moderation::SharedWorks::actor(principal, work, identities)`, built from the
  shared-publication records and the loaded site. A publication's site owner is that
  publication's coordinator, never the site Admin. A binding that holds only `editor` or `reader`,
  or whose account, registry key or participant no longer resolves (the existing
  `ViewPublication` check), resolves to the public actor on that publication's works: it sees what
  readers see and never falls back to the site Admin. An account bound in any shared publication
  that acts on a path no loaded post has (a deleted post, or a slug since renamed) also resolves to
  the public actor, because whether that path was a shared work cannot be told; the moderation
  token still reaches such items. A binding that is removed takes its works with it, so every
  grant lapses. The token records `@moderation-token` as its account in the audit trail, a name no
  Admin account can have.
- **A shared publication's works** are the `Post.url` of the post loaded from
  `posts/{publication_id}.md` (the path `assembly::post_path` writes), resolved at request time
  from the loaded site (`moderation::SharedWorks`), never stored with the record. A renamed slug
  therefore moves the work with the post, and a publication whose post is not loaded has no work,
  so nobody holds a publication role on anything through it. A post that only shares the
  publication's slug is not its work. Callers build it from the site as Admin loads it, drafts
  included.
- **The grant list is complete; every other combination is denied:**

  | Action | Site Admin | Coordinator (in scope) | Contributing author | Submitter | System | Public |
  | --- | --- | --- | --- | --- | --- | --- |
  | approve, reject, request clarification, remove, uphold report | yes | yes | no | no | no | no |
  | reopen | yes | no | no | no | no | no |
  | clarify, withdraw | no | no | no | yes | no | no |
  | expire | no | no | no | no | yes | no |
  | create a reader kind's item | no (uses the public path) | no | no | no | no | yes |
  | create an author response | yes | yes | yes (in scope) | no | no | no |

  Reopening undoes a moderator's decision, so it stays with the site Admin. Upholding a report also
  needs the grant to remove the reported item (ADR 0104).
- **Viewing** (`moderation::may_view`): the text and details of an item that is not public are
  visible to the site Admin, in-scope coordinators, in-scope contributing authors (except abuse
  reports, which may name or accuse others) and the submitter. A reader's private identity (a name
  they did not agree to publish, any contact detail a later kind adds) is visible only to the site
  Admin and the submitter: never to a coordinator, a publication site owner or a contributing
  author, so a co-writer on a shared work cannot learn the private names of that work's readers. Everyone else, including coordinators and authors out of scope, sees
  only what `is_public` allows. Purged text is visible to nobody.
- **Decisions are not authorship or approval of prose.** Approving a Third Perspective or a
  question publishes the reader's words as the reader's, never as an author's contribution, and
  creates no Work credit (ADR 0006). An author response is the author's own words, and it still
  starts pending.
- **Every check is server-side and first.** The grant is checked before the version, the state
  or anything else, so an unauthorized request returns `denied` whatever the item looks like.

## Considered options

- **Let contributing authors approve items about their own work.** Rejected for now: on a shared
  work one author would decide what readers see about another's section. Coordinators and the
  site Admin, who already arrange the publication, moderate; authors respond.
- **Let coordinators reopen.** Rejected: reversing a decision that may have followed a report is
  the site Admin's call.

## Consequences

- The inbox (#225) resolves the actor for each item with `SharedWorks::actor`, from the session or
  token, the stored shared-publication records and the site as Admin loads it, never from the
  request, and filters each list through `may_view`.
- Co-writers who also run the site see their own shared works as coordinators or authors, not as
  the site Admin; the moderation token stays the way to act on those works with full authority.
- A reader receipt (#226) is the only way a reader becomes a submitter; without it a reader can
  submit but cannot clarify or withdraw, and the copy fallback still lets them ask the author.

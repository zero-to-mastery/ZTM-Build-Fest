# ADR 0017: Draft routes serve only the caller's own draft from private, revision-checked storage

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#163](https://github.com/journey-to-code-org/open.blog/issues/163)
- Parent story: [#146](https://github.com/journey-to-code-org/open.blog/issues/146)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0016](0016-private-contribution-revisions-and-mutual-reveal.md) defined revisions in
`DraftSet` but no storage or route. [ADR 0014](0014-record-level-authorization-and-publish-gate.md)
left the edit route deny-by-default. Draft ids are not contract contributions, so the
`EditContribution` grant, which resolves a contract contribution, cannot authorize a draft.

## Decision

- A new action `EditDraft` targets the requester's own Participant. Contributors and Editors hold
  it for themselves only; Readers, Coordinators and Site owners without a Contributor role do not.
  It covers reading and saving the caller's own latest draft. Nothing else reads a draft.
- `GET` and `PUT /admin/api/collaboration/draft` call `SharedPublication::authorize` first. Every
  refusal (no session binding, wrong role, unknown or foreign publication) is the same 404.
  `PUT` needs the Admin session, CSRF, JSON, and rejects unknown fields.
- Each participant has one draft whose contribution id is their participant id, so a request
  cannot name another participant's draft. Participants who join later are admitted to the set
  on their first save; membership only grows.
- Drafts are stored one file per publication under `.openblog/private/collaboration/drafts/`,
  which Git ignores, `publish` refuses to commit, and no build, feed or export reads. Revisions
  are append-only, so the file is its own recoverable history; no backup files are made.
- A save runs inside the Admin content transaction and replaces the file atomically (private temp
  file, then rename) only if it still holds the exact bytes that were read. A stale revision
  answers 409 with the caller's own newer copy and writes nothing; the client keeps its text.
- A draft file that is malformed, oversized, a symlink or a directory is an error. It is never
  treated as empty and never replaced, so a bad file cannot silently lose drafts.
- Logs name the publication and revision number, never prose or identities.
- A save that would make the stored set reach the 8 MiB load limit (counting JSON escapes) or add
  a 201st revision to one draft is refused with 422 and its own message, and changes nothing, so
  a file the server wrote can always be read back and one person's saves cannot lock others out.
  Replacing or compacting revisions for long autosave sessions is deferred to the browser editor
  work; restoring an earlier revision has no route yet.

## Consequences

- Reveal, combined review and a browser editor are separate work and call the same entry point.

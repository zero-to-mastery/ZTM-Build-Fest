# ADR 0011: Manage the source library through narrow, revision-checked Admin APIs

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#34](https://github.com/journey-to-code-org/open.blog/issues/34)
- Parent story: [#17](https://github.com/journey-to-code-org/open.blog/issues/17)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0009](0009-research-source-library-identity.md) and
  [ADR 0010](0010-private-source-library-storage.md)
- Contract: [Research source library format](../specs/research-source-library.md)

## Context

ADR 0010 gave the library a private, revision-checked store. Authors still had to edit JSON
by hand. Admin must create, edit, archive, filter, and reopen every source type without
weakening any of the store's guarantees, and without the browser becoming a second
validator that could disagree with core.

## Decision

- **Narrow endpoints.** `GET /admin/api/sources`, `POST` (create), `PUT` (update), and
  `POST /admin/api/sources/archive` sit behind the Admin session and CSRF checks. Requests
  are JSON, at most 256 KiB, and always name the **library revision** they were based on.
  Responses are `no-store`.
- **One validator.** A request record is read by `SourceRecord::from_json` and written by
  the store, so Admin accepts exactly what a hand-edited file would. The browser performs
  only an advisory check to focus the right control; the server stays authoritative.
- **Conflicts never overwrite.** A stale revision returns `409` with `conflict: true`, the
  latest revision, and the newer stored copy of the record being changed. Nothing is
  written. Admin keeps the draft, refuses to resubmit it, and offers two explicit choices:
  use the stored copy (discarding the draft) or keep the draft on the latest library, which
  reloads the whole library first.
- **Failures are scoped.** Invalid records return `422` with diagnostics naming the source
  identifier and field; a damaged stored library is reported with its path and is never
  replaced. Storage failures leave the stored bytes unchanged.
- **Archive is a field, not removal.** `archived: true` hides a record from everyday lists
  and keeps it in place so records that point at it still resolve. It is set through a
  dedicated endpoint that changes only that field, so an editor that never saw a record's
  unknown fields cannot drop them. `false` is written as an absent field. Editing an
  archived record keeps it archived. Archive is not deletion: removal stays a store
  operation.
- **Lossless forms.** Admin sends the whole record. Fields the form does not edit, and
  creator, identifier, or location entries the author did not change, are carried through
  verbatim.
- **Placement.** Sources is a Research entry beside Evidence Studio, shown with that
  module and always reachable from the command palette. It adds no workspace-preference
  module, so stored preferences remain valid.
- **Hosted durability.** The hosted editorial workspace includes exactly
  `.openblog/private/research/sources.json`, with a 4 MiB text limit (the library limit)
  instead of the general 2 MiB, so a successful source write survives a restart. No other
  file under `.openblog/private/research/` participates.
- **Untrusted text.** Titles, creators, identifiers, and server messages reach the page
  only as text nodes, never markup.

## Consequences

- Searching and filtering run in memory over the library the server returned; at the
  10,000-record limit this is acceptable and avoids a second index to keep in sync.
- A second tab's change is detected only on save. Admin never merges records silently.
- Citation insertion, passage notes, and external metadata lookup remain separate tasks.

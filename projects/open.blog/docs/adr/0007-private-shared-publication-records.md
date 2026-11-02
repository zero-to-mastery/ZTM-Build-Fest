# ADR 0007: Keep each shared publication in one private, versioned record

- Status: Accepted
- Date: 2026-10-24
- Decision issue: [#156](https://github.com/journey-to-code-org/open.blog/issues/156)
- Parent story: [#144](https://github.com/journey-to-code-org/open.blog/issues/144)
- Contract: [Shared perspectives collaboration contract](../specs/shared-perspectives-collaboration.md#shared-publication-record)

## Context

[ADR 0005](0005-shared-publication-language.md) keeps private collaboration apart from Posts and
public credit, and [ADR 0006](0006-collaborator-identity-binding.md) requires the authorization
policy and the collaboration contract to be loaded from the same publication record. Until now
nothing stored either one. The first Admin flow, creating a shared reflection from a source,
needs somewhere to keep the title or guiding question, the source references, the contract, and
the policy.

Two places were available. A draft Post in `content/` would reuse the existing editor, but its
front matter would carry private sources, participants, and bindings into a file that Git,
feeds, exports, and `serve --drafts` all treat as canonical content. A private file outside
`content/` keeps the Post format untouched and needs no new database.

## Decision

Each shared publication is one JSON file at
`.openblog/private/collaboration/publications/<publication-id>.json`. `openblog init` already
ignores `.openblog/private/` in Git and `openblog publish` refuses to commit it, so these records
never reach the repository, the build, feeds, or exports. Creating a shared reflection writes no
Post or Document; a later publication operation (#158, #169) creates the author-owned Document
from an approved revision.

The record is versioned (`version: 1`) and holds:

- the stable opaque publication ID, which is also the file stem;
- an optional title and an optional guiding question, at least one of which is present;
- one to 20 ordered source references, keyed by stable IDs and marked with author provenance;
- the version 1 collaboration contract; and
- the version 1 authorization policy, whose `publicationId` must equal the record's.

Publication IDs are random (`shared-` and 12 hex digits), so a file name never reveals a title.
A record is written completely to a private temporary file and then hard-linked into place. The
link fails if the name is taken, so two creators can never overwrite each other, a crash leaves
either no record or a complete one, and a taken ID is retried with a new one. A record that is
malformed, oversized, misnamed, or a symlink grants nothing and is skipped.

The creator becomes the only participant, bound as `siteOwner` and `contributor` with the
contributor profile they choose. The Admin user always comes from the session, and the display
name always comes from the registry entry, never from the request body.

Nothing yet links an Admin user to a registry key, so the creator's choice of contributor profile
is not verified: any signed-in Admin user may pick any current key. This is accepted for now
because a registry entry grants no login or access ([ADR 0006](0006-collaborator-identity-binding.md)),
every decision is made for the session's Admin user, and the chosen key only labels the creator in
a record that only bound participants can see. The cost is that a key picked this way cannot be
bound again in that publication and cannot be removed from the registry while the record binds
it; the Contributors editor names the blocking keys when it refuses. A later user-to-registry link
can narrow the choice without changing the record shape.

ADR 0006 left the persisted policy to enforce that a binding cannot follow a reused name. Removing
an Admin account with `openblog user remove`, and adding one with `openblog user add`, now remove
that username from every record's bindings and advance the policy revision. The Admin
Contributors editor refuses to remove a registry key that a record binds. Hand edits to the users
file or `openblog.json` stay outside these checks; a binding whose account or key is missing
already grants nothing.

## Optional source metadata

The Admin endpoint `POST /admin/api/collaboration/publications/source-metadata` looks up a
source link on request. It is read-only: it stores nothing and never changes a record.

- Only links that `openblog_core::embed::detect` recognises (YouTube, CodePen) are looked up. The
  request goes to the provider's fixed oEmbed address with the canonical link rebuilt by the
  embed renderer, never the pasted text, so a link cannot choose the host.
- It uses the shared public-address HTTP client with no redirects, one 6-second deadline, no
  compression, and a 16 KiB response limit. A redirect, private address, wrong content type, bad
  JSON, or odd shape is "unavailable".
- Only `title` and `author_name` are read, reduced to one line of plain text within the
  existing field limits, plus the provider's name as publisher. HTML, thumbnails, captions, and
  transcripts are never requested or returned.
- The response is always HTTP 200 with `found`, `unavailable`, or `unsupported`, plus the embed
  link when recognised, so a provider outage never blocks authoring. Suggestions carry
  `provenance: "provider"`.
- The form applies a suggestion only to fields that are empty after trimming. Values the author
  typed are never replaced, and the saved record keeps `provenance: "author"` because the author
  reviewed and kept every value. This is a deliberate deviation from the specification's
  "provider suggestions need their own provenance": version 1 records have no per-field
  provenance, so the form labels each provider-filled field "Suggested by ..." until the author
  edits it, and per-field provenance in the record waits for a record version bump. Embed discovery itself needs no network and works offline.

## Consequences

- The canonical Post format, existing drafts, credits, builds, and feeds are unchanged, and a
  failed or refused creation writes nothing at all.
- Records are local to the server that hosts Admin Studio. Because Git ignores them, they are not
  backed up by `openblog publish`; operators back up `.openblog/private/` like other private state.
- One file per publication keeps writes independent. Later tasks that edit drafts (#163) or
  invitations (#159) replace the whole record under the content transaction lock with the
  existing revision checks.
- A future storage change is a migration of one versioned JSON shape. No hosted service or
  database is required, and the decision is reversible while no published work depends on it.

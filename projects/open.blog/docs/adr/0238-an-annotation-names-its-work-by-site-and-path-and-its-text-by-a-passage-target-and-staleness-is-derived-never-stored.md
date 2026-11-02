# ADR 0238: An annotation names its work by site and path and its text by a passage target, and staleness is derived, never stored

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#84](https://github.com/journey-to-code-org/open.blog/issues/84)
- Parent story: [#30](https://github.com/journey-to-code-org/open.blog/issues/30)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0237, ADR 0076, ADR 0077

## Context

A reader's highlight must survive an ordinary revisit and must say so when the text it marked has
changed, without ever pointing at different text (ADR 0077). It must also be unambiguous which work
on which site it belongs to, because a reader may keep annotations from several open.blog sites and a
document may be exported from one machine and imported on another.

## Decision

- **Work identity.** A work is `{ "site": "<origin>", "path": "<path>" }`. The site is an http(s) origin
  with no credentials, path, query or fragment, written as the URL parser writes it. The path is
  absolute, already in canonical percent-encoded form, and has no query, fragment, backslash,
  whitespace, dot segment, encoded dot or separator, or protocol-relative start. The key
  (`site` + `path`) is the identity; the author's domain model (slugs, series, drafts) is not
  consulted, so nothing here conflates annotation identity with authoring identity.
- **Text identity.** A highlight or note carries a passage target (ADR 0076) and the passage revision
  the reader saw (`p<model>:` plus 32 hex digits, supplied by the page, never computed here). A
  highlight must be a `quote` target. A note may be a quote, a section or the whole work (`work`
  targets never go stale). Targets are read with `readTarget`, so Unicode, whitespace and boundary
  rules are exactly the passage-target contract's: exact, prefix and suffix text plus a position hint.
- **Stale state is derived.** Whether an annotation is `current`, `reanchored` or `stale` (with the
  reason) is computed on demand by `assessAnnotations` from the target, the revision seen and the work's
  published passage text (ADR 0077). It is never written into the document, so it cannot be out of date,
  and a stale annotation keeps its record untouched. A work that cannot be loaded is reported stale with
  `workUnavailable`, never dropped.
- **Timestamps** are UTC to the second in RFC 3339 (`2026-10-27T09:30:00Z`), `updatedAt` not before
  `createdAt`. One form means dates sort as text and round trip byte for byte.
- **Ids** are lowercase slugs of at most 64 characters, unique across annotations, sources and trails
  in one document, so a trail step can name any of them by id alone.
- **Upgrades.** The document version covers this shape; a change to the passage-target model is a new
  target `version` and is read, or refused with a code, by the passage-target reader. A newer document
  version is refused (`unsupportedVersion`); `migrateDocument` is the one place a later version adds
  its upgrade step.

## Consequences

- A revisit needs only the work's published passage text, which the page already carries for feedback
  (ADR 0076); no network is needed.
- A renamed or moved page makes its annotations `workUnavailable` rather than lost; a later task can
  offer to re-home them.

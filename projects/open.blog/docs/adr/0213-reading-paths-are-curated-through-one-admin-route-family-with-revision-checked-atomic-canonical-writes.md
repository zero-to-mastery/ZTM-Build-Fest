# ADR 0213: Reading paths are curated through one Admin route family with revision-checked, atomic, canonical writes

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#77](https://github.com/journey-to-code-org/open.blog/issues/77)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0208](0208-a-path-is-one-versioned-plain-text-json-file-written-canonically-and-never-loses-a-field.md),
  [ADR 0212](0212-the-public-paths-value-is-an-allowlisted-deterministic-projection-and-nothing-reads-a-path-yet.md)
- Contract: [Reading paths](../specs/reading-paths.md#admin)

## Context

A path is a public, author-written file (ADR 0208) under the content folder. Admin must list,
create, edit, reorder and delete it, and a hand edit in source mode must agree with a form save.
Two tabs, a text editor and a build can all touch the same file, and a failed save must never
leave a half-written path. Unlike the private research stores, the file is content: it is written
under the content lock the documents already use, not under a private store's locks.

## Decision

- **One route family, deny by default.** `reading-paths` (list), `reading-paths/targets` (what may be
  picked), `reading-paths/path?slug=` (one path), `reading-paths/preview`, `reading-paths/reorder`,
  and `POST`/`PUT`/`DELETE` on `reading-paths`. Every route needs the session and every write the
  CSRF token through the existing `api` seam; a name or verb no route owns is not found. The
  router is the same one the documents use, so no route is public.
- **Stale-write protection by content hash.** A path's revision is the SHA-256 of the stored bytes.
  A replace and a delete name the revision they read and are refused with `409`, the latest
  revision and the newer copy when the file changed, went, or was edited by hand. A create is
  refused when the slug has a file. Nothing is written in any refusal.
- **Content lock and atomic writes.** A write holds the build lock and the content transaction
  lock (`409` when another write holds it), checks the path, writes a temporary file beside it,
  flushes it and renames it over the target. A failure removes the temporary file and leaves the
  stored file as it was. A path that cannot be read is listed with its problems and never stops
  the others, and the folder and file are refused if they are a symlink.
- **Lossless canonical round trip.** What is written is always `ReadingPath::to_canonical_json`
  (ADR 0208). A form save and a source save of the same path write the same bytes, fields this
  release does not define travel through the form model untouched and are kept, and the response
  carries the canonical text so the editor shows exactly what is stored. Source mode shows the
  stored bytes when the file cannot be read, so it can be repaired there.
- **Admin asks a little more than the format.** The format lets a draft leave a step without a
  transition. Admin does not write one: every step after the first must say how it relates and why,
  even in a draft, so the editor never stores a step the author has not explained. A hand edit
  that omits one is still readable and is repaired in the form.
- **Delete moves to the trash.** The file moves to `.openblog/trash`, as documents do, and is
  never destroyed. It needs the revision read.
- **Reorder never loses written text.** The reorder route takes the full order of step ids. A step
  that would become first has nothing to follow, so its transition would go: that is refused
  unless the request confirms it (`clearTransition`). A step that moves off the front needs a
  transition it never had, which the request supplies (`transitions`); nothing is invented for it.
- **Nothing is rebuilt.** Nothing reads a path in a build yet (ADR 0212), so a save does not
  trigger one, and a site with or without paths builds byte for byte as before.
- **Bounded and hostile-safe.** A body over 512 KiB, a wrong content type, invalid JSON, a repeated
  key or a bad slug is refused before any file is touched, and no message quotes a value.

## Consequences

- Admin, a text editor and the CLI agree on every path file byte for byte.
- A tab left open overnight cannot overwrite what another tab or an editor saved.
- Admin's stricter rule means a draft with an unfinished step cannot be saved from Admin; it stays
  in the browser until finished.

## Domain language

**Reading path** is defined in [`CONTEXT.md`](../../CONTEXT.md).

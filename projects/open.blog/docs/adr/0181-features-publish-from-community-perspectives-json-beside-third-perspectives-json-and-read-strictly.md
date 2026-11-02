# ADR 0181: Features publish from `community-perspectives.json`, beside `third-perspectives.json`, and are read strictly

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#214](https://github.com/journey-to-code-org/open.blog/issues/214)
- Parent story: [#205](https://github.com/journey-to-code-org/open.blog/issues/205)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0083](0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md),
  [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0176](0176-featuring-a-reflection-is-an-editorial-selection-of-one-approved-reflection-with-the-readers-own-consent.md)
- Coordinates with: [#229](https://github.com/journey-to-code-org/open.blog/issues/229) (curation),
  [#230](https://github.com/journey-to-code-org/open.blog/issues/230) (public section),
  [#103](https://github.com/journey-to-code-org/open.blog/issues/103) (portability)

## Context

ADR 0115 gave approved reflections a committed public file. Featuring needs the same properties: static
reading without a service, a file that is safe in a public repository, and a format that can grow
without breaking sites that already have it. It must not become a second copy of reader text.

## Decision

- **One more file, the same pattern.** `community-perspectives.json` in the content folder, written by
  Admin under the same content lock and read by `FeaturesFile::from_json`: version 1, an `items` list,
  at most 500 items and 2 MiB, canonical output (items sorted by post, day and id, two-space
  indentation and a final line break) so a change is a small, deterministic diff. A reader refuses a
  newer version, an unknown field, a repeated id, a malformed value or a note that fails ADR 0180,
  naming the item by its position ("item 3") and never its contents. Nothing is repaired or dropped.
- **Public fields only.** An item has `id`, `post`, `revision`, `digest`, `featured`
  and an optional `context`. It has no reader text, no receipt or its digest, no consent records, no
  editor or moderator, no reason and no time of day; the strict reader refuses each of those as a field this version does not
  define, and a test pins it. For an unknown field the error says only that the item has a field this
  version does not define or one of the wrong type: it names the item, not the field or its value, so a
  private or hostile value is never echoed into a log. A value that is wrong (not a field that is extra)
  does name its field, as in `` `digest` must be 64 lowercase hexadecimal digits``.
- **Additive growth.** A later field (for example editor-named groups) raises the version only for files
  that use it, as answers did for `third-perspectives.json`, so a site that never uses it keeps its file
  byte for byte. This task adds no hosted column, route, environment variable or setting, and changes no
  existing output: nothing reads the file yet (the build and the page are #229 and #230), so every page,
  feed, export and portable copy is byte-for-byte what it was, and a site without the file is
  unaffected. The portable fallback (#103) is ADR 0115's single link to the canonical page, which
  already covers the section.
- **Rendering is the one projection.** `project_post` calls the existing Third Perspective projection
  (`perspective_publication::project_post`) for the referenced reflections and then adds the digest and
  name checks, so escaping, the section's standing, modes and name rules cannot differ between a
  reflection and its feature. The section is canonical-page only: portable copies, feeds, search and
  `llms` files carry no feature.
- **Without JavaScript, accounts or a hosted service** the page shows what was featured, from the file,
  with the notice and provenance as ordinary text. The hosted service is needed only to learn that a
  feature must come off.

## Considered options

- **Put features in `third-perspectives.json`.** Rejected: that file's items are exactly the projection;
  a feature adds editorial fields and a different lifecycle, and older readers would refuse the new
  field.
- **Store the selection in the post's front matter.** Rejected: it would tie a reader's consent to an
  author's file and leak into the post's own history and exports.

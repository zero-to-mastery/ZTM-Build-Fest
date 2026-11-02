# ADR 0037: Archive, export and import the private notebook explicitly, and guard every publication boundary

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#39](https://github.com/journey-to-code-org/open.blog/issues/39)
- Parent story: [#18](https://github.com/journey-to-code-org/open.blog/issues/18)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0012](0012-source-library-interchange.md),
  [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0035](0035-private-notebook-storage-and-admin-capture.md),
  [ADR 0036](0036-private-notebook-search-and-backlinks.md)
- Contract: [Research notebook format](../specs/research-notebook.md)

## Context

The notebook holds other people's words and the author's unfinished thinking. Three needs
remain after capture and search. Entries must be set aside without being destroyed, so a
notebook stays usable as it grows. The notebook must be portable, for backup or for moving
to another project, without a second path that quietly copies private text somewhere public.
And the promise that research never reaches the public site must be checked by the build and
by tests, not only stated: a promise about files is easy to break by saving an export in the
wrong folder.

## Decision

- **Archive, never delete.** A passage or note may carry `"archived": true` (a defined field,
  written only when true, refused unless a boolean). Archived entries stay in the file,
  remain linked, still protect a linked passage from removal, and are included in exports.
  Lists and search leave them out unless asked (`includeArchived`), search counts them
  separately, and an archived question is not an open question. Archiving is not a
  visibility switch: `visibility` stays `private` and archiving publishes nothing.
  `POST /admin/api/research/archive` is revision-checked like every change and byte-reversible.
- **Export is an explicit, private bundle.** `POST /admin/api/research/export` returns the
  whole notebook as a versioned JSON bundle (`format: open.blog/research-notebook`,
  `version: 1`, `private: true`, `contains: [passages, notes]`, the sources the entries
  point at, and the notebook with unknown fields kept). It refuses unless the request says
  `includePrivate: true`, and Admin asks the author to confirm first. It is a `POST` so
  nothing about it can be fetched by a link or cached, deterministic for a revision, and
  `no-store`. Nothing else, including the CSL and BibTeX source exports, reads the notebook.
- **Import mirrors the source library.** `POST /admin/api/research/import` takes the bundle
  as an object and previews first (`apply: false`): each entry is `create`, `unchanged` or
  `conflict`. The bundle is validated by the same reader as the stored file against the
  stored library, so unknown sources, bad ids, credit fields, non-private entries and
  oversized or newer-version bundles are refused with diagnostics that name the field and
  never repeat text. An import only adds: a different entry under an existing id, or an id
  held by the other kind of entry, is a conflict that refuses the whole import. Applying
  rebuilds the plan from the notebook as stored under the lock, merges, validates the union,
  and writes atomically, so a refused or stale import writes nothing and creates no
  directories. Importing the same bundle twice is a no-op, and importing an export into an
  empty notebook restores the file byte for byte. The request is limited to 4.25 MiB.
- **Private research is recognised by structure.** `research_bundle::looks_like_private_research`
  recognises a bundle or a notebook-shaped JSON file by its shape, not by any words, so a post
  that happens to quote the same passage is never flagged. Three guards use it and report only
  the path:
  - `openblog build` (and so `serve` and Admin rebuilds) and `openblog check` refuse when
    `content`, `static` or `themes` hold such a file, wherever it was saved and whatever it
    was renamed to;
  - `openblog publish` and Admin's Publish refuse to commit such a file from a publishable
    folder, in addition to the existing refusal of anything under `.openblog/private`.
- **A regression corpus, not a checklist.** The tests seed a distinctive sentinel into every
  field an entry can carry (ids, excerpt, locator, an unknown field, note text, concept,
  and an archived note) and prove none reaches the built site, feeds, `search.json`,
  `llms.txt` and `llms-full.txt`, portable Markdown and HTML, CSL JSON and BibTeX, the content
  tree, other Admin views, the public server under several path spellings, anonymous and
  malformed error bodies, a damaged-notebook report, or the Git history after a publish with
  `.openblog` listed as publishable. Positive controls prove the sentinels are really stored
  and exported. A source scan proves the notebook code has no print, log or debug call, so no
  log line can carry private text.
- **What a diagnostic may say.** A signed-in diagnostic is scoped by entry id so the author
  can find the entry (ADR 0035). Ids are therefore the one thing signed-in error bodies
  may repeat; text, excerpts, locators, concepts and unknown fields never appear in one. The
  `409` conflict response keeps returning the author's own newer copy of the entry they were
  editing, as ADR 0035 decided, to a signed-in session only.

## Consequences

- An archive costs nothing to undo and loses nothing, but an archived entry is invisible
  until the author asks for it, so a long-archived question will not nag.
- A bundle is plain private text on disk once exported. The author is told so at export and
  again in the result; the build, check and publish guards catch the common mistake of saving
  it into a public folder, but cannot stop someone sending the file elsewhere.
- Import is additive only: merging two notebooks that edited the same entry needs the author
  to resolve the conflict by hand, which keeps the rule that nothing is overwritten silently.
- A bundle moved to a project whose library lacks a source is refused rather than creating a
  dangling link; the author imports the sources first (ADR 0012).
- The structural check can miss a bundle someone has transformed beyond recognition (for
  example zipped); it is a guard against accidents, not against an author deliberately
  publishing their own research, which stays possible only through an explicit projection.
- Hosted workspaces keep the notebook in their private durable store as before; that store is
  not a publish path, and Publish refuses private research regardless of where it came from.

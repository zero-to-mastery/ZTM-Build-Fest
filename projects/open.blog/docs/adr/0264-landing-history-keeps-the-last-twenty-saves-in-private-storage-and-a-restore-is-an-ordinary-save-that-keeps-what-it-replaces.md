# ADR 0264: Landing history keeps the last twenty saves in private storage, and a restore is an ordinary save that keeps what it replaces

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#337](https://github.com/journey-to-code-org/open.blog/issues/337)
- Parent story: [#319](https://github.com/journey-to-code-org/open.blog/issues/319)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0246, ADR 0252

## Context

"Put it back the way it was yesterday" should be one tap. The landing page is one public file saved by atomic
rename against a revision (ADR 0246); history must add to that without changing it.

## Decision

- **One small file per save, in private storage.** Every page the Admin saves is also written as
  `.openblog/private/landing-history/<number>.json` (`format: "openblog-landing-history"`, `version: 1`, the
  date, the page's revision, a one-sentence summary and the page). It is outside the content folder, so no
  build, feed, search index, sitemap or export reads it (tested: an old version's words are in no built file).
  When a project uses Git, the first write adds `/.openblog/private/` to `.gitignore` (the line `openblog init`
  writes) unless the folder is already ignored.
- **Bounded.** The newest 20 readable versions are kept; older ones are removed after a new one is safely
  written. A file this release cannot read (a newer `version`, or damaged) is listed as skipped, never counted
  against the 20, and never rewritten or deleted. The storage is additive: a newer release may add fields or a
  new `version` without disturbing this one.
- **A restore is an ordinary save.** `POST landing/history/restore` with `{ id, revision }` takes the kept
  page, checks it as any save is checked, and writes it by the same atomic rename under the same locks and the
  same revision check, so it is conflict-safe (a page changed elsewhere is a 409 that carries the current page)
  and atomic (a refused or failed restore writes nothing). The restore is itself kept as a new version.
- **The current page is never lost.** Before any save or restore replaces the file, the page it holds is kept
  if it is not already the newest version, which covers a page edited by hand or saved before history existed.
  A page written by a newer release is never overwritten, by a restore either.
- **Recording is best effort.** A history write that fails never fails a save; the answer says whether the
  version was kept.
- **A summary in plain words.** "First saved version, 3 sections", "Added 1 section", "Changed 2 sections",
  "Hid 1 section", "Reordered sections", "Restored the version from ...", or "No visible change".
- **In the Admin.** A History disclosure under the sections lists versions by date with a summary, a Preview
  (the server builds that version's home page into the same script-free sandboxed frame as the live preview,
  changing nothing) and a Restore button. Restoring over unsaved edits asks first. Routes: `GET
  landing/history`, `GET landing/history/item?id=`, `POST landing/history/restore`, all behind the session; the
  write behind the CSRF check, with a 4 KiB body bound.

## Considered options

- **History inside `landing.json`.** Rejected: it would publish old versions.
- **Git as the history.** Rejected: not every site uses Git, and "yesterday" must work without it.
- **Keep only the replaced page, not each save.** Rejected: restoring would then lose the newest page.

## Consequences

- Up to 20 files of at most 256 KiB each (usually a few KiB) live under `.openblog/private/`.
- Deleting the folder loses only history, never the page.

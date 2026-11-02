# ADR 0283: Erasing voice data is listed, confirmed, staged in a trash folder and checked again

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#465](https://github.com/journey-to-code-org/open.blog/issues/465)
- Parent story: [#426](https://github.com/journey-to-code-org/open.blog/issues/426)
- Parent epic: [#410](https://github.com/journey-to-code-org/open.blog/issues/410)
- Builds on: ADR 0266, ADR 0267, ADR 0282

## Context

The author must be able to prove that collected personal writing is gone. A half-finished erase that leaves some
files and loses others is worse than none, and the voice guide (epic VS4) is derived from the samples, so it goes
with them.

## Decision

- **One store function does it for every surface.** `voice_store::erase_plan(root)` lists what exists (read only,
  paths and kinds, never text) and `voice_store::erase_all(root)` removes it. `openblog voice erase [--yes]` and
  Admin `GET`/`POST voice/erase` are thin calls to these two.
- **What is erased:** every regular file in both sample folders (samples, and leftover temporary files), the
  session record, the guide, and leftover editor files (`editing*.md`, `polishing*.md` under
  `.openblog/private/voice/`). Other Assistant context, posts and settings are never touched. A folder found
  inside a sample folder is not touched; the post-check reports its parent.
- **The guide's location is named once**, in `voice_store::guide_paths(root)`: today
  `assistant/context/voice.md` (portable) and `.openblog/private/context/voice.md` (private). The
  Assistant guide (VS4) is wired in by changing that one function.
- **Confirmation.** The CLI lists and stops unless `--yes` is given. Admin lists first, asks the author to type the
  word `erase` (the button stays disabled until it matches), and the server refuses a request without that word,
  so a script cannot erase by a bare `POST`. The route sits behind the session and the CSRF and origin checks
  like every Admin write, and its body is limited to 4 KiB.
- **All or nothing.** Under the store lock, each file is renamed into a trash folder
  `.openblog/private/voice/erasing-<token>/`. If any rename fails, every file already moved is renamed back and
  the failure says "Nothing was erased". Only when every file is in the trash is the trash deleted. If that final
  delete fails, the answer says where the leftovers are and a repeated erase removes them. The trash sits under
  the private folder, so it is never published or committed.
- **Post-check.** After the lock is released the store looks again, from scratch, and returns the paths that still
  exist (empty means clean). The CLI prints "nothing is left" or the paths and exits with an error; Admin shows
  the same sentence and also removes the copies of drafts kept on that device.
- The old per-sample `erase` (never wired to a surface) is removed; a single sample can be erased by deleting its
  file, and "erase everything" is the one supported action.

## Consequences

An erase cannot be undone, so there is no soft-delete. A crash mid-erase leaves files either in place or in the
trash folder, which the next erase empties. Copies in Git history or backups are outside the product's reach and
the docs say so.

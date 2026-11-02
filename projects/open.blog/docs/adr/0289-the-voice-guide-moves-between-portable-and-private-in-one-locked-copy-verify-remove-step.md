# ADR 0289: The voice guide moves between portable and private in one locked copy, verify, remove step

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#410](https://github.com/journey-to-code-org/open.blog/issues/410)
- Story: #426 (task #463)
- Amends: ADR 0282 (private by default, reversible moves)
- Builds on: ADR 0279 (provenance line), ADR 0283 (the guide's paths and the link rule)

## Context

Story #426 says the portable choice is "explicit per sample and per guide and can be reversed by moving the file
in one transaction". Samples already move (`voice_store::move_visibility`, ADR 0282), but the guide had no move.
"Save as private" wrote a second copy and left the portable file, which Git still tracked. To make a guide
private, the author had to save a copy and then delete the original by hand, in two steps that could each fail
on their own.

## Decision

- **One store function: `voice_store::move_guide(root, to)`.** It moves `assistant/context/voice.md` to
  `.openblog/private/context/voice.md`, or the other way. The paths come from `voice_store::guide_paths`, the one
  place that names them (ADR 0283). `plan_guide_move` makes the same checks and writes nothing. The CLI and the
  Admin both call these functions.
- **Locks, in the usual order.** The caller takes the content transaction lock, because a guide save through the
  context route holds it. The Admin first takes its in-process build lock, as the context save does. The store
  function then takes the voice store lock. An import takes the same locks in the same order (ADR 0284). A
  move started while a content write is running is refused, not queued, in Admin. The CLI waits up to three
  seconds.
- **Copy, verify, remove. The guide is never lost.** The bytes are copied unchanged with a no-replace create
  and read back. A copy that does not match is removed, and the original stays. The original is removed only
  after that. If the original cannot be removed, both identical copies remain and the error says to run the move
  again. The next run finds an identical copy at the destination and only removes the original. A different file
  at the destination refuses the move, so nothing is overwritten.
- **Refusals.**
  - There is no guide to move.
  - Either guide path, or a folder on the way to it, is a link or junction. This is the erase rule (ADR 0283),
    and it applies even when the link points inside the project.
  - The guide is not a regular file or is larger than 64 KiB, the context limit.
  - The guide is moving to portable and is not UTF-8 text.
  - The guide is moving to portable and it is private-derived: its provenance line names `private`
    (ADR 0279), or one of its traits cites a sample that is private now. Portable context is tracked by Git.
    `voice_store::guide_is_private_derived` is the one rule; the guide merge (ADR 0288) and a context save as
    portable use it too, so a guide made from portable samples cannot reach Git after one of those samples was
    moved to private.

  Moving to private never checks provenance.
- **Private stays out of Git.** Before a private copy is written, the move calls `keep_private_out_of_git`,
  which adds `/.openblog/private/` to the repository's ignore rules.
- **Surfaces.** On the command line, `openblog voice guide --move portable|private` prints what would move and
  exits non-zero ("Nothing was moved"). With `--yes` it moves the guide. In Admin, each existing voice guide card
  in the Assistant Context view has **Make private** or **Make portable**. The button asks the server for the
  plan (`GET /admin/api/voice/guide/move?to=`), shows what would move or why it will not, and moves only on
  **Move to private** / **Move to portable** (`POST /admin/api/voice/guide/move`, `{ "to" }`). **Cancel**
  moves nothing. Both routes sit behind the session, and the POST also needs the CSRF token and the same
  origin, like every other voice route.

## Considered options

- **Save the other copy, then delete the original through the context routes.** Rejected: that is two requests,
  and a failure between them leaves the guide in both places or in neither.
- **Rename across the folders.** Rejected: the two folders can be on different volumes, and a rename can
  replace a file. A copy that is checked before removal works everywhere and never replaces anything.
- **Let a move to portable strip the provenance line.** Rejected: the line is the only record that the guide
  quotes private samples.

## Consequences

- A guide can be made private, and portable again, without being lost and without a moment where Git tracks
  something that should be private.
- Git history still keeps any commit made while the guide was portable. A move does not rewrite history.

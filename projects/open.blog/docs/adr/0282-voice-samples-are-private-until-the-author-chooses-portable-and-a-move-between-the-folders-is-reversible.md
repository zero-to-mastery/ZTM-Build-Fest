# ADR 0282: Voice samples are private until the author chooses portable, and a move between the folders is reversible

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#463](https://github.com/journey-to-code-org/open.blog/issues/463)
- Parent story: [#426](https://github.com/journey-to-code-org/open.blog/issues/426)
- Parent epic: [#410](https://github.com/journey-to-code-org/open.blog/issues/410)
- Builds on: ADR 0266, ADR 0267

## Context

Voice samples are personal writing. VS1 to VS3 already keep them out of builds, feeds and exports, and already
default to the private folder. This record states the policy in one place and names the tests that hold it.

## Decision

- **Private is the default everywhere.** `openblog voice` writes to `.openblog/private/context/voice/` unless
  `--portable` is given; the Admin session form preselects Private and its start route treats a missing
  `visibility` as private. A sample is portable only because the author said so, at the start or later.
- **Portable is an explicit, reversible choice.** Moving a sample (with its rough or polished partner) between the
  folders is `voice_store::move_visibility`: copies are checked byte for byte before any original is removed,
  nothing is overwritten, a failure before the first removal undoes the copies, and a repeat finishes a partly
  done move. A move there and back leaves the same bytes in the same place.
- **Staging proof.** Publishing stages only the configured publish paths and refuses a force-added private
  sample (`publishing_never_stages_a_private_voice_sample`); a build and a portable export carry no sample text
  (`init_creates_no_voice_files_and_a_build_is_identical_with_and_without_samples`,
  `a_portable_export_never_carries_a_voice_sample`); and
  `a_move_is_reversible_and_a_sample_is_only_staged_while_it_is_portable` shows a sample is staged only while it
  is portable and not after it is moved back: `git ls-files` no longer lists it once a publish has followed.
  Git history still keeps any earlier commit that carried the sample while it was portable; moving it back
  stops it being tracked from then on and does not rewrite the past.
- **The guide follows the same rule.** The voice guide is private by default (ADR 0283 lists where it lives).

## Consequences

No new surface was needed: this story adds the reversal and staging tests and this record. A CLI command to move
a sample is not added; Admin's "Make private" and "Make portable" are the way to change visibility.

## Amendment: the guide moves too (ADR 0289)

The guide now has its own move. `voice_store::move_guide` copies the file, checks the copy and then removes the
original, under the content transaction lock and the store lock. It refuses links and refuses a move to portable
for a guide that quotes private samples or cannot be read. The CLI runs it with
`openblog voice guide --move portable|private [--yes]`, and the Admin with **Make private** or **Make portable**
on the guide's card. See [ADR 0289](0289-the-voice-guide-moves-between-portable-and-private-in-one-locked-copy-verify-remove-step.md).

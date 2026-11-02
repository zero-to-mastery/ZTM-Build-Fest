# ADR 0270: Promoting a polished voice sample to a post draft is one store function that every surface calls

- Status: Accepted
- Date: 2026-10-28
- Parent epic: [#407](https://github.com/journey-to-code-org/open.blog/issues/407)
- Task: #443
- Builds on: ADR 0266, ADR 0267 ("From a polished draft to a post draft")

## Context

The CLI (`openblog voice promote`) and the Admin voice screen both turn a polished sample into a post draft.
ADR 0267 made the conversion pure (`VoiceSample::to_post_draft`). The part around it, which slugs are taken,
where the file goes, and not replacing anything, must also be one piece of code, or the two surfaces will
drift.

## Decision

- **One function**: `voice_store::promote_to_post_draft(root, visibility, file, dir) -> Result<PathBuf, StoreError>`.
  The CLI command is a wrapper that finds the sample and holds the content transaction lock; Admin calls the
  same function (holding the lock it already holds for content writes).
- **Refusals**: a rough draft or an invalid sample (the sentence says to polish first), a slug already used
  by any post including drafts (read the way a site load reads it: the `slug` field, else the file name
  without its date), a file that already exists, and a folder that is not `posts` or inside it.
- **Writes once, never replaces.** The file is created with the no-replace atomic write the export code
  uses, as `<content>/posts[/<dir>]/<day>-<slug>.md` with `draft: true`. The post is loaded with the ordinary
  post parser before anything is written, so a post that would not build is never created.
- **The sample is never touched.** The function reads it and does not write to the samples folders. Tests
  compare the folders byte for byte before and after.
- **The result is a path relative to the project root**, with `/` separators.
- The caller holds `transaction::ContentTransactionLock`, like every other content write; the function does
  not take it, so Admin does not deadlock against itself.

## Considered options

- **Rename on collision.** Rejected in ADR 0267: a silent rename makes two posts look like one.
- **Let each surface check slugs.** Rejected: that is the drift this ADR exists to prevent.

## What would trigger revisiting this

- Authors wanting to promote into series or pages: a new target kind, additive.

## Consequences

- Admin gets promotion by calling one function and mapping its `StoreError` to a response.

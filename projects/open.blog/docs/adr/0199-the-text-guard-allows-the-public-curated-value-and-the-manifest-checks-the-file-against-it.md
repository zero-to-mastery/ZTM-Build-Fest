# ADR 0199: The text guard allows the public curated value, and the manifest checks the file against it

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#197](https://github.com/journey-to-code-org/open.blog/issues/197)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0197](0197-the-curated-context-file-is-a-bounded-versioned-projection-of-the-one-public-curated-value.md), [ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md), [ADR 0191](0191-a-damaged-selections-file-refuses-a-full-build-and-withheld-selections-have-no-rows-to-acknowledge.md)

## Context

The text guard (ADR 0125) knows the text of every private research file, including the words of an
author's comment in `selections.json`, and refuses to publish it in machine data unless a projection
approved it. A comment the author selected for readers is exactly such text, so the new artifact needs
an allowance, and only for what is public.

## Decision

- **Allow the value the build renders, nothing more.** The guard allows the serialised public curated
  value (the published items and context), as it allows the atlas and comparison projections as the
  build renders them. The words of a selection that is withdrawn, stale, missing, unapproved or cyclic
  are not in that value, so they are still found wherever they appear; so is the text of every other
  private store, in the new file or any other.
- **The allowance is by words, and it is not scoped to the selection.** The guard works on word
  sequences ("shingles"), not on records: allowing the public value drops every sequence that the
  published text contains from the private set, wherever else that sequence appears. An annotation the
  author makes public that copies a sentence of a private note therefore excuses that sentence in every
  file, and the note's other sentences are still refused (tested). The Admin's selection form, the
  configuration guide and this record say so, and advise writing a comment fresh rather than pasting.
- **The file is machine data.** `curated-context.json` is scanned field by field like the atlas files:
  private text that no projection approved is a refusal naming the file, the store and the record, never
  the text. The same words in a page are a warning, as for every other page.
- **The file may only name what the manifest publishes.** The output check refuses a file that names a
  selection, a piece of context or a post that the manifest's curated projection and the published
  posts do not, wherever it names one: an item's `posts`, the keys of its `positions`, its `requires`, a
  context entry's `via`, and the address of each post and of each item's anchor (a published post's
  address and the item's own `ob-curated-` fragment) (an entry or relationship also has to be published by the atlas projection), and one
  that the manifest does not list.
- **A damaged selections file still refuses a full build** (ADR 0191). The curated selections are
  resolved against what the build publishes, never against the private files.

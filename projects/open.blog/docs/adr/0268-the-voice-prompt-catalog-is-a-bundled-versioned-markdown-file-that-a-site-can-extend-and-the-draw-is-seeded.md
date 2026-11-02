# ADR 0268: The voice prompt catalog is a bundled, versioned Markdown file that a site can extend, and the draw is seeded

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#433](https://github.com/journey-to-code-org/open.blog/issues/433)
- Parent story: [#412](https://github.com/journey-to-code-org/open.blog/issues/412)
- Parent epic: [#406](https://github.com/journey-to-code-org/open.blog/issues/406)
- Builds on: ADR 0266, ADR 0267

## Context

The prompts are what make a voice session worth doing: they have to reach an author's stories, opinions,
humor and expertise, not only their craft, and a non-programmer must be able to answer one in three minutes.
The catalog also has to be extensible by a site without a fork, and a draw has to feel random while steadily
filling gaps, yet be testable.

## Decision

### The catalog

- **One Markdown file** compiled into the binary (`crates/openblog-cli/src/voice_prompts/catalog.md`). Front
  matter has `version` and the standing `rule` ("write it the way you would say it"), stored once. Then
  `## pack-id: Title` sections with an optional one-line summary, and `### prompt-id: Title` sections that
  begin with `words: low-high` and hold the invitation. This release ships ten packs (teaching, stories,
  opinions, reviews, people, craft, humor, expertise, everyday life, openings and endings) and forty-two
  prompts, at least three per pack.
- **Ids are forever.** Pack and prompt ids are lowercase kebab-case, unique, and never renamed or reused,
  because a sample records its prompt id. Titles and wording may change freely.
- **`version` is the catalog version** stamped on a sample as `voice.catalog`. It is bumped only when an id
  is removed or its meaning changes; adding prompts does not bump it. A catalog newer than this release is
  refused with a sentence, and so is a sample stamped with one.
- **Parsing is pure** (`openblog_core::voice::catalog`). Errors are plain sentences with line numbers.

### The site file

- `assistant/voice/catalog.md` is optional and uses the same sections. **Site prompts append**: new packs
  after the bundled ones and new prompts after a bundled pack's own, both in id order, so the result does not
  depend on how the file is ordered. A site prompt whose id is already in the bundled catalog (even in a pack
  the site hides) is refused. **`disabled: [pack-id, ...]`** hides whole packs; an id that names no pack is a
  warning, never a failure. A site file that cannot be used is reported and the bundled catalog is used.
- Existing samples of a hidden pack stay readable and listed; hiding only stops them being drawn.

### The draw

- `draw_three(catalog, library, seed)` is a pure function. The caller supplies the entropy (a time or an OS
  random number); the same seed always gives the same draw, which is what makes it testable.
- **Preference order for each of the three picks**: a pack not yet drawn, then a prompt not in the previous
  draw (a redraw passes its previous three), then a prompt with no sample, then one with only a rough draft,
  then any. Ties are broken uniformly among packs first, then among prompts, so a small pack is not starved
  by a big one. With an empty library the three are from three different packs; with every prompt answered it
  still returns three.

## Considered options

- **JSON or TOML for the catalog.** Rejected: the invitations are prose and a Markdown file is easy to read
  and to send a pull request against.
- **Random draw weighted by a score.** Rejected: harder to explain and to test than an ordered preference.
- **Site prompts that override bundled ones.** Rejected: a sample's prompt id would then mean two things.

## What would trigger revisiting this

- Authors wanting to translate the catalog: that would add a `lang` to the catalog, selected by the site.
- A prompt that needs structured input (not free text): a new prompt `kind`, additive.

## Consequences

- Wording can improve in every release without touching anyone's samples.

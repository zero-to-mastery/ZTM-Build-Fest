# ADR 0144: Supplement layers render progressively from the complete static page

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#70](https://github.com/journey-to-code-org/open.blog/issues/70)
- Parent story: [#26](https://github.com/journey-to-code-org/open.blog/issues/26)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0141](0141-a-reading-mode-only-shows-or-hides-supplements-and-every-representation-stays-complete.md),
  [ADR 0142](0142-supplements-keep-real-headings-a-visible-boundary-and-warnings-in-every-mode.md),
  [ADR 0143](0143-the-reading-mode-control-is-a-native-radio-group-that-enhances-the-static-page.md)
- Contract: [Reading modes](../specs/reading-modes.md)

## Context

#69 shows and hides supplements from the reader's mode. #70 connects the mode to the static
supplemental layers so guided and deep-dive context appear progressively: nothing may be lost
without script, the reader keeps their place when a layer appears, and a link into a hidden layer
shows it. Review of #69 also found that its page painted every layer and then hid some (a layout
shift), that the saved choice was named per origin although GitHub Pages project sites share one,
and that several enhancement paths could undo the reader's own navigation.

## Decision

- **The static page stays the whole content.** Nothing is generated, fetched or split off for
  later; "progressive" means the enhancement is applied in layers over markup that is already
  complete. Portable copies, feeds, print without script and every no-JavaScript reader keep every
  supplement, labelled and in order (ADR 0141).
- **Hidden before paint, without script and without inline code.** The stylesheet hides, only where
  `@media screen and (scripting: enabled)` holds and only while `<ob-reading-modes>` is not yet
  defined (and has not marked itself `ob-reading-started`, the first thing it does), the
  layers the author's `default` hides (everything but warnings for standard, the deep-dive layers
  for guided). The element is defined, and the mode applied, in one task, so the layers the saved or
  default mode shows never flash. The hiding is the first keyframe of an animation held through a
  six second delay, not a declaration, so if the script never arrives (blocked, failed, offline) the
  layers return on their own (`animation-play-state: running !important` keeps a rule that pauses
  animations from freezing the hidden state). A reader whose saved choice differs from the author's default sees the
  difference apply once; their place is kept (below). Readers who asked for reduced motion (the
  stylesheet turns animations off for them) get the safe order instead: the full page first, the
  mode applied when script runs, place kept.
- **Hidden layers stay findable.** Where the browser has `hidden="until-found"`, a hidden supplement
  gets it instead of `hidden`: its box shrinks to nothing, its words are skipped until needed, find
  in page can reach them and the browser reveals the layer for a link or a match, firing
  `beforematch`, which marks it revealed and announces it. Without the feature the plain `hidden`
  of ADR 0143 applies and the link/hash handlers do the revealing.
- **The reader keeps their place.** Before a mode changes, the first article block in view that is
  not inside a layer about to change is measured; after the change the page is scrolled by the
  difference. It runs for every mode the reader chooses and for a load that restored a scroll
  position, and is independent of the browser's own scroll anchoring. Open `<details>`, citation
  state and the checked radio are never rebuilt: only `hidden` is toggled.
- **Reveal on navigation covers every way in.** A hash change, a click on any in-page `#` link
  (including one to the address already shown, which fires no `hashchange`), a citation back-link
  and a find-in-page match all show the holding supplement and its parents, focus the target and
  say so. A change made in another tab, or a clear of storage, applies only when it changes the
  mode shown, and never hides the supplement that holds focus or one the reader navigated into.
- **A layer that cannot be read is never hidden.** A supplement with a missing or unknown
  `data-ob-level` is shown in every mode, and one that throws is skipped on its own; the others go
  on. The build only writes known levels, so this protects against hand-edited or newer markup.
- **The fade-in is only for a mode the reader just chose.** `ob-just-shown` is set on the layers a
  chosen mode revealed and nowhere else: not on load, not without script, not under reduced motion.
- **The reset button uses `aria-disabled`,** not `disabled`, so it does not drop keyboard focus when
  it has nothing left to reset.
- **The saved choice is named per site, not per origin.** localStorage is per origin, which every
  GitHub Pages project site of one account shares; ADR 0143's "per site" was wrong for them. The
  build writes `data-ob-base="/blog"` on the element for a site under a folder (the base path of
  its `url`), and the key becomes `ob-reading-mode:/blog`. A site at the root keeps `ob-reading-mode`
  and the markup it had. A saved choice made under the old shared key by a project site is not
  migrated; the reader chooses once more.
- **Written ids cannot take a supplement's id.** For a post with supplements, a heading `{#id}`, a
  footnote label or a raw HTML `id` that begins `ob-supplement-` is renamed with a `section-`
  prefix (the written `id` value itself is renamed, so `title=` or `data-x=` text that matches is never
  the one changed, and a Markdown link to the renamed id follows it; a raw HTML `href` is left as
  written) and reported
  as a warning; heading slugs follow the same rule. A post that has not opted in is never touched:
  its slugs and ids are exactly as before.
- **U+0000 is read as U+FFFD** (CommonMark) before a post with supplements is parsed, so a NUL in
  the text can never look like the renderer's own tag. A post with no NUL is byte-identical.
- **Findings use plain words.** A supplement that holds a warning is reported as information
  ("nothing to fix"); the warning plumbing has no levels, so the wording carries it. `readingModes`
  maps warn on unknown keys and read `{enabled: false}` as off.

## Consequences

- A hidden layer costs nothing to render and loses nothing: it is in the page, in find in page, in
  every export and in print as the page is shown.
- The pre-paint hiding depends on `:defined` and `scripting`, both widely supported; where they are
  missing the page simply behaves as in ADR 0143.
- Sibling project sites no longer share a saved choice; moving a site to a different base path
  starts its readers from the author's default.
- Out of scope: generated explanations, recommendation, and any server-side record of the choice.

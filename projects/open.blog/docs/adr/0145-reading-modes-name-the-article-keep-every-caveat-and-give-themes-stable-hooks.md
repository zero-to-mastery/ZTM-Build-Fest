# ADR 0145: Reading modes name the article, keep every caveat and give themes stable hooks

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#71](https://github.com/journey-to-code-org/open.blog/issues/71)
- Parent story: [#26](https://github.com/journey-to-code-org/open.blog/issues/26)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0142](0142-supplements-keep-real-headings-a-visible-boundary-and-warnings-in-every-mode.md),
  [ADR 0143](0143-the-reading-mode-control-is-a-native-radio-group-that-enhances-the-static-page.md),
  [ADR 0144](0144-supplement-layers-render-progressively-from-the-complete-static-page.md)
- Contract: [Reading modes](../specs/reading-modes.md)

## Context

#71 closes the reading-modes story: review the whole experience for understandable labels,
cognitive load, focus order, reduced motion, contrast and an explicit separation of article from
supplement, so that a reader can always tell what is the article and no mode hides a caveat.

## Decision

- **The article is named by what surrounds it.** Nothing wraps or labels the article itself (its
  markup is the same in every mode and for every theme). Instead each supplement is a bordered,
  named group with a visible label and an "End of ... supplement." line, and the control carries one
  visible sentence, tied to its group by `aria-describedby`, saying everything outside those boxes
  is the article. The border (not a tint alone) is what separates them, so it survives forced
  colours (system colours) and print (black ink).
- **Caveats are checked twice.** The build marks a supplement that holds a warning or caution
  callout at any depth, and every supplement around it, `data-ob-always`. The component also looks
  for the rendered callouts itself, so markup that lost or changed the mark is still never hidden;
  the pre-paint hiding skips such a supplement too (`:has`, which fails safe: where it is not
  understood the rule is dropped and nothing is hidden early). Only supplements are ever hidden, so
  the article's own hedges and uncertainty are never affected by a mode.
- **A way past a layer, not another control.** A shown supplement gets a "Skip this ... supplement"
  link to its end line, visible only with focus, placed after the label so it never enters the
  group's name. No new mode, setting or preference is added: cognitive load stays at three radios
  and a reset.
- **Themes get a documented, tested list.** The classes, data attributes and one custom property in
  the spec's hooks table are the supported surface, and a test fails when a documented hook no
  longer exists in the page, script or stylesheet.
- **Out of scope, as the issue says:** reading-level scoring and any analytics of readers' choices.

## Consequences

- A shown supplement adds one tab stop for keyboard readers; a hidden one adds none.
- The note adds one sentence above the options; it can be restyled or hidden with its hook, though
  hiding it removes the plain statement of what is the article.
- Output is unchanged for a post that has not opted in.

# ADR 0143: The reading-mode control is a native radio group that enhances the static page

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#69](https://github.com/journey-to-code-org/open.blog/issues/69)
- Parent story: [#26](https://github.com/journey-to-code-org/open.blog/issues/26)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0140](0140-a-supplement-is-a-marked-block-quote-the-author-wrote-into-the-post.md),
  [ADR 0141](0141-a-reading-mode-only-shows-or-hides-supplements-and-every-representation-stays-complete.md),
  [ADR 0142](0142-supplements-keep-real-headings-a-visible-boundary-and-warnings-in-every-mode.md)
- Contract: [Reading modes](../specs/reading-modes.md)

## Context

#69 adds the control that lets a reader choose standard, guided or deep-dive reading. The page must
stay complete without script, the control must be operable by keyboard and screen reader at 320 CSS
pixels and 400% zoom, and the choice is a private preference.

## Decision

- **One custom element, `<ob-reading-modes default="guided">`, wraps the article prose** of a post
  that has supplements, and only such a post. It carries the author's default mode and nothing else;
  the control does not exist in the static page, so a reader without script sees every supplement
  and no dead control. A post without supplements has no element.
- **The control is a native radio group**: a `fieldset` with the legend "Reading mode" and three
  `input type=radio` with their own `label`s, one per mode. Native radios give the roles, the checked
  state, arrow-key movement inside the group, Tab in and out (focus is never trapped) and the
  platform's focus ring, with no key handling of our own. Each option has a visible one-line
  description, linked with `aria-describedby`, that says what it adds and how many supplements it
  shows.
- **Applying a mode sets `hidden` on each `.ob-supplement` its level does not show** and removes it
  from the rest, by `data-ob-level` and `data-ob-always` only. It never touches the article, the
  citations, the headings or the order. The stylesheet makes `[hidden]` win over the group's own
  `display`.
- **Changes are announced.** A visually hidden `role=status` region says "Guided reading. Showing 2 of
  3 supplements." after each change by the reader, and says what was revealed or reset. It is silent
  on load and when another tab changes the choice.
- **The choice is kept on this device, as a preference only.** `localStorage` key `ob-reading-mode`
  holds one of the three names; it is per origin, which is per site only for a site at the root of its
  host (corrected by [ADR 0144](0144-supplement-layers-render-progressively-from-the-complete-static-page.md):
  a project site under a folder adds its base path to the key), it is read and written
  in `try`/`catch`, a value that is not a mode is ignored, and nothing is sent anywhere or logged.
  When storage is blocked the choice applies to the page and the announcement says it could not be
  saved. A "Use the author's default" button clears the saved choice and returns to the author's
  default; it is aria-disabled while nothing is saved (ADR 0144).
- **Defaults.** Saved choice, else the author's `default` (ADR 0142), else standard.
- **Reduced motion.** Showing a supplement fades it in over 0.18 seconds only under
  `prefers-reduced-motion: no-preference`; scrolling to a revealed target is instant under `reduce`.
- **Layout.** The options wrap and stack; descriptions wrap anywhere; at 320 CSS pixels and at 400%
  zoom nothing scrolls sideways (the browser test emulates the 320 by 256 CSS pixel viewport that 400%
  zoom leaves; it does not drive the browser's zoom command). Print hides the control and prints the page as shown.
- **Fields are private** (`#name`) so none can shadow an `HTMLElement` property such as `hidden`,
  `popover` or `title`.
- **The rules live in one dependency-free module** (`web/components/reading-modes.js`): the mode
  names, `shows`, the default resolution, the storage reads and writes, and the descriptions and
  announcements. `tests/fixtures/reading-modes.json` holds the contract once; the Rust and Node tests
  read it.

## Consequences

- A reader can change mode with the keyboard alone and a screen reader reports the group, each
  option, its state and its description.
- Cross-device sync, accounts and any server-side record of the choice are out of scope and not
  possible with this design.
- #70's progressive rendering and #71's safeguards reuse the module and the markup.

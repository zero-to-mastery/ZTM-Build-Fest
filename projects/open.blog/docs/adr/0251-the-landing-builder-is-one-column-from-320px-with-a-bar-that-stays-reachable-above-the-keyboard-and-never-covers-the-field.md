# ADR 0251: The landing builder is one column from 320px, with a Preview, Save and Publish bar that stays reachable above the keyboard and never covers the field

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#328](https://github.com/journey-to-code-org/open.blog/issues/328)
- Parent story: [#316](https://github.com/journey-to-code-org/open.blog/issues/316)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0249, ADR 0250
- Serves: [#329](https://github.com/journey-to-code-org/open.blog/issues/329)

## Context

The builder is for an owner with one thumb on a phone. A desktop form squeezed onto a small screen, a
Save button that scrolls away, or a bar that hides the field being typed in would each cost them work.

## Decision

- **One column, wrapped, from 320px.** Cards, forms, the picker and the bar are single-column flows that wrap
  (long words break rather than widen the page). Nothing in the builder region scrolls sideways at 320px,
  at 200% text size, or in a 1280px page at 400% zoom (a 320px page). `body`'s old `min-width: 20rem` floor,
  which grew with the text size and forced sideways scrolling when text was enlarged, is now
  `min(20rem, 100vw)`.
- **44px everywhere.** Every button, input, select and text area in the builder and its bar is at least 44px
  tall and wide. Inputs use 16px text so phones do not zoom in on focus. Each field has a visible label; the
  hint and the problem are tied to it with `aria-describedby`. Nothing is hover-only: every control is
  visible and operable by touch, keyboard and screen reader, and the card buttons wrap into rows instead of a
  menu.
- **Keyboards that match the field.** Addresses are `type=url` with the URL keyboard, email is `type=email`,
  phone is `type=tel`, counts and coordinates are `type=number` with `inputmode` numeric or decimal.
  Autocapitalize and spellcheck are off for addresses.
- **A bar that stays put: Preview, Save, Publish.** The bar is sticky at the bottom of the screen and holds
  the status of unsaved work. It rides above the on-screen keyboard: when the visual viewport shrinks (a
  keyboard opening) the bar is moved up by the covered height. When a field takes focus and would sit under the
  bar, the page scrolls it clear (with a margin) so the bar never covers what is being edited. When large text
  or a short landscape screen makes the bar taller than a third of the screen it stays in the flow of the page
  instead of floating (`max-height: 30rem` and a measured check), so it never leaves no room to work.
- **Publish saves first.** Publish saves unsaved changes (and stops with the same plain problems if they are
  not valid), then commits and pushes as the header's Publish does. It is off, with the reason in words, when
  the site is not a git repository. Nothing is published by Save or by Preview.
- **Side by side on a wide screen.** From 64rem the preview is open beside the builder from the start, and
  "Hide preview" and "Preview" toggle it; below that it is the full-screen sheet of ADR 0250.
- **Reduced motion.** Under `prefers-reduced-motion: reduce` the builder's buttons, picker tiles and fields
  have no transition, transform or animation (the Admin buttons otherwise lift on hover).
- **One editor open at a time.** On a phone one open form at a time keeps the page short; the others stay as
  cards.

## Considered options

- **`position: fixed` for the bar.** Rejected: it overlays the last section and needs padding the bar's
  changing height would have to match; sticky stays in the flow and ends where the page ends.
- **`interactive-widget=resizes-content` in the viewport meta.** Rejected: it would change every Admin page
  and is not supported on iOS Safari; the visual viewport offset works wherever the API exists and the bar is
  still reachable where it does not.
- **A hamburger menu for card actions.** Rejected: five real buttons that wrap are one tap each and are all
  visible to a screen reader.

## Consequences

- The layout is tested at 320x568, 375x667, 768x1024, 1280x800 and landscape 667x375 with measured sizes
  and edges rather than screenshots, plus the zoom and text-size cases.
- There is no axe or similar checker in this repository's tests, so accessible names and labels are asserted
  directly for every control in the builder.

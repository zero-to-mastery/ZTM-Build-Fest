# ADR 0276: The voice view is phone-first, and its layout is checked in a real browser without relying on font metrics

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#451](https://github.com/journey-to-code-org/open.blog/issues/451)
- Parent story: [#420](https://github.com/journey-to-code-org/open.blog/issues/420)
- Parent epic: [#408](https://github.com/journey-to-code-org/open.blog/issues/408)
- Builds on: ADR 0251 (the landing builder's phone comfort), ADR 0272, ADR 0275

## Context

Many authors will write a voice sample on a phone, where the keyboard covers half the screen and the page is a
single column. The session must be comfortable there, and the proof must not depend on the fonts of the machine
that runs it: CI renders wider fallback fonts than a developer's laptop.

## Decision

- **One column, then three.** The three prompt cards stack below 48rem and sit side by side from 48rem. Each
  card is a real radio button inside a label at least 44px tall; nothing depends on hover.
- **The rough box and the polished editor are at least 40% of the screen tall** (`min-height: 40vh`) and the
  text is at least 16px, so a phone browser does not zoom the page when it takes focus.
- **The action bar floats and gives way.** Finish early and Start over (and Save and Reset) sit in a bar stuck to
  the bottom of the screen, which rides above the on-screen keyboard through `visualViewport`, and joins the
  flow of the page when its own height would take more than 40% of the screen (wide fonts, large text, a short
  screen or a phone on its side). It is the landing builder's rule, written once for this view
  (`keepBarReachable`). Fields scroll into view clear of it.
- **The gutters are the page's own** (at least 16px at 400px), and every paragraph, label, heading and
  row wraps anywhere, so a long unbroken word wraps instead of widening the page.
- **A scripted real-browser check** (`tests/browser/voice-session.spec.mjs`) drives the real binary and the real
  page at 400x800 and 1280x900: the cards stack (each below the one before, same left edge, inside the gutters),
  the box is at least 40% of the height, the bar is inside the viewport and its button is in view, and neither
  the region under test nor the page scrolls sideways, with a long unbroken word typed in. Overflow is measured on
  the region under test with a 1.5px tolerance, never against a fixed pixel width of text, so wider CI fonts
  cannot fail it. Screenshots of the draw, write and refine steps at 400px and the draw and write steps on a
  desktop are saved to `tests/browser/test-results/voice/` for the pull request.
- **The same spec proves the rest in a real browser**: the rough box's attributes as the browser reports them
  (`spellcheck`, `autocorrect`, `autocapitalize`, `writingsuggestions`), the stored rough file byte for byte, a
  reload in the middle of the window, Admin's unsaved question for polished edits, and a real 30 second window
  that warns in words and locks itself.

## Considered options

- **Assert pixel widths of text.** Rejected: it is a font test, and it fails on the next machine.
- **A bar that is always fixed.** Rejected: on a short or zoomed screen it would cover the work.

## What would trigger revisiting this

- A browser that stops reporting `visualViewport` sizes with the keyboard open: the bar would then simply stay
  where the page puts it, which is still usable.

## Consequences

- A phone author reaches Finish early and Save without hunting, and never sees a page that scrolls sideways.

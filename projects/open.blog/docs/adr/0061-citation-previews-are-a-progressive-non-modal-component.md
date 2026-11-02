# ADR 0061: Citation previews are one progressive, non-modal component that shows the page's own data as text

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#66](https://github.com/journey-to-code-org/open.blog/issues/66)
- Parent story: [#25](https://github.com/journey-to-code-org/open.blog/issues/25)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0059](0059-published-reference-data-for-citation-previews.md),
  [ADR 0060](0060-citation-navigation-is-static-html-checked-at-build.md)
- Contract: [Citation format](../specs/citations.md)

## Context

A post that publishes citations already reads fully without JavaScript: each marker is a
`doc-noteref` link to a focusable note, and the page carries its reference data inline (ADR 0059,
ADR 0060). B1 asks for a preview of the cited source beside the marker, so a reader can check a
reference without losing their place, with predictable open, close, Escape, outside interaction
and focus return, for keyboard, pointer, touch and screen-reader users. It must never remove the
underlying link, show anything but pre-rendered safe text and allowlisted links, or reach outside
the page.

## Decision

- **One component, loaded only where it has data.** `web/components/ob-citation-previews.js`
  defines `<ob-citation-previews>`. The renderer writes its module script right after the
  `ob-references` data in `<head>` and one empty host element at the end of `<main>`, both only
  on the page of a post that publishes citations. Every other page, feed and portable copy is
  byte-for-byte what it was. The host carries one localized attribute, `note-label` ("Go to
  note", or "Go to reference" for a bibliography), from the citation locale.
- **The marker stays the link.** Its `href`, role, name and id are never changed. A click or
  Enter follows it exactly as without JavaScript. A marker that no longer links to its own note
  is left alone.
- **Non-modal, described, in reading order.** One preview element (`role="group"`, named by the
  marker it belongs to) is moved straight after the marker's `<sup>` when it opens, so Tab goes
  from the marker into the preview's links and then on through the text. While it is open the
  marker is `aria-describedby` the preview's reference and locator text. This follows the APG
  tooltip pattern for opening on focus and hover and closing on Escape, without its "no
  interactive content" limit: because the preview is in the reading order, its links can be
  reached. It is not a dialog and never traps focus.
- **Predictable open and close.** Focusing a marker opens its preview; hovering opens it after
  250 ms. Escape closes it and, if focus was inside, returns focus to the marker without
  reopening. Focusing or pressing anything outside the marker and preview closes it; leaving both
  with the pointer closes it after 300 ms unless the keyboard is using it. Only one preview is
  open at a time.
- **Touch.** A first tap on a marker opens its preview instead of following the link; the
  preview's "Go to note" link and a second tap on the marker both follow it. A first tap is only a
  click that ends a primary touch `pointerdown` on the same marker while its preview is closed. A
  press the browser cancels, that focus leaves, or that is followed by a press elsewhere is
  forgotten, and a click with `detail` 0 (Enter, a script, or a screen reader activating the
  link, which on a touch screen often comes with no press at all) always follows the link.
- **Text only, links allowlisted.** The preview shows the reference's `formatted` text and the
  citation's new `formatted` locator text, assigned with `textContent`. Its outside link is the
  data's `link` only, checked again in the browser to be an absolute `http(s)` address with a
  host and no credentials; anything else is dropped and the text kept. The other link is the
  marker's own note fragment. The data is read only when its `version` is 1 and is at most 1 MB.
  Each reference and citation is checked on its own, so a malformed entry loses only its own
  preview.
- **Pre-rendered locators.** `ReaderCitation` gains an optional `formatted`: the citation's
  locators as readers see them in the notes' locale (`pp. 514–520, l. 3`), absent when there are
  none. It is additive, so the data stays version 1.
- **No requests, no storage, within the policy.** The component never fetches, never stores
  anything and adds no inline script or markup style. It positions the preview through custom
  properties set with the CSS object model, which `style-src 'self'` allows: below the marker,
  above it when only that fits, and inside the viewport's width with an 8px gutter. Its greatest
  width is the root element's `clientWidth` less both gutters, not `100vw`, which would count a
  classic scrollbar.
- **Motion and print.** The preview fades in only under `prefers-reduced-motion: no-preference`;
  the global reduced-motion rule removes it otherwise. Print hides it; the notes print.
- **Disconnection.** Removing the host closes the preview, removes it and its description, clears
  its timers and detaches every listener through one `AbortController`; connecting it again
  enhances the page again, once.

## Consequences

- Readers with JavaScript can check a reference in place; without it, nothing changes.
- Screen-reader users hear the reference as the marker's description and can Tab into its links.
- Themes style the preview through the shared tokens; they cannot change what it shows.
- A preview verifies nothing about a source; the contract states what it does not verify and
  the guarantees each release keeps ([Citation format](../specs/citations.md#guarantees)).
- Out of scope: fetching anything about a source, AI summaries and modal-only reading.

## Domain language

**Citation preview** is defined in [`CONTEXT.md`](../../CONTEXT.md).

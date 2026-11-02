# ADR 0256: The Customize look screen offers only choices, previews the unsaved look from the real home page, and saves like the landing builder

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#350](https://github.com/journey-to-code-org/open.blog/issues/350)
- Parent story: [#343](https://github.com/journey-to-code-org/open.blog/issues/343)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0248, ADR 0250, ADR 0251, ADR 0252

## Context

ADR 0248 stores the owner's look as a small versioned set of closed choices and `GET`/`PUT /admin/api/look`
reads and saves it. Owners need a screen that lets them change colors and fonts by tapping big options and
watching the site change, with no jargon and no way to break the site.

## Decision

- **Customize look is a screen beside Appearance** (`#/look`, a tab and a button on Appearance). It lists the
  looks gallery first (the eight curated looks with light and dark swatches, a name and a sentence), then
  Main color, Font style, Text size, Corners, Spacing, Page width and Heading weight, in plain words. Only the
  controls the active theme honors (the `controls` the server returns) are shown, with the server's kind
  sentence about the rest.
- **Nothing takes text.** Every control is a group of real radio buttons drawn as cards (with a mark and a
  border for the selection, never color alone), a swatch, or one native color picker. Choosing a curated look
  sets its palette and font style and clears a chosen accent, exactly as `look_presets::apply` does. The
  screen sends only the controls it knows; the server still validates everything and keeps fields it does not
  know.
- **Back to theme default and Reset everything, with Undo.** Each control has a Back to theme default button
  (disabled when nothing is chosen) and a line saying what is in force. Reset everything clears the look.
  Every change, including a reset, goes on an undo history (50 deep); a color-picker drag is one step.
- **The preview is the real home page with the unsaved look.** `POST /admin/api/look/preview` takes
  `{look, mode}`, validates the look as a save would, builds the home page in memory with the production code,
  replaces the link to the theme's `tokens.css` with the theme's whole stylesheet with the look layered over it
  (so a control reset to the theme default really shows the default, not the saved look), and stores it as a
  short-lived preview document served into the same script-free sandboxed frame as the landing preview. `mode`
  is `light`, `dark` or `system` and sets `data-theme` on the page, so owners see both colorings. It writes no
  file and publishes nothing; like every Admin route it is denied without a session and a CSRF token. The
  answer also carries the plain-words contrast notes and whether the accent was refused (ADR 0248), which the
  screen shows inline in a status region ("We adjusted a color so it stays easy to read").
- **The bar, the sheet and the frame are the landing builder's** (ADR 0250, 0251): Preview, Save and Make it
  live stay at the bottom on a phone, the preview is a full-screen sheet with Back on a phone and sits beside
  the controls on a wide screen, and Phone/Tablet/Desktop sizes are the same switcher.
- **Drafts and conflicts follow ADR 0252.** Unsaved choices are kept on the device under
  `ob-look-draft:<user>`, offered back as "Restore your unsaved changes?", and warned about on leaving. A
  `409` from the save shows "Your look was changed somewhere else" with Keep mine, Use the newer look (the
  owner's changes are put away as a restorable draft) and Compare (control by control, in words). A choice
  made while a save is in flight stays unsaved. A save that stored the look but could not rebuild the site
  says so and Make it live stops, as in commit 928ba311. Make it live is Save followed by Publish.
- **One draft store.** `createDraftStore` takes an optional check for what a draft holds, so the look reuses
  the landing page's store instead of copying it.

## Considered options

- **A free hex field for the accent.** Rejected: the picker and the swatches reach every color without a field
  that takes text.
- **Computing the preview in the browser from `--ob-*` values.** Rejected: it would drift from the build; the
  server builds the page, as for the landing preview.
- **A second shared preview component extracted from the landing builder.** Deferred: the placement code is
  repeated in `showLook` to leave the landing builder untouched; a later refactor can share it.

## Consequences

- A theme that honors few controls shows a short screen and says why; a theme that honors all shows all.
- The preview endpoint builds the site's sources for each preview, as the landing preview does, so it shares
  the build lock briefly.

# ADR 0249: The landing page builder is a list of cards in Admin with real buttons and plain-language forms, and no field takes markup

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#326](https://github.com/journey-to-code-org/open.blog/issues/326)
- Parent story: [#316](https://github.com/journey-to-code-org/open.blog/issues/316)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0245, ADR 0246
- Serves: [#327](https://github.com/journey-to-code-org/open.blog/issues/327), [#328](https://github.com/journey-to-code-org/open.blog/issues/328), [#329](https://github.com/journey-to-code-org/open.blog/issues/329)

## Context

ADR 0245 to 0247 define, store and render the landing page. A non-technical owner now needs to change it
from any device, with taps or a keyboard, without being able to break the page and without seeing code.

## Decision

- **One Admin view, `#/landing`**, in the existing Admin Studio shell and navigation ("Landing page", also in
  the command palette). It is not a second editor: it mounts and unmounts like the other Admin views, and it
  uses the same unsaved-work guard (`viewDirty`, `viewBusy`).
- **A section is a card** with its plain name, a one-line summary of what it holds, a "hidden from visitors"
  or "N things need attention" note in words, and real `<button>` controls: Edit, Move up, Move down, Hide or
  Show, Delete. Each button's accessible name starts with its visible text and then says which section and
  position it acts on ("Move up, Welcome banner "Hello there" (section 2 of 5)"). A move at either end is
  disabled and focus passes to the opposite direction. Alt with the up or down arrow on a card moves it too.
  Drag and drop is not offered: buttons are the whole interaction, so nothing depends on a pointer.
- **Add a section** opens a picker with one button per type showing an icon, a plain description ("A big
  welcome with a button.") and a sample. The new section is added at the end with a starting text that is safe
  to leave as it is, its form opens, and focus goes to its first field. The picker closes with Escape.
- **Editing is a form under the card**, built from a field description per type (`web/admin/landing.js`), so
  every type uses the same labelled inputs: text, a text area, `url`, `email`, `tel` and `number` inputs with
  matching mobile keyboards, a select, an optional group (a picture, a button) and a list of rows (buttons,
  opening times, links, questions). There is no field for HTML, CSS, a class, a style or a script, and no
  section type that takes them. A featured post is chosen from the published posts by name.
- **Problems are worded for the owner and shown beside the field.** A field's problem appears once it has been
  left (or after a failed Save), in an element the input is described by, with `aria-invalid`. The client
  checks the same limits the server does (required text, lengths, address schemes, ranges, video id shape) so
  it can refuse early; the server stays the authority, and its per-section problems from a refused save are
  shown in the section they belong to.
- **Hide keeps, Delete can be undone.** Hide only sets the section's `hidden` flag. Delete removes the card
  and offers Undo in a status region until the owner edits, saves, undoes or dismisses; Undo restores the
  section at its old position (with a new id if its id was taken meanwhile). Nothing is written to disk by
  any of these until Save.
- **A page with no file starts from the default layout** the legacy home settings stand for (ADR 0246's
  `legacy`), is not dirty, and writes nothing until Save. A file that cannot be read is explained and can be
  started again; saving replaces it.
- **What Save sends** is the page with blank optional values dropped (a blank "how many posts" is absent, not
  empty text) and every field this version does not know carried back unchanged.
- **Announcements.** Every action says what happened in a polite live region ("Welcome banner moved down to
  position 2 of 3.").

## Considered options

- **Drag and drop reordering.** Rejected for now: it needs pointer precision and a separate keyboard model;
  the buttons are the same on every device. It can be added later as an enhancement over the same operations.
- **A modal editor per section.** Rejected: a form inside the card keeps the section in context and avoids a
  focus trap on a small screen.
- **A raw JSON or source mode.** Rejected for this view: the owner is non-technical, and the file stays
  editable in the content folder for anyone who wants it.

## Consequences

- The model and rules live in `web/admin/landing.js` and are tested without a browser; the view is tested in
  Playwright against the real binary.
- #327 adds the preview, #328 the phone layout and action bar, #329 local drafts, the leave guard and conflict
  recovery, all over these operations.

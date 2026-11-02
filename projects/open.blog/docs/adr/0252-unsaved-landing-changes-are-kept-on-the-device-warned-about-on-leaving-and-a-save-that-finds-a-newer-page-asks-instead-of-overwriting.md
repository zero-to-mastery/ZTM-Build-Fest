# ADR 0252: Unsaved landing changes are kept on the device and warned about on leaving, and a save that finds a newer page asks instead of overwriting

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#329](https://github.com/journey-to-code-org/open.blog/issues/329)
- Parent story: [#316](https://github.com/journey-to-code-org/open.blog/issues/316)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0246, ADR 0249

## Context

A dropped connection, a stray swipe-back or editing on two devices must never cost an owner their work, and
a stored page that someone else changed must never be replaced without a choice (ADR 0246 refuses a stale
write with a `409`).

## Decision

- **A local draft.** Unsaved changes are written to `localStorage` under `ob-landing-draft:<user>` about a
  quarter of a second after each change, and at once when the page is hidden or closed (`pagehide`,
  `visibilitychange`), when Admin moves to another view, and when a save fails. A draft holds the page, the
  revision it was based on and the time. It holds the page's own public text and nothing else: no token, no
  session, no other site data. It is cleared by a successful save, by "Discard them", and when nothing is
  unsaved. Every storage access is inside `try`/`catch`; when the device refuses (blocked, full, private mode)
  the draft lives in memory for the life of the page, the bar says "This device would not keep a copy, so they
  are held only until you close or reload this page", and nothing else changes.
- **Restore is offered, never applied.** On return a draft that differs from the stored page shows
  "Restore your unsaved changes?" with Restore your unsaved changes and Discard them. Restoring brings back the
  draft and the revision it was based on, so saving it is checked against what is stored now like any other
  save, and the changes stay unsaved until Save. Until the owner chooses, the stored draft is not written
  over.
- **A warning before leaving.** The builder reports unsaved changes through the same seams as every other
  Admin view: a native confirmation when the owner moves to another part of Admin, and the browser's
  `beforeunload` prompt on closing or reloading. Choosing to stay keeps everything; choosing to leave still
  leaves the local draft. A clean page asks nothing.
- **A conflict is a choice.** A save that gets `409 conflict` writes nothing and shows "This page was changed
  somewhere else" with three plain choices, focus on the heading, and the state announced:
  - **Keep mine** makes the revision the newer one's and changes nothing by itself; the next Save, pressed by
    the owner, replaces the newer page.
  - **Use the newer version** first puts the owner's changes away as a draft based on the newer revision,
    then loads the newer page and offers "Restore your unsaved changes?" so nothing is lost.
  - **Compare** lists, section by section matched by id, which sections are only in one version and which
    differ (naming the parts that differ in the form's own words and both summaries), and whether the shared
    sections are in a different order. It changes nothing.
  If the stored file has become unreadable or was removed, only Keep mine is offered; a file from a newer
  release of open.blog (ADR 0246) cannot be saved over at all, with the reason in words.
- **A lost connection** is worded as one: "Could not reach the server. Your changes are kept on this device.
  Try again when your connection is back." Save stays enabled and works again when the connection does.

## Considered options

- **Restoring a draft automatically.** Rejected: an owner who meant to throw the changes away would find them
  back and perhaps save them; the offer costs one tap.
- **Merging the two versions.** Rejected: a merge of page sections decides for the owner; Compare shows the
  difference and the owner chooses.
- **Keeping drafts on the server.** Rejected: unsaved work is not content; it stays on the device it was made
  on and never reaches a public page, a log or an export.
- **A confirmation dialog on Use the newer version.** Rejected: putting the changes away as a restorable
  draft makes the choice reversible, which a dialog cannot.

## Consequences

- Reloading, closing or crashing a tab, a lost connection and a second device each leave the owner a way back.
- The draft is per device and per signed-in user name; it is not synchronised, and a different browser does
  not see it.

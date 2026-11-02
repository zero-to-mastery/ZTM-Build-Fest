# ADR 0277: The voice invitation is shown once on the Admin home, and a dismissal is an admin preference

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#452](https://github.com/journey-to-code-org/open.blog/issues/452)
- Parent story: [#421](https://github.com/journey-to-code-org/open.blog/issues/421)
- Parent epic: [#408](https://github.com/journey-to-code-org/open.blog/issues/408)
- Builds on: ADR 0272, ADR 0120 (progressive workspace layout)

## Context

The Simple workspace layout hides optional modules, including the Assistant group that holds Voice. A new
author would never learn the feature exists. It should be offered once, politely, and never again once the author
has said no, started, or has samples.

## Decision

- **One card on the Admin home** ("Gather your voice") above the publishing metrics: a sentence of what it is
  (three prompts, three minutes, nothing corrected, nothing published, private by default), **Try a voice session**
  (an ordinary link to `#/voice`) and **Dismiss**.
- **It shows only when all of these hold:** the author has no sample files, no session is open (not even an
  expired one waiting to be locked), and the admin's preferences do not say `voiceInvitationDismissed`. It
  reads `GET voice/status`, which only reads: showing a card never locks a session or creates a folder. If that
  call fails, or answers something unexpected, no card is shown.
- **Dismiss is an admin preference**, `voiceInvitationDismissed: true` in the admin's own private preferences file
  (one per signed-in admin, per project, so "per site"), saved through the same revision-checked route as the other
  preferences. The key is written only when true: a file saved before this release, or one that never dismissed
  it, has exactly the shape it had. Saving `false` removes the key. The file still refuses keys it does not know.
  A dismissal that could not be saved keeps the card and says so; stored settings that cannot be read are never
  replaced from the card.
- **Start does not dismiss.** Writing a first sample removes the reason to show it, and an author who started but
  scrapped the session may still want the card.
- **The card is a labelled region** with a heading; Dismiss has its own label and focus moves to the first
  metric on the page when the card goes.

## Considered options

- **A per-browser flag in `localStorage`.** Rejected: the dismissal would not follow the author between browsers,
  and the issue asks for the admin preference.
- **Always show a Voice link in the Simple layout.** Rejected: the Simple layout is deliberately calm (ADR 0120).

## What would trigger revisiting this

- A second feature that wants a one-time invitation: the preference could become a list of dismissed invitations.

## Consequences

- The Voice tab can stay out of the Simple layout and still be discoverable once.

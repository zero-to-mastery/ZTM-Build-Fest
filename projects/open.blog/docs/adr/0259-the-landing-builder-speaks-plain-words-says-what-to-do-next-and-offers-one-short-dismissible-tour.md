# ADR 0259: The landing builder speaks plain words, says what to do next, and offers one short dismissible tour

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#339](https://github.com/journey-to-code-org/open.blog/issues/339)
- Parent story: [#320](https://github.com/journey-to-code-org/open.blog/issues/320)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0249, ADR 0258

## Context

Someone who has never built a web page should understand every label, hint and error, and should never be
stuck on an empty screen. Help must not be a wall, and nothing may nag.

## Decision

- **Primary words are plain.** The builder says "section", "web address" and "picture description", not
  "block", "URL" or "alt text"; a video's `id` is a "video code". Technical terms appear only in the Help
  words, in brackets ("also called a URL"). A test scans every sentence the builder shows (the model's labels,
  hints, samples, messages and starters, the form builders, and the landing view) against a short jargon list.
- **Every problem says what happened and what to do next.** Messages from the checks end with the fix ("Remove
  them, or copy the address again.", "Shorten it by 12.") and the failed-request texts name the next step. A
  test runs a corpus of bad values through the checks and requires a doing word in each and no jargon.
- **Publish says it makes things live.** The button keeps the word Publish (a title says "make your saved page
  live") and the introduction and Help say "Publish (make it live)".
- **An empty page is an invitation.** The empty state points to the ready-made layouts and to Add a section.
- **Help is a short list of words** under "Help: what the words on this page mean" (a native `details`
  disclosure) covering Section, Layout, Hide, Preview, Save, Publish (make it live), Web address and Picture
  description. There is no separate Help screen in Admin yet, so it lives on the page it explains.
- **One tour, three steps, optional.** It is a labelled region in the page, not a modal or a spotlight: Step 1
  of 3 (the page is a list of sections), Step 2 (change a section) and Step 3 (see it, keep it, make it live).
  Next and Back move between steps and put focus on the step's heading, which is described by its text so
  screen readers read it; Skip the tour, Finish the tour and the Escape key close it. It uses plain text only,
  wraps at any width and text size, and has no animation, so reduced motion needs nothing special.
- **Dismissed means gone.** Closing it in any way records that on the device (`ob-landing-tour:<user>`) or,
  when the device will not keep it, for the visit. It is not shown while the starting points or a restore
  offer are on screen, is never shown twice in a visit, and never steals focus when it appears.

## Considered options

- **A modal, spotlight tour.** Rejected: it traps keyboard focus and hides the thing it explains.
- **A Help screen.** Deferred: Admin has no Help screen; a disclosure on the page is closer to the words.
- **Showing the tour again from a button.** Not added, so "never repeats after dismissal" is literal; a
  later story can add "Show the tour" if owners ask.

## Consequences

- New owner-facing text in the landing builder is checked by the jargon test; a new technical word must be
  added to the Help words with a plain explanation or reworded.

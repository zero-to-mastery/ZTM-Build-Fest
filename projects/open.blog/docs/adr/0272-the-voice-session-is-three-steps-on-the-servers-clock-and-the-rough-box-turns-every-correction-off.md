# ADR 0272: The voice session is three steps on the server's clock, and the rough box turns every correction off

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#445](https://github.com/journey-to-code-org/open.blog/issues/445)
- Parent story: [#417](https://github.com/journey-to-code-org/open.blog/issues/417)
- Parent epic: [#408](https://github.com/journey-to-code-org/open.blog/issues/408)
- Builds on: ADR 0266, ADR 0271, ADR 0249 (the landing builder's patterns)

## Context

The reference prototype is one page: three random prompts, a three-minute timer, a rough draft that locks at zero,
and a polished editor pre-filled with the rough text. Admin needs the same flow with open.blog's standards: the
author's words are never rewritten, the clock cannot be gamed, nothing is lost, and it works on a phone.

## Decision

- **A native custom element, no framework.** `<ob-voice-session>` (`web/admin/voice-session.js`) is built with
  the same small DOM builder as the rest of Admin. The pure rules (formatting the clock, the countdown, the
  words for each state) are in `web/admin/voice.js` so a test calls them at an exact second. No dependency.
- **Step one draws; step two writes; step three refines.** The draw shows three prompts as real radio buttons
  (a prompt is chosen, then Start), "Draw three more" asks the server to avoid the ids just shown, and a pack in
  the address (`#/voice?pack=...`) restricts the draw. Private is the default place to keep the sample.
- **The page's clock is a display.** The server returns the time left as a duration. The countdown takes it
  and only ever moves the end sooner: a late answer cannot give time back. Each autosave restates the time left.
  When the clock reaches zero the page locks with the text on screen; the server accepts it only within its
  10 second grace and otherwise locks what it saved. A draft save the server refuses as late becomes a lock, not a
  lost draft. If the page is away and comes back after the deadline, loading the session locks it from the
  saved text on the server (ADR 0271).
- **The rough box refuses every correction.** `spellcheck="false"`, `autocorrect="off"`, `autocapitalize="off"`,
  `autocomplete="off"`, `writingsuggestions="false"` and the attributes that make Grammarly-style extensions keep
  out. This is on the rough textarea only: the polished editor is the author's own text, so the browser's
  spell-check is welcome there. After the lock the rough text is shown in a read-only region (a `div`, not a
  form control), with a sentence that says why. Nothing in the page has a way to edit it, and the server has no
  route that would let it.
- **Autosave is quiet.** The draft goes to the server 1.5 seconds after typing stops, one request at a time, and
  never on every key. A failure shows a plain sentence and tries again after the next pause.
- **Finish early locks at once.** If nothing is written yet, it says so and the clock keeps running (an empty
  rough draft is never created). "Start over" asks first and then scraps the session.
- **The polished editor is pre-filled with the rough text** and a title, and offers "Reset to rough", which asks
  before it replaces anything. Saving creates the polished draft once and then updates it with the revision it
  read. A save that finds a newer draft says so and offers: keep mine and save over it, use the saved one, or keep
  editing. Edits typed while a save is in flight stay unsaved instead of being overwritten by the answer.
- **Voice follows the Assistant module of the layout.** Its tab sits in an "Assistant" group that the Simple
  layout hides like the other optional modules, and is shown on its own page whatever the layout. The
  invitation card (ADR 0277) is how a Simple-layout author finds it.

## Considered options

- **Count down from the local clock.** Rejected: a wrong clock would give or take time.
- **A read-only textarea for the locked rough draft.** Rejected: it is still an editable-looking control, and
  extensions attach to textareas. A plain region cannot be edited by anything.
- **Lock without asking on Finish early.** Kept: it is the prototype's behaviour and the text is already safe.

## What would trigger revisiting this

- Authors wanting a different window than three minutes: the server already takes `timeLimitSeconds`.

## Consequences

- A tab that is closed mid-session resumes with the original deadline from any surface.
- The rough text only ever reaches the screen as text, so it can not carry markup.

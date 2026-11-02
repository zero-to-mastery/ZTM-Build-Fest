# ADR 0275: The voice timer is not live, and the view speaks only its marks and the lock

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#450](https://github.com/journey-to-code-org/open.blog/issues/450)
- Parent story: [#420](https://github.com/journey-to-code-org/open.blog/issues/420)
- Parent epic: [#408](https://github.com/journey-to-code-org/open.blog/issues/408)
- Builds on: ADR 0272, ADR 0251 (the landing builder's phone comfort)

## Context

A timed writing session is easy to make hostile to a screen reader (a clock that is read every second) and to
anyone who is sensitive to motion or colour. A person using a keyboard or a screen reader must be able to finish
a session as comfortably as anyone else.

## Decision

- **The clock is a `role="timer"` with a name and no live region.** The visible digits change every second and
  are not announced. A separate polite live region (`role="status"`), outside the steps so it outlives them,
  speaks only: "1 minute left." and "30 seconds left." as the clock passes those marks, and the lock ("Time is
  up. Your rough draft is locked.", or "Your rough draft is locked." for Finish early).
- **No timer announcement comes within 25 seconds of the last.** A new session says nothing until the one-minute
  mark. A resumed session says where it stands once ("Resumed. 45 seconds left."), and a mark that would follow
  it within 25 seconds is not repeated. The gap is a little under the 30 seconds between the two marks because
  each autosave restates the time left and can only move the end sooner; with a 30 second gap a save between the
  marks silenced "30 seconds left." (amended 2026-10-28). The lock is an event and not a tick, so it is always said once; a test
  runs the whole three minutes second by second and checks the messages and the gaps.
- **Focus goes where the author works next.** Start puts the cursor in the rough box; the lock puts it in the
  polished editor (also when the time runs out); "Draw three more" focuses the first new prompt; starting over
  or another session focuses the new step's heading; the questions that open inline ("Start over", "Reset to
  rough", a conflict) focus their own title, and closing them returns focus to the work or the control they came from.
- **Tab reaches everything in reading order**, with no positive tabindex. The locked rough text is a labelled
  region that can be reached and scrolled by keyboard, and it is not a form control.
- **State is words and a shape, never colour alone.** The timer shows a circle while writing, a triangle and
  "N seconds left" in the last 30 seconds, and a square and "Time is up" after the lock, with a different border
  for each. Prompt and visibility choices are real radio buttons; stage badges carry a word and a shape.
- **Reduced motion.** The only animation is a slow pulse of the warning state's outline, and it exists only
  under `prefers-reduced-motion: no-preference`. Under `reduce`, transitions, animations and scrolling effects
  of the Voice view are off. The script uses no `requestAnimationFrame`, `animate` or smooth scrolling.
- **An axe-style scan** (accessible names, labels, references, duplicate ids, positive tabindex, headings, group
  names) runs on every step of the view in the Admin DOM harness: draw, write, the questions, refine, the
  conflict, the library and its empty state.

## Considered options

- **Announce every ten seconds.** Rejected: too chatty; the author is writing.
- **Make the digits `aria-live="polite"`.** Rejected: a screen reader would read every change.
- **No pulse at all.** Considered; kept because the warning would otherwise be invisible to someone looking at
  the page rather than the digits, and it is off for anyone who asked for less motion.

## What would trigger revisiting this

- Screen reader users asking for a different cadence: the marks are two constants in `voice.js`.

## Consequences

- A person who cannot see the clock still hears when a minute and half a minute are left and when it ends.

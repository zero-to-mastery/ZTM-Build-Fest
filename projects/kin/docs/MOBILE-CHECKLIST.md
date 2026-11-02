# Mobile acceptance checklist (#316)

A manual pass on real devices for the mobile Updates epic (#309). CI covers
the same behaviour in emulation (`scripts/chat-layout-regression.mjs`,
`scripts/undo-regression.mjs` and the Talk later block in
`scripts/chat-regression.mjs`); this list covers what emulation can't: real keyboards, safe areas, installed-PWA
chrome, touch timing and assistive technology.

Record each run in the release's PR: device, OS and browser version, how Kin
was opened (installed PWA or browser tab), and pass/fail per row with a note
for any failure.

## Devices

- [ ] iPhone, installed PWA (Add to Home Screen), current iOS.
- [ ] iPhone, Safari tab.
- [ ] Android phone, installed PWA, current Chrome.
- [ ] iPad with a hardware keyboard, Safari, including Split View.
- [ ] One pass with VoiceOver (iOS) and one with TalkBack (Android).

## Chat fits the screen (#310)

- [ ] Opening Updates → Chat lands on the newest message (or the first
      unread, with "New messages"), never the top of history.
- [ ] Only the message list scrolls; the page itself doesn't move.
- [ ] Tapping the message box: the keyboard opens, the composer sits right
      above it, the bottom bar steps aside, the caret stays visible while
      typing several lines.
- [ ] Closing the keyboard: the bottom bar returns, nothing is left under it.
- [ ] Notch and home indicator: nothing sits under them in portrait or
      landscape.
- [ ] Phone landscape: the header, title and tabs step aside on Chat; the
      composer stays above the keyboard.
- [ ] Scrolling up: Jump to latest appears; it brings you back; a new
      message while scrolled up is announced.
- [ ] Loading older messages keeps your reading position.

## Composer and message actions (#311)

- [ ] The composer is one row: + , message, emoji, Send (Voice while empty).
- [ ] + opens photo, file, camera and poll; each works.
- [ ] A long press on a message opens the bottom sheet; quick reactions are
      first; it doesn't also select text or show the system callout.
- [ ] ⋯ opens the same sheet; a swipe down, the backdrop and (iPad keyboard)
      Escape close it; focus returns to ⋯ with VoiceOver/TalkBack.
- [ ] Copy, Reply, Pin, Edit, Delete and Delete for me work from the sheet.
- [ ] iPad: the sheet is no wider than 480px; with the hardware keyboard,
      Tab reaches every action.
- [ ] A draft survives switching to Handoffs and back.

## Talk later and Updates (#312, #313)

- [ ] Talk later on a message adds it to To talk about; the message shows
      the mark; resolve and reopen work; jumping from the list finds the
      message.
- [ ] Older Talk topics appear in the same list and can be resolved and
      reopened.
- [ ] A member without chat access sees To talk about under Handoffs, with
      only the older topics.
- [ ] Updates shows two tabs, Handoffs and Chat; counts carry words, not only
      colour; the tabs fit on one row at 320px and at 200% text.
- [ ] An old `#updates/talk` link opens the list.

## Delete routine and undo (#314, #315)

- [ ] Delete routine (in the row's ⋯ on a phone) removes it from Routines and
      Today with no confirmation; the toast offers Undo above the bottom bar.
- [ ] Undo brings it back with its schedule and today's completion; Redo on
      the next toast deletes it again.
- [ ] Complete, reopen, archive, plan and pin an item: each toast's Undo
      works, and the change syncs to a second device.
- [ ] iPad keyboard: Cmd+Z undoes and Shift+Cmd+Z redoes outside text fields;
      inside a text field they undo typing only.
- [ ] Locking clears Undo.

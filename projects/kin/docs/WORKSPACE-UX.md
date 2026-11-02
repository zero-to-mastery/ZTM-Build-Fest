# Household Workspace UX — design and implementation contract

**Status:** unversioned UX implementation candidate on `feat/kin-workspace-ux`,
based on `origin/kin-development` at `d27bf48` (the merge of the v0.41.1
attachment patch). Presentation, navigation, and browser-side composition only.
No persistent, transport, cryptographic, or domain-protocol contract changes;
no version number, tag, or release line is created. The record of what was
actually built and verified is at the end of this document.

This document is the contract the implementation follows. Where it says
"must", a browser regression asserts it.

---

## 1. Goal

A returning household member should be able to answer, within a few seconds
and on any screen size:

| Question | Where the answer lives |
| --- | --- |
| What needs attention now? | **Today**: task counts, plans still open from earlier, planned-for-today items, plans coming up, routines due in the current period, handoffs waiting, catch-up |
| Where do things live? | **Lists** (To do · Shopping · Staples), **Routines**, **Updates** (Handoffs · Talk · Chat), **Household** |
| How do I add something? | A capture field at the top of Today and of every list, each fixed to where it lands |
| How do I open its details? | The item text or its `Details` control opens one shared detail view |
| Did it save, and is it syncing? | Inline result next to the capture field; a header status chip for device/sync state |

Kin stays a calm household workspace: five destinations, one list at a time,
no dashboards, no statistics, no draggable widgets, no new domain rules in
JavaScript.

---

## 2. Navigation and route mapping

### 2.1 Primary destinations

Ordered identically on desktop (left rail) and mobile (bottom bar, five equal
tracks):

| # | Label | Route | Contents |
| --- | --- | --- | --- |
| 1 | Today | `#today` | Today composition (§3) |
| 2 | Lists | `#lists/todo` · `#lists/shopping` · `#lists/staples` | One list at a time with its own quick-add |
| 3 | Routines | `#routines` · `#routines/checklists` | Existing routines first; `Add routine` opens creation; reusable checklists in their own segment |
| 4 | Updates | `#updates/handoffs` · `#updates/talk` · `#updates/chat` | Handoffs (acknowledge), Talk (topics to discuss, resolve) and Chat (the household's one chat room, #112) |
| 5 | Household | `#household` and its secondary destinations (§2.3) | Notes & reference, Areas & status, People & devices, Privacy & recovery |

Presentation labels map to unchanged canonical values:

| UI label | Canonical value |
| --- | --- |
| To do | `need` classification (plus legacy `today` items, see §3.2) |
| Shopping | `shopping` |
| Staples | `staple` |
| Updates | the former Handoff page (`kin-handoff-list`, `kin-talk-list`), plus `kin-chat` |
| Household | the former More page |
| Reusable checklists | playbooks (`save-playbook`, `archive-playbook`, `instantiate-playbook`) |

No persisted classification, event kind, or command value is renamed.

### 2.2 Secondary routes and aliases

`web/routes.js` resolves `location.hash` (and `location.pathname`) to a
`{ page, segment, canonical }` record. Unknown hashes resolve to Today.

| Requested | Resolves to | Why |
| --- | --- | --- |
| `#lists` | `#lists/todo` | first list |
| `#handoff` | `#updates/handoffs` | legacy primary destination |
| `#handoff/talk`, `#talk` | `#updates/talk` | legacy tab |
| `#more` | `#household` | legacy primary destination |
| `#search` | `#search` (no primary destination current) | legacy search route; still reachable from the header on every page |
| `/pair` with no hash | `#household/people` | the invitation route must show the join form, not Today |
| `#pair`, `#invite`, `#recover*` | not routes today; resolve to Today | pairing, invitation, and recovery are handled inside People & devices and Privacy & recovery, not by hash |

`history.pushState` is used for in-app navigation; `popstate`/`hashchange`
re-resolve the route, so Back/Forward and refresh land on the same view and
segment. The resolved canonical route is exposed as `kin-app[data-route]`,
the active primary link carries `aria-current="page"`, the active segment link
carries `aria-current="true"`, and `document.title` is `<Page> — Kin`.

### 2.3 Household secondary destinations

| Route | Label | Existing features it holds |
| --- | --- | --- |
| `#household` | Household (hub) | current mode and Pulse at a glance, links to the four destinations, Search, Install |
| `#household/notes` | Notes & reference | `kin-notes`: Notes, household reference records, maintenance history (with attachments) |
| `#household/areas` | Areas & status | `kin-areas`; household mode selector with its routine effect spelled out; `kin-pulse` |
| `#household/people` | People & devices | `kin-household`: create/join/add device, pairing, trusted devices, membership, log out |
| `#household/privacy` | Privacy & recovery | `kin-security` settings: lock, passkey unlock, automatic lock, recovery key, export/restore |

Household mode copy: "Routines pause while the household is in Vacation,
Guests, or Rest. Nothing else changes: lists, handoffs, and access stay as
they are." Pulse stays discoverable from the hub and from Areas & status.

---

## 3. Today: a read-only composition

`web/today-view.js` exports `composeToday({ items, routines, pins, handoffs,
mode, civilDate })`. It filters and groups the Rust projection; it never
derives recurrence, eligibility, or validity. All date comparisons use the
integer civil date (`YYYYMMDD`) that the browser already passes to Rust.

### 3.1 Rule A — Planned for today

Active items whose `planningDate === civilDate`, excluding Staples. Each keeps
its task/shopping identity (shown as a small label). The same canonical record
appears in Lists; completing it in either place completes the same record.

### 3.2 Rule B — Legacy Today items (compatibility)

Items persisted with classification `today` (pre-v0.22 captures and v0.1
legacy events normalised to Today by Rust) are preserved as they are:

- An undated legacy Today item (`planningDate === null`) remains on Today in
  the same "Today" list as planned items.
- An explicit planning date takes precedence: a legacy Today item dated for
  another day leaves the Today list and is listed by its date (Earlier plans
  or Coming up, and its list).
- Legacy Today items are also listed under **To do**, so nothing depends on
  the Today view to be found.
- No event is rewritten and no migration runs. New captures never create a
  `today`-classified item; the Today capture creates a `need` or `shopping`
  item and sets its planning date explicitly.

### 3.3 Rule C — Earlier plans

Active items (not Staples) with `planningDate < civilDate` stay in their lists
and are listed, oldest first, in a visible "Earlier plans" section labelled
"Still open from earlier". It comes first because these are the most
time-sensitive open tasks. No alarm styling, no counts in red, no "overdue",
"late" or "behind".

### 3.3a Rule C2 — Coming up

Active items (not Staples) with `planningDate > civilDate` are listed under
"Coming up", soonest first, after Today. Equal dates keep the Rust projection
order (the sort is stable), so every device shows the same order. A completed
future-dated item is not today's work and leaves Today.

### 3.3b Item summary and actionable rows

When the household has any task or shopping item, an "Item summary"
(visually hidden heading) heads the task sections with counts of items still
open from earlier, planned for today, coming up, and completed from today's
plans. "Items" covers both tasks and shopping items. The completed count is
items planned for today (or undated legacy Today items) whose status is
completed; it is not a count of everything completed on this calendar day. Each count is the length of the list the
same `composeToday` call returned, so a completed task can only be counted as
done and the counts change only when the projection does. Non-zero counts are
native buttons that move focus to their section (the done count opens the
Completed disclosure); zero counts are plain text. The summary sits directly
above the sections at every width, so reading and focus order match the
layout.

Every row completes with one native button through the existing `complete`
command (`reopen` on completed rows). The app-wide busy guard disables every
workspace control, including the summary, while a change saves, so rapid
repeats append one event. A failed local save shows the error with Try again
and leaves the task and counts unchanged. When a completed row leaves its
section (an earlier or coming-up plan), focus moves to the row that took its
place, else the previous row, else the section heading. A completed Today row
keeps focus on its Reopen action.

### 3.4 Rule D — Routines

Routines are shown from the Rust-derived `occurrenceStatus` and
`occurrenceKey` only:

| Cadence | Open occurrence label |
| --- | --- |
| daily | Today |
| weekdays | Today |
| weekly | This week |
| biweekly | This two-week period |
| monthly | This month |

Cadences that share a label share one group, so every-day and every-weekday
tasks sit under a single "Today" heading. Each repeating task has exactly one
row for its current occurrence, never one per future occurrence. The row
reads "Repeats every weekday · Next: Mon, Oct 19"; the next date is the
Rust-derived `nextOn`, formatted only. A **Schedule** button opens that
task's editor on Routines (§5.5).

Completed occurrences are listed under the collapsed Completed disclosure.
`unavailable` occurrences are omitted (an every-weekday task at the weekend).
With nothing due and nothing done the section says "Nothing repeating is due
today."; with no repeating tasks at all it points to Repeat in Quick add. When household mode is not Normal, the
routines section states that occurrences are paused and offers no
complete/reopen actions (Rust rejects them independently).

### 3.5 Rule E — Household context

- Catch up (`kin-catch-up`) stays at the top of Today in compact form.
- Handoffs with status `unacknowledged` are summarised as "N handoffs waiting
  for a Got it" with a link to `#updates/handoffs`. No read receipts.
- Pinned items render in a separate "Quick access" section. A pin implies no
  date or obligation; a pinned item may also appear elsewhere on Today.

### 3.6 Deduplication and completed content

Within the actionable sections (Earlier plans, Today, Coming up) an item
appears at most once. Completed items with today's date, completed legacy Today items,
and completed routine occurrences sit under one collapsed "Completed"
disclosure. Empty states explain the situation without implying anything was
removed:

| State | Today shows |
| --- | --- |
| No projection yet | "Today's tasks aren't available yet…" |
| No tasks at all | "No household tasks yet…" and **Add a task for today** |
| Tasks exist, none today | "Nothing planned for today." with links to To do and Shopping, and **Add a task for today** |
| Everything for today done | "Everything planned for today is done. Completed tasks are listed below." |
| Nothing coming up | "Nothing is planned for the coming days." |

**Add a task for today** opens the universal Quick add (and its
partial-capture recovery) with the Today destination; it is not a second
composer. Focus returns to the button, or to the Today heading if a refresh
has replaced it.

### 3.7 Today capture

The Today capture field offers:

- **What it is**: Task (`need`) or Shopping item (`shopping`).
- **When it matters**: Today (default), Tomorrow, a chosen date, or no date.
- **Quick access**: an optional pin.

Saving uses existing commands in order: `add` (with a client-generated id),
`set-item-planning-date`, `pin`. Partial success is reported truthfully
("Saved to To do. Couldn't set the date — Try again.") and the retry runs only
the remaining operations against the same item id; it never creates a second
item or announces success early.

---

## 4. Responsive layout and the shared detail view

Breakpoints are content-driven, not device names:

| Width | Shell | Opening an item |
| --- | --- | --- |
| < 720 px | fixed bottom navigation, five equal tracks; compact header with Search and Lock | full-height modal sheet (`<dialog>`) |
| 720–1179 px | persistent left navigation; one centred content column (max 720 px) | the detail replaces the list in the content column with a Back control (non-modal) |
| ≥ 1180 px | left navigation; content column; **conditional** detail column (380–440 px) | the detail opens beside the list, which stays visible |

The detail is one element, `<kin-item-detail>`, owned by `<kin-app>`. Layout
changes re-home that same element between the sheet, the inline column, and
the side column. There is never a second copy of the editor, so drafts inside
it (an unsent checklist step, a reminder date/time) survive resizing.

The detail view holds, for one canonical item id: text, kind and status, the
primary action (Complete/Reopen or Add to Shopping), checklist steps and the
add-step form, photos and files (`kin-attachments` in full mode), planned
date, responsibility, Area, reminder on this device, pin, archive, and "Last
changed". Archived or missing records render an explanation and a Close
control instead of actions.

Default rows (`<kin-item>`) show: a restrained complete control, the item text
(a button that opens details), a context line (planned date, responsibility,
Area) when present, "n of m steps" only when steps exist, a compact strip of
attachment thumbnails only when attachments exist, `Add photo`, and `Details`.
Completing and opening are separate controls; clicking text never completes.

---

## 5. State, focus, and draft lifetime

- **Selection** is the item id plus its origin (route and focused control).
  Closing restores focus to the originating row's `Details` control, or to
  the list heading when the row is gone. Escape closes the sheet and the
  inline/side detail.
- **Scroll position** is remembered per route and per list while unlocked and
  restored on return (including returning to Search).
- **Search** keeps its query, filters, and results while unlocked; results
  open the real record by id. Returning (Back) shows the same results.
- **Drafts** (capture text, step text, reminder date/time, note editors)
  stay in unlocked in-memory component state. Checklist drafts are keyed by
  canonical item id, so changing selection, closing details, routing away, or
  resizing cannot move one item's text into another item's editor. Reminder
  edits are also captured against their target item. A background refresh
  re-renders rows and the detail but reapplies the matching draft and keeps
  focus. A successful save clears only the submitted value/revision; failed
  saves keep it for retry. Drafts for temporarily closed details continue to
  block update activation. Lock/session replacement destroys these maps.
- **Lock, logout, teardown, access loss** replace every protected component,
  close the viewer and the detail, forget previews and progress, and clear
  search state, exactly as before. No plaintext goes to `localStorage`,
  `sessionStorage`, URLs, or logs.
- **Stale records**: if the detail's record is archived or missing after a
  refresh, the detail explains that instead of submitting a stale action.
  Existing stale-command protections (error code 4 refresh) are unchanged.
- **Update activation** still refuses while an edit is focused or a draft is
  non-empty; the step and reminder drafts in the detail count as drafts.

### 5.1 Feedback wording

| Situation | Where | Text |
| --- | --- | --- |
| Local save, no sync configured | inline by the capture field | "Saved on this device." |
| Local save, sync configured | inline by the capture field | "Saved here. Waiting to sync." |
| Attachment capture | row status | "Saving photo…" / "<name> is saved on this device" |
| Save failed | inline by the capture field, with Try again | "Couldn't save. Your text is still here." |
| Attachment failed | row status (alert) | "Couldn't add this photo. Try again." plus the specific reason |

The header chip reports only states the app actually knows: "On this device"
(no sync), "Up to date" (sync ready), "Syncing…", "Sync paused", "Offline —
saved here". Relay acceptance is never presented as delivery.

### 5.2 Reminders

`<kin-reminder>` replaces `window.prompt`. It has labelled date and time
inputs, a readable confirmation of the resolved local date and time, Today /
Tomorrow / In 1 hour shortcuts that fill the inputs so the resolved time is
always visible, validation ("Choose a time that hasn't passed yet."), Set and
Cancel, and the explanation "On this device only, while Kin is open in this
browser." The underlying `LocalReminders` model is unchanged.

### 5.3 Keyboard shortcuts and command palette

| Shortcut | Action |
| --- | --- |
| Ctrl + K (Windows, Linux) / Cmd + K (Mac) | Open the command palette |
| N | Quick add a task |
| / | Go to Search and focus its field |
| ? | Show keyboard shortcuts |
| Escape | Close the open dialog, then the item details |

- **Where they work.** Only in the unlocked, rendered workspace. The unlock
  screen, a locked session, and a closing session ignore them, and
  `runWorkspaceCommand` re-checks this before acting.
- **Typing is never hijacked.** N, / and ? do nothing when focus is in a text
  input, textarea, select, contenteditable region, or a text-role element,
  including fields inside open shadow roots (checked through
  `composedPath()` and the deep active element). They also ignore IME
  composition (`isComposing`, key code 229) and auto-repeat.
- **Other dialogs keep their keyboard.** While Quick add, the mobile item
  sheet, or the photo viewer is open, no shortcut runs and the browser keeps
  Ctrl/Cmd+K. Ctrl/Cmd+K works from a text field and over the non-modal
  side or inline details. Escape inside any open dialog closes that dialog
  first, so the details beneath stay open.
- **Browser shortcuts.** Kin calls `preventDefault()` only when it acts. On a
  Mac, Ctrl+K is left alone because text fields use it to delete to the end
  of the line. Alt/AltGr and Shift with Ctrl/Cmd+K are left to the browser.
- **Palette.** `<kin-command-palette>` is a native modal `<dialog>` in light
  DOM that holds the APG combobox-with-listbox pattern. The field keeps focus,
  Up and Down move `aria-activedescendant` (wrapping), Enter runs the active
  command, and Escape, Close, or the backdrop closes it. A polite status
  announces the match count, and an empty result shows "No commands match."
  The commands are a fixed allowlist in `web/keyboard-commands.js`: Go to
  Today, Go to To do, Go to Shopping, Search household, Quick add a task, and
  Keyboard shortcuts. Filtering is local plain-text word matching; the query
  is never stored, logged, or evaluated.
- **Help.** A second modal dialog lists every shortcut, with Windows/Linux and
  Mac modifiers on separate lines. It stacks to one column at narrow widths.
  The palette and the help swap in place, so only one overlay is ever open.
- **Focus.** Opening the palette remembers the focused element. Dismissing it
  restores focus there, or to the current page heading if that element is
  gone. A command runs after the palette has closed. Today focuses its
  heading, To do and Shopping focus their current list link, and Search
  focuses its field. Quick add returns focus to the original element when it
  closes.
- **Lifecycle.** Lock, logout, and household changes call `dismiss()`, which
  closes both dialogs without running a command or restoring focus. A command
  chosen before a lock carries the previous security generation and is
  dropped. Disconnecting the palette closes it and disables commands until it
  is reconnected. The palette persists nothing, and the visible Quick add
  and Search controls advertise their keys through `aria-keyshortcuts`.

### 5.4 Bulk complete, reopen, and undo

- **Where.** To do and Shopping each have a **Select** button. Staples are
  replenished rather than completed, so they have none. Today keeps its
  one-click row completion and has no selection mode.
- **Selection.** Selection mode replaces each row's completion control with a
  native checkbox inside a 48px label named "Select <item>". Details and Add
  photo stay available, so normal navigation is unchanged. The ids live only
  in that list element, keyed by canonical Item id. They are pruned whenever
  the projection changes, so an item that is archived, removed, or moved
  elsewhere drops out. Lock, logout, and household changes replace the
  element, which discards the selection.
- **Select all** selects the eligible rows a person can see: open items, plus
  completed ones only while the Completed disclosure is open.
- **Toolbar.** A labelled group holds a polite count ("2 items selected"), Select
  all, Complete N, Reopen N, Clear selection, and Done selecting. Each action
  appears only when the selection contains items it applies to, and it submits
  only those items.
- **Mutation.** A batch is a sequence of the existing `complete` and `reopen`
  commands, run one at a time through `appendCommand`. Each command is its own
  encrypted IndexedDB transaction, validated by Rust against the full local
  history, and queued for sync like any single change. The busy guard and
  disabled controls block repeated activation. A progress line ("Completing 3
  of 10…") shows during the batch.
- **Partial success.** Batches are not atomic. Committed changes stay
  committed. The outcome counts successes, failures, and skipped items
  separately, for example "3 items completed. 2 could not be completed.".
  Failed items stay selected, and **Try failed items again** retries only
  them. Saving on the device is never described as synced.
- **Undo.** **Undo** issues the inverse existing command (reopen for completed
  items, complete for reopened items) as new events. History is never deleted
  or rewritten. Only items that changed successfully are in the undo set.
  - **Conflict check:** before compensating, undo replays the encrypted log
    afresh. An item is skipped and reported ("changed since then, so it was
    left as it is") unless it is still in the status this device left it in
    and still carries the same Rust-derived `lastChangedAt`.
  - **Atomic status check:** Rust then re-checks the status inside the append
    transaction (see [EVENTS](EVENTS.md), "Item completion and reopening
    preconditions").
  - **Partial undo:** undo can partially fail. **Try undo again** retries only
    the failures.
  - **Lifetime:** undo is available until it runs, until the next bulk action
    or Dismiss, for at most ten minutes, and never across lock, logout, a
    household change, or reload. It is kept in memory only.
- **Concurrency limit.** The domain has no expected-version field. The
  `lastChangedAt` check plus Rust's atomic status check cannot see a change
  that another device authored but that has not yet synced to this one. Such
  a change is ordered by normal sync replay when it arrives. Undo therefore
  never knowingly overwrites a newer change, but it cannot guarantee
  conditional updates across devices.
- **Focus.** After a batch or undo, focus moves to Undo, Try again, or Dismiss.
  A toolbar control that hides while focused hands focus to Select all or
  Select. Lock or session changes discard results from the old session
  without touching the new interface.

### 5.5 Repeating tasks

Repeating tasks are Routines presented as ordinary tasks. Rust owns every
recurrence rule; `web/recurrence.js` only names the values Rust returns and
plans which existing commands a request still needs.

- **Schedules.** Does not repeat (default), Every day, Every weekday, Every
  week, Every two weeks, Every month. There is no custom rule editor.

  | Schedule | Occurrence (Rust `Cadence`) |
  | --- | --- |
  | Every day | Each civil date. |
  | Every weekday | Each Monday–Friday civil date (protocol 24). Saturday and Sunday have no occurrence; Friday's does not carry over. |
  | Every week | The Monday–Sunday week. |
  | Every two weeks | Fourteen-day periods anchored to the creation date. |
  | Every month | The calendar month, keyed by its first day. A task created on the 31st has one occurrence in every month, including February, so no day-of-month clamping exists. |

  Dates are integer civil dates from the browser's local calendar, so a
  daylight-saving day of 23 or 25 hours is still one day.
- **Quick add.** A collapsed **Repeat: Does not repeat** disclosure follows the
  destination line. Title + Enter still creates a one-off task. Choosing a
  schedule updates the summary and the destination line ("Adds a repeating
  task (every weekday). It shows on Today whenever it's due."), which the title
  field is described by. Saving sends one `create-routine` command with a
  client id, so the existing partial-capture recovery treats it like an `add`;
  a retry never creates a second task. Shopping and Staples destinations hide
  Repeat.
- **Completion.** Completing affects only the current occurrence key. Rust
  refuses a completion or reopening of any other key (yesterday's view,
  tomorrow, a weekend day), a second completion of a done occurrence, and any
  change while the household mode is not Normal. Repeating tasks are never
  bulk-selectable, so bulk complete and undo cannot touch an occurrence.
- **Schedule editor.** Each row on Routines has a **Schedule** disclosure: the
  current schedule and next date, a Repeat select, and **Change schedule**.
  **Delete routine** (#314) sits beside Complete, where Archive was, keeping
  the row's tab order; below 720px it lives in the row's ⋯ menu. Routines have no schedule-change event and history is
  never rewritten, so **Change schedule** explicitly starts a new repeating task
  today with the same title (and owner), then stops the old one. Its past
  completions stay with the old schedule, and the current period's done mark
  does not carry over; the editor says so before saving. A failure after the
  new schedule is saved says the old one is still repeating; Try again resumes
  with the same replacement id. A change from a stale view (already stopped)
  is refused with an explanation. **Delete routine** archives the Routine:
  it leaves Routines and Today on every device, past completions stay in
  history. There is no confirmation dialog: the toast offers Undo (#315),
  which creates it again with the same text, schedule, owner and today's
  completion.
- **Feedback.** Polite status messages: "Added. Repeats every weekday; it's on
  Today now.", "Done for this period. Next: tomorrow.", "Schedule changed:
  repeats every week, starting today. Past completions are kept.", "Routine
  deleted. Past completions are kept." Stale actions reuse "That period
  changed. Review the current routine."
- **Concurrency limit.** Two devices that change the same schedule before
  syncing each create a replacement; both remain visible and either can be
  stopped. If the two devices' clocks differ, the later archive of the
  original is quarantined on sync and the device shows the generic
  "could not be applied" notice ([DAILY-UX-HARDENING](DAILY-UX-HARDENING.md)
  F1). Identical completions converge on one occurrence.

### Undo and redo your own recent changes (#315)

- **What.** A session-scoped history of your own changes on this device:
  adding an item or routine, completing and reopening (items and routine
  occurrences), archiving an item, deleting a routine, a planned date, and a
  pin. Text edits are left to the field's own undo. Chat, membership and
  security actions are never recorded. Bulk complete and reopen keep their own
  Undo on the bulk bar.
- **How.** After a change, a toast in the feedback area shows the
  confirmation beside **Undo** and a dismiss button. It stays until the next
  action or until dismissed; it never times out (WCAG 2.2.1). After an undo
  it offers **Redo**, the touch path for redo. On keyboards, Ctrl/Cmd+Z undoes
  and Shift+Ctrl/Cmd+Z or Ctrl+Y redoes, only when focus is not in a text
  field and no dialog is open; native text undo is never taken over. On a
  phone the toast sits above the bottom bar (and above the chat composer).
- **History is never rewritten.** Each undo or redo appends ordinary
  household commands that sync like any change (`web/undo.js`): reopen after
  complete, the previous date, unpin after pin, archive after add. Archive is
  terminal, so undoing an archive or a routine deletion creates it again
  under a new id: an item with its text, list, date, area, pin, owner and
  steps; a routine with its text, schedule, owner and today's completion. The
  original stays archived in history; attachments stay with it.
- **Refusal.** Before running, the entry is checked against the current
  projection. If the thing changed since (for example another member completed
  it or moved its date), or is gone, nothing is changed and Kin says so in
  plain words. A run that fails partway goes back on the stack and Try again
  resumes it.
- **Lifetime.** Kept in memory only (up to 20 each way); locking clears it.
  Nothing about it is persisted or synced.

---

## 6. Acceptance tests

Browser (`scripts/workspace-ux-regression.mjs`, run by
`scripts/browser-regression.mjs`; CDP-driven viewport checks live in the
runner):

1. Add a task in To do; it is listed there and found by Search.
2. Add a shopping item; it stays a shopping item.
3. Plan that shopping item for today; Today shows the same canonical item.
4. Complete it from Today; Shopping shows it completed (and the reverse).
5. A synthetic legacy `today` event stays on Today undated and in To do; no
   event bytes change.
6. A future-dated item is listed under Coming up, not as today's work.
7. An earlier-dated item appears under Earlier plans; paused routines show
   no occurrence actions.
8. Open and close details without losing scroll position or an unsent step
   draft.
9. Search for an item, a checklist step, and a note; each opens its target.
10. Back returns to Search with the query, filters, and results intact.
11. Attachment picker lifecycle survives re-render, route change, details,
    and lock (existing `attachment-upload-regression.mjs`, updated).
12. Lock during details/search/viewer: protected content is gone.
13. Set and cancel a routine reminder through the date/time control.
14. Offline saves and an injected failure produce truthful inline feedback.
15. Back/forward and legacy routes (`#more`, `#handoff`, `#search`,
    `#lists`) resolve.
16. Resize 360 → 768 → 1024 → 1440 → 1920 with details open: one editor, the
    draft intact, five equal nav tracks on mobile.
17. Keep separate unsaved checklist text on A and B while switching, closing,
    routing, and resizing; returning restores the target's own draft. Saving
    clears the submitted step, and an empty Enter adds no duplicate.
18. A delayed save or failure for A completes with B selected without
    clearing B or showing A's error on B. Returning to A restores its retry.
    Phone-sheet checklist and planning-date failures keep the draft and a
    usable in-sheet retry through rerenders.
19. Add and Enter resume a partially saved capture's canonical id. Editing
    that pending capture presents explicit Finish saved item / Start a new
    item choices, and finishing preserves newer text.
20. Real keyboard Escape closes the photo viewer first on desktop and above
    the mobile sheet, including after rerender; the next Escape closes details.

Node (`node --test`): `web/today-view.test.mjs` (rules A–E, dedupe,
completed, mode), `web/routes.test.mjs` (aliases, segments, `/pair`),
`web/reminder-time.test.mjs` (validation, formatting, shortcuts),
`web/capture-plan.test.mjs` (remaining steps after partial success).

Screenshots are written to `target/ux-screenshots/` (ignored) for Today,
Shopping, and an open item at 360, 390, 768, 1024, 1440, and 1920 px, in
light and dark, populated and empty, and with a failed save.

### Known boundaries

- Headless Chromium-family automation only. Installed-PWA, physical camera,
  Safari/Firefox, and real assistive technology are not exercised.
- No usability study with real people was performed; §1 is the design
  intent, not a measured outcome.
- Sync "Up to date" reflects the coordinator's last state, not recipient
  delivery or reading.
- Reminders remain browser-local and foreground-only.

---

## 7. Implementation record

Implemented on `feat/kin-workspace-ux` from `origin/kin-development` at
`d27bf48`, uncommitted. Every change is under `projects/kin/`; version
numbers (`0.41.1`), tags, Rust sources, the WASM ABI, storage, sync, server,
and cryptography are untouched.

### What was built

| Area | Files |
| --- | --- |
| Routes and shell | `web/routes.js` (+test), `web/components/kin-app.js` (header tools, five destinations, segments, Household hub and sub-pages, detail hosting, scroll memory, search-result routing, sync chip), `web/components/kin-segment-nav.js`, `web/components/kin-sync-status.js`, `web/styles/app.css` |
| Today composition | `web/today-view.js` (+test), `web/components/kin-today.js` (Today view and one-list-at-a-time views), `web/components/kin-compose.js` (Today capture: kind, plan, pin; inline results), `web/capture-plan.js` (+test) |
| Rows and details | `web/components/kin-item.js` (simplified row), `web/components/kin-item-detail.js` (shared detail, re-homed by `<kin-app>`), `web/components/kin-attachments.js` (`compact` mode) |
| Routines and reminders | `web/components/kin-routines.js`, `web/components/kin-reminder.js`, `web/reminder-time.js` (+test), `web/household-validation.js` (checklist wording) |
| Search | `web/components/kin-search.js` (actionable results, safe highlighting), `web/search.js` (label) |
| Updates, notes | `web/components/kin-handoff-list.js`, `kin-talk-list.js`, `kin-notes.js` (record ids for reveal, wording) |
| Offline shell | `web/service-worker.js` (new modules in the precache list; the cache name already derives from the served shell fingerprint) |
| Tests | `scripts/workspace-ux-regression.mjs` (new), `scripts/workspace-screenshots.mjs` (new, evidence only), updated `browser-regression.mjs`, `mobile-ux-regression.mjs`, `attachment-upload-regression.mjs`, `shopping-regression.mjs`, `planning-date-regression.mjs`, `routine-regression.mjs`, `passkey-regression.mjs`, `security-ui-regression.mjs`, `household-authority-regression.mjs`, `catch-up-regression.mjs`, `handoff-regression.mjs`; Node tests under `web/` |
| Docs | this contract, `UX.md`, `COMPONENTS.md`, `ACCESSIBILITY.md`, `TESTING.md`, `README.md`, `CHANGELOG.md`, `AGENTS.md` |

### Decisions worth knowing

- The former "today" classification is never written by new captures. It
  remains a valid canonical value that Rust accepts and replays; the UI
  treats it as "undated legacy Today item" (§3.2).
- Search marks no primary destination; it is reachable from the header on
  every page and from the Household overview, so no sixth tab was added.
- Secondary destinations are hash routes, not in-page tabs, so Back/Forward
  and refresh work and the selected segment is identifiable.
- The detail view is hosted by `<kin-app>` rather than inside `<kin-today>`
  so one instance can serve Today and every list and be re-homed on resize.
- Capture and app-wide errors use the existing global status/alert region.
  A checklist or planning-date failure is instead announced beside the
  selected detail editor, with its retry button in that same presentation.
  This keeps mobile retries inside the active modal and avoids duplicate
  announcements. The detail retains that feedback across unrelated renders;
  success clears it.
- The open photo viewer owns Escape while it is the top modal layer. Its
  native close releases the preview URL and restores focus to the equivalent
  viewer control after a rerender; a later Escape can close the underlying
  detail or sheet.
- Routine rows on the Routines page keep responsibility and the reminder
  control inline (no routine detail view was added); on Today a routine row
  only shows its period and a complete control.
- Three latent defects were fixed because the new coverage hit them:
  `LocalReminders` threw "Illegal invocation" in browsers (unbound
  `setTimeout`), so reminders never scheduled from the UI; cached thumbnails
  were skipped while a tile was still being built; and a row rebuilt while
  the viewer was open lost focus on close. Capture ids are hex strings so a
  partial-save retry can find its record.

### Historical implementation verification

Run on 2026-10-13 (Windows 11, Node 22.13.0 via `fnm exec`, pinned Rust
toolchain, headless Edge 155) from `projects/kin`:

| Command | Outcome |
| --- | --- |
| `node scripts/verify.mjs --browser "<edge>"` (the `verify:browser` gate) | PASS, exit 0: environment; Rust format; Clippy (warnings denied); version consistency (`0.41.1` unchanged); Kin diff whitespace; 51 Node test files / 473 tests; 173 Rust tests; release wasm32 build matching the local browser asset; browser regression (37 suites, including the new workspace journeys with 88 checks and the responsive checks with 10); security storage (4); security UI (149); passkey (67, PRF exercised); household authority (103) |
| `node scripts/workspace-screenshots.mjs "<edge>"` | PASS: 22 screenshots in `target/ux-screenshots/` (360/390/768/1024/1440/1920, light and dark, empty, populated, failed save, offline) plus `regression-*.png` from the gate |
| `python scripts/check_version.py`, `git diff --check -- projects/kin` | PASS |

Not run: `scripts/verify.test.mjs` (the runner's self-test; two of its cases
fail on this machine on an untouched checkout, as recorded for v0.41.1).
During development two intermittent gate failures were traced to real timing
defects and fixed (cached thumbnail application before connection; focus
return after a row rebuild); one Handoff retry step was made tolerant of a
background refresh that can start between its wait and its click.

### Not done / boundaries

- No real-device, installed-PWA, Safari/Firefox, or assistive-technology
  session was run; headless Chromium-family automation only.
- No usability study with real household members.
- Routine rows did not get their own detail view; their inline controls were
  tidied instead.
- The Talk and Handoff capture forms keep their existing single-field layout
  and byte limits (wording only changed).

## 8. PR #42 correctness remediation

This remediation starts from PR branch `feat/kin-workspace-ux` at
`c6adca29e4855defa736c7163dc98b1571a884b4`, the reviewed baseline.
Verification in this section covers the current uncommitted working-tree
patch; it is not a CI result. It adds item-keyed transient checklist/reminder
drafts, clears only matching successful checklist submissions, preserves
partial capture ids across Add/form submission, offers an explicit choice
when a pending capture was edited, puts detail save errors and retry beside
the active editor, and assigns Escape to the topmost photo viewer. No event,
storage, version, WASM, or security contract changed.

Fresh remediation verification (2026-10-13, Windows 11, Node 22.13.0, pinned
Rust 1.93.0, headless Edge 155) covers the uncommitted working-tree patch:

| Command | Outcome |
| --- | --- |
| `npm --prefix projects/kin run verify` | PASS, exit 0: environment, formatting, Clippy, version consistency, whitespace, 51 Node test files / 473 tests, 173 Rust tests, release WASM build |
| `npm --prefix projects/kin run verify:browser -- "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"` | PASS, exit 0: full verification plus browser, security storage, security UI, passkey, and household authority suites |

For this machine, Node 22.13.0 was placed first on `PATH` before invoking
these npm commands. Browser coverage reports 110 workspace journey checks,
15 responsive checks, and 31 phone attachment/viewer checks. The security
sub-gates report 4 storage, 149 security UI, 67 passkey, and 103 household
authority assertions. The release WASM build matched the local browser asset;
no committed expected WASM artifact exists. Version remains `0.41.1`.

Screenshots are under `target/ux-screenshots/`, including
`regression-360-detail-step-error.png`,
`regression-360-detail-date-error.png`,
`regression-viewer-escape-mobile-preserved.png`,
`regression-viewer-escape-desktop-preserved.png`, and the responsive
`regression-*.png` set. The first remediation browser run exposed focus
returning to a thumbnail in the inert background after a detail rerender; the
fallback now prefers the equivalent control inside the active detail. The
final full gate passed after this correction. `scripts/verify.test.mjs` was
not run, and no fresh CI result is claimed. The PR API could not be reached
from this environment, so remote PR metadata was not independently queried.
Physical camera, installed-PWA, Safari/Firefox, and real assistive technology
are outside this headless Edge run.

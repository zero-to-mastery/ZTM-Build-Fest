# Kin Daily UX Hardening (PR 07)

Release-readiness audit of the Daily UX line (#47 Quick add, #48 partial
capture, #49 security UI, #50 actionable Today, #51 keyboard commands, #52
bulk actions, #53 repeating tasks and protocol 24). This is a hardening
change: it fixes confirmed defects and adds regressions, and adds no feature,
protocol, store or dependency.

Base: `origin/kin-development` at `087c537` (the merge of #53).

## 1. What was audited

| Area | Scope |
| --- | --- |
| Daily journeys | Quick add durability and partial recovery; Today completion, details and focus; palette navigation; bulk complete, undo, partial failure and retry; repeating-task creation, completion and schedule change; lock and unlock |
| Offline | shell caching, offline unlock, local Quick add, reload replay, at-rest encryption, offline bulk undo, offline-cached household appearance |
| Sync and concurrency | duplicate delivery, concurrent completion, concurrent schedule changes, remote-batch failure handling, protocol 24 |
| Session isolation | every `await` in Quick add, completion, bulk, undo, schedule change, reminders and household-settings flows, checked against lock, logout and household re-open |
| Accessibility | names, headings, dialogs, nested Escape, palette combobox, live regions, forced colors, reduced motion |
| Responsive | 320, 375, 768 and 1280 px |
| Service worker | cached path allowlist, complete import graph, release-scoped caches, no API caching |

Every `await` in those flows was compared with the app's session guard
(`captureSession` / `isCurrentSession` in `kin-app.js`). The guard compares
the security generation, the vault and its lock state, the store and the
engine.

## 2. Confirmed defects and fixes

Each fix below has a regression that **fails on the unfixed base and passes
with the fix**. This was checked by running the new browser suite against a
worktree of `087c537`.

| # | Severity | Defect | Fix |
| --- | --- | --- | --- |
| D1 | High (privacy) | **Routine reminders survived lock.** Lock never cancelled local reminder timers, and `LocalReminders.cancelAll` had no callers. A `routine:*` reminder's delivery check was always true. So a reminder set before lock showed an OS notification with the decrypted routine title while Kin was locked. On base, the suite observed a second notification after lock. | **Lock suspends reminders.** Every timer stops and every title and closure is dropped; only `{ id, at, vaultId }` stays in memory. **Unlocking the same vault resumes them** once the fresh state loads, using the record's current title. A reminder that came due while locked fires once; one whose record is gone or archived is dropped. Resuming never prompts for permission, and without granted permission reminders stay suspended. **Another vault's reminders are discarded.** Logout, leaving or deleting the household, an element disconnect and restore clear reminders for good. Delivery also requires a live session and record. Review follow-up: the first version cancelled reminders on lock, so any lock, including auto-lock, silently deleted them. |
| D2 | Medium | **A notification-permission prompt answered after lock** registered the reminder and replaced "Household locked." with "Reminder set on this device…". `handleLocalReminder` had no session capture. | Capture the session. `schedule` arms nothing once its record is no longer current. Review follow-up: the stale path cancels by attempt token, so it can never cancel a newer reminder that the next session set for the same item. Before this follow-up it cancelled by id. |
| D3 | Medium (privacy) | **Household settings settling after lock wrote into the locked header.** `refreshHouseholdDefaults` awaited the network and IndexedDB without a session check. A late success put the decrypted household name in the locked header. On base the suite saw `brand: "Secret Household Name"`. A late failure replaced "Household locked." with an appearance error. `handleSaveHouseholdDefaults` had the same gap. | Assert the session after the load and the save. Gate the error status on the session too. Review follow-up: the save's `catch` also checks the session before calling the editor's `complete`. Previously a save settling after lock or a household re-open (including the stale-session assert itself) still reported to the editor, and a re-open keeps that editor for the new session. |
| D4 | Medium (data) | **A lock between the two schedule-change commands created a duplicate repeating task on retry.** The change is create-replacement, then archive-original. Lock cleared the in-memory resume token. After unlock, choosing the same schedule minted a new replacement id, which left the original archived and **two weekly replacements active**. This was observed on base. | The resume token holds only random ids and a cadence. It now survives lock, bound to the vault that created it, so unlocking the same vault resumes the change. A different vault never sees it. |
| D5 | Medium (a11y) | **The phone-width Quick add trigger was named "AddQuick add".** CSS generated content (`::before { content: "Add" }`) joined the accessible name. This was confirmed in Edge's accessibility tree. | `content: "Add" / ""` gives the decorative label empty alt text. A plain `content: "Add"` fallback is declared first for engines without the syntax. |
| D6 | Low (a11y) | **The repeating-task Schedule and Repeat disclosures had no open/closed marker.** Only accent color showed the state, and forced colors removes it. | Both join the existing chevron rule, which draws with `currentColor` and rotates on `[open]`. |
| D7 | Low (a11y) | **A bulk outcome could go unspoken.** Focus moves to Undo or Retry as the polite result appears, and those buttons did not reference the result text. | Undo, Try again and Dismiss are `aria-describedby` the outcome message. Its id is unique per list. |

Production files changed: `web/components/kin-app.js` (D1–D4),
`web/components/kin-today.js` (D7) and `web/styles/app.css` (D5, D6).

## 3. Regression coverage added

### Browser: `scripts/daily-ux-hardening-regression.mjs` (53 checks)

This suite runs inside `browser-regression.mjs` after the repeating-tasks
suite. It uses the real encrypted store and the WASM engine.

- **Example 1.** Offline Quick add creates exactly one task. No IndexedDB
  store, Web Storage entry or Cache Storage response contains the title as
  text or UTF-8 bytes, and no `/api/` response is cached. After a reload, an
  offline unlock replays the task once, still planned for today, with one
  Today row.
- **Example 3.** Lock while Quick add's encrypted write is held open. The
  settling write cannot reveal the title, announce success, raise an alert or
  reopen the dialog. After unlock the task exists at most once, and no stale
  recovery prompt appears.
- **D4.** The archive step of a schedule change is held, and the lock then
  makes it fail. Afterwards the replacement is durable and the original still
  repeats. Retrying after unlock gives one weekly replacement, with the
  original stopped.
- **D1/D2 reminders across lock.**
  - A lock suspends a reminder as `{ id, at, vaultId }` only: no timer, no
    title, no closure.
  - Unlocking the same vault re-arms the reminder. Its Routines row shows the
    same time as before the lock, and it fires at that time.
  - A reminder that comes due while locked stays silent, then fires once
    after unlock.
  - Auto-lock suspends and restores in the same way.
  - When a second tab archives the item while this tab is locked, the
    reminder never fires.
  - Reminders tagged for another vault are discarded. One origin holds one
    vault, so a replaced vault is simulated by re-tagging the suspended entry;
    `web/reminders.test.mjs` covers the mismatch directly.
  - Logout restores and fires nothing.
  - A permission prompt answered after lock registers nothing.
  - A stale permission answer leaves the new session's reminder for the same
    item intact.
  - `web/reminders.test.mjs` adds unit tests for suspend, resume, overdue,
    skip, vault mismatch, permission, `clearAll` and the token-guarded cancel.
- **D3.** A household-settings load that resolves, or rejects, after lock
  leaves the locked brand, title and status untouched.
- **D3 save path.** These checks drive the real editor's Save button against
  a deferred save.
  - A save that resolves or rejects after lock, or after a household re-open,
    never calls the old completion, and nothing reaches the locked or new
    view.
  - A failure in the current session reports through the editor's live status
    and leaves Save available to retry.
  - The retried save completes once and applies the saved name.
- **D5.** Accessible name, read from the CDP accessibility tree at 375px.
- **D6.** Disclosure markers, with forced colors off and on.
- **D7.** Bulk outcome descriptions.
- **Palette opener removed.** The palette's opener is removed before Escape.
  Focus falls back to a connected, visible heading, and N still opens Quick add
  afterwards. This was an audit coverage gap; the behaviour was already
  correct.
- **Responsive.** At 320, 375, 768 and 1280px, Today and Routines do not
  scroll sideways. A 130-character unbroken title wraps inside its row. The
  Quick add dialog and the palette fit the viewport, and Quick add targets are
  at least 44px.
- **Performance and cleanup.** The suite records the samples in section 5 and
  checks that daily flows leave no object URL unrevoked.

### Rust: `rust/src/recurring_task_tests.rs` (3 tests)

- `concurrent_schedule_changes_at_one_logical_time_keep_both_replacements_in_any_order`
- `concurrent_schedule_changes_at_different_logical_times_reject_the_merge_in_any_order`
- `weekdays_skip_the_weekend_across_both_daylight_saving_transitions`. This
  test covers Example 4 for Weekdays. The US weekends of 2026-03-08 and
  2026-11-01 neither add nor drop a weekday, because keys are civil dates.
  Daily and weekly DST keys were already covered in `web/wasm/routines.test.mjs`.

### Real-WASM storage: `web/storage/remote-replay.test.mjs` (2 tests)

- **An unreadable or unsupported remote event stops the batch.** Engine code
  2 (unreadable) or 3 (unsupported) stops the remote batch instead of being
  quarantined. Quarantining would advance the sync cursor past history that
  the engine never applied. Before this test, only the caller's ordering
  (metadata validation first) protected that, and no test pinned it.
- **Concurrent schedule changes through `reconcileRemoteEvents`.** Equal
  clocks give zero quarantined events and both replacements active. A later
  clock quarantines exactly one archive. Both results are the same in either
  delivery order.

### Already covered: verified, not duplicated

- **Example 2:** bulk undo while the event-log read fails.
  `bulk-actions-regression.mjs` covers the fail-closed read, no compensating
  command, and keeping the result for retry.
- **Lock or logout during a bulk batch or undo:** `bulk-actions-regression.mjs`.
- **Today completion during lock or household re-open:**
  `today-actionable-regression.mjs`.
- **Example 6:** palette → help → back → Escape, and Escape over item details.
  `keyboard-commands-regression.mjs`.
- **Locked shortcuts and a palette command chosen just before lock:**
  `keyboard-commands-regression.mjs`.
- **Duplicate delivery and concurrent occurrence completion:** Rust
  `synchronized_duplicates_…`, `server/sync-e2e.test.mjs` and
  `remote-replay.test.mjs`.
- **Service worker shell:** `web/service-worker.test.mjs` walks the full static
  import graph from `kin-app.js`. The audit found no dynamic `import()` and no
  CSS `@import`.

## 4. Verification

### Environment

| | |
| --- | --- |
| OS | Windows 11 Home 10.0.26300, x64 |
| Node | 22.13.0 (via fnm; the declared minimum) |
| Rust | rustc 1.93.0 (254b59607 2026-01-19), cargo 1.93.0, pinned toolchain, `wasm32-unknown-unknown` |
| Browser | Microsoft Edge 155.0.4283.45, headless (`--headless=new`) |
| WASM | local release build, SHA-256 `e46bab4b…f1b8908`, identical to `web/wasm/kin_engine.wasm` |

### Results

`node scripts/verify.mjs --browser "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"`
(`npm run verify:browser` with the browser path; on this machine it is run
through `fnm exec --using v22.13.0`). Exit status 0, in 320.6 s:

| Stage | Result |
| --- | --- |
| A Environment | PASS |
| B Static | PASS: `cargo fmt`, Clippy, version consistency, diff whitespace |
| C Unit and integration | PASS: 569 Node tests in 61 files (base 567); 189 Rust tests (base 186) |
| D WASM | PASS: the release build matches `web/wasm/kin_engine.wasm` |
| E Browser | PASS: browser regression (all suites, including the new one), security storage (4), security UI (149), passkey (71), household authority (103) |

**Base comparison.** On untouched `087c537`, Node and Rust passed (567 and
186 tests). The first base browser run failed with a 30 s CDP timeout inside
the 10,000-event bounded-history step. Three audit processes were loading the
machine at the time. Re-run alone from a clean worktree of the base, the same
runner passed. That step is unrelated to Daily UX and was not changed.

The new suite's negative control: run against the base `web/`, D1–D7 fail as
described in section 2, and every other check passes.

## 5. Performance

These are diagnostic samples, not budgets, the same as
[DAILY-UX-BASELINE](DAILY-UX-BASELINE.md). They come from one headless Edge
run on the machine above, with the synthetic regression household. Times run
from user action to the app's idle projected state through the real encrypted
store and WASM.

Two runs are shown. **Isolated** is the suite alone on a freshly established
household with 17 items. **In gate** is the same suite late in the full
browser runner, after earlier suites have built a household of 143 items and
a much longer event log. Times are in ms.

| Measure | Samples | Isolated median / p95 | In gate median / p95 |
| --- | --- | --- | --- |
| Quick add: submit to committed and idle | 15 | 60.4 / 68.9 | 349.0 / 400.9 |
| Today render (`today.update`, all items) | 25 | 5.8 / 9.9 | 22.9 / 37.8 |
| Replay and render from the encrypted log (includes recurrence projection) | 15 | 46.3 / 88.3 | 195.5 / 222.7 |
| Palette open and filter, to next frame | 15 | 12.5 / 16.3 | 17.5 / 22.0 |
| Bulk complete, 10 items | 3 | 228.7 / 317.6 (22.9 per item) | 897.6 / 1009.1 (89.8 per item) |
| Bulk complete, 50 items | 2 | 1712 / 2871 (34.2 per item) | 5143 / 6129 (102.9 per item) |
| Startup: reload to shell | 1 | 133 | 171 |
| Startup: reload to unlocked and ready, incl. recovery-secret KDF | 1 | 548 | 927 |

- With 2 or 3 samples, the bulk p95 is the maximum.
- Startup is a single sample per run.
- The JS heap after GC went from 4.9 to 5.4 MB across the in-gate measurement
  loops.
- No object URLs were created or left unrevoked by the daily flows.

**Against the PR 01 baseline** (76.2 ms create, 53.9 ms complete, 25-item bulk
at 61.7 ms per item):

- **Isolated:** Quick add commit and bulk per-item cost are at or below the
  baseline.
- **In gate:** costs rise with the length of the event log. Each command is
  validated by replaying the household's history in Rust, so a bulk batch is
  roughly O(items × history). The same run's PR 52 sample (25 items) was 55.3
  ms per item, which matches its own baseline. This is the existing
  architecture, not a regression in this line.

No measurement showed a material problem against the PR 01 baseline, so no
performance code changed.

## 6. Known limitations and follow-ups

### F1: concurrent schedule changes (PR 53 limitation, characterised)

A schedule change is create-replacement plus archive-original. There is no
supersession record. When two devices change one Routine before syncing:

- **Equal logical times** (both devices were at the same clock): both archives
  are accepted. The original is archived and **both replacements stay active**.
  The result is the same on every device and in every delivery order. No
  history is lost.
- **Different logical times:** the later archive, from a different device, of
  an already-archived Routine is a recorded no-op. A full replay returns Ok,
  nothing is quarantined, and both replacements stay active. A device
  archiving a Routine it already archived itself stays invalid.

There is still no supersession record. Two offline schedule changes leave both
replacement Routines active.

### F2: protocol 24 and already-shipped clients

- **How Weekdays is identified.** Weekdays is the existing `RoutineCreated`
  event (kind 14, event version 1) with cadence byte 4. The current engine
  answers `UnsupportedVersion` (code 3) for any request below protocol 24, and
  the tests pin that.
- **What a shipped v23 engine does instead.** It fails on the unknown cadence
  byte and reports `MalformedProtocol` (code 2). The failure is safe:
  - metadata validation throws before the store is touched;
  - the cursor does not advance;
  - nothing is quarantined or partially applied;
  - sync retries.

  The sync chip says the event could not be read instead of giving upgrade
  guidance. Every later event waits behind it until the client updates.
- **Service worker updates.** They deliver the new engine as one complete
  release-scoped shell.

This cannot be changed in clients that have already shipped. For the next
protocol addition, give new payload variants an explicit event version or a
new event kind, so that older engines map them to code 3, and add a "needs a
newer Kin" sync state. Protocol versioning was not changed here.

### F3: accessibility follow-ups (not fixed, design-level)

- **Visual order and focus order differ on wide Today.** At 960px and wider,
  the grid places Quick access, Routines and Updates above the agenda, but DOM
  and focus order put them after it (`app.css` grid areas versus
  `kin-today.js` render order). Fixing this means choosing one order for both.
- **Select and routine toggles change their label as well as `aria-pressed`.**
  For example, a screen reader hears "Done selecting, pressed". Pick one: a
  stable label with a pressed state, or a changing label without one.
- **Quick add's message changes role at the moment its text arrives.** The
  message switches between `alert` and `status` in the same update, which some
  screen readers do not announce. This only affects the success text after
  "Finish previous task". Separate status and alert regions would fix it.
  Several suites assert on the current element, so this was left for a
  focused change.
- **The browser cannot certify announcement quality.** NVDA and VoiceOver
  checks remain manual (see the baseline's known gaps).

### F4: other notes

- **Quick add partial capture lost on lock.** A lock between Quick add's
  create step and its date/pin step drops the recovery prompt, because
  recovery state and the draft are cleared on purpose. After unlock, the task
  exists without its Today date. No duplicate is possible, because the draft
  is gone too.
- **Synchronizing after reconnection.** The browser fixture has no relay. This
  is covered by `server/sync-e2e.test.mjs` (offline completions re-pushed
  through the encrypted relay) and by the household-authority browser drill.
- **Offline shell delivery.** Covered by the security UI suite. The new
  offline Quick add check reloads through the shell, then unlocks and replays
  with the network off.

- **Replay cost grows with history.** This is a scale follow-up, not a Daily
  UX defect. Bulk and Quick add latency grow with the length of the event
  log, about 100 ms per item at the gate's synthetic history. If real
  households reach that size, consider incremental validation (append-time
  checks against the current projection) instead of full replay per command.
  That is a domain-engine change and was not attempted here.

# Testing Contracts

Member-versus-device onboarding, push-recipient expectations and the required
platform/migration evidence are defined in
[Member and Device Identity Acceptance](IDENTITY-PAIRING-ACCEPTANCE.md).
`scripts/identity-docs.test.mjs` keeps the security, copy and matrix contracts
linked from every affected document. Automation does not certify physical
mobile cameras, vendor push delivery, assistive technology or comprehension;
those rows require named manual release evidence.

## Refactor track gates

- **Projection-equivalence oracle.** `projectionOracle` in
  `scripts/event-arena-regression.mjs` compares the projection bytes a store's
  cached history produces with a fresh full read (native IndexedDB, decrypt of
  every row) and full replay, for the same events, `as_of`, civil date, cursor
  and identity. Any cached or incremental history path must pass it. The
  storage runner exercises it across unlock, local appends, a second
  connection's appends (checking that only rows after the tail are decrypted),
  a non-append rewrite detected through the store generation (with a negative
  control that shows the oracle fails without the bump), out-of-order
  synchronized events, restore, root rotation and lock. `browser-regression.mjs`
  runs `eventArenaPeerRegressions`: two real tabs, where the peer tab decrypts
  exactly one row for one new event and matches the oracle.
- **Protocol-24 golden fixtures.** `rust/src/golden_tests.rs` builds five
  scenarios through the command path (empty, a household using every command
  kind, bound pre-sync history with two diverging devices, an expired Pulse in
  a paused mode, and 400 bulk Items) and freezes the complete KINE request and
  the KINS projection under `rust/fixtures/golden/`. `web/wasm/golden.test.mjs`
  replays the same requests through the release WASM. Regenerate only
  deliberately with `KIN_UPDATE_GOLDEN=1 cargo test golden`.
- **Protocol 24.** `rust/src/request_tests.rs` (framing, bindings, ordering,
  bounds), `event_decode_tests.rs` (every kind's payload rules, Handoff and
  Talk lifecycles) and `state_encode_tests.rs` (projection layout and limits)
  replace the per-version protocol tests. `web/wasm/projection-decode.test.mjs`
  checks that the bridge fails closed on every truncation of a golden
  projection, on trailing bytes, on invalid header fields and on a section
  table that does not cover the body.
- **Server hygiene (Slice 10).** `server/http-body.test.mjs` checks that a
  declared length over the limit is answered with 413 before any body byte
  is sent, that a chunked body is refused once it passes the limit, and that
  `/api/sync/events` refuses JSON (415) and malformed batches (400).
  `web/sync/envelope-wire.test.mjs` round-trips real encrypted envelopes and
  pull pages exactly and refuses every truncation and non-canonical input.
  Server tests write push bodies as `{ events }` and read pull pages as
  objects through `server/sync-wire-test-utils.mjs`. The server module
  splits are pure moves: the server suite is unchanged.
- **Streaming archives (Slice 9).** `web/security/archive-stream.test.mjs`
  round-trips histories of 0, 1, 256, 257 and 517 events exactly and refuses
  a changed byte in any segment, a dropped, repeated or swapped segment,
  wrong counts and a too-short length; the archive key must depend on the
  root, salt and metadata. `archive.rs` checks that the held-history import
  plan equals the whole-request plan for every golden fixture.
  `security-ui-regression.mjs` opens a package-format-3 export, checks that a
  package-format-2 export from v0.47 still validates, and tampers with the
  manifest. `history-mirror.test.mjs` checks that a whole history goes to the
  engine in bounded batches.
- **Test hook (Slice 8).** Browser scripts reach the application through
  `document.querySelector("kin-app").ctx`, the controller context
  (COMPONENTS.md). There are no element methods for tests to call or replace;
  replace a controller method on `app.ctx.<key>` and restore it afterwards.
- **Reading events in place (Slice 8).** `history_tests.rs` checks that an
  `EventView` gives the same event ID, logical time and summary input as a
  full decode for every record of every golden fixture. A command executed
  against the held history must equal one executed against the whole request,
  including the conflicts it rejects.
- **Instance history (Slice 6).** `rust/src/history_tests.rs` checks append
  batches, truncation and atomic rejection, and that replaying the held
  history matches replaying the whole request for every golden fixture.
  `web/wasm/history-mirror.test.mjs` checks over the real WASM that a growing
  arena view sends only new records, a shorter one truncates, `historyWith`
  extras are rolled back, and a new epoch, another arena or an array sends
  the history whole. `web/wasm/abi-test-support.mjs` (not shipped) lets raw
  ABI tests replay a whole KINE request: reset, append, project.
- **Replay checkpoint (Slice 7).** `rust/src/history_tests.rs` replays every
  golden fixture one appended record at a time and requires the same result
  (bytes or error) as a whole replay of that prefix. A single-device history
  reuses the checkpoint after its first projection. An equal logical time,
  another identity context, a truncation below the checkpoint and a rejected
  record each rebuild. A command executed from the checkpoint equals one
  executed from a full replay.
- **Section revisions.** `rust/src/section_tests.rs` covers the contiguous
  section layout, the table and revision wrapping. The `abi.rs` tests check
  that revisions advance only for changed sections across calls, survive a
  non-projection call, never repeat after the basis is lost, and that command
  results locate their projection. `projection-decode.test.mjs` checks that an
  unchanged section is reused by identity and equals a full decode, that
  revision 0 and another engine instance's state never reuse, and that reused
  sections are still checked against counts and cross-section references.
  `scripts/incremental-render-regression.mjs` (in the browser runner) checks
  in two real tabs that a peer refresh after a new Handoff keeps the Items
  array and its rendered rows, and that a new Item renders, with the
  incremental state equal to a full decode of the same projection.
- **ABI ownership.** `web/wasm/abi-ownership.test.mjs` checks that every
  `kin_alloc` input is freed exactly once when the copy, the export, the result
  copy or the decode throws, for each operation family, and against the real
  engine.
- **Arena unit tests.** `web/storage/event-arena.test.mjs` covers growth past
  every initial capacity, subarray views, prefix stability across appends,
  idempotent appends, lookups, detached rows, stale views after reset or wipe,
  and zero-filling on wipe and growth.
- **Stage timings.** `node scripts/core-performance.mjs [--browser <exe>]`
  builds the release WASM if it is missing and prints per-stage medians; the
  refactor baseline is in [audits/REFACTOR-BASELINE.md](audits/REFACTOR-BASELINE.md).

Corruption tests that rewrite an already-read row in place (outside Kin's
write paths) reset the store's arena first, because the arena detects such a
change at the next full read rather than on the next command
([THREAT-MODEL](THREAT-MODEL.md)).

## Daily UX baseline

`web/daily-ux-fixtures.js` defines deterministic empty, overdue, due-today,
and completed records in the shape emitted by the Rust/WASM projection.
`web/daily-ux-fixtures.test.mjs` locks their Today grouping. The workspace
browser journey measures a real local due-today create and completion, checks
focus restoration, and prints the interaction and latency baseline. Existing
browser coverage supplies offline creation/reload and 320px reflow evidence.
See [DAILY-UX-BASELINE](DAILY-UX-BASELINE.md) for the implementation map,
measurement definitions, accessibility baseline, and disclosed gaps.

## Actionable Today coverage

`scripts/today-actionable-regression.mjs` runs inside `browser-regression.mjs`
after the responsive workspace suite. Its in-page part checks `<kin-today>`
states over projection-shaped records (not yet available, empty, all done, no
upcoming, full ordering and counts, semantic sections and labelled buttons),
Quick add from an empty state, and then the real store and WASM replay:
counts equal both the rendered rows and the projection, one-click completion
and focus, rapid repeats append one event, local save failure and retry, a
replayed peer change, a newer change arriving mid-save, navigation mid-save,
details origin and focus return, and lock or household re-open while a
completion is pending. Its CDP part completes a task with a real Enter key
while offline, reloads, unlocks locally while still offline, reconnects, and
checks 320px and desktop layout (screenshots in `target/ux-screenshots/`), an
unrelated open editor draft, forced colours and reduced motion.
`web/today-view.test.mjs` covers the composition rules: upcoming ordering,
one section per item, counts, all-done, empty projections, month/year and DST
civil-date boundaries, and deterministic ordering.

## Bulk actions and undo coverage

`web/bulk-actions.test.mjs` covers eligibility, planning (skipped, archived,
staple, and unknown ids), selection reconciliation, undo conflict rules, and
outcome wording. The `command_tests.rs` test
`item_completion_and_reopening_must_change_status` covers the Rust
precondition and the idempotent replay of historical duplicates.

`scripts/chat-layout-regression.mjs` (#310, #311, #316) runs after the chat
suite on the room it leaves: Chat fits the screen at 320×568, phone
landscape, 768×1024, 1024×768, 820×1180, desktop and desktop at 200%; at
320px with 200% text, dark mode and reduced motion; with the keyboard open
(emulated through a shorter visual viewport); Jump to latest; the + menu; and
message actions by mouse, right-click, long press and swipe. Physical devices
follow [MOBILE-CHECKLIST](MOBILE-CHECKLIST.md).

`scripts/undo-regression.mjs` (#314, #315) runs inside
`browser-regression.mjs` after the bulk suite: the toast after a change, Undo
then Redo on it, Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z outside text fields only,
refusal when the item changed since, an archived item and a deleted routine
brought back by creating them again (with date, schedule and today's
completion), Dismiss, and "Nothing to undo." `web/undo.test.mjs` covers the
history and every reversal mapping.

`scripts/bulk-actions-regression.mjs` runs inside `browser-regression.mjs`
after the keyboard suite, through the real store and WASM. It covers:

- Keyboard-only selection with Enter and Space on native checkboxes, Select
  all, Clear selection, and focus continuity.
- Bulk complete by keyboard with exact event counts, and the polite outcome.
- Undo appending new events, and repeated undo.
- Rapid repeats completing each item once.
- Partial failure with retry and carried undo, and partial undo with retry.
- Undo leaving an item alone after a change written only to the encrypted
  log, plus Rust rejecting a stale completion with code 4.
- Mixed selections, Select all including open completed items, and
  ineligible ids never reaching the store.
- Remote archive reconciliation.
- Quick add, the palette, and Details from selection mode.
- Navigating mid-batch, and Shopping.
- A 25-item performance sample (`METRIC bulk-complete`).
- 320px, forced colours, and reduced motion.
- Offline completion, reload persistence, and no Web Storage leakage.
- Lock during a batch, and refusal of an undo from a previous session.

## Repeating tasks coverage

- **Rust.** `recurrence.rs` tests cover Weekdays keys, `next_start` for every
  cadence, an exhaustive two-year check that `next_start` is the first later
  date with a new occurrence, and monthly creation on the 31st.
  `recurring_task_tests.rs` covers protocol-24 gating and wire layout,
  weekend refusal, independent future occurrences, stale and repeated
  commands, concurrent completions from two devices, stopping, and paused
  modes.
- **WASM.** `web/wasm/routines.test.mjs` checks Weekdays and `nextOn` through
  the real engine and that `executeCommand` refuses stale or weekend intents.
- **Sync.** `server/sync-e2e.test.mjs` has two devices complete one occurrence
  offline through the encrypted relay, re-push a duplicate envelope, and
  converge on one completed occurrence.
- **Units.** `web/recurrence.test.mjs` (labels, next-date wording, capture
  and schedule-change planning, resume and refusal), `web/today-view.test.mjs`
  (one Today group, one row per task), `web/bulk-actions.test.mjs` (Routines
  are never bulk targets), and `web/service-worker.test.mjs` (every module
  statically imported from `kin-app.js` is in the offline shell).
- **Browser.** `scripts/recurring-tasks-regression.mjs` runs inside
  `browser-regression.mjs` after the bulk suite, with a pinned page clock. It
  covers: default one-off Quick add; keyboard-only Repeat selection with
  visible summary; one Routine and no Item; one Today row with next date and no
  checkbox; bulk complete and undo leaving the occurrence alone; Space
  completion; a stale repeat; weekend absence and Monday's new occurrence;
  reload and unlock; Schedule from Today; a partial schedule change and its
  resume without a duplicate; a stale change; 320px targets and overflow; and
  Delete routine.

## Daily UX hardening coverage

`scripts/daily-ux-hardening-regression.mjs` runs inside
`browser-regression.mjs` after the repeating-tasks suite. It covers offline
Quick add with an at-rest plaintext scan and a reload; lock during a pending
Quick add write; a schedule change interrupted by lock and resumed after
unlock; reminders and permission prompts across lock; household settings that
settle after lock; the phone-width Quick add trigger's accessible name;
disclosure markers in forced colors; bulk outcome descriptions; the palette's
fallback when its opener is removed; reflow at 320, 375, 768 and 1280px; and
it prints `METRIC daily-ux-hardening` samples with median and p95.
`rust/src/recurring_task_tests.rs` and `web/storage/remote-replay.test.mjs`
pin concurrent schedule changes, the Weekdays DST weekend, and that an
unreadable or unsupported remote event stops a batch instead of being
quarantined. See [DAILY-UX-HARDENING](DAILY-UX-HARDENING.md).
`web/storage/quarantine.test.mjs` pins the quarantine bound, retry
bookkeeping and review message; `remote-replay.test.mjs` and the browser
`sync-storage-regression.mjs` show a completion delivered before its item is
kept encrypted and applied once the item arrives (#153).

## Keyboard shortcuts and command palette coverage

`web/keyboard-commands.test.mjs` covers the command allowlist against the
router, filtering and ranking, the Ctrl/Cmd+K, N, / and ? mapping (including
the Mac Ctrl+K exclusion, non-Latin layouts, AltGr, IME, and auto-repeat),
typing detection through nested shadow roots, and the help contents.
`scripts/keyboard-commands-regression.mjs` runs inside
`browser-regression.mjs` after the Today lifecycle suite and uses real CDP
key events. It covers:

- Ctrl+K and Cmd+K opening the palette, with no duplicate overlays.
- Escape closing the palette and restoring focus.
- Filtering, the announced empty result, wrapping arrow selection, Enter, and
  pointer selection.
- Modal Tab containment.
- Each navigation command's destination and focus.
- N, / and ? from a page, and their absence while typing in Search, Quick
  add, a field two shadow roots deep, and contenteditable.
- IME and auto-repeat.
- Quick add opened by N saving exactly once.
- Overlays: the palette over side details (Escape closes only the palette),
  the Search origin kept, and the mobile sheet blocking shortcuts.
- Navigating during an in-flight save.
- 320px reflow and 48px targets for both dialogs, forced colours, and reduced
  motion.
- Lock with the palette open, every shortcut ignored while locked, a command
  chosen just before lock being dropped, and disconnection.

`scripts/quick-add-regression.mjs` still runs unchanged, including
partial-capture recovery.

## Household workspace UX coverage (unversioned candidate)

`scripts/workspace-ux-regression.mjs` runs inside `browser-regression.mjs`
after the attachment suite. It also checks that empty automatic sync polls do
not repaint the workspace or refresh peer tabs, and records before/after WebM
clips in `target/ux-screenshots/kin-sync-refresh-*.webm`. Its in-page part covers the journeys in
[WORKSPACE-UX](WORKSPACE-UX.md) §6: To do and Shopping capture, planning a
shopping item for today and seeing the same record on Today, completing from
either view, a synthetic legacy `today` item on Today and under To do with
date precedence, future and earlier plans, paused routines, opening/closing
details with scroll position and drafts intact, search results that open an
item, a checklist step and a note by canonical id and return to search, the
in-app routine reminder control, offline/failed/partial saves with inline
feedback, legacy route aliases with Back/Forward, and lock during details and
search. Its CDP part resizes 360 → 768 → 1024 → 1440 → 1920 → 390 with details
open, asserting five equal navigation tracks, one editor re-homed between
sheet, inline and side presentations with its draft, no horizontal overflow,
no undersized target, Escape, and no empty column; it writes
`target/ux-screenshots/regression-*.png`. `scripts/workspace-screenshots.mjs`
(not part of the gate) captures Today, Shopping, an open item, Search,
Routines, Household, failed-save and offline states at representative widths
in light and dark. Node tests: `web/routes.test.mjs`,
`web/today-view.test.mjs`, `web/reminder-time.test.mjs`,
`web/capture-plan.test.mjs`, plus the compact-mode case in
`web/components/kin-attachments.test.mjs`. Existing suites were updated for
the new structure (details instead of inline row tools, `#updates`,
`#household/...`, Today capture semantics).

PR #42 remediation coverage extends these real browser paths: item A/B
checklist draft isolation, close/route retention, successful-save clearing,
empty-submit duplicate prevention, and delayed A success/failure while B is
selected without draft clearing or feedback leakage; partial capture retries
through Try again, Add, and a real Enter key
with the same canonical id and an explicit finish-or-start-new choice after
edits; checklist and planning-date failure/retry inside the actual mobile
`<dialog>` with one alert and draft retention through rerender; and native
keyboard Escape over desktop details and the mobile detail sheet, including
rerender and focus/URL cleanup. `target/ux-screenshots/regression-360-detail-step-error.png`,
`regression-360-detail-date-error.png`,
`regression-viewer-escape-mobile-preserved.png`, and
`regression-viewer-escape-desktop-preserved.png` capture representative
synthetic-data states. These remain local uncommitted-patch results, not CI.

## v0.41.1 Mobile Attachment Upload coverage

The browser regression runs `scripts/attachment-upload-regression.mjs` right
after the mobile UX suite. Unlike the in-page suites it is driven from Node
over CDP so that it exercises the real control rather than the handler: the
viewport is a 390×844 phone, `Add photo` on a Shopping row is tapped with a
synthesized touch, the browser's own `Page.fileChooserOpened` must name the
app-owned input and the tapped item, the list is re-rendered while the picker
is "open" (the sync-tick condition that lost files on phones), and a genuine
JPEG encoded by the browser is supplied with `DOM.setFileInputFiles`. It then
asserts the preparing → saving → saved feedback on the row, the sealed stored
record and canonical binding, the tile with name/kind/state under the right
item and nothing under another item, the bounded thumbnail, the viewer with
focus return, Today/Lists navigation, Details open/close, a stale sync refresh
that must not drop the row, lock/unlock restore with a fresh thumbnail, a
`text/plain` refusal with its reason kept visible, and a cancelled picker that
creates nothing. Running the script directly delegates to the shared browser
fixture. The passkey suite attaches through the same row button and shared
input with a real household identity and checks that the stored record is
household-key ciphertext. Node tests: `web/attachments/attachment-progress.test.mjs`,
`web/attachments/attachment-lifecycle.test.mjs` (file-problem messages,
failure stages, orphan grace), and `web/components/kin-attachments.test.mjs`.
Installed-PWA and camera-capture behaviour cannot run headless and remain on
the manual device checklist in the v0.41.1 release record.

## v0.41.0 Mobile Experience & Passkey-First UX coverage

The browser regression runs `scripts/mobile-ux-regression.mjs` inside the
page after the planning-date suite. Running that script directly delegates to
the same shared browser fixture, so the documented direct command exercises
the mobile assertions instead of exiting without a browser. It covers the Today capture default and
sticky destination, per-list quick-add on Lists, the item `Details`
disclosure, the Today "Get started" card and household chooser, plain-language
sync/offline/attachment messages, the security settings panel (passkey state,
inactivity lock preference, no secrets in web storage), and the recovery-first
lock screen. The passkey suite adds passkey-first lock-screen assertions and
proves that a server-accepted WebAuthn assertion with the wrong local PRF
output cannot unlock the vault or change encrypted event bytes. It also
exercises the real attachment capture path: lazy thumbnail decode only after
the tile scrolls into view, the in-app viewer, object-URL revocation on close
and lock, document tiles, and the plain failure message. The security UI
suite checks the welcome and save-key steps and a presentation-only synthetic
PRF wrapper. `web/attachments/attachment-preview.test.mjs` and the new
`passkey-unlock` cases cover the preview cache and the offline/unenrolled
error paths. Planning-date and Area tests expand `Details` before using the
controls, and a 320px Today layout check asserts no overflow, 48px targets,
fixed bottom navigation, and collapsed details.
The same mobile suite checks that time spent with the page hidden counts toward
the configured inactivity limit and that an expired limit locks before the
person can continue; pointer and scroll activity reset the deadline. Closing the
tab always locks immediately; a refresh of the same tab stays unlocked unless
the person turned that off ([ADR 0010](decisions/0010-reload-resume.md)), and
the main browser regression checks refresh, Lock, navigation and the setting.
Regression tabs start with refresh-resume off (`scripts/cdp-page.mjs`), and in
light mode with forced colours off whatever the computer's own appearance
(#795). A check that wants dark mode, forced colours or reduced motion asks for
it through `setMedia` (`scripts/cdp-media.mjs`), which keeps that light start
for everything it isn't asked to change; `setMedia(client)` returns to it.
First-run copy explains that passkey-first describes everyday unlock; initial encryption
setup still starts with the recovery key.

## Reproducible verification

From either the repository root or `projects/kin/`, run `npm run verify
--prefix projects/kin` at the repository root or `npm run verify` inside Kin.
The gate requires Node `>=24.16.0`, the active pinned Rust toolchain from
`rust-toolchain.toml`, Cargo, Git, Python `>=3.11` for the existing version
check, and the `wasm32-unknown-unknown` target. It runs formatting,
warnings-denied Clippy, version checks, Kin-only `git diff --check`, every
`*.test.mjs` under `server/`, `web/` and `scripts/`, all Rust tests,
the release WASM build, and a hash comparison against the committed
`web/wasm/kin_engine.wasm` when that artifact is tracked. This repository
ignores the generated browser WASM, so that comparison is reported `NOT RUN`
for the default gate. Browser mode compares the local browser asset with the
fresh build and fails on a stale or missing file without replacing it.
The Node suite sets the existing documented `NODE_NO_WARNINGS=1` setting to
keep subprocess SQLite experimental warnings from corrupting exact CLI output
assertions.

Run every gate including the browser suites with `npm run verify:browser`
([below](#run-the-browser-gates-locally)). The normal verification command
reports the browser stage as `NOT RUN`; it is not a pass. The suites drive any
Chromium-family browser over the DevTools protocol; CI runs them on Windows
Edge and Linux Chrome.

The default mandatory local gate is `verify`; browser regressions are an
explicit second command. `node --test scripts/verify.test.mjs` runs focused
tests for the verification runner itself (they are also part of the gate). The active root workflow is
`.github/workflows/kin-verification.yml`; a synchronized project-local reference
is retained at `docs/ci/kin-verification.workflow.yml`. Pull requests that
change Kin or its workflow, and pushes to `kin-development`, run three jobs
(#329):

- `verify` (Windows): stages A–D (environment, static checks, every Node and
  Rust test, the release WASM build).
- `verify-linux` (Linux): the same stages, and publishes the engine it built.
- `browser`: each browser suite in its own job, on Windows Edge and on Linux
  Chrome, against that published engine
  after checking its SHA-256. Each runs
  `node scripts/verify.mjs --browser-only --suite <suite>`, with the retry and
  FLAKY reporting below. The longest suite, `browser-regression`, runs as
  two jobs: `KIN_REGRESSION_PART=1` runs every single-tab check, and `=2`
  runs the quick in-page single-tab checks (the two-tab checks build on the
  handoffs, topics and routines they leave) and then the checks with a second
  tab, skipping the slow browser-driven sections. Each does the shared setup
  and the final console, request and storage checks. Unset, it runs
  everything once. In October 2026
  the Edge run of the whole suite took 326 s; the next longest job took 139 s.

Every one of them must pass; a suite that fails on either browser fails the
run.
`scripts/ci-workflow.test.mjs` fails if the two copies drift apart or an
action is not pinned to a full commit.

**Reused work and the published engine (#330).** Every run's Linux job
publishes the engine it built as the `kin-engine-wasm` workflow artifact
(`kin_engine.wasm` and its `kin_engine.wasm.sha256`, kept 30 days), so a
machine without the `wasm32` target can run the browser gates against the same
engine ([below](#run-the-browser-gates-locally)); the `browser` jobs use it
too, so no browser job installs Rust. Measured in October
2026, the toolchain install (10–12 s), `npm ci` (0–2 s; Kin has no npm
dependencies) and the WASM build (7–9 s) are a small share of a run; the
browser step (about 360 s on Windows) is the rest. A Cargo `target/` cache is
deliberately not kept: Cargo rebuilds a path crate whose files have new
modification times, which every checkout gives them, and Kin has no other
crates to reuse.

## Flaky browser suites

A browser suite that fails is run once more (`scripts/verify.mjs`, #328). If
the retry passes the suite is **FLAKY**: it does not fail the gate, but the
report never shows it as PASS. The summary's `Flaky:` line names it, and in
GitHub Actions it also appears as a warning annotation and in the job summary,
with the first assertion or error that failed. If the retry fails too, the
suite FAILs with the second failure (the first is kept as `firstAttempt`).
A suite is never run a third time.

With `KIN_DIAGNOSTICS_DIR` set (CI sets it), each failed attempt leaves
`<suite>-attempt<N>.log` (its full output) and, under `attempt<N>/`, a
screenshot and the address, title and text of each page the suite had open
when it failed (`captureFailure` in `scripts/cdp-page.mjs`). CI uploads the
folder as the `kin-browser-diagnostics` artifact.

A flake is a bug to fix, not noise: fix the cause rather than lengthening a
wait, and never delete or weaken a test to make it pass.

A suite that waits for Kin to settle waits the way the `idle()` helpers do:
until none of `app.busy`, `app.refreshing`, `app.pendingRefresh` and
`app.wakePending` is set. `wakePending` is a wake (window focus, the tab
showing again, the Pulse timer) whose refresh has not started yet (#793).
Without it a check can land just before that refresh clears an alert,
disables the controls or moves focus.

### Triage a flake

1. **Read it.** The job summary's "Flaky browser suites" table (or the
   warning annotation) names the suite and its first failing assertion or
   error. Open the job's `kin-browser-diagnostics-<browser>-<suite>` artifact:
   `<suite>-attempt1.log` is the failed attempt's full output, and
   `attempt1/` holds a screenshot and the address and text of each page the
   suite had open.
2. **Reproduce it.** Run that suite alone, several times, against the same
   engine: `node scripts/verify.mjs --browser-only --suite <suite>` (fetch the
   commit's engine with `node scripts/fetch-wasm.mjs` if you can't build it).
   A flake that never reproduces locally is usually a wait on something
   asynchronous (an animation frame, a media-query `change`, a second tab
   starting); look for the step just before the failing assertion.
3. **File it.** Add a comment to the open flake-tracking issue (#327 while the
   test and CI reliability epic, #326, is open; afterwards a new issue labelled
   for test health), with the run link, suite, browser, the first failing line
   and what the diagnostics showed.
   "Browser did not start" now says which it was (`scripts/browser-launch.mjs`,
   #327): the browser exited first (with its exit code and the end of its own
   error output) or didn't write its DevTools port within 45 s.
4. **Fix the cause** rather than lengthening a wait or retrying more, and say
   in the fix which race it closes. Never delete or weaken a test to go green.

### Test health over time

`node scripts/test-health.mjs` (needs `GITHUB_TOKEN` or `gh auth login`)
reads the last 20 completed `kin-development` runs of Kin verification and
prints, per job, how many passed first time, passed only on retry (FLAKY) and
failed, worst first, with the run links. Options: `--runs N` (1–100),
`--branch NAME`, `--repo OWNER/NAME`. It reads the latest attempt of each
run, so a run someone re-ran by hand before #328 counts as its final result;
retries since #328 happen inside the job and are counted as FLAKY. The
epic's target is 20 consecutive runs with nothing flaky or failed.

The gate runs every `*.test.mjs` under `server/`, `web/` and `scripts/`, so
the runner's own tests, the documentation checks and the v1.0 compatibility
check are part of it (before #328 the `scripts/` tests ran only by hand).

## Run the browser gates locally

One command, on Windows, macOS or Linux (#331):

```sh
npm run verify:browser
```

- **Browser.** `KIN_BROWSER` if set; otherwise the first installed Edge,
  Chrome or Chromium in the usual places (`scripts/find-browser.mjs`), named
  in the output. With none, the run fails saying what to install.
- **Engine.** If `web/wasm/kin_engine.wasm` is missing, it is built first
  (as `build-wasm.sh` does) and the report says so; the engine's Node tests and
  the browser suites both load it. Stage D then builds afresh and compares.
- **Missing prerequisites** fail stage A with the exact fix, for example
  `rustup target add wasm32-unknown-unknown`.

Where the `wasm32` target can't be installed, fetch the engine CI built for
the same commit instead:

```sh
node scripts/fetch-wasm.mjs            # HEAD; or --commit <sha>
```

To run one suite, or only the browser suites against the engine already in
place: `node scripts/verify.mjs --browser-only --suite passkey-regression`
(`--suite` repeats; `--browser [EXECUTABLE]` or `KIN_BROWSER` names the
browser).

It needs a GitHub token (`GITHUB_TOKEN`, or `gh auth login`), finds that
commit's `kin-engine-wasm` artifact, checks the engine against the SHA-256 CI
recorded with it, and only then installs it. The commit must have been pushed
and verified within the last 30 days. Then run just the browser suites
against it (stages A–D need the `wasm32` target):
`node scripts/verify.mjs --browser-only`.

Verification is fail-fast. When a mandatory command fails, later commands in
that stage and dependent stages are reported `NOT RUN` with the reason; they
are not counted as passing. The report retains completed results, identifies
the first failing command, gives runtime and elapsed time, and exits nonzero.
An environment prerequisite failure similarly prevents static, test, WASM,
and browser checks. In the default mode the optional browser stage is always
`NOT RUN`; use `verify:browser` to make those suites mandatory.

While a child command is active, the runner handles SIGINT and SIGTERM,
attempts to stop the active command tree, waits for cleanup to finish, and
then exits unsuccessfully without scheduling later checks. POSIX commands run
in an isolated process group and cleanup signals that group. Windows cleanup
uses the built-in `taskkill /T /F` scoped to the child PID. A cleanup error is
a verification failure and is included in the report. This terminates normal
descendants within the isolated tree; detached descendants that deliberately
leave that tree and hard process or host failures cannot be guaranteed to
terminate. The process-tree regression is exercised on Windows here; POSIX
process-group termination is implemented but was not exercised in this
Windows environment. Browser runners retain their own cleanup behavior.

The v0.16.0 gate adds Note lifecycle, validation, protocol-10 compatibility,
prior-history, real-WASM, and browser create/edit/archive coverage to the
existing Rust, encrypted-sync, storage, server, and browser regression suites.
The v0.16.1 correctness gate covered concurrent Note update/archive events with
both device-ID orderings, browser parity for Unicode scalar/UTF-8/control
limits, invalid-submit non-append behavior, and persisted-state waits in
keyboard regressions to avoid accepting a pre-action idle state. The v0.16.2
gate adds offline Notes lifecycle/reload, stale canonical command rejection,
Notes labels/errors/focus, and three consecutive full browser runs.

The v0.17.0 Checklist Steps gate adds ordered Step lifecycle through real
WASM, protocol-11 layout and prior-protocol compatibility, capacity and text
bounds, equal-time terminal-archive convergence, parent Item independence and
gating, browser add/complete/reopen/archive flows, local persistence, and the
existing encrypted-sync regression.

The v0.18.0 Richer Routine Scheduling gate adds protocol-12 cadence decoding,
biweekly creation-date anchoring, monthly calendar keys, leap/month/year
boundaries, prior-protocol fail-closed behavior, stale occurrence checks, and
accessible UI wording through real WASM and browser regressions. Daily/Weekly
keys and protocol-11 result layouts remain covered as compatibility fixtures.

The v0.19.0 Shared Shopping Lists gate adds protocol-13 classification
decoding/encoding, protocol 1–12 fail-closed checks, real-WASM event and
summary projection, browser capture/list isolation and the complete existing
Item lifecycle with list-focus restoration. Local encrypted persistence and
the existing sync/archive adapters remain the only storage path.

The v0.20.0 Staples & Replenishment gate adds protocol-14 classification
decoding/encoding, protocol-13 fail-closed checks, real-WASM event and summary
projection, reusable Staples capture, one-click manual replenishment into an
independent Shopping Item, failed-append retry with stable item identity,
source-list focus restoration, archiving behavior, and protected-UI plaintext
disposal on lock.

**Status:** The historical v0.13.3 recovery release gate passed on Windows x64 with Node 22.12,
Rust 1.93, and Edge 154. The gate covered 300 Node/real-WASM tests (226 server),
118 Rust tests, formatting, warnings-denied Clippy, release WASM, all product,
storage, security UI and virtual-passkey browser runners, version consistency,
and whitespace. See [V0.13.0](planning/V0.13.0.md) and [RECOVERY](RECOVERY.md).

## Post-v0.40 live household authority drill

`scripts/household-authority-regression.mjs` drives several independent
headless browser profiles (separate `--user-data-dir`, cookies, IndexedDB,
device keys and CDP virtual authenticators) against one real in-process Kin
server and relay on loopback. The server clock is injectable so Temporary
expiry is enforced deterministically; the browsers keep real time. The drill
covers Adult, Limited and Temporary admission through the real pairing
ceremony, Limited/Temporary trust-management denials, member removal and
device revocation while the affected client is offline, Temporary expiry, a
rotation committed by an Adult that is revoked before the offline Adult
receives it, export through the product control, restore into a clean
profile, same-member device re-authorization with catch-up, and two-client
reconciliation after concurrent offline edits. It runs in about two minutes and
leaves no data behind.

Pairing requires the displayed invitation code and operates the real "I
compared this fingerprint" checkboxes and passkey buttons. The drill compares
the fingerprint strings rendered in the two profiles and checks that approval
is refused, and activation disabled, until confirmation. That is automated
evidence for protocol and UI gating only. It is not a person comparing two
screens and does not count as a manual fingerprint-verification test.

B-002 committed-rotation recovery has focused service, cryptographic, and
durable coverage in `server/rotation-recovery.test.mjs` and
`server/durable-sync-integrity.test.mjs`: recipient authorization after
revocation, removal, and Temporary expiry; tampered, forged, misaddressed, and
superseded-key packages; historical sender keys; consecutive rotations; lost
acknowledgements; capacity bounds; restart equivalence; corrupt durable
markers; and pre-marker grants.

```powershell
$kinBrowser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node projects/kin/scripts/household-authority-regression.mjs $kinBrowser
```

Results and limits are recorded in
[audits/LIVE_HOUSEHOLD_VERIFICATION.md](audits/LIVE_HOUSEHOLD_VERIFICATION.md).
Separate browser profiles on one machine are not physical devices, different
networks or independent people; those drills remain manual.

## A page that loads while the service worker installs (#770)

The worker takes over open pages when it activates. A page whose load had
already left for the network missed that and stayed without a worker until
its next load, so it could not start offline. In the household drill this
was a joining device's first reload, and it failed now and then on Edge.
`scripts/worker-claim-regression.mjs` (its own CI job) makes it happen every
time: its server holds one shell file, which keeps the install open, and
the reloaded page's document until the worker has activated. It then checks
that the page comes under the worker anyway (the page asks with
`KIN_CLAIM`).

```sh
node scripts/verify.mjs --browser-only --suite worker-claim-regression
```

## The home server's control panel (#718)

The control panel's setup and status ([HOME-SERVER](HOME-SERVER.md#setting-it-up-the-control-panel),
[ADR 0025](decisions/0025-kin-at-home.md) §10–§11) are covered at three
levels, all on loopback with nothing reaching the internet:

- **Server units** (`server/home/setup.test.mjs`): the one-time codes
  (alphabet, single use, one-hour expiry, five tries), `home/settings.json`
  written 0600 in a 0700 `home/` and left alone by a bad change, the stored
  control sessions, the name rules, the setup state machine (free name, own
  domain with its account and records, the restart, a refused name, done,
  `KIN_HOME_NAME`), the own-domain DNS checks and the HTTPS-record reader.
- **Server HTTP** (`server/home/control-panel.test.mjs`): the loopback
  panel's rules (no tunnel streams, loopback Host only, no proxies,
  same-origin JSON writes), the app's API closed until setup, the status
  holding counts and never content, admin-only access through the
  household's address with a fresh passkey, and a printed confirmation code
  for changes on the computer itself. `control-setup-e2e.test.mjs` runs setup
  end to end against the real relay in test mode and the in-process ACME
  server, through the restart, to a certificate a phone can use.
- **Components** (`web/control/control-panel.test.mjs`): every code the home
  server sends has plain words, and each component renders and acts on a
  small DOM stand-in (`web/control/test-dom.mjs`).
- **Browser** (`scripts/control-panel-regression.mjs`, its own CI job): a
  headless browser opens the address the launcher prints, enters the code,
  checks and chooses a name, agrees, connects, follows Kin's restart on the
  same port and the certificate to "Kin is ready" and the status page,
  checking labels, focus, live regions, 40 px targets and 320 px reflow on
  each screen. It uses `server/home/home-test-utils.mjs`, the same harness as
  the end-to-end test.

```sh
node scripts/verify.mjs --browser-only --suite control-panel-regression
```

## v0.13 recovery release gate

Recovery tests cover same-member replacement, member-assisted fresh credential
establishment, revocation/session invalidation, unrelated/removed/revoked/stale
authority rejection, single-use activation, and stale-backup preservation of
newer credentials, devices, revocations and epoch rotation state. The complete
v0.12 gate remains required so recovery changes cannot regress identity,
WebAuthn, sync/provisioning, durability, deletion tombstones, browser storage,
Rust replay, accessibility, or UI security.

## v0.12 data-lifecycle release gate

Run the complete v0.11 server gate, Rust/WASM and version checks, then the
established browser and security regressions. Use an isolated browser profile
and synthetic households only.

```powershell
npm run test:server --prefix projects/kin
cargo fmt --manifest-path projects/kin/Cargo.toml -- --check
cargo clippy --manifest-path projects/kin/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path projects/kin/Cargo.toml
cargo build --manifest-path projects/kin/Cargo.toml --target wasm32-unknown-unknown --release
Copy-Item projects/kin/target/wasm32-unknown-unknown/release/kin.wasm projects/kin/web/wasm/kin_engine.wasm
node --test (rg --files projects/kin/server projects/kin/web -g '*.test.mjs')
python projects/kin/scripts/check_version.py
$kinBrowser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node projects/kin/scripts/browser-regression.mjs $kinBrowser
node projects/kin/scripts/security-storage-regression.mjs $kinBrowser
node projects/kin/scripts/security-ui-regression.mjs $kinBrowser
node projects/kin/scripts/passkey-regression.mjs $kinBrowser
```

The server gate covers schema 1→2 migration and rollback, lifecycle state
transitions, fresh-passkey request/cancellation, write/session invalidation,
expiry finalization, tombstone restore merging and explicit restore
acknowledgement. Browser/UI runs preserve the existing keyboard, focus,
forced-colors, reflow, lock and offline checks. The package candidate is
server-only; the published Rust/WASM version and client event/storage formats
remain unchanged. Passing these checks does not certify physical media
sanitization, external backups, offline devices, other browsers or authenticators.

Windows x64 validation passed on Node 22.12, Rust 1.93 and Edge 154: 218 server
tests, 74 browser-unit tests and 118 Rust tests; formatting, warnings-denied
Clippy, release WASM, version consistency, all four browser/security runners,
and isolated PowerShell and POSIX (`run.sh` under Git Bash) launcher smokes also
passed. A WSL-built WASM artifact passed the browser-unit and core browser
regressions. The WSL HTTP launcher was not run because that distribution has no
Node executable. Do not treat this as validation on Linux/macOS or as release
publication approval.

## v0.11 durable-service gate

Install the locked native dependency once, then run the service suite from the
repository root:

```powershell
npm ci --prefix projects/kin
npm run test:server --prefix projects/kin
```

The suite includes file-backed migration rollback and unsupported-schema tests,
corrupt relay-data fail-closed checks, competing stale-cursor writers, online
backup and verified offline restore, exclusive process/maintenance locks, and
a spawned HTTP service restart. The restart test verifies fresh passkey login
using a persisted trusted-device verifier, durable acknowledgement, exact
ciphertext recovery, idempotent retry/conflict behavior, and device-sequence
continuity. Use synthetic credentials and events only.

PR #17 hardening regressions also cover canonical admin/startup web-root guards
(including symlinked missing ancestors), static traversal/symlink isolation,
rollback and retry after stale-writer conflicts, fatal store failures, bounded
durable cursor pagination, actionable stale-lock errors, admin exclusion and
cleanup, invalid restore sources, and preservation of old WAL/SHM state. See
[V0.11.0](planning/V0.11.0.md#pr-17-pre-merge-hardening-evidence-2026-10-03) for gate results.

Semantic-integrity fixtures first create normal API state, then directly mutate
synthetic SQLite databases while retaining physical/foreign-key validity.
They cover normalized JSON/envelope mismatches, impossible identity limits and
ownership, grant/package/rotation contradictions, relay/device sequences, audit
structure, failed startup, readiness before household access, and backup/restore
rejection before publication/replacement. Valid historical state and bounded
relay pages remain covered. See [v0.11.5 evidence](planning/V0.11.0.md#v0115-semantic-integrity-evidence-2026-10-03).

The production smoke process also takes an exclusive service lock. A test or
operator restoring a database must stop that process first. The lock is
intentionally left behind after an unclean exit; verify process state before
manual cleanup. See [DEVELOPMENT](DEVELOPMENT.md) for backup/restore commands
and limitations.

## v0.10 security and portability gate

Run from the repository root after building the current WASM artifact. Browser
runners use isolated temporary profiles and synthetic text/credentials. They do
not bypass production recovery, storage encryption or WebAuthn verification.

```powershell
cargo fmt --manifest-path projects/kin/Cargo.toml -- --check
cargo clippy --manifest-path projects/kin/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path projects/kin/Cargo.toml
cargo build --manifest-path projects/kin/Cargo.toml --target wasm32-unknown-unknown --release
Copy-Item projects/kin/target/wasm32-unknown-unknown/release/kin.wasm projects/kin/web/wasm/kin_engine.wasm
node --test (rg --files projects/kin/server projects/kin/web -g '*.test.mjs')
python projects/kin/scripts/check_version.py
$kinBrowser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node projects/kin/scripts/browser-regression.mjs $kinBrowser
node projects/kin/scripts/security-storage-regression.mjs $kinBrowser
node projects/kin/scripts/security-ui-regression.mjs $kinBrowser
node projects/kin/scripts/passkey-regression.mjs $kinBrowser
```

The version check keeps the published Kin release anchors separate from an
unreleased durable-service package candidate; server-only work does not imply
a Rust/WASM product-version bump.

The storage runner includes legacy-key migration checks. Optional `--performance`
and `--maximum-payload` measure 10,000-event migration/unlock and encrypted archive
round trips. Since Slice 9 each archive phase (export, restore) reports its
time and the renderers' peak working set and private bytes inside it, next to
the level before it; the timing run exposes `gc` and collects before each
phase, and the round trip compares per-record digests so no fixture copy stays
alive. The WebAuthn runner uses a CDP virtual authenticator supporting PRF,
real browser ceremonies and the real server verifier; it is not physical hardware
or cross-platform certification. Preserve prior feature suites when changing
startup/draft expectations: security must not weaken domain, rollback or a11y checks.

## v0.10.1 correctness regressions

The same commands above include the patch checks. `security-operation-regression.mjs`
(called by the security UI runner) holds an old recovery unlock across lock and a
new unlock, then settles it both during and after the new operation. It also
holds an authentication-error metadata read across re-unlock. Verify the live
vault, lock control, busy state, disabled controls and feedback remain current,
and the old root is disposed.

The key-migration suite now delays fingerprint hashing for new, existing,
mismatched, conflicting and concurrently proposed trusted pins. It checks input
mutation during verification and locking before verification completes.

`server/rotation-recovery.test.mjs` uses real cryptographic packages and service
validation with controlled transport loss/expiry. It covers expired unaccepted
proposals, accepted lost responses, subsequent access changes, recipient key
succession/revocation, acceptance racing package refresh, competing proposals and
mismatched acknowledgements. The storage runner also exercises pending-rotation
compare-and-set and the retained rotation barrier in encrypted IndexedDB.

## Rust domain tests

### v0.10.3 bounded storage and corruption gate

`bounded-storage-regression.mjs` runs through the existing storage runner. It
checks 270 sparse ordered records with native pages ≤128 and crypto concurrency
≤32, duplicate routing rejection, decrypted index mismatch, cancellation between
batches, durable peer locks during 70-event migration/restore, exact source
retention and resume, lock after queued native restore writes, and duplicate
archive rejection before encryption. `encrypted-idb.test.mjs` checks both root
formats against wrong routing/AAD, unsupported versions, plaintext field leakage,
truncation and modified tags. Existing wrapper, KARC metadata/ciphertext,
canonical duplicate and malformed/version tests remain mandatory.

The storage runner now also forcibly terminates and reopens its isolated browser
profile at pre/post event-publication boundaries (four assertions), separately
from its four document-reload assertions. Synthetic recovery keys stay only in
the test host. The UI runner holds a real peer read while locking to verify that
numbered intent aborts the native transaction before the durable lock can queue
behind it. Existing same/current-epoch delayed-notification tests remain intact.

The full release gate additionally runs both project build/launcher workflows,
including PowerShell and POSIX shell HTTP/WASM smoke tests, native formatting and
warnings-denied Clippy/tests, complete Node/real-WASM/server tests, all product,
security and PRF browser runners, version/whitespace and Kin-only path checks.

### v0.10.2 root lifecycle gate

The established storage runner invokes `root-rotation-regression.mjs` and
`root-key-rotation-regression.mjs`, including durable phase interruptions,
quota/native abort, peer locks, stale manifest/root/capability rejection,
foreign journals, exact canonical/context/sync/outbox retention, restored private
keys/epoch secrets/pins, root 2→3, old copied wrapper isolation, and real document
reload before/after event publication. Node vault tests exercise candidate
generation failures, authenticated root versions and independent recovery roots.
The UI runner invokes `root-rotation-ui-regression.mjs` for re-entry confirmation,
replacement, cancellation, new-key resume, old-key rejection and offline recovery.

Optional `--performance --maximum-payload` now measures 1,000 representative,
10,000 short-text and 10,000 maximum-text events: migration, decrypt, Rust replay,
archive export/restore, exact canonical roundtrips, archive and serialized
encrypted-record bytes, origin storage estimates, and sampled Windows renderer
working set where available. Sampling includes retained synthetic fixture memory;
it is neither a precise database-file size nor a mobile measurement.

Before v0.1.0 is considered complete, cover at least:

1. `ITEM_ADDED` creates an active item with the specified ID, text, actor, and creation time.
2. Two distinct additions produce both items in deterministic creation order.
3. `ITEM_ADDED` followed by `ITEM_COMPLETED` derives a completed item.
4. Completing an unknown item returns the specified deterministic validation error and no partial state.
5. Reconstructing the same ordered stream repeatedly yields structurally identical output.
6. Exact duplicate event delivery is idempotent; reuse of an event ID with different bytes fails as an integrity error.
7. A second distinct completion event for an already-completed item is a valid no-op in state.
8. Malformed event envelope or payload fails safely.
9. Unsupported protocol and event-schema versions fail with stable error categories.
10. Cross-household input and bounds/length violations fail without partial state.
11. Reopen/archive payloads are exactly one item ID; every shorter or longer payload fails as malformed protocol data.
12. Protocol v1 cannot encode state that has Needs classification or archived status; it fails closed instead of dropping fields.

The Rust reducer must be testable without a browser or WebAssembly runtime. Use the standard Rust test harness; no third-party test framework is required.

The browser bridge's focused encoding/Unicode regression tests use Node's built-in test runner (no npm dependencies):

```text
node --test projects/kin/web/wasm/kin-engine.test.mjs
```

## ABI/protocol tests

Verify null/zero pointers, undersized and oversized buffers, overflow-safe range checks, zero-item results, stale-output reset between calls, correct result lifetime, memory growth handling, deterministic error status, malformed encoding, and the rule that input pointers are not retained after return.

## Browser-level validation

The browser regression runner uses Node 22+ built-ins and a local Chromium-family executable. Build WASM first, then run from the repository root (PowerShell example):

```powershell
node projects/kin/scripts/browser-regression.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
```

It starts a loopback static server and an isolated headless browser profile, runs against the shipped CSP and real Rust/WASM/IndexedDB, and removes its temporary profile afterward. It does not access the user's existing Kin database. No npm install is needed. The runner fails on assertion errors, uncaught browser errors, CSP errors, or third-party page requests; the automatic favicon 404 is ignored.

Regression cases include unchanged/edited drafts after failed add, exact original-command retry, rapid and stale retry clicks, delayed add completion, reconnect during a pending save, and peer refresh retaining a failed-command retry. Both synchronous and asynchronous quota categories are injected without exhausting disk space. A separate real transaction abort after request success verifies rollback and retry. The remaining checks cover the existing add/complete/replay, storage, cross-tab, Unicode, rendering, focus, and narrow-layout flows below. Automated focus checks assert focus ownership and a 3px outline; they do not certify screen-reader announcements or visual contrast.

The v0.2.3 regression suite retains Rust as the authoritative validator/reducer, IndexedDB schema 1 as the canonical event source, immutable source event bytes, and content-free BroadcastChannel invalidations. It covers complete/reopen/archive recovery, stale canonical state, focus continuity, accessibility modes, repeated WASM calls after failure/empty input, and 10,000-event replay/result bounds in native Rust and the browser.

Manually exercise or use a lightweight browser-native harness to verify:

- WASM loads and exports match the ABI contract.
- IndexedDB opens and event history reads in append order.
- Existing events load and Rust reconstructs state.
- An item can be added and then completed through UI commands.
- New capture defaults to Needs; selecting Today changes classification with one native control action.
- Schema-v1 legacy items normalize to Today; schema-v2 classification survives reload without modifying original stored bytes.
- Complete and reopen work from their appropriate states; archive creates a tombstone that remains in IndexedDB and stays hidden after reload.
- Refresh reconstructs exactly the same visible state.
- Repeated actions and replay do not duplicate/corrupt state.
- User-entered text renders safely as text.
- Storage/ABI failures reach an understandable error state without claiming success.
- A compose draft survives a same-tab reload and clears only after successful persistence; the draft is not written to the event store.
- Focus returns to a usable control after add, complete, reopen, and archive; `aria-busy` clears after success or failure.
- Complete/reopen/archive storage failures and transaction aborts preserve the prior state; retry applies exactly one event.
- If canonical state makes a retry invalid, reload the full event log through Rust, clear the stale retry, present the current state, and append nothing.
- Rebuild and serialize 10,000 synthetic classified events deterministically below the 64 MiB request/result limits; verify repeated WASM calls do not return stale state/error buffers.
- A quota-exceeded write preserves the event count, announces a storage-full message, exposes retry, and a later retry persists exactly one event.
- With two same-origin tabs open, a successful write in one invalidates the other; the peer reloads canonical events and reruns Rust replay. Verify the notification carries no event or household content.
- CSP smoke: load the page under its shipped same-origin policy and inspect the console for CSP violation messages.
- Accessibility stress: test forced-colors, text-spacing overrides, 320px reflow, 200% browser zoom, and visible focus around actions.
- No household-content, backend, analytics, or third-party network requests occur; serving local static assets from the application origin is expected.
- Browser console has no uncaught errors.
- Keyboard interaction, focus visibility, status announcements, and a narrow mobile viewport work.

## Cross-browser and assistive-technology checklist

The following platforms/assistive technologies are not certified by the Windows/Chrome regression run. Mark an item verified only after running it against a release build:

- [ ] Firefox desktop: startup, add/complete/reload, storage failure, CSP console, 320px reflow.
- [ ] Safari desktop: startup, add/complete/reload, storage failure, CSP console, 320px reflow.
- [x] Standalone Chrome desktop (headless): startup, add/complete/reload, storage failure, CSP console, 320px reflow.
- [ ] NVDA with Firefox or Chrome: labels, status/error announcements, completion, and focus restoration.
- [ ] VoiceOver with Safari: labels, status/error announcements, completion, and focus restoration.

### The family fridge (#317, #325)

`scripts/fridge-regression.mjs` (run from the browser regression) covers, in
headless Chromium-family browsers through the real engine: the 3:4 door at
320×568, phone portrait and landscape, 768×1024, 820×1180, 1024×768 and
desktop, and desktop at 200% zoom (no horizontal scroll, every visible control
at least 44 px); kitchen-screen mode at 1024×768 and 1180×820 with a coarse
pointer, full screen and leaving it on lock (#324); finger, pen and mouse
drawing, second-finger cancel and palm rejection; the eraser, undo and redo;
magnets by dialog, keyboard, menu and drag; clearing and bringing it back;
dark mode, forced colours and reduced motion; and the reopened log. Export
and restore of the fridge are covered in `web/security/archive-stream.test.mjs`
and `web/board/board-room.test.mjs`.

Emulated touch and pen are not real hardware. Before calling the fridge
verified on a release, check by hand:

- [ ] iPhone (Safari): draw with a finger, a second finger cancels, the page
  around the door still scrolls, magnets by drag and by menu, VoiceOver reads
  the summary and each magnet.
- [ ] Android phone (Chrome): the same, plus TalkBack.
- [ ] iPad with Apple Pencil: palm resting on the screen while drawing leaves
  no marks; landscape shows the side rail; full screen and leaving it; locks
  after the chosen time while left on the fridge.
- [ ] iPad with a hardware keyboard: every tool and magnet by keyboard (arrows,
  Shift+arrows, Enter, Delete), focus visible throughout.
- [ ] Desktop (Firefox, Safari, Chrome or Edge): mouse drawing, the eraser,
  forced colours (Windows contrast themes), 200% browser zoom.

Do not introduce an external test framework just for convenience. Record tested browser/runtime versions and manual steps in the release notes when implementation begins.

## Handoff

Coverage in protocol.rs, kin-engine.test.mjs, and scripts/handoff-regression.mjs (called by the browser runner) exercises mixed replay, lifecycle, legacy rejection, immutable storage, inert text, drafts/retries, and cross-tab canonical state.

## v0.3.1 correctness evidence

Handoff tests reject every shortened payload, overlong references, unsupported schemas, extreme lengths, invalid UTF-8 and whitespace-only domain text. Exact v3 result records and separate entity namespaces are checked. Actor provenance comes from envelopes; same and different acknowledging actors both succeed. Browser fault injection verifies event/counter rollback, retry once, and metadata mismatch preservation; Node tests reject malformed Handoff result fields and recover on the next call.

## v0.3.2 resilience and accessibility

The browser runner covers delayed Handoff persistence across reconnect/peer refresh, newer draft ownership, sessionStorage denial, acknowledgement/archive failure and abort retry, rapid repeated retry, and stale actions without invalidation delivery. Handoff semantics, focus, announcements, disabled controls and touch targets are checked under the existing accessibility modes. No screen-reader or native desktop zoom certification is claimed.

## v0.3.3 hardening evidence

Rust checks truncated Handoff request/event headers, reserved fields, extreme text lengths and a deterministic 10,000-event mixed projection. Real WASM tests reject every truncated Handoff result boundary and trailing bytes, observe memory growth during 10,000-Handoff replay, and verify independent host-owned results across success/error/empty/repeated calls. The complete earlier regression suite remains required.

## v0.3.4 retry recovery

User-authorized follow-up patch: a failed canonical refresh retains the original failed command and feedback in transient application memory. Repeated refresh failure offers refresh retry first; successful Rust replay restores the command retry unless canonical state invalidates it. No automatic append occurs on refresh recovery. New commands supersede suspended retries. Browser regressions cover Handoff add/acknowledge/archive, Item add, repeated failure, newer drafts, stale peer actions and supersession. This is not persisted household state or a new capability.

## v0.3.5 build and run workflow

Validate both launchers through the existing platform build scripts, confirm the server serves `web/` on loopback port 8000, and run the complete browser regression suite against the generated WASM. The launch workflow changes no application behavior.

## v0.4.1 correctness evidence

Talk correctness audit passes the full lifecycle matrix, every truncated payload, overlong references, unsupported schemas, empty/oversized/invalid UTF-8 and blank text, exact v4 records, malformed status/reserved/count/length fields and combined entity limits. Exact pre-Talk writer/result fixtures remain unchanged. Browser tests verify event/counter rollback, retry once, metadata preservation and invalid-transition non-append. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts and both launchers (page/WASM HTTP 200), and the complete Chrome 154.0.8037.59 browser suite on Windows x64/Node 22.12.0; POSIX via WSL. Previously listed platform/assistive-technology gaps remain.

## v0.4.2 resilience and accessibility evidence

Expanded Talk browser checks for keyboard resolve/reopen/archive, native input-to-Add focus order, semantic headings/lists, labels, polite status/assertive errors, visible focus and 48px targets under forced colors. Added independent draft assertions and direct stale retries with missed invalidation, alongside repeated-refresh recovery. Retained delayed saves, reconnect, queued peer refresh, sessionStorage denial, quota/abort rollback, rapid retry once and supersession. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts/launchers (page/WASM HTTP 200), and complete browser suite in Windows x64/Chrome 154.0.8037.59/Node 22.12.0, POSIX via WSL. 320px, increased spacing, forced colors, reduced motion and 200% page-scale emulation pass; native zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

## v0.4.3 hardening and final audit

Added every truncated v4 result-header/Talk-record boundary, malformed request headers and extreme lengths, 10,000-event mixed replay, and 10,000-Talk real-WASM growth with independent copied results across repeated success/error/empty calls. Retained explicit v3 Handoff truncation/trailing-byte coverage. Visual inspection found and fixed horizontal overflow caused by a 320px page minimum width when a desktop scrollbar consumes space; reflow assertions now compare scrollWidth with clientWidth. The corrected 320px screen preserves full input focus outlines and wrapping actions.

Passed 58 Rust tests and 19 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, version consistency, release WASM, PowerShell and WSL POSIX build scripts and build/run launchers (page and WASM HTTP 200), and complete browser regressions. Environment: Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.59; POSIX via WSL. Keyboard, all Talk lifecycle focus restoration, native focus order, semantics, busy/status/error, 48px targets, scrollbar-aware 320px reflow, forced colors, increased spacing, reduced motion and 200% page-scale emulation passed. Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

Architecture/product/privacy audit confirms Rust-only reduction; separate Item/Handoff/Talk semantics; immutable canonical IndexedDB schema-1 events; no migration; unchanged v1/v2/v3 contracts and explicit v4; content-free invalidation; textContent rendering; same-origin static requests; no framework/runtime dependency, analytics, AI, remote service, sentiment, scores, blame, identity inference, resolver attribution or response metrics. Resolved is workflow state only and claims neither agreement nor an objective solution. No remaining release-blocking defect was found in exercised environments. Cross-browser, assistive-technology and native-zoom checks remain validation gaps, not certifications. No additional UI feature was added. Duplication remains manageable, so no orchestration refactor was introduced.

## v0.5.0 Pulse

Pulse coverage is in rust/src/pulse_tests.rs, web/wasm/kin-engine.test.mjs and scripts/pulse-regression.mjs, called by the complete browser runner. All prior regressions remain; actual milestone evidence and gaps are in V0.5.0. See [V0.5.0](planning/V0.5.0.md).

Optional local visual evidence: set `KIN_VISUAL_CHECK=1` when running the browser regression script. Screenshots are written only to ignored `projects/kin/target/pulse-active-320.png` and `pulse-change-320.png`. They contain synthetic regression data.

## v0.6.0 Since You Last Looked

`rust/src/catchup_tests.rs` and protocol tests cover summary selection, stable cursor lookup, missing-cursor failure, duplicate delivery, Pulse exclusion, actual through-boundary, ordering, eight-entry cap, total count, and exact v6 bytes. `web/wasm/kin-engine.test.mjs` runs the real WASM ABI for v1–v6 compatibility and summary decoding. `scripts/catch-up-regression.mjs`, called by the complete browser runner, exercises legacy first-run history, cursor initialization racing with append, an event arriving after render, stale-tab monotonicity, beyond-snapshot rejection, truncation/omitted count, explicit no-event marking, keyboard/focus, and cross-tab view-state invalidation. The existing Item, Handoff, Talk, Pulse, storage, retry, 10,000-event, CSP, same-origin, and accessibility-mode regressions remain required.

Do not claim Firefox, Safari, native desktop zoom, NVDA, or VoiceOver coverage unless those environments are actually exercised. Chromium 200% page-scale emulation is not native desktop zoom.

## v0.6.1 Summary Correctness

The correctness-only suite covers an empty event stream; cursor at first, middle, and latest event; missing cursor; first occurrence of an exact duplicate; conflicting event IDs; Pulse events between meaningful changes; exact eight/nine/many counts and omitted entries; summary order and through-boundary; append after render; stale tab writes; requested boundaries beyond the frozen snapshot; malformed/partial local metadata preservation; and strict v6 cursor/reserved fields. No capability was added.

## v0.6.2 Summary Resilience & Accessibility

The browser suite injects cursor quota failure and transaction abort, verifies event/cursor/logical-counter rollback and retry, preserves the displayed summary through repeated refresh failures, and keeps a pending mark busy through reconnect. It exercises cross-tab convergence after `view-state-changed`, recovery after a missed notification, both stale/new write orders, and Pulse expiry refresh while the summary remains visible. Keyboard/focus, semantic structure, feedback roles, target size, narrow reflow, forced colors, text spacing, reduced motion, and page-scale zoom remain part of the complete browser gate.

## v0.6.3 Summary Hardening & Polish

Run every truncated v6 result boundary and malformed summary count, kind, entity/classification combination, reserved byte, UTF-8 sequence, extreme length and trailing-byte check. Verify combined 10,000-entity plus summary bounds, a 10,000-event v6 summary-source replay, real WASM memory growth, and copied-result lifetime. Retain every previous Node, Rust, browser, storage, privacy, and accessibility regression.

## v0.7.0 Routines

Run `cargo test`, the `web/wasm/kin-engine.test.mjs`, `routines.test.mjs`,
and `modes.test.mjs` suites, and the complete browser runner after a release
Wasm build. `rust/src/routine_tests.rs` holds independent v7 wire fixtures;
`recurrence.rs` covers Gregorian calendar primitives.
`scripts/routine-regression.mjs` exercises real IndexedDB/Wasm lifecycle,
boundaries, stale keys, quota/abort/retry, cross-tab races and keyboard focus.
`scripts/browser-regression.mjs` also verifies mode persistence, paused
routine actions, and planning-date capture/edit/clear/persistence with local
Today/Tomorrow shortcuts. Existing suites retain explicit legacy protocol
fixtures.

## v0.22.0 Lightweight Planning Dates

Run Rust command/replay tests and `web/wasm/kin-engine.test.mjs` after
rebuilding the release WASM. The browser regression exercises the native date
input, local Today/Tomorrow resolution, clear behavior, event persistence,
replay, accessibility naming, and focus restoration.
See [V0.7.0](planning/V0.7.0.md) for the full matrix and actual release evidence.

## v0.23.0 Calendar Interoperability

Run `npm run test:calendar` for RFC text escaping, UTF-8 line folding, all-day
date encoding, deterministic ordering, stable UIDs, exclusion of completed,
archived, and undated Items, invalid civil dates, and 10,000-event/16 MiB
bounds. The full Edge regression verifies the accessible Lists action,
unencrypted-download disclosure, MIME type, filename, local iCalendar payload,
and that clearing the last active planning date disables export. No event,
IndexedDB row, or network request is produced by download.

## v0.24.0 Useful Household History

Rust replay tests cover Item creation, effective area/date/status/Step
changes, idempotent no-ops, and deterministic equal-time distributed replay.
Protocol tests verify the exact protocol-17 timestamp extension while
preserving protocol 16. Real-WASM and Edge regressions verify the projected
timestamp, date-only UI label, and update after an effective change.

## v0.25.0 Search & Filters

Run `node --test projects/kin/web/search.test.mjs` for case-insensitive
substring matching across unarchived household text, active checklist Steps,
combined Item-only filters, unassigned Areas, empty queries, and the 100-result
display bound. The full Edge browser regression verifies labeled keyboard
controls, live result feedback, filter isolation from Handoff/Talk/Note
results, archived-record exclusion, navigation, focus retention, and clearing.
No Rust/WASM or persistent-format migration is introduced.

## v0.18.0 Richer Routine Scheduling

Run the same Rust, WASM, and browser routine suites after rebuilding
`web/wasm/kin_engine.wasm`. `rust/src/recurrence.rs` covers creation-anchored
14-day intervals, monthly starts, Gregorian boundaries, and invalid keys;
`rust/src/routine_tests.rs` and `web/wasm/routines.test.mjs` verify protocol
12 and older-protocol rejection; `scripts/routine-regression.mjs` covers the
accessible cadence selector, current period labels, completion reset, and
real IndexedDB persistence. No storage migration is expected.

## v0.9.3 Encrypted Sync Gate

Run from the repository root after the release WASM build:

```powershell
cargo test --manifest-path projects/kin/Cargo.toml
node --test projects/kin/web/sync/crypto.test.mjs
node --test projects/kin/server/pairing-service.test.mjs projects/kin/server/pairing-sync-keys.test.mjs projects/kin/server/sync-service.test.mjs projects/kin/server/sync-http.test.mjs projects/kin/server/sync-e2e.test.mjs
node --test projects/kin/web/wasm/kin-engine.test.mjs projects/kin/web/wasm/routines.test.mjs projects/kin/web/wasm/modes.test.mjs
node projects/kin/scripts/browser-regression.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
```

The release gate includes: exact canonical-byte encrypt/relay/decrypt roundtrip; ciphertext opacity; wrong-key, wrong-AAD/identity, modified nonce/tag/signature, wrong recipient, and expiry failures; same-member and new-member device enrollment; duplicate/mismatched provisioning retries; revocation and stale-session rejection; single-winner epoch CAS and the 128-epoch bound; 16-device/128-grant bounds; equal-Lamport delivery in different arrival orders; archive/concurrent-mutation conflict behavior; local clock advancement; exact-envelope retries after relay cursor reset; crash-safe remote event/replay/cursor commit; catch-up cursor independence; non-destructive v1→v2 IndexedDB migration; CSP, accessibility modes, and legacy v1-v7 compatibility.

Identity-binding relay tests cover the 256-record boundary: exact canonical retry succeeds at capacity, conflicting reuse and genuinely new overflow fail without mutation, exact duplicates within one request commit once, and mixed conflict/overflow batches remain atomic. The final available slot is accepted while the next unique binding is rejected.

The browser-native synthetic storage fixture uses an isolated database and the real release WASM. It verifies byte-preserving migration, idempotent encrypted retry, cursor rollback rejection, cross-order v8 state replay versus arrival-ordered catch-up, and retained-envelope requeue after process-local relay loss. Service restart tests explicitly assert that accepted relay ciphertext is lost and acknowledgement is not durable; local canonical history remains intact. These tests do not certify cross-browser behavior, assistive technology, physical multi-device behavior, production durability, or an independent cryptographic audit.

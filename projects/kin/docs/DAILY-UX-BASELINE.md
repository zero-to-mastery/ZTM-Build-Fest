# Kin Daily UX Baseline

This PR records the existing daily task experience without changing its domain,
storage, encryption, synchronization, or visual behavior. Measurements are
diagnostic baselines, not performance budgets.

## Implementation map

| Concern | Existing implementation | Regression evidence |
| --- | --- | --- |
| Today composition | `web/today-view.js`; rendered by `web/components/kin-today.js` | `web/today-view.test.mjs`, `web/daily-ux-fixtures.test.mjs`, workspace browser journey |
| Task capture | `web/components/kin-compose.js`; orchestration in `web/components/kin-app.js` | workspace and mobile browser journeys |
| Completion/reopen | canonical commands from `kin-item`; app persists then replays | Rust command/state tests, real-WASM tests, workspace and core browser journeys |
| Navigation | `web/routes.js`; five-destination shell in `kin-app` | route unit tests and workspace browser journey |
| Rust projections | `rust/src/{command,event,state,protocol}.rs` through `web/wasm/kin-engine.js` | Rust tests, real-WASM Node tests, deterministic daily projection fixtures |
| Encrypted offline persistence | `web/storage/encrypted-idb.js` and `event-store.js` | encrypted storage tests plus browser offline create/reload checks |

The named fixtures in `web/daily-ux-fixtures.js` are stable browser-facing Rust
projection records for empty, earlier unfinished ("overdue" in test naming),
due-today, upcoming, and completed states. Product copy deliberately says **Earlier
plans** and **still open**, not overdue or late.

## Interaction baseline

Counts start with focus already in the Today capture, matching the primary
daily entry point. Typing a title is one text-entry interaction and pressing
Enter is one submit interaction: **2 interactions to create**. Completing the
visible row is **1 interaction**. Reaching Today from another primary
destination adds one navigation interaction. Pointer and keyboard activate the
same native controls.

The browser regression measures `performance.now()` from submit to the app's
idle projected state and from completion activation to idle projected state.
It prints `METRIC daily-ux ...` with create/complete milliseconds and the above
counts. Timing varies by machine and is recorded with each verification run;
the regression checks only that both measurements are finite and positive.

Recorded baseline on 2026-10-14: **76.20 ms create** and **53.90 ms
complete**, using Edge 155.0.4283.45, Node 22.13.0, Windows x64, and the local
release WASM. This is one warmed headless run with synthetic household data.

## Keyboard and accessibility baseline

- Today capture uses labeled native input/select/button controls and submits
  with Enter. Successful creation clears the title and restores focus to it.
- Completion is a native button with an action-specific accessible name and
  pressed state. After replay moves the row, focus is restored to the same
  item's Reopen action.
- Primary navigation uses links and marks the current destination. Details use
  a native dialog at narrow widths and Escape returns focus to the opener.
- Status is exposed through polite text; errors use an alert. State and
  classification are not communicated by color alone.
- Automated coverage checks visible 3px focus, 48px controls, forced colors,
  reduced motion, increased text spacing, 200% page-scale emulation, and 320px
  reflow without horizontal overflow. Page-scale emulation is not native zoom.

## Daily resilience coverage

The complete browser runner covers a locally encrypted create while network
conditions are offline, reload and Rust replay from IndexedDB, keyboard
completion, focus restoration, and a 320px Today viewport. The focused daily
journey additionally creates and completes a due-today task through the real
store and WASM projection while recording latency and interaction counts.

## Actionable Today follow-up

The actionable Today dashboard ([WORKSPACE-UX](WORKSPACE-UX.md) §3.3–3.6) adds
Coming up, a task summary, empty and all-done states, and focus continuity
when a completed row leaves its section. Completion still uses the existing
row button, canonical command and busy guard, so the interaction count stays
**1 interaction to complete**. `scripts/today-actionable-regression.mjs`
prints `METRIC today-actionable` with the completion latency and the cost of
one full Today render with the accumulated test household. These are
diagnostic samples, like the baseline above, not budgets.

## Keyboard commands follow-up

Ctrl/Cmd+K, N, / and ? ([WORKSPACE-UX](WORKSPACE-UX.md) §5.3) make Quick add
and Search reachable without a pointer. Pressing N from any workspace page is
**1 interaction to open capture**, the same as the Quick add button. The
palette adds no new save path: completion and capture interaction counts are
unchanged.

## Bulk actions follow-up

Completing N selected items is **N + 2 interactions** with a pointer (Select,
N checkboxes, Complete N), or fewer with Select all. Undo is one more. The
browser suite prints `METRIC bulk-complete` for a 25-item batch: total and
per-item milliseconds through the real encrypted store and WASM. Commands run
one at a time and yield to the event loop between IndexedDB transactions. This
is a diagnostic sample, not a budget.

## Repeating tasks follow-up

A one-off Quick add is unchanged: **2 interactions to create**. A repeating
task adds two: open Repeat and choose a schedule (**4 interactions**, or one
more for a schedule further down the list). Completing its current occurrence
from Today is **1 interaction**, the same row control as any task. Changing or
stopping a schedule is Schedule, choose, confirm (**3 interactions**). Today
shows one row per repeating task, never its future occurrences.

## Hardening follow-up

[DAILY-UX-HARDENING](DAILY-UX-HARDENING.md) records the release-readiness
audit, its fixes, and repeated samples (median and p95) for Quick add commit,
Today render, replay, palette open/filter, and bulk completion of 10 and 50
items. Interaction counts are unchanged.

## Known gaps

- Timings are local end-to-end samples, not statistically rigorous benchmarks
  and not representative of low-end physical phones.
- Firefox, Safari, native desktop zoom, NVDA, VoiceOver, installed-PWA launch,
  and physical-device offline transitions remain manual checks.
- Headless automation validates accessible names, focus ownership, semantic
  controls, and live-region wiring; it cannot certify announcement quality or
  visual contrast perception.

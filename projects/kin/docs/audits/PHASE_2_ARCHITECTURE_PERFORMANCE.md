# Phase 2 architecture and performance measurements

**Measured:** 2026-10-16  
**Candidate:** v0.47.0 plus the reliability landing stack  
**Environment:** Windows x64, Node 22.21.1, Edge 155.0.4283.45

These measurements decide whether narrowly scoped architecture work is
justified. They are not production certification or a substitute for the
physical-device matrix.

## Busy-state traversal

Command:

```text
node scripts/core-performance.mjs --browser <edge> --json target/phase2-busy-baseline.json
```

`core-performance.mjs` now isolates `StatusController.setBusy(true)` and
`setBusy(false)` around the shipped application. Figures are medians after one
warm-up.

| History | Rendered controls | Busy on | Busy off | Round trip | No-change app refresh |
|---|---:|---:|---:|---:|---:|
| 1,000 short events | 4,166 | 8.8 ms | 8.6 ms | 17.4 ms | 33.8 ms |
| 9,980 short events | 40,086 | 95.8 ms | 105.8 ms | 201.6 ms | 649.6 ms |
| 9,980 events × 4 KB | 40,086 | 96.9 ms | 103.7 ms | 200.6 ms | 674.5 ms |

The cost scales with rendered controls, not canonical byte size. At the local
history bound the traversal alone blocks the main thread for about 0.2 s per
operation. This is material and justifies a native disabled-fieldset prototype.
The status, alert and route-announcement regions must remain outside the
disabled control boundary or remain non-form descendants whose live-region
semantics are verified.

### Native fieldset result

The prototype replaces per-component list traversal with one native disabled
fieldset around the workspace. Header Quick add, Lock, the bounded detail view
and the external retry control remain explicit. Status, alert, state and route
announcements remain outside the fieldset. Focus intent is captured before
native disabling and settled through component-level constant-cost hooks after
the fieldset re-enables, but only when focus was actually lost. Unlocked
security settings remain inside the workspace fieldset and are disabled during
an app-wide save, in addition to their own one-security-operation guard. The
locked/protecting surface is rehomed outside the unavailable workspace so its
Lock or unlock action remains usable.

| History | Traversal baseline | Native fieldset | Reduction |
|---|---:|---:|---:|
| 1,000 short events | 17.4 ms | 1.6 ms | 90.8% |
| 9,980 short events | 201.6 ms | 30.6 ms | 84.8% |
| 9,980 events × 4 KB | 200.6 ms | 30.0 ms | 85.0% |

The result is material and keeps canonical, storage and component ownership
unchanged. The browser regression verifies native click suppression, focus and
draft restoration, lock/unlock reconstruction, narrow/wide layouts, forced
colors and reduced motion.

## Cold relay synchronization

Command:

```text
node scripts/relay-performance.mjs --json target/phase2-relay.json
```

The harness uses the real process-local relay, its 20-event binary pages, Web
Crypto signature verification/decryption, the coordinator's conservative
200-request sliding-window budget and one release-WASM replay. Pulls no longer
clear the relay's rate buckets. Fixture construction still clears buckets only
between source-device push batches, because the fixture represents history
accumulated across earlier rate windows; its time is reported but excluded.

| History | Pages | Wire bytes | Pull wall clock | WASM replay | Catch-up wall clock | Budget wait | Peak requests/min |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1,000 events | 50 | 306,893 | 166.5 ms | 13.1 ms | 179.6 ms | 0 ms | 50 |
| 10,000 events | 500 | 3,078,894 | 120.54 s | 82.7 ms | 120.62 s | 118.32 s | 200 |

The earlier 45.17-second and 496.49-second cadence claims were not valid
production measurements: the harness cleared `rateBuckets` before every pull
and then added a modeled five-second delay. The corrected wall-clock figures
above exercise the rate policy instead. Crypto and replay still do not justify
a protocol rewrite; at the local maximum, the deliberate request budget is the
dominant cost.

### Bounded continuation result

The coordinator now schedules another capped five-page pass on the next event
loop turn whenever the relay reports `hasMore` and the committed cursor moved
forward. Continuation passes perform only pull, verify, commit and cursor
advance. Status, device-directory, binding and bootstrap work is not repeated;
pending pushes and attachment reconciliation run after the final page. Each
pass publishes at most one projection update. A catch-up lasting more than 30
seconds discards that cached authorization context for one full pass, refreshing
status, the trusted-device directory and identity bindings before continuing
with a fresh context. The request budget remains in force during that refresh.
Stop, lock, errors and terminal states end the chain, while relay throttling
remains a quiet “Catching up…” state and resumes after its hint or a bounded
fallback delay.

The 200-request client window stays below the relay's 256-request limit. It
does not delay the 1,000-event fixture and makes the honest 10,000-event
process-local lower bound about 120.62 seconds rather than the previously
claimed 1.49 seconds. These measurements include the budget wait and exclude
only fixture construction, real network transport and IndexedDB commit.
Cross-network browser and physical-device measurements remain required before
treating them as end-to-end results.

## Archive restoration on constrained hardware

Command:

```text
node scripts/security-storage-regression.mjs <edge> --performance-only --maximum-payload --cpu-throttle 4
```

Edge DevTools throttled renderer CPU 4×. This is a repeatable constrained-CPU
simulation, not a physical low-end-device claim. The harness uses real browser
crypto, IndexedDB and release WASM and verifies every restored canonical record
against its source SHA-256 digest. Phase timings exclude the harness's 1.2 s
pre-phase collection wait; the end-to-end restore timing includes it.

| History | Archive | Export | Restore end to end | Restore phase | Restore peak working set | Exact |
|---|---:|---:|---:|---:|---:|---|
| 1,000 short events | 0.15 MiB | 1.46 s | 3.74 s | 2.00 s | 503 MiB | yes |
| 10,000 short events | 1.52 MiB | 4.70 s | 20.34 s | 16.79 s | 389 MiB | yes |
| 10,000 events × 4 KB | 40.25 MiB | 2.95 s | 77.37 s | 73.89 s | 1,024 MiB | yes |

The maximum-payload case is materially slow and memory-heavy, but it is a
synthetic supported bound and the recovery path remains exact and atomic. No
restore architecture change is made from this result alone. Physical-device
archive transfer remains a release gate; if that reproduces memory pressure or
termination, optimize the protect-and-stage phase without weakening atomic
promotion, canonical validation or archive compatibility.

## Decisions

1. Prototype native fieldset disabling because the measured main-thread cost is
   material.
2. Use immediate bounded relay continuation because the measured cadence, not
   the protocol or crypto, dominates cold synchronization.
3. Do not redesign archive restoration yet. Carry its constrained maximum as a
   known release risk into physical-device acceptance.
4. Do not change persistent formats, Rust/WASM ownership, relay storage,
   cryptography or archive atomicity from these measurements.


# Refactor track — performance baseline

Baseline for the `kin-refactor-track` slices and the record each slice is
compared against. A slice may not regress a measured stage by more than 10%
without a written justification in its report.

## How it is measured

`node scripts/core-performance.mjs --browser <chromium>` (builds the release
WASM first if it is missing). Every figure is a median after one warm-up.

- **Node stages** (real release WASM, no storage; 7 samples): request encode,
  copy into WASM memory, Rust replay plus projection encode, copy-out plus JS
  decode. Inputs are `ITEM_ADDED` events through the Rust command encoder.
- **Browser stages** (real IndexedDB, Web Crypto and the shipped app in a
  temporary headless profile): native IDB read of every protected row (4
  samples), decryption of every row (4), store unlock to the first projection
  (1), store-level refresh (`getCatchUpState` plus replay; 5) and command
  (`append`; 5), and in the app page: `renderState()` (5), the full
  `refreshFromEvents()` a peer tab runs, including render (5), and unlock
  through the app's recovery-key path (1).
- Datasets: 1,000 short-text events (24-byte text), and 9,980 short-text and
  9,980 × 4,096-byte events. Browser fixtures stop 20 events short of the
  10,000-event store limit so the command samples can append. The table rows
  still say "10k".

Environment: Windows 11 x64, Node 22.13.0, Edge 155.0.4283.45, Rust 1.93.0.
Measurements are from one machine with nothing else running. They are evidence
for relative change, not a device-class benchmark.

## Baseline (`kin-development` at `d616eef` plus the Phase 0 bridge changes, before the arena)

| Stage (ms) | 1k short | 10k short | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Request encode | 0.24 | 0.95 | 12.57 |
| Copy into WASM | 0.01 | 0.15 | 6.55 |
| Rust replay + encode | 1.07 | 9.90 | 83.73 |
| Copy-out + JS decode | 4.47 | 32.11 | 80.46 |
| IDB read (all rows) | 12.1 | 119.2 | 492.8 |
| Decrypt (all rows) | 123 | 1,445 | 10,711 |
| Store unlock → projection | 275 | 3,444 | 24,456 |
| Store refresh | 128 | 1,515 | 10,556 |
| Store command | 133 | 1,516 | 10,743 |
| App `renderState()` | 269 | 2,498 | 2,321 |
| App peer refresh (incl. render) | 420 | 4,688 | 13,538 |
| App unlock (recovery key) | 664 | 5,998 | 24,940 |

Observations that drive the slices:

- Decryption dominates every storage path (H1). A refresh or command decrypts
  the whole log, and unlock decrypted it twice (`ensureContext` then
  `getCatchUpState`).
- Rust replay is small next to everything around it. At 10k short events JS
  decode (32 ms) costs three times the replay (10 ms) (H2, H3).
- Rendering every section costs about 2–2.5 s at 10k events whether or not
  anything changed (H5); after Slice 1 it dominates the app refresh.

## Slice 1 — session plaintext arena

| Stage (ms) | 1k short | 10k short | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Request encode (Node, array input) | 0.21 | 0.76 | 8.70 |
| Copy into WASM | 0.01 | 0.14 | 5.14 |
| Rust replay + encode | 1.03 | 9.91 | 67.38 |
| Copy-out + JS decode | 4.52 | 33.83 | 58.49 |
| IDB read (all rows) | 11.3 | 88.7 | 454.4 |
| Decrypt (all rows) | 117 | 1,188 | 8,390 |
| Store unlock → projection | 142 | 1,447 | 9,223 |
| **Store refresh** | **5.4** | **50.1** | **194** |
| **Store command** | **6.8** | **57.2** | **226** |
| App `renderState()` | 169 | 2,023 | 2,023 |
| App peer refresh (incl. render) | 219 | 2,541 | 2,856 |
| App unlock (recovery key) | 416 | 3,439 | 12,616 |

The "IDB read" and "decrypt" rows are the raw full-log costs, measured
directly. With the arena, normal operation pays them once, at unlock.

**D1 gate (decrypted history in memory only if it measurably helps): passed.**

- Store refresh at 10k events fell from 1,515 ms to 50 ms (30×), under the
  100 ms target. Commands fell from 1,516 ms to 57 ms (27×). With 4 KB events
  they fell from about 10.6 s to about 0.2 s.
- Decryption no longer grows with history on refresh or command; only rows
  after the arena tail are decrypted (one row for one new event, asserted by
  the two-tab regression). The remaining refresh cost is the full replay,
  decode and copy, which still grow linearly (about 5 ms per 1,000 short
  events). Phases 3–5 (Slices 6–8) target that work.
- Unlock is faster, not slower: one full decrypt instead of two (store unlock
  3,444 → 1,447 ms at 10k; app unlock 5,998 → 3,439 ms).
- The app's peer refresh is still about 2.5 s at 10k because `renderState()`
  rebuilds every section (about 2.0 s). That is H5, the subject of Slice 4. It
  does not affect the store-level gate, which measures the history path the
  arena changes.
- No Node stage regressed beyond noise. The 10k decode moved +5% between
  runs, inside run-to-run variance; the 4 KB stages improved because command
  requests no longer copy the history twice.

## Slice 2 — protocol 24 only

Two runs, because the first showed movement in stages this slice did not
touch (the Node array encode and the app render); the second, with nothing
else running, is the comparison of record.

| Stage (ms) | 1k short | 10k short | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Request encode | 0.25 | 0.74 | 8.48 |
| Copy into WASM | 0.01 | 0.14 | 5.10 |
| Rust replay + encode | 1.09 | 9.93 | 62.99 |
| Copy-out + JS decode | 3.78 | 31.93 | 55.61 |
| Store unlock → projection | 146 | 1,416 | 9,463 |
| Store refresh | 5.6 | 48 | 180 |
| Store command | 7 | 55 | 242 |
| App `renderState()` | 177 | 2,144 | 2,216 |
| App peer refresh (incl. render) | 236 | 2,536 | 2,697 |
| App unlock (recovery key) | 407 | 5,245 | 12,399 |

Every multi-sample stage is within ±10% of Slice 1 except render at 10k short
(+6%, inside the first run's spread). App unlock at 10k varied between runs:
3,439 ms (Slice 1), 4,027 ms (Slice 2, first run) and 5,245 ms (Slice 2,
second run). It is one unrepeated sample of the app's whole boot-and-unlock
path, and the replay code under it is unchanged, so this is run-to-run
variance, not a regression. The store-level unlock, which is sampled more
directly, is 1,416 ms against 1,447 ms. Replay itself is unchanged: decoding
and encoding run the same protocol-24 code without version branches, and the
golden fixtures are byte-identical.

## Slice 3 — shared component helpers and the `<kin-app>` split

| Stage (ms) | 1k short | 10k short | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Rust replay + encode | 1.10 | 9.88 | 64.88 |
| Copy-out + JS decode | 3.98 | 30.80 | 58.47 |
| Store unlock → projection | 142 | 1,453 | 9,703 |
| Store refresh | 6 | 47 | 161 |
| Store command | 7 | 54 | 202 |
| App `renderState()` | 185 | 2,245 | 2,050 |
| App peer refresh (incl. render) | 228 | 2,594 | 2,959 |
| App unlock (recovery key) | 409 | 3,495 | 13,258 |

The split moves code without changing it, and no stage moved by more than
10% against Slice 2. The largest moves were app peer refresh at 10k × 4 KB
(+9.7%) and render at 10k short (+4.7%), both inside the run-to-run spread
recorded above. The added indirection (`this.ctx.<controller>`) is one
property lookup per call.

## Slice 4 — incremental rendering

`scripts/core-performance.mjs` gained two app stages: a peer refresh after one
new Handoff (Items untouched), and a full render after every projection array
was replaced, so nothing can be skipped. The existing render and refresh
stages repeat with nothing changed. "Before" is the Slice 3 commit measured
with this same harness. "After" is the slice's final build.

| Stage (ms) | 1k before | 1k after | 10k before | 10k after | 10k × 4 KB before | 10k × 4 KB after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Rust replay + encode (Node) | 1.08 | 1.04 | 10.18 | 9.67 | 64.36 | 66.30 |
| Copy-out + JS decode (Node, full) | 4.19 | 3.09 | 34.27 | 17.15 | 57.73 | 50.69 |
| Store refresh | 6 | 3 | 49 | 30 | 194 | 142 |
| Store command | 6 | 5 | 56 | 43 | 231 | 196 |
| App `renderState()`, nothing changed | 174 | 0 | 1,856 | 0 | 2,089 | 0 |
| App peer refresh, nothing changed | 227 | 32 | 2,648 | 524 | 2,868 | 654 |
| App peer refresh, one new Handoff | 198 | 19 | 2,396 | 509 | 2,407 | 347 |
| App full render (all arrays replaced) | 181 | 171 | 1,854 | 1,942 | 2,143 | 2,156 |
| Store unlock → projection | 150 | 142 | 1,522 | 1,521 | 9,812 | 9,487 |
| App unlock (recovery key) | 648 | 413 | 3,554 | 3,479 | 12,721 | 13,034 |

- A refresh that changes no section, or only small ones, no longer re-renders
  10,000 Item rows: 2.6 s → 0.5 s at 10k. A render with unchanged inputs costs
  nothing.
- Full JS decode is faster without reuse too (34 → 17 ms at 10k). Each
  section decodes against its own bounds, and IDs convert to hex through a
  lookup table.
- Rust replay + encode at 10k × 4 KB is +3% in the table's sample and about
  +8% across repeated runs (66–67 ms against 61–62 ms), inside the 10% budget. That is the exact comparison of a 40 MB Items section with the
  previous projection. A first version used the slice `==`, which on wasm32
  is a byte-at-a-time memcmp (+20%). Comparing eight bytes at a time brought
  it inside the budget.
- Full render is within ±5% of before (+4.7% at 10k short, +0.6% at 4 KB),
  inside the run-to-run spread recorded for Slices 2 and 3. It does the same
  work.
- The remaining ~0.5 s of an unchanged refresh at 10k is mostly the busy
  toggle: `setBusy` disables and re-enables every control in the 10,000-row
  lists. It is not addressed here.

## Slice 5 — component splits

Slice 5 moves code between files and adds `<kin-bulk-bar>`. Replay, decode,
storage and the render work itself are unchanged, so the gate is "no
regression". The slice was measured back to back against its parent commit
(4e6fdf1), with one more run of the slice afterwards:

| Stage (ms) | 10k before | 10k after (run 1 / 2) | 10k × 4 KB before | 10k × 4 KB after (run 1 / 2) |
| --- | ---: | ---: | ---: | ---: |
| App peer refresh, nothing changed | 550 | 514 / 659 | 704 | 750 / 770 |
| App peer refresh, one new Handoff | 509 | 458 / 620 | 420 | 368 / 380 |
| App full render | 2,339 | 2,295 / 2,798 | 2,258 | 2,497 / 2,171 |
| Store unlock → projection | 1,703 | 1,973 / 1,442 | 10,692 | 10,834 / 10,054 |
| App unlock (recovery key) | 4,256 | 4,959 / 3,650 | 15,372 | 19,210 / 12,925 |

The machine was noisy during these runs: two runs of the same build differ by
up to ±20%, in both directions. The stages that moved most (store unlock, app
unlock) run code Slice 5 does not touch. The view stages fall either side of
the parent depending on the run. No stage is consistently slower. The Slice 4
numbers above came from a quieter run, so they are not directly comparable
with these.

## Slice 6 — the engine holds the history

The Node stages change with the ABI. A refresh used to encode the whole
history into a request and copy it into WASM memory. Now the instance keeps
the history, and the host appends what changed:

| Node stage (ms) | 1k | 10k | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Before: request encode + copy, every replay | 0.3 | 0.9 | 15.7 |
| After: load the whole history, once per session or epoch | 0.3 | 2.3 | 24.6 |
| After: append one event, per refresh | 0.00 | 0.00 | 0.01 |
| Rust replay + encode (before / after) | 1.1 / 1.0 | 9.9 / 9.9 | 79.3 / 64.9 |

Replay itself did not change; its 10k × 4 KB difference is run-to-run noise.

Measured back to back against the Slice 5 commit (dab2332):

| Browser stage (ms) | 10k before | 10k after | 10k × 4 KB before | 10k × 4 KB after |
| --- | ---: | ---: | ---: | ---: |
| Store refresh | 39 | 31 | 209 | 140 |
| Store command | 64 | 50 | 265 | 207 |
| App peer refresh, nothing changed | 660 | 570 | 632 | 598 |
| App peer refresh, one new Handoff | 510 | 575 | 414 | 383 |
| App full render | 3,164 | 2,822 | 2,288 | 2,075 |
| Store unlock → projection | 2,227 | 1,676 | 10,876 | 11,694 |
| App unlock (recovery key) | 5,822 | 4,534 | 15,508 | 16,187 |

- Store refresh and command, the stages this slice targets, are 21–33%
  faster. They no longer copy the history into WASM on every call.
- Loading the whole history (unlock, a new store generation) validates every
  record once, in Rust, on append. It costs about what the old per-call
  encode and copy cost.
- The app stages and unlock moved in both directions between sizes. That is
  the same ±20% machine noise recorded for Slice 5, not a pattern: the
  slice's view changes do not touch those paths.
- Rust holds a copy of the history in WASM memory with an eighth of
  headroom. Before, each replay's request copy was freed but never zeroed,
  and WASM memory never shrinks, so the resident size is about the same
  (THREAT-MODEL.md).

## Slice 7 — replay checkpoint

| Node stage (ms) | 1k | 10k | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Full replay + encode (Slice 6 / Slice 7) | 1.0 / 0.9 | 9.6 / 9.7 | 67.5 / 62.1 |
| Replay + encode after one more event, from the checkpoint | 0.4 | 3.6 | 30.2 |

What remains of the incremental projection is decoding every held record
(the summary and command checks still read them), copying the state in
`finalize`, and encoding. Slice 8's zero-copy decoding targets the first.

Browser stages, two runs of the Slice 6 commit (54fa162) and two of Slice 7:

| Stage (ms) | 10k before | 10k after | 10k × 4 KB before | 10k × 4 KB after |
| --- | ---: | ---: | ---: | ---: |
| Store refresh | 38 / 35 | 22 / 28 | 172 / 151 | 118 / 97 |
| Store command | 50 / — | 40 / 48 | 186 / — | 146 / 137 |
| App peer refresh, nothing changed | 462 / 527 | 513 / 518 | 594 / 653 | 634 / 561 |
| App peer refresh, one new Handoff | 412 / 483 | 445 / 493 | 330 / 337 | 334 / 294 |
| App full render | 2,240 / 2,292 | 2,059 / 2,243 | 2,494 / 2,496 | 2,098 / 2,160 |

- Store refresh and command, which replay in the engine, are consistently
  faster.
- The app stages are dominated by the DOM (the busy toggle over 10,000 rows)
  and overlap between the two builds. A first single-run comparison showed
  app refresh at 10k short +12%. The second baseline run put both builds in
  the same range, so it is noise, not a regression.

## Slice 8 — reading events in place

Two runs each of the Slice 7 commit (e98d489) and of Slice 8:

| Node stage (ms) | 10k before | 10k after | 10k × 4 KB before | 10k × 4 KB after |
| --- | ---: | ---: | ---: | ---: |
| Full replay + encode | 9.7 / 10.0 | 8.9 / 9.2 | 69.6 / 65.3 | 46.8 / 54.3 |
| Replay + encode after one more event | 3.7 / 3.7 | 2.6 / 2.6 | 35.3 / 32.4 | 15.9 / 17.9 |

Natively, decoding the held records for an incremental projection at
10k × 4 KB fell from 38 ms to 0.1 ms. The rest of that projection is the
`finalize` copy and encoding; reserving the encode buffer once removed its
repeated growth copies.

| Browser stage (ms) | 10k before | 10k after | 10k × 4 KB before | 10k × 4 KB after |
| --- | ---: | ---: | ---: | ---: |
| Store refresh | 29 / 28 | 29 / 29 | 121 / 120 | 102 / 134 |
| Store command | 52 / 45 | 46 / 50 | 166 / 162 | 142 / 156 |
| App peer refresh, nothing changed | 566 / 559 | 518 / 614 | 570 / 646 | 636 / 709 |
| App full render | 3,360 / 2,268 | 2,247 / 3,294 | 2,221 / 3,242 | 2,919 / 3,344 |

- The engine stages halved at 10k × 4 KB.
- The browser stages are dominated by IndexedDB, JS decoding of the
  projection and the DOM. This machine's run-to-run spread is wider than any
  difference between the builds (full render ranges over 1 s within one
  build), so they show neither a gain nor a regression.

## Slice 9 — streaming archives

`node scripts/security-storage-regression.mjs <edge> --performance-only
--maximum-payload` (per-phase memory added in the Slice 9 prep commit).
Memory is the renderers' growth inside the phase over the sample just before
it, after a forced collection; the before figures are the prep commit
(71ce7a0), the after figures two runs of Slice 9.

| 10k × 4 KB | Before | After |
| --- | ---: | ---: |
| Export time | 20.0 s | 0.22 / 0.23 s |
| Export, private bytes growth | +955 MB | +147 / +151 MB |
| Export, working set growth | +790 MB | +147 / +132 MB |
| Restore (check + write) time | 26.1 s | 15.0 / 14.6 s |
| Restore, private bytes growth | +525 MB | +219 / +166 MB |
| Restore, working set growth | +511 MB | +221 / +167 MB |
| Archive size | 60.2 MB | 42.2 MB |

- Gate (peak memory at least halved): export is at 16% of its old growth,
  restore at 32–42%. Both round trips are exact (per-record SHA-256).
- Export no longer decrypts the store or serializes the household as one
  value: it reads the session arena and seals 256-event segments into one
  buffer. Restore is now dominated by protecting each row for IndexedDB
  (about 14 s of the 15); the rows must all be ready before the single atomic
  write, so they are held until it.
- At 10k short events the archive fell from 6.06 to 1.59 MB.

`core-performance.mjs`, the prep commit and Slice 9 back to back (three
pairs): the Node stages are unchanged (10k × 4 KB full replay 55.9 / 60.3
ms, history load 29.3 / 30.0 ms, within run-to-run spread). The browser
stages overlap between builds; 1k app unlock, which read 100–150 ms slower in
two pairs, read 512 / 488 ms in the third. The mirror's 4 MiB batches only
change how a whole history enters the engine.

## Slice 10 — server hygiene

No stage of `core-performance.mjs` touches the server, so there is nothing
to compare there. What changed in size:

| 20-envelope sync batch | JSON | Binary |
| --- | ---: | ---: |
| 150-byte events | 11,994 B | 6,288 B |
| 1 KB events | 34,654 B | 23,288 B |
| 4.2 KB events | 119,994 B | 87,288 B |

| Server module (lines) | Before | After |
| --- | ---: | ---: |
| `durable-store.mjs` | 2,299 | 429 core + 8 modules of 96–464 |
| `pairing-service.mjs` | 1,901 | 146 core + 8 modules of 131–355 |

- Over 400 lines: `durable-store/schema.mjs` (464, one 428-line migration
  method kept whole in a pure move) and `durable-store/envelopes.mjs` (447).
- An oversized body now costs the server at most its limit: a declared
  length over it is refused before the body is read.

# Timelines and historical evidence

For simultaneous yearly planes and project continuity trails, see
[Temporal Stack](temporal-stack.md). Its Open Timeline control retains the
one-frame navigation and comparison behavior described here.

Timelines compile a bounded series of scenes through the same Rust/WASM layouts and mappings as ordinary visualizations. Every timeline has an explicit reference date and ends with the current input records at that date. SVG renders that final scene as a static fallback; HTML and the web component add Previous date/Next date controls with an evidence label.

```js
import { createTimeline, renderSceneHTML } from '@constellation/core';
const scene = createTimeline('example', currentRecords, {
  referenceDate: '2026-09-01T00:00:00Z', animate: false,
}, {
  snapshots: [{ date: '2024-01-01', records: savedRecordsFrom2024 }],
});
const html = renderSceneHTML(scene);
```

Snapshots contain actual records saved by your source. Their star counts, styles, relationships and other values are used as supplied. Constellation cannot reconstruct historical star counts, project architecture or contributor membership from today's GitHub response.

Alternatively provide `{ dates: ['2022-01-01', '2024-01-01'] }`. These frames include only projects with known creation dates at or before each date. Future update timestamps and unsupported archive state are removed, but other metrics remain current. The UI explicitly calls these **creation-date views using current metadata**, not historical snapshots. Unknown creation dates are omitted from retrospective frames and remain available in the current view. With neither dates nor snapshots, known creation dates supply the frames.

`temporalMetadata(records)` reports known created/updated dates and source-provided release publication dates. Missing dates remain null; no events are invented. The model uses `timeline.version: 1`, ISO date IDs, ascending frames, and evidence values `snapshot`, `current-metadata`, or `current`. Dates must be unique, no later than the reference date, with at most 64 frames including the current frame.

Configuration can include a `timeline` object with `referenceDate` and either `dates` or `snapshots`. The same `createScene` pipeline compiles it, so CLI HTML export needs no special flags beyond `--format html`. Large snapshot datasets are better supplied through the programmatic API than stored in a share URL. Existing v6 config size limits still apply. The legacy SVG time-lapse feature remains compatible and independent of this explicit timeline model.

The interactive runtime exposes `setFrame(index)` and `frameIndex`, and emits `timeline-change` with `{ index, date, evidence }`. Controls use ordinary buttons and announce the displayed date. Frames are precompiled, requiring no network access or graph recalculation while navigating an export.

## Frame changes

Each supplied snapshot runs through the same transforms, mappings and layout, so nodes can appear/disappear, grow, change color/opacity and relationships, or move. Runtime transitions interpolate shared-node geometry over 300 ms and fade arriving/departing nodes. Shared node groups retain DOM identity; frame navigation preserves camera, local filter and theme. Selection persists only when its nodes remain visible.

Reduced-motion preferences disable interpolation and fades, including when the preference changes during a transition. Rapid navigation cancels the previous transition and cleans up temporary departure graphics. The runtime interpolates compiled coordinates; it does not duplicate Rust layout or path algorithms.

## Scrubbing and comparison

The Date slider navigates the available snapshots; its accessible value includes the actual date and evidence type. Then and Now jump to the first and final frames. `setDate(isoDate)` chooses the nearest available snapshot (earlier wins a tie); no intermediate historical data is invented.

Compare with Now displays the selected frame beside the final scene, synchronizes the camera and reports added/removed node counts. The comparison uses the full compiled frame populations; local interactive filters do not redefine those totals. When the earlier frame uses current metadata, the comparison explicitly warns that its metrics are not historical growth data. The Now panel is static and has isolated SVG styles/IDs. Small screens stack the two views.

Both the exported runtime and web component expose `setFrame(index)`, `setDate(date)` and `compareWithNow(boolean)`. The component reports a descriptive error when these methods are used on a scene without a timeline.

## Caching, sparse history and limits

`createTimelineHost({ maxEntries: 4, maxBytes: 16777216 })` returns an explicit host with `create(account, records, options, definition, runtime)`, `clear()` and `cacheStatistics`. Cached results are cloned, LRU eviction counts keys and values toward the byte budget, and oversized results are not retained. Cancellation is checked before work and before retention. Calls with registered layout engines, node renderers or diagnostic callbacks bypass the cache. Hosts do not share mutable state.

A timeline is limited to 64 frames and 16,384 aggregate frame nodes; lower graph caps or fewer snapshots reduce output size. Empty historical frames are valid. Missing creation dates do not fabricate early membership. Canonical normalized records are accepted, and `temporalMetadata` preserves source-provided activity snapshot dates with finite numeric metrics. The current reference-date frame always uses the current input records.

Run `node scripts/benchmark-timeline.mjs` to measure compilation, cached retrieval and export sizes. A five-frame, 256-node reference example produced about 2.34 MiB of self-contained HTML. Run `node examples/timeline-demo.mjs` for a creation-date example in `dist/timeline-demo.html`. Its evidence labels deliberately distinguish current metrics from historical measurements.

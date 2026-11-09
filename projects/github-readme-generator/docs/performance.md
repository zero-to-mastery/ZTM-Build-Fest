# Performance and browser baseline

Core workflows are tested in Playwright's Chromium, Firefox and WebKit engines. Recent Chromium/Edge, Firefox and Safari are the intended browser targets; real Safari/OS assistive-technology behavior still needs manual acceptance. Static builds support HTTP serving at `/` and `/readme-studio/`, including local Workers, WASM and offline assets, without a router fallback or frontend environment variables.

Smoke tests cover 100 KB, 250 KB, 500 KB and 1 MB READMEs. They assert completion and exact exports rather than tight timing thresholds. At 1 MB, DOM preview and analysis can take seconds, particularly on slower hardware. JavaScript fallback after Worker failure may briefly block the main thread. Download source first when working near browser memory/storage limits.

The large-document browser journey includes editor input, preview, Health, project serialization and exact downloaded source. During the development run, complete 1 MB journeys took roughly 12 seconds in Chromium, 33 seconds in Firefox and 23 seconds in WebKit. These include browser/test overhead and are not input-latency measurements. Maintainer-only pure parse/analysis measurements are in [release evidence](releases/0.9.x.md); run `npm run benchmark:analysis` on the target machine for comparable local observations.

Search limits result cards to 50. Library tests cover 200 saved snippets, 200 badges with bounded remote previews and 100 project forms with deferred details/screenshots. Analysis retains one parsed-source cache. Undo history is capped by both count and estimated bytes; Workers terminate on component removal, stale fallback requests are ignored, and object URLs are revoked after downloads. Repeated-heading preview anchors use per-slug counters to avoid restarting duplicate scans for every heading.

## Bundle checks

`npm run report:bundle` reports raw/gzip sizes by file type and for code chunks, with a 550 kB main-JavaScript release ceiling. This is an explicit regression budget, not a reason to ignore total transfer size. Investigate changed contributors before raising it. Vite's own size advisory stays enabled.

Main code, Markdown rendering/sanitization, syntax highlighting, Worker code and WASM are reported separately. Splitting dependencies reduces the largest chunk; it does not eliminate their transfer cost. The current heavy contributors are highlight.js's common language set, the feature UI, Markdown/DOMPurify, bundled fonts and the optional local WASM core. No new design-system, search-index or PWA dependency was added.

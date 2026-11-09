# v0.1.3 hardening review

Historical release evidence. For the current offline and performance behavior, see [offline](offline.md) and [performance](performance.md).

The release focuses on recovery, keyboard predictability, safe previewing, and large-document usability. It adds no major block family or service integration.

## Performance evidence

Local representative measurements on Windows with two Playwright workers; these are observations, not latency guarantees:

| Engine / input   | App input handler | Incremental edit | Preview completion | Health completion | Section parsing |   Save |
| ---------------- | ----------------: | ---------------: | -----------------: | ----------------: | --------------: | -----: |
| Chromium, 100 KB |            2.5 ms |           114 ms |             333 ms |            497 ms |          8.9 ms |   1 ms |
| Chromium, 250 KB |            4.9 ms |           422 ms |             493 ms |          1,309 ms |         22.6 ms | 1.6 ms |
| Firefox, 100 KB  |              2 ms |            28 ms |             381 ms |          1,604 ms |           14 ms |  <1 ms |
| Firefox, 250 KB  |              2 ms |            55 ms |             569 ms |          4,703 ms |           33 ms |   1 ms |
| WebKit, 100 KB   |              1 ms |            47 ms |             364 ms |            970 ms |           16 ms |   1 ms |
| WebKit, 250 KB   |              1 ms |           114 ms |             550 ms |          1,916 ms |           47 ms |   5 ms |

Preview measurements include the 180ms scheduling delay. Health completion includes Worker startup, transfer, and test/UI overhead. Input handling excludes browser-native bulk paste; the incremental edit column exercises a real keyboard insertion after loading the document. Large native textarea pastes can still vary substantially between browser/platform combinations. The tested baseline is 100 KB, with additional 250 KB smoke coverage and no editor virtualization.

The initial heading-heavy 250 KB Health benchmark took roughly 1.2 seconds. Profiling isolated Marked's callback-result array concatenation; the dedicated side-effect visitor reduced a comparable 250 KB analysis to about 41 ms. Health also runs in a Worker, with one in-flight job and only the latest pending document. Preview, Health, and save have independent 180/600/900ms schedules. Snapshot history has both count and estimated byte limits.

## Security and dependency review

Malicious fixtures exercise scripts, iframes, objects, embeds, forms, active inputs/buttons, event attributes, javascript/data URLs, SVG payloads, malformed nesting, and application overlay classes. Legitimate details, pictures, code highlighting, and disabled task checkboxes remain supported. Shared URL validation applies to builder output and preview; user-authored source never goes through a sanitizer on export.

Installed versions reviewed: Marked 16.4.2, DOMPurify 3.4.16, highlight.js 11.12.0, Playwright 1.63.0, Vitest 4.1.11, Vite 7.3.6. The local npm 10.9 audit command failed against a retired quick-audit endpoint. A request containing the installed lockfile package versions to npm's bulk advisory endpoint succeeded and returned no advisories on 2026-09-27. No dependency upgrade was justified by that result; it is not a guarantee against unknown vulnerabilities.

The production main JavaScript is about 335 KB (111 KB gzip), versus about 322 KB (107 KB gzip) in v0.1.2. The Health Worker is about 52 KB and loads when Health is used. Marked, DOMPurify, highlight.js's common language bundle, and local fonts remain the main contributors. No new runtime dependency was added.

## Recovery, accessibility, and hosting

Tests cover original-data preservation, partial salvage, schema rejection, quota failures, backup restore/merge, duplicate IDs, rapid edit flushes, local error recovery, clipboard fallback, and offline export. Dialog focus, keyboard reorder controls, reduced motion, selected pane states, and layouts at 320/375/390/430/768px have browser coverage. A WebKit-only overflow from long select option text was fixed by constraining and clipping the draft control.

Light/dark text, control borders, warnings, and focus colors received a contrast pass. Disabled controls remain visibly disabled. Automated keyboard checks are not a full screen-reader audit or WCAG certification; device-specific assistive technology remains an area for ongoing manual review.

Production smoke tests use an ordinary HTTP file server at `/` and `/readme-studio/`, including Worker loading. The same `dist/` supports Netlify's static publish directory; no router fallback or application environment variables are required. `file://` loading is not supported for module/Worker security reasons. Offline reloads are not guaranteed because no service worker is installed.

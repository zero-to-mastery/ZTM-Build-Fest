# Offline authoring and updates

Production builds install a small service worker on HTTPS or localhost. After a complete initial installation, the cached app can reload without its origin server and still open saved drafts, edit, preview, analyze, review refactors, open Studio project files and download local exports. Development mode does not install it. A browser may disable/evict site storage; installation or indefinite cache retention is not guaranteed.

The cache contains an explicit list of local build files, fonts, Workers and WASM assets. It does not dynamically cache arbitrary URLs. Publishing APIs, non-GET requests, authorization headers, query-bearing requests and external images are excluded. Installation fetches omit credentials. Local draft data stays in its existing storage rather than the service-worker cache.

Navigation uses the network first, with cached HTML only after a connection failure. Static hashed assets use the current cache. The app checks for updates on registration and when connectivity returns. A completed waiting update offers **Save and reload update** only when an active service worker already exists; the first installation does not show an update notice. The update action flushes the current workspace first and refuses to reload if saving fails. Current and previous scoped caches are retained during activation. Other applications' caches are untouched. Close/reload old tabs after updating; do not depend on indefinitely retaining every older build.

GitHub import, public metadata refresh, link checks, evidence snapshot capture/change checks, drift checks (except anchors within the document), authentication and publishing still require a connection. Saved evidence snapshots remain readable offline. Remote badges/widgets/images may fail offline without retry loops. The visible offline message is based on the browser's connection state, which cannot prove that any specific provider is reachable. Provider failures retain their normal error messages and local export paths.

Browser installation is optional and depends on browser support. Core offline use does not require an installed PWA.

## Verification

`npm run test:static` builds on the production output and tests both root and subpath hosting in Chromium, Firefox and WebKit. It deliberately drops origin connections and requires the reloaded page to come from the service worker, then checks Health, refactors and exact project export. Chromium also exercises explicit update activation and saving before reload. Unit checks cover cache allowlists, omitted credentials and retention boundaries.

Connection failure is used instead of relying solely on Playwright offline emulation, which has known service-worker navigation differences; see the [upstream WebKit report](https://github.com/microsoft/playwright/issues/42775). Separate browser workflow tests still check the application's offline UI after initial load. These are engine tests, not a claim that every OS/browser installation configuration has been manually tested.

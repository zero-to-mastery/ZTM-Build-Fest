# Interactive HTML

Build a self-contained visualization and open it directly in a modern browser:

```sh
node src/cli.mjs build --username octocat --fixture repositories.json --format html --output dist/constellation.html
```

Use your own repository JSON array as the fixture, or omit `--fixture` to load GitHub data. Existing config, source, transform, mapping and layer options apply. SVG remains the default format and the GitHub Action's existing output.

Drag the canvas to pan, scroll to zoom, or use the labelled zoom controls. Select a node to focus it; Fit frames the visible nodes and Reset restores the original view. Tab reaches the canvas, controls and nodes. Arrow keys navigate nodes, Home/End select the first/last keyboard target, Enter/Space select, Escape steps back one focus level (relationship → project → overview), and +/- zoom.

The renderer embeds compiled scene data and a small DOM runtime. It does not fetch data or recalculate layouts when opened. A status region announces selection and actual semantic detail transitions. When `semanticZoom.mode` is `auto`, camera zoom crosses deterministic hysteresis thresholds and switches between precomputed grouped and project detail. Project expansion is available only when the bounded offline artifacts fit; otherwise the grouped view remains usable and explains that automatic project detail is unavailable. Existing reduced-motion rules remain in effect.

```js
import { createScene, renderSceneHTML } from '@constellation/core';
const scene = createScene('example', repositories, options);
const html = renderSceneHTML(scene, { title: 'Project constellation' });
```

Scene objects use the validated Scene API v1 contract and should come from the compiler or validated scene JSON. Configuration remains declarative. HTML titles and embedded JSON are escaped; runtime metadata uses DOM text APIs. The exported page works offline without a web server.

Run `node examples/interactive-demo.mjs` to generate a small offline example in `dist/interactive-demo.html`.

Select a node to see its description, language and star count. The **Why is this here?** disclosure uses the same bounded Scene Evidence and shared explanation logic as Core to describe inclusion, position, appearance and connections offline. Explicit project selection, derived scene inclusion and Showcase presentation roles are explained separately. Repository nodes also state their featured order; language/topic nodes can list Featured repositories represented by their real membership. Source-provided HTTP(S) project links open safely in a new tab. Shift-click or Shift-Enter on a second node traces the shortest path across visible connections. Both endpoints remain visible when no path exists. Path computation uses the embedded Rust/WASM engine, with no network requests.

Selecting a project also enters evidence-backed project focus: the inspector lists the projects it is connected to and why, opens a single relationship's explanation, and offers a return to the overview. Focus is shareable through `#focus=` URL state and Back/Forward. See [Evidence Navigation and Interactive Focus](evidence-navigation.md).

A host runtime exposes `selectionState` as `{ start, end, path }`; `selectNode(id, { extend: true, focus: false })` extends a selection programmatically. Clear selection resets details and highlights. Selection layer visibility controls highlighting without disabling accessible details.

Find and Language filter the compiled nodes locally; they do not reload sources or change stored scene positions. Paths follow the remaining visible connections. Theme switches between the original scene palette and Midnight/Light, retaining per-node mappings. Reset restores the camera and selection; filter and theme controls retain your choices.

The runtime exposes `setFilter({ query, language })` and `setTheme("original" | "midnight" | "light")`. Controls work without a server. The responsive SVG preserves its camera as its container resizes. Changes to the operating system reduced-motion preference immediately pause SVG animation and disable CSS animation.

## Security and size

Exports include a deterministic SHA-256 script allowlist and `default-src` set to `none`. The policy permits WASM compilation (`wasm-unsafe-eval`), but does not permit JavaScript eval or injected event handlers. Inline styles are needed for SVG presentation and trusted custom CSS. Network fetches, remote images, form submission and base URL overrides are blocked. Project links remain explicit user navigation. Hosts embedding the runtime must provide their own equivalent CSP; do not weaken an existing policy to accommodate untrusted CSS.

Embedded scene JSON escapes HTML delimiters and Unicode line separators. Metadata is inserted with text APIs. Node links permit only HTTP(S), without embedded credentials. Source and layout modules still require explicit trusted-host registration; the export never interprets config as executable code. Imported scene records are validated, but custom CSS remains trusted styling and can alter appearance.

`htmlBundleStatistics(scene)` reports HTML, scene JSON, embedded runtime and raw WASM bytes. Run `node scripts/benchmark-html.mjs` for size budgets and rendering timings. A reference run produced 603 KiB at 45 nodes and 3.5 MiB at 2,048 nodes; rendering took roughly 10–80 ms on the development machine. Timing is diagnostic, while byte budgets are enforced. Modern browsers with WebAssembly, modules and Web Crypto are supported.

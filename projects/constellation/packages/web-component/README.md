# Embed a constellation

Import `@constellation/web-component` in a browser application to register `<constellation-view>`. The package depends on the matching `@constellation/core` release. Use a bundler or an import map for these module specifiers; no application framework is required.

```js
import '@constellation/web-component';
const view = document.createElement('constellation-view');
view.config = { version: 7, account: 'example', options: { animate: false } };
view.records = [{ name: 'compiler', full_name: 'example/compiler', language: 'Rust' }];
document.body.append(view);
```

Properties `config`, `records` and `scene` accept isolated JSON data. Assigning a compiled scene bypasses source loading and layout. The `config` attribute accepts JSON; `account` supplies the account for an otherwise empty view. A `src` attribute loads an HTTP(S) JSON scene, configuration, or `{ config, records }` document. Config-only inputs use the current `records` property: the component never implicitly fetches GitHub or loads executable plugins.

Each element uses Shadow DOM for SVG styles and controls. It shares the HTML export's accessible pan/zoom, selection, details, path highlighting, filtering, themes and reduced-motion behavior. Errors appear as an accessible message when no previous view exists and dispatch an `error` event. Source URLs follow the embedding page's CSP and CORS policies. Imported custom CSS must be self-contained; no config text is executed.

Run the existing preview server and open `/examples/web-component.html` for a browser example.

For a plain browser deployment, serve the packages alongside your page and map the three module names as shown in the demo: `@constellation/core`, `@constellation/core/browser-runtime`, and `@constellation/web-component`. Keep the core's `src/wasm` assets in their packaged relative locations and serve `.wasm` as `application/wasm`. The component module automatically registers the default name; `defineConstellationView(name)` registers an alternate tag without replacing an existing definition. This is a browser entry point and requires DOM globals; import the core for server-side scene rendering.

The component package contains only its entry module and documentation; its matching core dependency owns compilation, WASM, scene validation and the shared render/runtime implementation. The component entry is budgeted below 24 KiB and the complete uncompressed core package below 2 MiB. The external-consumer test copies both packages into an isolated directory and exercises real module loading, WASM, keyboard behavior and Chromium's accessibility tree.

The enclosing page should provide a descriptive heading and size the host with ordinary CSS. Shadow DOM isolates internal selectors. Native controls and live status updates expose selection without relying on color; reduced motion follows system preferences. Supply human-readable record names/descriptions and project links for useful details. No autoplay is added by the component; SVG animation follows the scene's configuration and reduced-motion settings.

## Methods and events

After `scene-ready`, call `selectNode(id, { focus, extend })`, `clearSelection()`, `fit()`, `reset()`, `setFilter({ query, language })`, or `setTheme(name)`. The `selection` getter returns an isolated `{ start, end, path }` value. Unknown/hidden node IDs throw; camera methods called before readiness throw a descriptive error.

For semantic detail, set `view.semanticLevel` to `'auto'`, `'groups'` or `'projects'`. Automatic mode follows camera scale with hysteresis and evaluates the current camera immediately when selected; explicit modes ignore camera thresholds. Canonical scene/data replacement resets semantic navigation and cancels pending camera decisions. A selected group expands locally first, and changing focus in Projects detail hands expansion to another eligible group while preserving the camera. Unrelated groups stay collapsed. The component emits `semantic-level-change` when the effective level changes and for manual group expand/collapse actions. `view.expandGroup(id)` and `view.collapseGroup(id)` remain available, and the canonical scene stays available from `view.scene`. See [Semantic Groups](semantic-groups.md) for thresholds, bounds and legacy Config v7 normalization.

`await setConfig(config)` returns whether a connected view was rendered successfully. `loadScene(sceneOrJSON)` validates and renders synchronously, returning the same boolean. Assigning data while disconnected stages it for connection. These update methods report errors through the event rather than an unhandled promise rejection.

Selecting a project also enters evidence-backed focus. Additive focus members are `focusProject(id, { focus })`, `focusRelationship(projectId, relatedId)`, `returnToOverview()`, the `focusState` getter, and the `focus-change` event. With the `history` attribute and a unique `id`, focus is shareable as `#<id>.focus=` URL state with Back/Forward support. See [Evidence Navigation and Interactive Focus](evidence-navigation.md).

Listen on the element for `scene-ready` (first render per connection), `scene-change` (subsequent renders), `node-select`, `node-hover`, and `error`. Events bubble and cross the Shadow DOM boundary. Scene events include an isolated scene in `detail.scene`; selection includes `id`, node metadata, start/end and path; hover includes `id`; errors include `message`. Handlers may immediately use the imperative API. Programmatic selection uses the same event path as keyboard and pointer interaction.

## Lifecycle and isolation

`loading="lazy"` defers rendering and source requests until the element approaches the viewport (200 px margin). Give it a useful size in your page layout. Unsupported IntersectionObserver falls back to eager rendering. Each instance owns its pipeline, layout and source caches; it shares no mutable configuration or selection state.

Changing `src`, supplying a new scene/config, or disconnecting cancels in-flight loading. Aborted results cannot replace newer data or emit errors. Explicit config/scene updates take precedence over a previously set URL until `src` changes or `reload()` is called. Reconnection restores the staged scene/config and listeners. Disconnecting disposes pointer, keyboard, media and resize listeners and clears computation caches.

Source caching retains at most four JSON documents, each at most 1 MiB; larger valid documents are used without retention, and documents above 32 MiB are rejected. `cacheStatistics` reports source and computation counts. `await reload()` clears source caching and reloads the current URL. ResizeObserver reports `view-resize` without disturbing the camera.

Web Component API v1 is exported as `WEB_COMPONENT_API_VERSION = 1`. Legacy v6 configuration remains accepted. Story, timeline and hierarchy methods/events are documented in their dedicated guides. Use a unique element ID when opting into URL history.

Universe scenes add `focusLayer(layerId)` for semantic dimensional layers. Temporal scenes also expose `setTemporalView`, `focusYear`, `focusTemporalNode` and `resetTemporalView`. See [Temporal Stack](temporal-stack.md).

Scene nodes retain the optional bounded provenance attachment through component events and offline interaction. See [Evidence and provenance](evidence-provenance.md) for the shared contract and privacy limits.
# Semantic Graph input

Use `semantic-graph="./graph.json"` for an explicit HTTP(S) JSON URL, or assign a graph object with `view.semanticGraph = graph`. The component validates Semantic Graph v1, projects it through Core into Scene v1, and uses the existing renderer. Programmatic assignment is offline. URL input is bounded to 16 MiB and requires CORS permission from the graph host. Failed replacements preserve the last valid view and emit `semantic-graph-error`; successful loads emit `semantic-graph-load`. Semantic Graph overrides `src` and config while active; removing the attribute restores the normal configured source, and `view.semanticGraph = null` clears a programmatic graph override. See [Portable Embed and Export](portable-embed.md).

Developer graphs also expose Atlas navigation: `atlasState`, `atlasBreadcrumbs`, `atlasContext`, `atlasShareState`, `navigateAtlasGroup(id)`, `navigateAtlasProject(id)`, `navigateAtlasStructure(projectGraph, nodeId)`, `atlasBack()`, `atlasForward()`, and `loadAtlasShareState(value, projectGraph?)`. A successful transition emits `atlas-change`. This state is independent of camera and semantic zoom; it never mutates the graph. Share state is compact URL parameter data and includes no graph or camera payload. Structural navigation requires an already loaded Project Constellation graph and never triggers acquisition. See [Developer Atlas](developer-atlas.md).

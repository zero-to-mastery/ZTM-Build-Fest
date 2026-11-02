# Portable Embed and Export

Semantic Graph v1 is the portable semantic source. Embeds and visual exports validate it, project it through Core to Scene v1, and use the existing renderer and runtime.

## Web Component

Load the built Web Component and point its dedicated graph attribute at a UTF-8 JSON resource:

```js
import '@constellation/web-component';
```

```html
<constellation-view semantic-graph="./alice.semantic-graph.json"></constellation-view>
```

Resolve the package entry with your browser import map or application bundler, as in [the runnable example](../examples/web-component.html).

The existing `src` attribute continues to load Scene or config JSON. `semantic-graph` accepts only an explicit HTTP(S) URL. The host must allow browser CORS access. The component reads at most 16 MiB, decodes strict UTF-8, validates Semantic Graph v1, and projects through Core. It does not execute graph contents or acquire data from GitHub.

For a fully offline embed, assign a graph object directly:

```js
const graph = JSON.parse(graphJSON);
const view = document.querySelector('constellation-view');
view.semanticGraph = graph;
```

Assignment validates and projects synchronously without network access. Invalid replacements keep the prior rendered view and emit `semantic-graph-error`; successful replacements emit `semantic-graph-load` with subject, version, fingerprint, and private-source status. Graph values are cloned through canonical serialization and are not mutated. Accessible component status includes the subject and semantic identity.

An active Semantic Graph overrides `src` and config while records/account remain available for the fallback scene. Removing `semantic-graph` restores the normal configured source; assigning `view.semanticGraph = null` clears a programmatic graph override.

## Standalone HTML and bundle

The CLI produces an offline interactive HTML file from the graph projection:

```sh
constellation --semantic-graph alice.semantic-graph.json --format html --output constellation.html
```

The HTML uses the existing interactive runtime and makes subject, Semantic Graph version, fingerprint, source coverage, and private-source disclosure available in a semantic information section. It does not call GitHub or embed source code.

Generate a deterministic directory bundle with:

```sh
constellation --semantic-graph alice.semantic-graph.json --format bundle --output ./dist/alice
```

The directory contains canonical `<subject>.semantic-graph.json`, `constellation.md` rendered with Semantic Markdown v1 standard detail, `constellation.svg`, `constellation.html`, and `manifest.json`. The manifest format is version 1 and records artifact names, subject, package and semantic format versions, fingerprint, visibility, and truncation. It does not wrap the graph or contain local paths, timestamps, credentials, cache data, or source contents. Repeated generation from the same graph produces the same artifact bytes.

The `sg1:` value is a non-cryptographic semantic change identifier. It identifies graph meaning; SVG and HTML appearance remains presentation. Private provenance is retained as a warning because project names, paths, and structure may still be present in an export.

The Studio offers SVG, PNG, standalone HTML and the portfolio package (**Get it** → **Put it on a website** → **Download portfolio package**), a single JSON container. Semantic graph and Semantic Markdown downloads are available from Core and the CLI. The directory form of the portfolio artifact comes from the CLI; the Studio does not package a directory or ZIP.

## Framework integrations

Install matching package releases (`@constellation/core` and `@constellation/web-component`); this branch builds version 5.0.0 packages. Use the same release for both packages. The component package owns registration and the Core package owns scene validation and rendering.

### Plain HTML

The browser import map needs the Core, browser runtime, and component entries. See [the runnable example](../examples/web-component.html). The packaged Core inlines its WASM bytes, so no `.wasm` file or WASM MIME mapping is needed for the Web Component. In browsers, Core first probes for an optional `constellation_core_bg.wasm` beside its modules and then uses the inline bytes; hosts that serve only the package record that probe as one harmless 404. Loading a `src` scene fetches only that JSON document; it does not request GitHub data.

### React

Register the element once, pass a validated Scene, and listen to native element events. An effect tied to `scene` handles listener cleanup and replacement; stable scene identity avoids reinitialization from unrelated renders.

```jsx
import { useEffect, useRef } from 'react';
import '@constellation/web-component';

export function Constellation({ scene }) {
  const ref = useRef(null);
  useEffect(() => {
    const view = ref.current;
    const ready = event => console.info('Constellation ready', event.detail.scene);
    const error = event => console.error('Constellation error', event.detail.message);
    view.addEventListener('scene-ready', ready);
    view.addEventListener('error', error);
    view.scene = scene;
    return () => {
      view.removeEventListener('scene-ready', ready);
      view.removeEventListener('error', error);
    };
  }, [scene]);
  return <constellation-view ref={ref} aria-label="My projects" />;
}
```

### Astro

Keep the component entry on the client. A same-origin `scene.json` works through the existing `src` property, and the host page can provide a static SVG as a no-JavaScript fallback.

```astro
<constellation-view src="/portfolio/scene.json" aria-label="My projects"></constellation-view>
<script>
  import '@constellation/web-component';
</script>
```

Both examples use the same Web Component API v1; they add no renderer or framework package. A standalone interactive HTML file embeds its runtime and requires no network after download. A host Content Security Policy must allow the module scripts (including any inline import map, by hash), `'wasm-unsafe-eval'`, inline styles for the component's Shadow DOM (`style-src 'unsafe-inline'`), and `connect-src` for any Scene origin; no remote code source is required.

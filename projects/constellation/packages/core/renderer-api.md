# Renderer API v1

`renderSceneSVG(scene)` and `renderSceneHTML(scene, { title, initialChapter })` consume validated compiled scenes and return string artifacts. SVG is deterministic and static-compatible; HTML embeds the same scene/SVG and the offline interaction runtime. Both preserve reduced-motion behavior.

```js
import { renderScene, svgRenderer, htmlRenderer } from '@constellation/core';
const svg = renderScene(scene, { renderer: svgRenderer });
const html = renderScene(scene, { renderer: htmlRenderer, title: 'Project map' });
```

A renderer descriptor has `apiVersion: 1`, `id`, `mimeType`, `extension` and `render(scene, options)`. The host validates and clones the scene/options before invoking a trusted descriptor, and requires a string result. Descriptors are application code, never module names or executable strings loaded from config. Direct built-in functions avoid the extra cloning when the caller already owns its scene.

`htmlBundleStatistics(scene)` reports artifact, embedded scene, runtime and raw WASM sizes. Rendering never reloads sources or recomputes layout. The SVG renderer can use Rust traversal for an explicitly selected path. Interactive paths use the same bundled traversal functions. A timeline falls back to its reference-date scene; hierarchy to its root; stories to their first chapter's scene.

See [HTML](interactive-html.md), [Scene API](scene-api.md) and [security](security-model.md) for artifact and input boundaries.

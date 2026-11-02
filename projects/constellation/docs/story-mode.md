# Legacy visual stories

**Legacy v3 compatibility — creation UI retired.**

Existing v3 scene JSON remains readable through `parseScene`, renderers and the web component. The `createStory` public API is retained for v3 consumers. Studio no longer creates, edits or offers exports of stories.

A story is an ordered, declarative set of chapters. Chapters use compiled scenes or explicit scene definitions; configuration never contains executable callbacks.

```js
import { createScene, createStory, renderSceneHTML } from '@constellation/core';
const scene = createScene('example', records, { referenceDate: '2026-09-01T00:00:00Z' });
const story = createStory({ scenes: [{ id: 'projects', scene }], chapters: [
  { id: 'intro', title: 'Our projects', narration: 'Start with the whole collection.', scene: 'projects' },
  { id: 'compiler', title: 'The compiler', scene: 'projects', focus: 'example/compiler',
    annotations: [{ x: 450, y: 50, text: 'Shared tooling' }], theme: 'light',
    layers: { starfield: { visible: false } } },
] });
const html = renderSceneHTML(story);
```

Use `scene` as a catalog ID or a compiled scene object. Alternatively supply `definition: { account, records, options }` in a chapter or catalog entry. `layout` selects an existing arrangement for a declarative definition and invokes the normal compiler/Rust layout. A compiled scene cannot be relaid out without its input definition.

Chapters support `id`, `title`, `narration`, `camera` (four-number viewBox), `focus` (node ID), `selection` (zero, one or two IDs), `path: { start, end }`, `filter: { query, language }`, `theme`, `timeline` (frame index), `annotations` (text/x/y), and `layers`. Two selected endpoints highlight the Rust-computed shortest path. A filter that hides the requested selection clears it. Annotations use the normal annotations layer and are escaped in SVG and HTML.

Compilation produces `story.version: 1` with ordered chapters containing isolated scenes and validated runtime state. There are at most 64 chapters and 16,384 chapter nodes. Titles/narration remain text. Static SVG renders the first chapter's scene. Interactive HTML and the web component provide Previous/Next and a labelled chapter selector; no autoplay is introduced.

Call `setChapter(idOrIndex)` and inspect `chapterIndex` on the runtime or component. `chapter-change` reports `{ index, id, title }`. Nested timeline and hierarchy controls remain available inside each chapter. Story navigation itself does not overwrite the embedding page's browser history.

## Chapter transitions

Manual chapter changes interpolate shared-node position, size, fill color and opacity over 300 ms; arriving/departing nodes fade. Shared node groups keep their DOM identity. Camera movement follows the chapter’s explicit view or focused node. Changing chapter again cancels the previous transition and disposes temporary graphics. The system reduced-motion preference skips these effects and immediately applies the target camera, including when changed mid-transition. No timer advances chapters automatically.

## Compatibility boundary

The parser, validation model, chapter runtime, offline HTML and component contracts remain supported for existing artifacts. The former Studio editor and its import controls have been retired. Use `parseScene` to import previously exported JSON in a v3 consumer.

Programmatic HTML previews may use `renderSceneHTML(story, { initialChapter: index })`; the renderer validates the index and keeps its CSP deterministic.

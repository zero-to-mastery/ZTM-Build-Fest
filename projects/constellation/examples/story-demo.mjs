import { mkdir, writeFile } from 'node:fs/promises';
import { createScene, createStory, renderSceneHTML } from '../src/core-api.mjs';
const records = ['compiler', 'runtime', 'studio'].map((name, i) => ({ name, full_name: `example/${name}`, language: i === 2 ? 'JavaScript' : 'Rust', stargazers_count: 10 + i }));
const scene = createScene('example', records, { referenceDate: '2026-09-01T00:00:00Z', animate: false });
const story = createStory({ chapters: [
  { id: 'overview', title: 'Our projects', narration: 'Three supplied project records form this scene.', scene },
  { id: 'connection', title: 'Shared tooling', narration: 'Compiler and runtime share Rust. The line describes that relationship, not a dependency.', scene, focus: 'example/compiler', path: { start: 'example/compiler', end: 'example/runtime' }, annotations: [{ text: 'Shared language', x: 450, y: 50 }] },
] });
await mkdir('dist', { recursive: true });
await writeFile('dist/story-demo.html', renderSceneHTML(story));

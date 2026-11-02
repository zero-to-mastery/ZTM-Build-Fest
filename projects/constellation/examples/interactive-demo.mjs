import { mkdir, writeFile } from 'node:fs/promises';
import { createScene, renderSceneHTML } from '../src/core-api.mjs';

const repositories = ['compiler', 'runtime', 'studio'].map((name, index) => ({
  name, full_name: `example/${name}`, language: index === 2 ? 'JavaScript' : 'Rust',
  topics: ['visualization'], stargazers_count: 10 + index * 5,
}));
const scene = createScene('example', repositories, { referenceDate: '2026-09-01T00:00:00Z' });
await mkdir('dist', { recursive: true });
await writeFile('dist/interactive-demo.html', renderSceneHTML(scene));

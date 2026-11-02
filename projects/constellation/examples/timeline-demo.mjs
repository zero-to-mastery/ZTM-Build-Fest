import { mkdir, writeFile } from 'node:fs/promises';
import { createTimeline, renderSceneHTML } from '../src/core-api.mjs';
const records = ['compiler', 'runtime', 'studio'].map((name, index) => ({ name, full_name: `example/${name}`, language: index === 2 ? 'JavaScript' : 'Rust', created_at: `${2020 + index}-01-01`, stargazers_count: 10 * (index + 1) }));
const scene = createTimeline('example', records, { referenceDate: '2026-09-01T00:00:00Z', mappings: { size: 'stars' } }, { dates: ['2020-01-01', '2021-01-01', '2022-01-01'] });
await mkdir('dist', { recursive: true });
await writeFile('dist/timeline-demo.html', renderSceneHTML(scene));

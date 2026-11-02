import { mkdir, writeFile } from 'node:fs/promises';
import { createOrganizationHierarchy, renderSceneHTML } from '../src/core-api.mjs';
const records = ['compiler', 'runtime', 'studio'].map((name, i) => ({ name, full_name: `example/${name}`, language: i === 2 ? 'JavaScript' : 'Rust', topics: ['visualization'] }));
const scene = createOrganizationHierarchy('example', records, { referenceDate: '2026-09-01T00:00:00Z', animate: false,
  organizationData: { records: { 'example/compiler': [{ login: 'alice', contributions: 3 }] }, scanned: 1, selected: 3, complete: false },
});
await mkdir('dist', { recursive: true });
await writeFile('dist/hierarchy-demo.html', renderSceneHTML(scene));

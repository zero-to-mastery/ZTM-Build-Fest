import { performance } from 'node:perf_hooks';
import { createScene, renderSceneSVG, renderSceneHTML, serializeScene } from '../src/core-api.mjs';

for (const count of [25, 100, 200]) for (const years of [6, 20]) {
  const records = Array.from({ length: count }, (_, i) => ({ name: `project-${i}`, full_name: `demo/project-${i}`, language: ['Rust', 'JavaScript', 'Python'][i % 3], created_at: '2000-01-01', stargazers_count: count - i }));
  const start = performance.now();
  const scene = createScene('demo', records, { arrangement: 'temporal-stack', referenceDate: '2026-09-01', maxRepos: count, nodeCap: count > 100 ? count : 100, temporalStack: { yearStart: 2027 - years } });
  const compileMs = performance.now() - start, renderStart = performance.now();
  const svg = renderSceneSVG(scene), html = renderSceneHTML(scene);
  console.log(JSON.stringify({ nodesPerLayer: count, years, compileMs: Math.round(compileMs), renderMs: Math.round(performance.now() - renderStart), svgBytes: Buffer.byteLength(svg), htmlBytes: Buffer.byteLength(html), sceneBytes: Buffer.byteLength(serializeScene(scene)) }));
}

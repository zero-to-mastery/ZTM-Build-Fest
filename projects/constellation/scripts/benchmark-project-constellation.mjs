import { performance } from 'node:perf_hooks';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { createProjectConstellationScene } from '../src/project-constellation-scene.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { renderSceneHTML } from '../src/renderer-html.mjs';
import { serializeScene } from '../src/scene.mjs';

const ms = fn => { const start = performance.now(); const value = fn(); return { value, elapsedMs: +(performance.now() - start).toFixed(2) }; };
for (const count of [50, 128, 256]) {
  const sourceCount = count - 1;
  const tree = Array.from({ length: sourceCount }, (_, i) => ({ path: `src/module-${String(i).padStart(3, '0')}.mjs`, type: 'blob', size: 24 }));
  tree.push({ path: 'package.json', type: 'blob', size: 35 });
  const contents = { 'package.json': JSON.stringify({ name: 'benchmark', main: 'src/module-000.mjs' }) };
  for (let i = 0; i < sourceCount; i++) contents[`src/module-${String(i).padStart(3, '0')}.mjs`] = i ? "import './module-000.mjs';" : 'export const entry = true;';
  const modelRun = ms(() => createProjectConstellation({ projectId: 'benchmark/project', ref: 'fixture', tree, contents }));
  const sceneRun = ms(() => createProjectConstellationScene(modelRun.value).scene);
  const svgRun = ms(() => renderSceneSVG(sceneRun.value));
  const htmlRun = ms(() => renderSceneHTML(sceneRun.value));
  const serialized = serializeScene(sceneRun.value);
  process.stdout.write(`${JSON.stringify({ inputFiles: count, nodes: modelRun.value.nodes.length, edges: modelRun.value.edges.length, truncated: modelRun.value.statistics.truncated, normalizationAndGraphMs: modelRun.elapsedMs, sceneMs: sceneRun.elapsedMs, svgMs: svgRun.elapsedMs, htmlMs: htmlRun.elapsedMs, svgBytes: Buffer.byteLength(svgRun.value), htmlBytes: Buffer.byteLength(htmlRun.value), sceneJSONBytes: Buffer.byteLength(serialized) })}\n`);
}

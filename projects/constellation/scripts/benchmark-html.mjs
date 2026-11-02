import { performance } from 'node:perf_hooks';
import { createScene, renderSceneHTML, htmlBundleStatistics, serializeScene } from '../src/core-api.mjs';

const results = [45, 256, 2048].map(count => {
  const records = Array.from({ length: count }, (_, i) => ({ name: `project-${i}`, full_name: `benchmark/project-${i}`, language: ['Rust', 'JavaScript'][i % 2] }));
  const scene = createScene('benchmark', records, { nodeCap: count > 100 ? count : 100, maxRepos: count, animate: false, referenceDate: '2026-09-01T00:00:00Z' });
  const start = performance.now();
  renderSceneHTML(scene);
  const renderMs = performance.now() - start, sizes = htmlBundleStatistics(scene);
  if (sizes.htmlBytes > 12 * 1024 * 1024 || sizes.runtimeBytes > 1024 * 1024) throw new Error('Interactive artifact exceeds size budget.');
  const sceneBytes = Buffer.byteLength(serializeScene(scene));
  const baseline = structuredClone(scene); delete baseline.evidence;
  const baselineSceneBytes = Buffer.byteLength(serializeScene(baseline));
  const { sceneBytes: embeddedSceneBytes, ...htmlSizes } = sizes;
  return { nodes: count, renderMs, serializedSceneBytes: sceneBytes, baselineSceneBytes, evidenceBytes: sceneBytes - baselineSceneBytes, embeddedSceneBytes, ...htmlSizes };
});
console.log(JSON.stringify(results, null, 2));

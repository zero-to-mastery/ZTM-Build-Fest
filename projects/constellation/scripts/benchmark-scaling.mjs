import { performance } from 'node:perf_hooks';
import { renderConstellation, layoutStatistics } from '../src/core-api.mjs';
const repos = Array.from({ length: 2048 }, (_, i) => ({ name: `project-${i}`, full_name: `benchmark/project-${i}`, language: 'Rust' }));
for (const snapToRings of [false, true]) {
  const options = { nodeCap: 2048, maxRepos: 2048, snapToRings, animate: false };
  const times = [];
  for (let i = 0; i < 4; i++) {
    const computed = layoutStatistics.computedNodes, start = performance.now();
    const svg = renderConstellation('benchmark', repos, { ...options, colors: { star: i % 2 ? '#aabbcc' : '#ccbbaa' } });
    times.push({ ms: +(performance.now() - start).toFixed(2), computedNodes: layoutStatistics.computedNodes - computed, bytes: Buffer.byteLength(svg) });
  }
  console.log(JSON.stringify({ nodes: repos.length, snapToRings, times }));
}

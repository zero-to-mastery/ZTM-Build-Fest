import { performance } from 'node:perf_hooks';
import { layoutScene, layoutCacheStatistics } from '../src/core-api.mjs';
const runs = [];
for (const [arrangement, count, nodeCap] of [['rings', 100, 100], ['force', 100, 100], ['galaxy', 100, 100], ['field', 2048, 2048]]) {
  const scene = { nodes: Array.from({ length: count }, (_, i) => ({ id: `bench/${i}`, metadata: { full_name: `bench/${i}`, name: `p-${i}`, language: ['Rust', 'JavaScript'][i % 2] } })) };
  const times = [];
  for (let i = 0; i < 6; i++) { const start = performance.now(); layoutScene(scene, { arrangement, nodeCap }, { account: 'bench', seed: 'fixed', reference: 0 }); times.push(performance.now() - start); }
  runs.push({ arrangement, count, coldMs: times[0], warmMedianMs: times.slice(1).sort((a, b) => a - b)[2] });
}
console.log(JSON.stringify({ node: process.version, runs, cache: layoutCacheStatistics() }, null, 2));

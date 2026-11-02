import { performance } from 'node:perf_hooks';
import { createScene, renderSceneSVG, serializeScene, parseScene } from '../src/core-api.mjs';

if (!global.gc) throw new Error('Run with node --expose-gc scripts/benchmark-scene.mjs');
const repositories = Array.from({ length: 2048 }, (_, i) => ({
  name: `project-${i}`, full_name: `benchmark/project-${i}`, language: ['Rust', 'JavaScript', 'Python'][i % 3],
  topics: [`group-${i % 13}`], stargazers_count: i, created_at: '2020-01-01T00:00:00Z',
}));
const options = { nodeCap: 2048, maxRepos: 2048, animate: false, referenceDate: '2026-09-01T00:00:00Z' };
const measure = fn => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };
function run() {
  const compile = measure(() => createScene('benchmark', repositories, options));
  const serialize = measure(() => serializeScene(compile.value));
  const parse = measure(() => parseScene(serialize.value));
  const render = measure(() => renderSceneSVG(parse.value));
  return { nodes: compile.value.nodes.length, edges: compile.value.edges.length,
    compileMs: compile.ms, serializeMs: serialize.ms, parseMs: parse.ms, renderMs: render.ms,
    jsonBytes: Buffer.byteLength(serialize.value), svgBytes: Buffer.byteLength(render.value) };
}
const cold = run();
global.gc();
const before = process.memoryUsage().heapUsed;
const samples = Array.from({ length: 12 }, run);
global.gc();
const retainedBytes = process.memoryUsage().heapUsed - before;
const median = key => samples.map(sample => sample[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
console.log(JSON.stringify({ node: process.version, platform: process.platform, cold,
  warmMedianMs: Object.fromEntries(['compileMs', 'serializeMs', 'parseMs', 'renderMs'].map(key => [key, median(key)])),
  retainedBytes, iterations: samples.length }, null, 2));
// A generous retention check catches keeping complete scenes in an accidental
// unbounded cache; it is independent of machine-sensitive timing measurements.
if (retainedBytes > 16 * 1024 * 1024) throw new Error('Repeated scene processing retained more than 16 MiB after GC.');

import { performance } from 'node:perf_hooks';
import { createScene, createStory, htmlBundleStatistics } from '../src/core-api.mjs';
const records = Array.from({ length: 128 }, (_, i) => ({ name: `project-${i}`, full_name: `benchmark/project-${i}`, language: 'Rust' }));
const scene = createScene('benchmark', records, { referenceDate: '2026-09-01', animate: false, nodeCap: 128, maxRepos: 128 });
const start = performance.now();
const story = createStory({ chapters: Array.from({ length: 8 }, (_, i) => ({ id: `chapter-${i}`, title: `Project ${i}`, scene, focus: records[i].full_name })) });
const compileMs = performance.now() - start, sizes = htmlBundleStatistics(story);
if (sizes.htmlBytes > 12 * 1024 * 1024) throw new Error('Story benchmark exceeds 12 MiB export budget.');
console.log(JSON.stringify({ chapters: 8, nodes: 1024, compileMs, ...sizes }, null, 2));

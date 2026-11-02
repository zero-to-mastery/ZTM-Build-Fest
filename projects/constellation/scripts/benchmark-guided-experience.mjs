import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createScene } from '../src/constellation.mjs';
import { semanticGraphFromScene } from '../src/semantic-graph.mjs';
import { generateStoryCandidates, recommendStoryCandidate } from '../src/story-candidates.mjs';
import { renderProfileStorySVG } from '../src/profile-story-export.mjs';
import { renderWorkflow } from '../src/export.mjs';

const records = Array.from({ length: 100 }, (_, i) => ({
  full_name: `fixture/r${i}`, name: `r${i}`, language: i % 2 ? 'Rust' : 'HTML',
  topics: [i % 2 ? 'tools' : 'web'], private: false,
  created_at: `${2010 + i % 15}-01-01`, updated_at: '2026-10-01',
}));
const options = { maxRepos: 100, showOther: true, nodeMode: 'repositories', arrangement: 'rings', referenceDate: '2026-10-11T00:00:00Z', seedMode: 'account' };
const graph = semanticGraphFromScene(createScene('fixture', records, options));
const measure = (run, count = 20) => {
  run();
  const start = performance.now();
  for (let i = 0; i < count; i++) run();
  return (performance.now() - start) / count;
};
const candidate = recommendStoryCandidate(generateStoryCandidates(graph, options));
const result = {
  fixtureProjects: records.length,
  recommendationMs: measure(() => recommendStoryCandidate(generateStoryCandidates(graph, options))),
  compactSVGMs: measure(() => renderProfileStorySVG(candidate, 480)),
  wideSVGMs: measure(() => renderProfileStorySVG(candidate, 900)),
  publishingSetupMs: measure(() => renderWorkflow('fixture', options, { story: 'auto', targetWidth: 480, sourceAccount: true })),
};
const modules = (await readdir(new URL('../src/', import.meta.url))).filter(name => name.endsWith('.mjs'));
result.studioTopLevelModuleBytes = (await Promise.all(modules.map(name => readFile(new URL(`../src/${name}`, import.meta.url))))).reduce((total, bytes) => total + bytes.length, 0);
result.rawWasmBytes = (await readFile(new URL('../src/wasm/constellation_core_bg.wasm', import.meta.url))).length;
console.log(JSON.stringify(result, null, 2));

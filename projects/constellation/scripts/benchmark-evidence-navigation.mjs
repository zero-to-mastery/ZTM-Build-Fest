import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { createEvidenceNavigator } from '../src/engine.mjs';

// Synthetic developer graphs: every project has one primary language and up to
// three topics from small vocabularies, plus authored families and explicit links,
// so hubs are large and second-degree expansion is dense.
function graphFor(count) {
  const nodes = [], edges = [];
  const languages = ['Rust', 'TypeScript', 'Go', 'Python', 'C'];
  const topics = Array.from({ length: 24 }, (_, i) => `topic-${i}`);
  for (const language of languages) nodes.push({ id: `language:${language}`, kind: 'language', label: language, provenance: [{ category: 'source' }] });
  for (const topic of topics) nodes.push({ id: `topic:${topic}`, kind: 'topic', label: topic, provenance: [{ category: 'source' }] });
  for (let i = 0; i < count; i++) {
    const id = `bench/project-${String(i).padStart(4, '0')}`;
    nodes.push({ id, kind: 'project', label: `Project ${i}`, provenance: [{ category: 'source' }] });
    edges.push({ id: `uses-language:${i}`, kind: 'uses-language', from: id, to: `language:${languages[i % languages.length]}`, provenance: [{ category: 'source' }] });
    for (let t = 0; t < 3; t++) edges.push({ id: `has-topic:${i}:${t}`, kind: 'has-topic', from: id, to: `topic:${topics[(i * 7 + t * 5) % topics.length]}`, provenance: [{ category: 'source' }] });
    if (i % 8 === 0 && i + 1 < count) edges.push({ id: `project-relationship:${i}`, kind: 'project-relationship', from: id, to: `bench/project-${String(i + 1).padStart(4, '0')}`, provenance: [{ category: 'user' }] });
  }
  for (let f = 0; f * 6 < count; f++) {
    const gid = `group:user:family-${f}`;
    nodes.push({ id: gid, kind: 'semantic-group', label: `Family ${f}`, properties: { groupKind: 'project-family' }, provenance: [{ category: 'user' }] });
    for (let m = f * 6; m < Math.min(count, f * 6 + 6); m++) edges.push({ id: `member:${m}`, kind: 'member-of', from: `bench/project-${String(m).padStart(4, '0')}`, to: gid, provenance: [{ category: 'user' }] });
  }
  return { version: 1, nodes, edges };
}

const mean = values => Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3));
const wasm = await readFile(new URL('../src/wasm/constellation_core_bg.wasm', import.meta.url));
console.log(JSON.stringify({ wasmBytes: wasm.length }));
for (const count of [12, 128, 512, 2048]) {
  const graph = graphFor(count), graphBytes = Buffer.byteLength(JSON.stringify(graph));
  const builds = [];
  let navigator;
  for (let i = 0; i < 6; i++) {
    navigator?.destroy();
    const start = performance.now(); navigator = createEvidenceNavigator(graph); builds.push(performance.now() - start);
  }
  const depth1 = [], depth2 = [];
  let result;
  // Distinct project IDs defeat the adapter cache so each query reaches Rust.
  for (let i = 0; i < 24; i++) {
    const id = `bench/project-${String((i * 37) % count).padStart(4, '0')}`;
    let start = performance.now(); result = navigator.navigate(id, 1); depth1.push(performance.now() - start);
    start = performance.now(); result = navigator.navigate(id, 2); depth2.push(performance.now() - start);
  }
  console.log(JSON.stringify({
    projects: count, graphBytes,
    meanIndexBuildMs: mean(builds.slice(1)),
    meanDepth1Ms: mean(depth1), meanDepth2Ms: mean(depth2), maxDepth2Ms: Number(Math.max(...depth2).toFixed(3)),
    lastConnections: result.connections.length, lastSecondDegree: result.secondDegree.length, truncated: result.truncated,
    outputBytes: Buffer.byteLength(JSON.stringify(result)),
  }));
  navigator.destroy();
}

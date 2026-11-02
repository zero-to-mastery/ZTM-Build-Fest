import { performance } from 'node:perf_hooks';
import { createScene } from '../src/constellation.mjs';
import { semanticGraphFromScene } from '../src/semantic-graph.mjs';
import { generateStoryCandidates } from '../src/story-candidates.mjs';
import { composeStory } from '../src/engine.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';

function inputFor(count) {
  return {
    projects: Array.from({ length: count }, (_, index) => ({
      id: `benchmark/project-${String(index).padStart(3, '0')}`,
      languages: [`Language ${index % 8}`],
      topics: [`area-${index % 12}`, `tool-${index % 7}`],
      featured: index < 3,
      position: [(index % 20) * 38, Math.floor(index / 20) * 34],
    })),
    families: [{ id: 'tooling', members: Array.from({ length: Math.min(count, 12) }, (_, index) => `benchmark/project-${String(index).padStart(3, '0')}`) }],
    relationships: [{ id: 'authored:0:1', from: 'benchmark/project-000', to: 'benchmark/project-001' }],
    edge_budget: Math.min(4096, Math.max(1, count * 2)),
  };
}

for (const count of [6, 12, 128, 512]) {
  const input = inputFor(count);
  const serialized = JSON.stringify(input);
  const times = [];
  let output;
  for (let index = 0; index < 12; index++) {
    const start = performance.now();
    output = composeStory(input);
    if (index >= 2) times.push(performance.now() - start);
  }
  console.log(JSON.stringify({
    projects: count,
    inputBytes: Buffer.byteLength(serialized),
    meanCompositionMs: Number((times.reduce((sum, value) => sum + value, 0) / times.length).toFixed(3)),
    candidates: output.candidate_count,
    selected: output.relationships.length,
    suppressed: output.suppressed_count,
    outputBytes: Buffer.byteLength(JSON.stringify(output)),
  }));
}

const records = Array.from({ length: 12 }, (_, index) => ({
  full_name: `benchmark/project-${String(index).padStart(3, '0')}`,
  name: `Project ${index}`,
  language: ['Rust', 'JavaScript', 'Python'][index % 3],
  topics: [`area-${index % 4}`],
}));
const graph = semanticGraphFromScene(createScene('benchmark', records, { nodeMode: 'repositories', showOther: true, seed: 'story-composition-benchmark' }));
const candidate = generateStoryCandidates(graph).find(item => item.id === 'projects');
console.log(JSON.stringify({
  projectsSceneBytes: Buffer.byteLength(JSON.stringify(candidate.scene)),
  projectsSvgBytes: Buffer.byteLength(renderSceneSVG(candidate.scene)),
  projectsEdges: candidate.scene.edges.length,
}));

for (const count of [6, 12]) {
  const boundedRecords = records.slice(0, count);
  const boundedOptions = { nodeMode: 'repositories', showOther: true, seed: `candidate-benchmark-${count}` };
  const boundedGraph = semanticGraphFromScene(createScene('benchmark', boundedRecords, boundedOptions));
  const generationTimes = [], serializationTimes = [];
  let projectsCandidate;
  for (let index = 0; index < 12; index++) {
    const start = performance.now();
    projectsCandidate = generateStoryCandidates(boundedGraph, boundedOptions).find(item => item.id === 'projects');
    const generated = performance.now();
    const serializedScene = JSON.stringify(projectsCandidate.scene);
    const serialized = performance.now();
    if (index >= 2) {
      generationTimes.push(generated - start);
      serializationTimes.push(serialized - generated);
    }
  }
  console.log(JSON.stringify({
    candidateProjects: count,
    meanCandidateGenerationMs: Number((generationTimes.reduce((sum, value) => sum + value, 0) / generationTimes.length).toFixed(3)),
    meanSceneSerializationMs: Number((serializationTimes.reduce((sum, value) => sum + value, 0) / serializationTimes.length).toFixed(3)),
    sceneBytes: Buffer.byteLength(JSON.stringify(projectsCandidate.scene)),
    svgBytes: Buffer.byteLength(renderSceneSVG(projectsCandidate.scene)),
    relationships: projectsCandidate.composition.relationships.length,
  }));
}

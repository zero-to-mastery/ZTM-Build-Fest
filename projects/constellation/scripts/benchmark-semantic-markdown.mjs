import { performance } from 'node:perf_hooks';
import { createScene } from '../src/constellation.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { semanticGraphFromScene, semanticGraphFromProjectConstellation } from '../src/semantic-graph.mjs';
import { renderSemanticMarkdown } from '../src/semantic-markdown.mjs';
import { repositories } from '../test/fixtures/recruiter.mjs';

function measure(name, graph) {
  for (const detail of ['standard', 'detailed']) {
    const start = performance.now();
    const output = renderSemanticMarkdown(graph, { detail });
    console.log(JSON.stringify({ name, detail, milliseconds: +(performance.now() - start).toFixed(3), bytes: Buffer.byteLength(output), lines: output.split('\n').length - 1 }));
  }
}

const seed = repositories[0];
for (const count of [45, 256]) {
  const items = Array.from({ length: count }, (_, index) => ({ ...seed, full_name: `benchmark/project-${String(index).padStart(3, '0')}`, name: `project-${index}` }));
  const scene = createScene('benchmark', items, { maxRepos: count, nodeCap: 512 });
  measure(`developer-${count}`, semanticGraphFromScene(scene));
}
for (const count of [50, 100]) {
  const tree = Array.from({ length: count }, (_, index) => ({ path: `packages/pkg-${String(index).padStart(3, '0')}/package.json`, type: 'blob' }));
  const model = createProjectConstellation({ projectId: `benchmark/project-${count}`, tree }, { nodes: count });
  measure(`project-${count}-structural-nodes`, semanticGraphFromProjectConstellation(model));
}

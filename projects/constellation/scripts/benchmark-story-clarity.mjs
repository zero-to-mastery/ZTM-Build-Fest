import { performance } from 'node:perf_hooks';
import { analyzeStoryClarity } from '../src/engine.mjs';

function inputFor(count) {
  const columns = Math.ceil(Math.sqrt(count));
  const projects = Array.from({ length: count }, (_, i) => ({
    id: `benchmark/project-${String(i).padStart(3, '0')}`,
    role: i < 3 ? 'featured' : i < 6 ? 'supporting' : '',
    x: (i % columns) * 34 + 16,
    y: Math.floor(i / columns) * 26 + 16,
    radius: 4,
    prominence: 4,
  }));
  const labels = projects.map((project, i) => ({
    id: `label:${project.id}`, projectId: project.id, text: `Project ${i}`,
    bounds: { x: project.x - 28, y: project.y + 5, width: 56, height: 12 },
    priority: i < 3 ? 3 : i < 6 ? 2 : 1, visible: true,
  }));
  const pairLimit = Math.min(count * (count - 1) / 2, 4096);
  const relationships = [];
  for (let i = 0; i < count && relationships.length < pairLimit; i++) {
    for (let j = i + 1; j < count && relationships.length < pairLimit; j++) {
      relationships.push({ id: `rel:${i}:${j}`, from: projects[i].id, to: projects[j].id, kind: i % 2 ? 'shared-topic' : 'shared-language', style: i % 2 ? 'dashed' : 'solid', evidence: ['language:Rust'] });
    }
  }
  return {
    width: Math.max(480, columns * 34 + 32),
    height: Math.max(180, Math.ceil(count / columns) * 26 + 32),
    projects, labels, relationships,
    groups: [{ id: 'benchmark/technical', projectIds: projects.slice(0, Math.min(count, 64)).map(project => project.id) }],
  };
}

for (const count of [6, 12, 128, 512]) {
  const input = inputFor(count), inputBytes = Buffer.byteLength(JSON.stringify(input));
  const timings = []; let result;
  for (let iteration = 0; iteration < 12; iteration++) {
    const start = performance.now(); result = analyzeStoryClarity(input);
    if (iteration >= 2) timings.push(performance.now() - start);
  }
  console.log(JSON.stringify({
    projects: count, inputBytes,
    meanEvaluationMs: Number((timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(3)),
    diagnostics: result.diagnostics.length,
    suggestions: result.suggestions.length,
    outputBytes: Buffer.byteLength(JSON.stringify(result)),
  }));
}

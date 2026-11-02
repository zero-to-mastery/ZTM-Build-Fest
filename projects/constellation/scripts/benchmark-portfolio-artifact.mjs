import { performance } from 'node:perf_hooks';
import { createScene } from '../src/constellation.mjs';
import { semanticGraphFromScene } from '../src/semantic-graph.mjs';
import { createPortfolioArtifact, validatePortfolioArtifact } from '../src/portfolio-artifact.mjs';

const output = [];
for (const projects of [12, 100]) {
  const records = Array.from({ length: projects }, (_, index) => ({
    name: `project-${String(index).padStart(3, '0')}`,
    full_name: `benchmark/project-${String(index).padStart(3, '0')}`,
    language: index % 2 ? 'Rust' : 'JavaScript',
  }));
  const scene = createScene('benchmark', records, { animate: false });
  const graph = semanticGraphFromScene(scene);
  const started = performance.now();
  const artifact = await createPortfolioArtifact(graph, { constellationVersion: '4.7.0', scene });
  const createMs = performance.now() - started;
  const validationStarted = performance.now();
  const result = await validatePortfolioArtifact(artifact.files['manifest.json'], artifact.files);
  const validateMs = performance.now() - validationStarted;
  const assetBytes = Object.values(artifact.manifest.artifacts).reduce((sum, value) => sum + value.size, 0);
  output.push({ projects, createMs, validateMs, assetBytes, manifestBytes: new TextEncoder().encode(artifact.files['manifest.json']).byteLength, files: result.files });
}
console.log(JSON.stringify(output, null, 2));

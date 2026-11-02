import { performance } from 'node:perf_hooks';
import { createScene } from '../src/constellation.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { semanticGraphFromScene, semanticGraphFromProjectConstellation, serializeSemanticGraph, semanticGraphFingerprint, projectSemanticGraphToScene } from '../src/semantic-graph.mjs';
import { createPortableExport } from '../src/portable-export.mjs';
import { renderSemanticMarkdown } from '../src/semantic-markdown.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { renderSceneHTML } from '../src/renderer-html.mjs';

const measure = fn => { const start = performance.now(); const value = fn(); return { value, ms: +(performance.now() - start).toFixed(2) }; };
const cases = [];
for (const count of [45, 256]) {
  const records = Array.from({ length: count }, (_, i) => ({ full_name: `benchmark/project-${String(i).padStart(3, '0')}`, name: `project-${i}`, language: i % 2 ? 'Rust' : 'JavaScript' }));
  const scene = createScene('benchmark', records, { maxRepos: Math.min(count, 100), nodeCap: Math.min(count + 1, 256) });
  const present = new Set(scene.nodes.map(node => node.id));
  for (const [i, record] of records.entries()) if (!present.has(record.full_name)) scene.nodes.push({ id: record.full_name, geometry: { x: 500 + i, y: 500, radius: 5 }, metadata: { ...record, description: '', html_url: '', nodeKind: 'repository' }, style: { color: null, glow: null, opacity: 1, shape: 'circle' }, interaction: { hidden: false, labelHidden: false } });
  scene.presentation.graph.nodeCount = scene.nodes.length;
  cases.push({ name: `developer ${count}`, graph: semanticGraphFromScene(scene) });
}
for (const count of [50, 100]) {
  const tree = Array.from({ length: count - 1 }, (_, i) => ({ path: `src/module-${String(i).padStart(3, '0')}.mjs`, type: 'blob', size: 24 }));
  tree.push({ path: 'package.json', type: 'blob', size: 35 });
  const contents = { 'package.json': JSON.stringify({ name: 'benchmark', main: 'src/module-000.mjs' }) };
  for (let i = 0; i < count - 1; i++) contents[`src/module-${String(i).padStart(3, '0')}.mjs`] = i ? "import './module-000.mjs';" : 'export const entry = true;';
  cases.push({ name: `project ${count}`, graph: semanticGraphFromProjectConstellation(createProjectConstellation({ projectId: 'benchmark/project', ref: 'fixture', tree, contents })) });
}
for (const { name, graph } of cases) {
  const json = measure(() => serializeSemanticGraph(graph));
  const fingerprint = semanticGraphFingerprint(graph);
  const scene = measure(() => projectSemanticGraphToScene(graph, { referenceDate: '2000-01-01T00:00:00Z' }));
  const svg = measure(() => renderSceneSVG(scene.value));
  const html = measure(() => renderSceneHTML(scene.value, { title: `${graph.subject.id} constellation`, semanticMetadata: { subjectLabel: `${graph.subject.kind}: ${graph.subject.id}`, version: graph.version, fingerprint, truncated: graph.statistics.truncated, privateSource: graph.project?.provenance?.visibility === 'private' } }));
  const markdown = measure(() => renderSemanticMarkdown(graph, { detail: 'standard' }));
  const portable = measure(() => createPortableExport(graph));
  const manifest = measure(() => `${JSON.stringify(portable.value.manifest, null, 2)}\n`);
  const bundleBytes = Object.values(portable.value.files).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
  process.stdout.write(`${JSON.stringify({ case: name, nodes: graph.nodes.length, edges: graph.edges.length, serializationMs: json.ms, projectionMs: scene.ms, svgMs: svg.ms, htmlMs: html.ms, markdownMs: markdown.ms, manifestMs: manifest.ms, totalPortableExportMs: portable.ms, bundleBytes })}\n`);
}

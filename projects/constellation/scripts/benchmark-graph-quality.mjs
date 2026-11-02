import { evaluateGraphQuality } from '../src/engine.mjs';
import { performance } from 'node:perf_hooks';

for (const count of [10, 25, 50, 100]) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, kind: 'project', label: `Project ${i}`, x: (i % 10) * 88, y: Math.floor(i / 10) * 62, evidence: [`language-${i % 6}`, `topic-${i % 9}`] }));
  const edges = nodes.flatMap((node, i) => i + 1 < nodes.length && i % 4 === 0 ? [{ from: node.id, to: nodes[i + 1].id }] : []);
  const start = performance.now();
  const result = evaluateGraphQuality({ nodes, edges, groups: [] });
  const elapsed = performance.now() - start;
  console.log(`${count} projects: ${elapsed.toFixed(3)} ms, score ${result.score.toFixed(3)}`);
}

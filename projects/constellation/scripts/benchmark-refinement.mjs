import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import init, { refine_layout } from '../src/wasm/constellation_core.js';
await init({ module_or_path: await readFile(new URL('../src/wasm/constellation_core_bg.wasm', import.meta.url)) });
// Call WASM directly so the JS result cache cannot hide computation cost.
for (const count of [64, 128, 256]) {
  const nodes = Array.from({ length: count }, (_, i) => ({ x: 60 + (i % 16) * 48, y: 50 + Math.floor(i / 16) * 27, radius: 6, label: [-35, 7, 35, 20], hidden: false, locked: i % 17 === 0 }));
  for (const snap of [false, true]) {
    const input = JSON.stringify({ nodes, anchors: snap ? nodes.map(n => [n.x, n.y]) : null, intensity: 10, height: 560 });
    const expected = refine_layout(input);
    const times = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      if (refine_layout(input) !== expected) throw new Error('Non-deterministic refinement');
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ count, snap, medianMs: +times[2].toFixed(2), maxMs: +times.at(-1).toFixed(2) }));
  }
}

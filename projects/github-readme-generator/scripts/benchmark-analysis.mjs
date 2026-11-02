import { performance } from "node:perf_hooks";
import { parseSource } from "../src/analysis/source.js";
import { analyzeDocument, documentStats } from "../src/analysis/analyze.js";
const sample =
  "# Section 🌍\n\nText with [a link](./guide.md) and ![badge](https://img.shields.io/badge/JS-blue).\n\n```js\nconst x = 1;\n```\n\n";
const median = (values) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
for (const kb of [10, 100, 250, 500, 1024]) {
  const source = sample.repeat(
    Math.ceil((kb * 1024) / new TextEncoder().encode(sample).length),
  );
  const times = { parse: [], analysis: [], stats: [] };
  for (let i = 0; i < 6; i++) {
    parseSource("cache reset " + i);
    let start = performance.now();
    parseSource(source);
    times.parse.push(performance.now() - start);
    start = performance.now();
    analyzeDocument(source);
    times.analysis.push(performance.now() - start);
    start = performance.now();
    documentStats(source);
    times.stats.push(performance.now() - start);
  }
  rows.push({
    kb,
    bytes: new TextEncoder().encode(source).length,
    ...Object.fromEntries(
      Object.entries(times).map(([k, v]) => [
        k + "Ms",
        Number(median(v.slice(1)).toFixed(3)),
      ]),
    ),
  });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      method:
        "Median of five warm runs; analysis reuses the preceding parse; no browser DOM",
      rows,
    },
    null,
    2,
  ),
);

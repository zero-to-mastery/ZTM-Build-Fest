import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import * as wasm from "../src/analysis/wasm/readme_core.js";
import { analyzeCore, coreHeadings } from "../src/analysis/js-fallback.js";
import { analyzeDocument } from "../src/analysis/analyze.js";
import { wasmCore } from "../src/analysis/wasm-loader.js";
const bytes = readFileSync(
  new URL("../src/analysis/wasm/readme_core_bg.wasm", import.meta.url),
);
wasm.initSync({ module: bytes });
const core = wasmCore(wasm);
const median = (a) => a.sort((a, b) => a - b)[Math.floor(a.length / 2)],
  rows = [];
for (const kb of [10, 100, 250, 500, 1024]) {
  const source =
      "# Section 🌍\n\nText with [link](./guide.md).\n\n### Next\n\nParagraph\n\n".repeat(
        Math.ceil((kb * 1024) / 69),
      ),
    heads = coreHeadings(analyzeDocument(source).headings);
  const timings = { js: [], wasm: [] };
  for (let i = 0; i < 8; i++)
    for (const [name, fn] of [
      ["js", analyzeCore],
      ["wasm", core.analyze],
    ]) {
      const start = performance.now();
      fn(source, heads);
      if (i > 2) timings[name].push(performance.now() - start);
    }
  rows.push({
    kb,
    jsMs: Number(median(timings.js).toFixed(3)),
    wasmMs: Number(median(timings.wasm).toFixed(3)),
  });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      method:
        "Shared core only, includes JSON/string transfer; median of five warm runs",
      wasmBytes: bytes.length,
      wasmGzipBytes: gzipSync(bytes).length,
      rows,
    },
    null,
    2,
  ),
);

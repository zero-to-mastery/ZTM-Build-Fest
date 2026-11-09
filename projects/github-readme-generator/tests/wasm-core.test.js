import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as wasm from "../src/analysis/wasm/readme_core.js";
import { analyzeCore, coreHeadings } from "../src/analysis/js-fallback.js";
import { analyzeDocument } from "../src/analysis/analyze.js";
import { wasmCore, createCoreLoader } from "../src/analysis/wasm-loader.js";
let core;
beforeAll(() => {
  wasm.initSync({
    module: readFileSync("src/analysis/wasm/readme_core_bg.wasm"),
  });
  core = wasmCore(wasm);
});
describe("optional WASM parity", () => {
  const fixtures = [
    "",
    "# Title\r\n\r\n### Next\r\ntext",
    "🌍\ud800\uFEFFword\u0085word\n",
    "<script>\n```\n# malformed",
    readFileSync("tests/fixtures/analysis/mixed.md", "utf8"),
  ];
  it.each(fixtures)(
    "matches JS shared rules and complete analysis",
    (source) => {
      const js = analyzeDocument(source),
        heads = coreHeadings(js.headings);
      expect(core.analyze(source, heads)).toEqual(analyzeCore(source, heads));
      expect(
        JSON.parse(wasm.analyze_readme(source, JSON.stringify(heads))).value,
      ).toEqual(analyzeCore(source, heads));
      expect({
        ...analyzeDocument(source, { core }),
        engine: "JavaScript",
      }).toEqual(js);
    },
  );
  it.each([100, 250, 500, 1024])(
    "completes deterministic %i KB analysis",
    (kb) => {
      const source =
        "# H\n\nText 🌍\n\n### Next\n\n![alt](./image.svg)\n\n".repeat(
          Math.ceil((kb * 1024) / 53),
        );
      const heads = coreHeadings(analyzeDocument(source).headings);
      const a = core.analyze(source, heads);
      expect(a).toEqual(core.analyze(source, heads));
      expect(a).toEqual(analyzeCore(source, heads));
      expect(
        analyzeDocument(source, { core }).issues.length,
      ).toBeLessThanOrEqual(1000);
    },
    30000,
  );
  it("returns structured errors for invalid ranges and JSON", () => {
    expect(JSON.parse(wasm.analyze_readme("text", "bad")).ok).toBe(false);
    expect(
      JSON.parse(wasm.extract_sections(1, '[{"level":9,"start":2,"end":3}]'))
        .ok,
    ).toBe(false);
  });
  it("falls back on load failure and caches the attempt", async () => {
    let calls = 0;
    const loader = createCoreLoader(async () => {
      calls++;
      throw Error("offline");
    });
    const loaded = await loader.load();
    expect(loaded.engine).toBe("JavaScript");
    await loader.load();
    expect(calls).toBe(1);
    expect(loader.status.available).toBe(false);
  });
  it("falls back on timeout and runtime errors", async () => {
    const slow = createCoreLoader(() => new Promise(() => {}), 5);
    expect((await slow.load()).engine).toBe("JavaScript");
    const broken = createCoreLoader(async () => ({
      analyze() {
        throw Error("failure");
      },
    }));
    const loaded = await broken.load();
    expect(loaded.analyze("# x", [])).toEqual(analyzeCore("# x", []));
    expect(broken.status.engine).toBe("JavaScript");
  });
});

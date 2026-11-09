import { jsCore, analyzeCore } from "./js-fallback.js";
export function wasmCore(module) {
  return {
    engine: "WASM",
    analyze(markdown, headings) {
      const result = JSON.parse(module.document_stats(markdown));
      if (!result.ok) throw new Error(result.error);
      return analyzeCore(markdown, headings, result.value);
    },
  };
}
export function createCoreLoader(
  load = async () => {
    const module = await import("./wasm/readme_core.js");
    await module.default();
    return wasmCore(module);
  },
  timeoutMs = 2000,
) {
  let pending,
    status = { engine: "JavaScript", available: false, reason: "Not loaded" };
  return {
    get status() {
      return { ...status };
    },
    load() {
      if (!pending)
        pending = (async () => {
          let timer;
          try {
            const core = await Promise.race([
              load(),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("WASM load timed out")),
                  timeoutMs,
                );
              }),
            ]);
            status = { engine: "WASM", available: true, reason: null };
            return {
              get engine() {
                return status.engine;
              },
              analyze(source, headings) {
                if (!status.available) return analyzeCore(source, headings);
                try {
                  return core.analyze(source, headings);
                } catch {
                  status = {
                    engine: "JavaScript",
                    available: false,
                    reason: "WASM analysis failed; using JavaScript",
                  };
                  return analyzeCore(source, headings);
                }
              },
            };
          } catch {
            status = {
              engine: "JavaScript",
              available: false,
              reason: "WASM unavailable; using JavaScript",
            };
            return jsCore;
          } finally {
            clearTimeout(timer);
          }
        })();
      return pending;
    },
  };
}
export const analysisCore = createCoreLoader();

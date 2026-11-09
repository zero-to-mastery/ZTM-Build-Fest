import { analyzeDraft } from "./health-analysis.js";
import { analysisCore } from "../analysis/wasm-loader.js";
self.onmessage = async ({ data }) => {
  try {
    const core = await analysisCore.load();
    self.postMessage({
      result: analyzeDraft(data, core),
      engine: analysisCore.status,
    });
  } catch {
    self.postMessage({ error: true });
  }
};

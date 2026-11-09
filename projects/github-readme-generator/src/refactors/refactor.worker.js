import { refactorCatalog, planRefactors, refactorDiff } from "./registry.js";
self.onmessage = ({ data }) => {
  try {
    if (data.selected) {
      const plan = planRefactors(data.source, data.selected, data.options);
      self.postMessage({ id: data.id, plan, diff: refactorDiff(plan) });
    } else
      self.postMessage({
        id: data.id,
        catalog: refactorCatalog(data.source, data.options),
      });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error:
        error.message || "Unable to prepare refactors. Source is unchanged.",
    });
  }
};

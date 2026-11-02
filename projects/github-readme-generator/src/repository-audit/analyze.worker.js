import { classifyReadme } from "./classify.js";
self.onmessage = ({ data: { id, source, repo } }) => {
  try {
    self.postMessage({ id, result: classifyReadme(source, repo) });
  } catch {
    self.postMessage({
      id,
      error:
        "README analysis could not complete. Open the source to review it manually.",
    });
  }
};

export function auditAnalyzer() {
  let worker,
    sequence = 0,
    closed = false;
  const pending = new Map();
  const fallback = async (job) => {
    try {
      const { classifyReadme } = await import("./classify.js");
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (closed) throw new DOMException("Audit cancelled", "AbortError");
      job.resolve(classifyReadme(job.source, job.repo));
    } catch (error) {
      job.reject(error);
    }
  };
  try {
    worker = new Worker(new URL("./analyze.worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      data.error ? job.reject(Error(data.error)) : job.resolve(data.result);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      worker = null;
      for (const job of pending.values()) fallback(job);
      pending.clear();
    };
  } catch {
    worker = null;
  }
  return {
    analyze(source, repo = {}) {
      if (closed)
        return Promise.reject(
          new DOMException("Audit cancelled", "AbortError"),
        );
      return new Promise((resolve, reject) => {
        const job = { source, repo, resolve, reject },
          id = ++sequence;
        if (!worker) {
          fallback(job);
          return;
        }
        pending.set(id, job);
        try {
          worker.postMessage({ id, source, repo });
        } catch {
          pending.delete(id);
          fallback(job);
        }
      });
    },
    close() {
      closed = true;
      worker?.terminate();
      for (const job of pending.values())
        job.reject(new DOMException("Audit cancelled", "AbortError"));
      pending.clear();
    },
  };
}

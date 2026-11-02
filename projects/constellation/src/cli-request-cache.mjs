import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createGitHubRequestCache } from "./github-request-cache.mjs";

export function createCliRequestCache({
  path = ".cache/constellation-github-requests-v1.json",
  fetchImpl = fetch,
  refresh = false,
  dryRun = false,
  ttlMs,
} = {}) {
  let saved = "{}";
  try {
    saved = readFileSync(path, "utf8");
  } catch {}
  const cache = createGitHubRequestCache({
    fetchImpl,
    storage: {
      getItem: () => saved,
      setItem: (_key, value) => {
        saved = value;
        if (!dryRun)
          try {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, value);
          } catch {}
      },
    },
    ttlMs,
  });
  return {
    fetch(url, options = {}) {
      return cache.fetch(url, {
        ...options,
        ...(refresh ? { refresh: true } : {}),
      });
    },
    clear: () => cache.clear(),
    statistics: () => cache.statistics(),
  };
}

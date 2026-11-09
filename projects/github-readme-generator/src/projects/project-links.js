import { safeUrl } from "../markdown/url-safety.js";
export function projectLinkTargets(projects) {
  return [
    ...new Set(
      projects
        .flatMap((p) => [
          p.repositoryUrl,
          p.liveUrl,
          p.caseStudyUrl,
          p.imageUrl,
          p.darkImageUrl,
          p.imageLink,
          ...p.links.map((l) => l.url),
        ])
        .filter(Boolean),
    ),
  ];
}
export async function checkProjectLinks(
  urls,
  { fetcher = fetch, signal, timeout = 8000 } = {},
) {
  const list = [...new Set(urls)].slice(0, 300),
    results = Array(list.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, list.length) }, async () => {
      while (cursor < list.length && !signal?.aborted) {
        const i = cursor++,
          url = list[i];
        if (!safeUrl(url, { relative: false }) || !/^https?:\/\//i.test(url)) {
          results[i] = {
            url,
            state: "unverified",
            message: "Only absolute HTTP(S) links can be checked.",
          };
          continue;
        }
        const controller = new AbortController(),
          abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, timeout);
        try {
          const r = await fetcher(url, {
            method: "HEAD",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
          });
          results[i] = {
            url,
            state: r.ok
              ? "reachable"
              : [404, 410].includes(r.status)
                ? "unavailable"
                : "unverified",
            message: r.ok
              ? "Responded successfully."
              : `HTTP ${r.status}. A provider may restrict automated checks.`,
          };
        } catch {
          results[i] = {
            url,
            state: "unverified",
            message: controller.signal.aborted
              ? "Check timed out or was cancelled."
              : "Browser policy (CORS), offline state, or a network error prevented verification.",
          };
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      }
    }),
  );
  return results.filter(Boolean);
}

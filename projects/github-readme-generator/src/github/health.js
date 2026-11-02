import { marked } from "marked";
import { visitTokens } from "../markdown/visit-tokens.js";
import { documentSegments } from "../markdown/source-context.js";
import {
  resolveLinkUrl,
  resolveImageUrl,
  isRelativeUrl,
  srcsetCandidates,
} from "../markdown/resolve-urls.js";
import { safeUrl } from "../markdown/url-safety.js";
import { repositoryIdentity } from "../projects/github-project.js";
import {
  contextRepositories,
  repositoryContext,
} from "./repository-context.js";
import { rateLimitMessage } from "../state/network-errors.js";
import { cachedHealth, cacheHealth } from "./health-cache.js";
const decode = (s) =>
  s
    .replace(
      /&(?:amp|quot|apos|lt|gt);/g,
      (v) =>
        ({
          "&amp;": "&",
          "&quot;": '"',
          "&apos;": "'",
          "&lt;": "<",
          "&gt;": ">",
        })[v],
    )
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const v =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : "";
    });
// URL values written in one Markdown source, in source order: link and image
// tokens plus a/img/source attributes in raw HTML. Entities are decoded;
// nothing is resolved, fetched or rewritten.
export function sourceUrls(source) {
  return tokenUrls(marked.lexer(source));
}
// The same walk over already-lexed tokens, so callers that track source
// positions per block share one URL extraction. Each URL keeps the token it
// came from (a link, image or HTML token).
export function tokenUrls(tokens) {
  const urls = [];
  let token = null;
  const add = (value, image) =>
    urls.push({ value: decode(value || ""), image, token });
  visitTokens(tokens, (t) => {
    token = t;
    if (t.type === "link") add(t.href, false);
    if (t.type === "image") add(t.href, true);
    if (t.type === "html") {
      const s = t.text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
      for (const tag of s.match(/<(?:a|img|source)\b[^>]*>/gi) || []) {
        const attr = (name) => {
          const match = [
            ...tag.matchAll(
              /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
            ),
          ].find((m) => m[1].toLowerCase() === name);
          return match?.slice(2).find((v) => v !== undefined) || "";
        };
        if (/^<a\b/i.test(tag)) add(attr("href"), false);
        else {
          add(attr("src"), true);
          for (const c of srcsetCandidates(attr("srcset"))) add(c.url, true);
        }
      }
    }
  });
  return urls;
}
export function healthTargets(draft) {
  const results = new Map(),
    repos = contextRepositories(draft);
  const add = (value, image, context) => {
    if (!value || value.startsWith("#") || /^mailto:/i.test(value)) return;
    let url = (image ? resolveImageUrl : resolveLinkUrl)(value, context);
    if (url.startsWith("//")) url = "https:" + url;
    const repo = repositoryIdentity(url),
      category = repo
        ? "Repositories"
        : image
          ? /shields\.io|badge/i.test(url)
            ? "Badges"
            : /stats|metrics|typing|streak|activity|snake|constellation/i.test(
                  url,
                )
              ? "Widgets"
              : "Images"
          : "External Links";
    let requestUrl = repo ? `https://api.github.com/repos/${repo}` : url,
      api = !!repo;
    if (isRelativeUrl(value) && context?.type === "github" && url) {
      const raw = new URL(resolveImageUrl(value, context));
      const parts = raw.pathname.split("/").slice(1);
      requestUrl = `https://api.github.com/repos/${parts[0]}/${parts[1]}/contents/${parts.slice(3).join("/")}?ref=${parts[2]}`;
      api = true;
    }
    const key = url || value;
    if (!results.has(key))
      results.set(key, {
        url: url || value,
        requestUrl,
        category,
        image,
        repo,
        api,
        snapshot: repos.find((r) => r.fullName.toLowerCase() === repo) || null,
      });
  };
  for (const segment of documentSegments(draft))
    for (const { value, image } of sourceUrls(segment.source))
      add(value, image, segment.sourceContext);
  return [...results.values()].slice(0, 300);
}
export async function readBounded(response, max = 100000) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let size = 0,
    parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw Error("Response exceeded inspection limit.");
      parts.push(value);
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      all.set(part, offset);
      offset += part.length;
    }
    return new TextDecoder().decode(all);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function responseHealth(response, target) {
  const status = response.status,
    notes = [];
  let state = response.ok
    ? response.redirected
      ? "redirected"
      : "reachable"
    : [301, 302, 303, 307, 308].includes(status)
      ? "redirected"
      : [404, 410].includes(status)
        ? "not found"
        : status === 429 ||
            (status === 403 &&
              response.headers.get("x-ratelimit-remaining") === "0")
          ? "rate limited"
          : [401, 403, 405, 501].includes(status)
            ? "blocked by CORS/HEAD policy"
            : "unknown";
  if (state === "rate limited") notes.push(rateLimitMessage(response));
  if (state === "not found")
    notes.push(
      target.repo
        ? "Repository missing or not publicly available."
        : `HTTP ${status}; this URL did not return a resource.`,
    );
  if (target.image && !target.api) {
    const type = response.headers.get("content-type");
    if (type && !/^image\//i.test(type) && response.ok)
      notes.push(`Expected an image; received ${type}.`);
    const size = Number(response.headers.get("content-length"));
    if (size > 5_000_000)
      notes.push("Image exceeds 5 MB according to exposed headers.");
  }
  return { state, notes };
}
export function repositoryNotes(current, previous, now = Date.now()) {
  const notes = [];
  if (current.archived) notes.push("Repository is archived.");
  if (
    previous?.defaultBranch &&
    current.defaultBranch !== previous.defaultBranch
  )
    notes.push(
      `Default branch changed: ${previous.defaultBranch} → ${current.defaultBranch}.`,
    );
  if (previous && current.homepage !== previous.homepage)
    notes.push(
      `Repository homepage changed: ${previous.homepage || "(none)"} → ${current.homepage || "(none)"}.`,
    );
  const updated = Date.parse(current.updatedAt);
  if (Number.isFinite(updated) && updated <= now)
    notes.push(
      `Last repository update: ${Math.floor((now - updated) / 86400000)} days ago; age does not imply abandonment.`,
    );
  return notes;
}
export async function checkTarget(
  target,
  { fetcher = fetch, signal, timeout = 10000 } = {},
) {
  const base = { ...target, checkedAt: Date.now() },
    url = target.requestUrl;
  if (!/^https?:\/\//i.test(url || "") || !safeUrl(url, { relative: false }))
    return {
      ...base,
      state: "unknown",
      notes: [
        "Relative links need a GitHub import source; only HTTP(S) resources are checked.",
      ],
    };
  const controller = new AbortController(),
    abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeout);
  const request = (method) =>
    fetcher(url, {
      method,
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: target.api
        ? { Accept: "application/vnd.github+json" }
        : undefined,
    });
  try {
    controller.signal.throwIfAborted();
    let response = await request(target.api ? "GET" : "HEAD");
    let get = target.api;
    if ([405, 501].includes(response.status) && !target.api) {
      await response.body?.cancel();
      response = await request("GET");
      get = true;
    }
    const result = { ...base, ...responseHealth(response, target) };
    if (response.ok && target.repo) {
      try {
        const r = repositoryContext(JSON.parse(await readBounded(response)));
        result.notes.push(...repositoryNotes(r, target.snapshot));
        result.repository = r;
      } catch {
        result.state = "unknown";
        result.notes.push("Repository metadata could not be verified.");
      }
    } else if (
      get &&
      response.ok &&
      !target.api &&
      /image\/svg\+xml/i.test(response.headers.get("content-type") || "")
    ) {
      try {
        const svg = await readBounded(response, 65536);
        if (
          /(?:not found|invalid|inaccessible|rate limit|error)/i.test(
            svg.replace(/<[^>]+>/g, " "),
          )
        )
          result.notes.push(
            "SVG text may indicate a provider error; inspect the rendered badge/widget.",
          );
      } catch {
        result.notes.push("SVG inspection stopped at 64 KB.");
      }
    } else await response.body?.cancel();
    return result;
  } catch {
    return {
      ...base,
      state: signal?.aborted
        ? "unknown"
        : controller.signal.aborted
          ? "timeout"
          : "blocked by CORS/HEAD policy",
      notes: [
        signal?.aborted
          ? "Check cancelled."
          : controller.signal.aborted
            ? "Request timed out."
            : "Browser policy, offline state or a network failure prevented verification. This does not prove the link is broken.",
      ],
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export async function scanTargets(
  targets,
  { force = false, onResult = () => {}, ...options } = {},
) {
  const list = targets.slice(0, 300),
    out = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, list.length) }, async () => {
      while (cursor < list.length && !options.signal?.aborted) {
        const target = list[cursor++],
          result =
            (!force && cachedHealth(target)) ||
            (await checkTarget(target, options));
        if (!options.signal?.aborted) cacheHealth(target, result);
        out.push(result);
        onResult(result);
      }
    }),
  );
  return out;
}

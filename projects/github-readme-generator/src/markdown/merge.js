import { visitTokens } from "./visit-tokens.js";
import { marked } from "marked";
import { detectSections, normalizeHeading } from "./sections.js";
import { resolveImageUrl, srcsetCandidates } from "./resolve-urls.js";
export const comparisonText = (source) =>
  source
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
export function contentHash(source) {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${source.length}:${(hash >>> 0).toString(16)}`;
}
export function imageUrls(source, context) {
  const urls = [];
  visitTokens(marked.lexer(source), (token) => {
    if (token.type === "image")
      urls.push(
        resolveImageUrl(token.href, context) || `unresolved:${token.href}`,
      );
    if (token.type === "html")
      for (const tag of token.raw
        .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
        .matchAll(/<(?:img|source)\b[^>]*>/gi))
        for (const m of tag[0].matchAll(
          /\b(src|srcset)\s*=\s*["']([^"']+)["']/gi,
        ))
          for (const url of m[1].toLowerCase() === "srcset"
            ? srcsetCandidates(m[2]).map((c) => c.url)
            : [m[2]])
            urls.push(
              resolveImageUrl(url.replace(/&amp;/g, "&"), context) ||
                `unresolved:${url}`,
            );
  });
  return urls;
}
function enrich(sections, context) {
  return sections.map((s) => {
    const body = comparisonText(s.body);
    return {
      ...s,
      normalized: normalizeHeading(s.title),
      bodyHash: contentHash(body),
      comparedBody: body,
      embeds: imageUrls(
        s.source,
        typeof context === "function" ? context(s) : context,
      ),
    };
  });
}
const indexBy = (sections, key) => {
  const map = new Map();
  sections.forEach((s, i) => {
    for (const k of key(s))
      if (k) {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(i);
      }
  });
  return map;
};
export function compareSections(
  current,
  imported,
  { levels = [1, 2], currentContext = null, importedContext = null } = {},
) {
  const a = enrich(detectSections(current, { levels }), currentContext),
    b = enrich(detectSections(imported, { levels }), importedContext);
  const headings = indexBy(a, (s) => [s.normalized]),
    bodies = indexBy(a, (s) => (s.comparedBody ? [s.bodyHash] : [])),
    kinds = indexBy(a, (s) => (s.kind !== "custom" ? [s.kind] : [])),
    embeds = indexBy(a, (s) => s.embeds);
  const matches = b.map((section) => {
    const indices = new Set();
    const collect = (map, key) => {
      for (const i of (map.get(key) || []).slice(0, 50)) indices.add(i);
    };
    collect(headings, section.normalized);
    if (section.comparedBody) collect(bodies, section.bodyHash);
    if (section.kind !== "custom") collect(kinds, section.kind);
    section.embeds.forEach((url) => collect(embeds, url));
    const candidates = [...indices]
      .sort((a, b) => a - b)
      .map((index) => {
        const other = a[index];
        const sameBody =
          !!section.comparedBody &&
          section.bodyHash === other.bodyHash &&
          section.comparedBody === other.comparedBody;
        const sameHeading = section.normalized === other.normalized;
        const reasons = [];
        if (comparisonText(section.source) === comparisonText(other.source))
          reasons.push("Possible duplicate: identical section");
        else if (sameBody && !sameHeading)
          reasons.push("Different heading, identical content");
        else if (sameHeading && !sameBody)
          reasons.push("Matching heading, different content");
        else if (
          sameHeading ||
          (section.kind === other.kind && section.kind !== "custom")
        )
          reasons.push("Likely matching sections");
        if (section.embeds.some((url) => other.embeds.includes(url)))
          reasons.push("Possible duplicate: identical image/embed URL");
        // Similarity is bounded and only considered for an already matching heading.
        if (sameHeading && !sameBody) {
          const left = new Set(
              section.comparedBody.slice(0, 4000).split(/\s+/),
            ),
            right = new Set(other.comparedBody.slice(0, 4000).split(/\s+/));
          const common = [...left].filter((w) => right.has(w)).length;
          if (common / Math.max(left.size, right.size) > 0.9)
            reasons.push("Possible duplicate: near-identical source");
        }
        return { index, reasons };
      })
      .filter((c) => c.reasons.length);
    return { section, candidates, ambiguous: candidates.length > 1 };
  });
  return { current: a, imported: b, matches };
}
export function joinPieces(pieces) {
  let markdown = "";
  const result = [];
  let previous;
  for (const piece of pieces) {
    let prefix = "";
    if (
      previous &&
      markdown &&
      piece.source &&
      !(previous.side === piece.side && previous.end === piece.start)
    ) {
      const trailing =
        markdown.match(/(?:\r?\n)*$/)?.[0].replace(/\r/g, "").length || 0;
      const leading =
        piece.source.match(/^(?:\r?\n)*/)?.[0].replace(/\r/g, "").length || 0;
      prefix = "\n".repeat(Math.max(0, 2 - trailing - leading));
    }
    result.push({ ...piece, prefix });
    markdown += prefix + piece.source;
    previous = piece;
  }
  return { markdown, pieces: result };
}
export function assembleMerge(comparison, decisions) {
  const before = new Map(),
    after = new Map(),
    replace = new Map(),
    end = [];
  comparison.imported.forEach((section, index) => {
    const choice = decisions[index];
    if (!choice || !["keep", "use", "before", "after"].includes(choice.action))
      throw new Error("Choose an action for every imported section.");
    if (choice.action === "keep") return;
    const piece = { ...section, side: "imported" };
    const target = choice.target;
    if (target === "end") {
      if (choice.action === "use")
        throw new Error("Choose a current section to replace.");
      end.push(piece);
      return;
    }
    if (!Number.isInteger(target) || !comparison.current[target])
      throw new Error("Choose a valid current section.");
    if (choice.action === "use") {
      if (replace.has(target))
        throw new Error(
          "Two imported sections cannot replace the same current section. Choose an insertion instead.",
        );
      replace.set(target, piece);
    } else {
      const map = choice.action === "before" ? before : after;
      if (!map.has(target)) map.set(target, []);
      map.get(target).push(piece);
    }
  });
  return joinPieces(
    comparison.current
      .flatMap((section, index) => [
        ...(before.get(index) || []),
        replace.get(index) || { ...section, side: "current" },
        ...(after.get(index) || []),
      ])
      .concat(end),
  );
}
export function duplicateWarnings(markdown, context) {
  const sections = enrich(detectSections(markdown), context);
  const seen = new Map(),
    images = new Set(),
    warnings = [];
  for (const s of sections) {
    if (s.comparedBody) {
      const key = s.bodyHash;
      const previous = seen.get(key);
      if (previous === s.comparedBody)
        warnings.push("Possible duplicate section content.");
      else seen.set(key, s.comparedBody);
    }
    for (const url of s.embeds) {
      if (images.has(url))
        warnings.push("Possible duplicate image or widget embed.");
      images.add(url);
    }
  }
  return [...new Set(warnings)];
}

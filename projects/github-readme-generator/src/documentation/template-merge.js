import { parseSource, attributes } from "../analysis/source.js";
import { serializeBlocks } from "../markdown/serialize.js";
import { IMPORT_LIMIT } from "../state/import.js";

const key = (text) =>
  String(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
const aliases = [
  ["Overview", "Purpose", "About", "Introduction"],
  [
    "Setup",
    "Installation",
    "Install",
    "Getting started",
    "Quick Start",
    "How to run",
    "Running locally",
  ],
  ["Environment", "Environment Variables", "Environment configuration"],
  ["CLI reference", "Command line reference"],
  ["API endpoint", "Endpoints", "API reference"],
  ["Library guide", "Package guide"],
  ["Controls", "Game controls", "Keyboard controls"],
  ["Save and data", "Save and Data Behavior", "Save data", "Saving"],
  ["Cargo dependency", "Cargo installation"],
  ["Crate links", "Registry links"],
  ["Testing", "Tests", "Running tests"],
  ["Screenshots", "Screenshot", "Gallery"],
  ["Contributing", "Contribution guidelines"],
  ["License", "Licensing"],
  ["Configuration", "Config"],
];
const related = {
  [key("CLI reference")]: [
    "Commands",
    "Flags and options",
    "Usage",
    "Examples",
  ],
  [key("Library guide")]: [
    "Usage",
    "Import",
    "API",
    "Compatibility",
    "Examples",
  ],
  [key("API endpoint")]: [
    "API",
    "Authentication",
    "Parameters",
    "Requests",
    "Responses",
  ],
  [key("Cargo dependency")]: ["Installation", "Setup", "Usage"],
  [key("Crate links")]: ["Documentation", "Links"],
  [key("Demo")]: ["Demo and screenshots", "Live preview"],
};
const mask = (source) =>
  source.replace(
    /<!--[\s\S]*?(?:-->|$)|<(pre|code|script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (text) => text.replace(/[^\r\n]/g, " "),
  );

export function existingSections(source) {
  const parsed = parseSource(source.replace(/^\ufeff/, " "));
  const top = new Set(parsed.tokens);
  const headings = [];
  for (const node of parsed.nodes) {
    if (!top.has(node.token)) continue; // Quoted/nested examples are not section declarations.
    if (node.token.type === "heading")
      headings.push({ title: node.token.text, ...node.sourceRange });
    if (node.token.type === "html") {
      const clean = mask(node.token.raw);
      for (const match of clean.matchAll(
        /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
      )) {
        headings.push({
          title: match[2].replace(/<[^>]*>/g, ""),
          ...parsed.range(
            node.start + match.index,
            node.start + match.index + match[0].length,
          ),
        });
      }
    }
  }
  headings.sort((a, b) => a.start - b.start);
  return headings.map((heading, index) => {
    const body = source.slice(
      heading.end,
      headings[index + 1]?.start ?? source.length,
    );
    const clean = mask(body);
    const parsedBody = parseSource(clean);
    const tokens = parsedBody.tokens;
    const prose = parsedBody.nodes
      .filter(
        (n) =>
          (n.token.type === "text" && !n.token.tokens) ||
          n.token.type === "html",
      )
      .map((n) =>
        n.token.type === "html"
          ? n.token.raw.replace(/<[^>]*>/g, " ")
          : n.token.text,
      )
      .join(" ");
    const words = prose.match(/[\p{L}\p{N}]+/gu) || [];
    const code = tokens.some((t) => t.type === "code" && t.text.trim());
    const table = tokens.some((t) => t.type === "table" && t.rows.length);
    const image = parsedBody.nodes.some(
      (n) =>
        (n.token.type === "image" &&
          !/shields\.io|badge/i.test(n.token.href)) ||
        (n.token.type === "html" &&
          [...n.token.raw.matchAll(/<img\b[^>]*>/gi)].some((match) => {
            const attrs = attributes(match[0]);
            return attrs.src && !/shields\.io|badge/i.test(attrs.src);
          })),
    );
    return {
      ...heading,
      normalized: key(heading.title),
      content: words.length >= 6 || code || table || image,
    };
  });
}

export function matchTemplateSections(source, titles) {
  const headings = existingSections(source || "");
  return titles.map((title) => {
    const keys = (
      aliases.find((group) =>
        group.some((alias) => key(alias) === key(title)),
      ) || [title]
    ).map(key);
    const exact = headings.filter((h) => keys.includes(h.normalized));
    const nearby = headings.filter((h) =>
      (related[key(title)] || []).some((label) => key(label) === h.normalized),
    );
    const matches = exact.length ? exact : nearby;
    const status = exact.length
      ? exact.some((h) => h.content)
        ? "matched"
        : "needs-content"
      : nearby.length
        ? "related"
        : "missing";
    return {
      title,
      status,
      matches: matches.map((h) => ({ title: h.title, line: h.line })),
      suggested: status === "missing",
    };
  });
}

export async function readRepositoryFile(file) {
  if (!file || file.size > IMPORT_LIMIT)
    throw Error("Choose a UTF-8 README no larger than 2 MB.");
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > IMPORT_LIMIT)
    throw Error("README exceeds the 2 MB limit.");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw Error(
      "README must be valid UTF-8 text. Existing source was retained.",
    );
  }
}
export function reviewSignature(before, plan) {
  return JSON.stringify({
    before,
    after: serializeBlocks(plan.blocks),
    name: plan.name,
    metadata: plan.metadata,
  });
}

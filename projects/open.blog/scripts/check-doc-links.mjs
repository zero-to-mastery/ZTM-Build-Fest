import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function markdownSourceWithoutFences(source) {
  let fenced = false;
  let fenceCharacter = "";
  let fenceLength = 0;
  return source
    .split("\n")
    .map((line) => {
      const opener = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (opener && !fenced) {
        fenced = true;
        fenceCharacter = opener[1][0];
        fenceLength = opener[1].length;
        return "";
      }
      if (fenced) {
        const closer = line.match(/^\s{0,3}(`+|~+)\s*$/);
        if (closer && closer[1][0] === fenceCharacter && closer[1].length >= fenceLength) fenced = false;
        return "";
      }
      return line;
    })
    .join("\n");
}

function markdownSourceWithoutCode(source) {
  return markdownSourceWithoutFences(source)
    .split("\n")
    .map((line) => line.replace(/`[^`]*`/g, ""))
    .join("\n");
}

function githubHeadingSlug(heading) {
  const plain = heading
    .replace(/\s+#+\s*$/, "")
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*~`]/g, "")
    .toLowerCase();
  return Array.from(plain)
    .filter((character) => /[\p{L}\p{N}\s_-]/u.test(character))
    .join("")
    .trim()
    .replace(/\s+/g, "-");
}

export function markdownHeadingIds(source) {
  const ids = new Set();
  for (const line of markdownSourceWithoutFences(source).split("\n")) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (!match) continue;
    const base = githubHeadingSlug(match[1]);
    if (!base) continue;
    let id = base;
    let suffix = 1;
    while (ids.has(id)) id = `${base}-${suffix++}`;
    ids.add(id);
  }
  return ids;
}

function documentationFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return documentationFiles(target);
    return entry.isFile() && entry.name.endsWith(".md") ? [target] : [];
  });
}

export function discoverDocumentationFiles(root) {
  return [
    path.join(root, "README.md"),
    path.join(root, "CHANGELOG.md"),
    ...documentationFiles(path.join(root, "docs")),
    path.join(root, "crates", "openblog-cli", "templates", "counter-service", "README.md"),
  ].filter((file) => fs.existsSync(file));
}

function localTarget(rawTarget) {
  const unwrapped = rawTarget.replace(/^<|>$/g, "");
  if (!unwrapped || unwrapped.startsWith("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(unwrapped)) return null;
  const hash = unwrapped.indexOf("#");
  const pathname = hash >= 0 ? unwrapped.slice(0, hash) : unwrapped;
  const anchor = hash >= 0 ? decodeURIComponent(unwrapped.slice(hash + 1)).toLowerCase() : "";
  return { pathname: decodeURIComponent(pathname), anchor };
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

export function checkMarkdownFiles(files, root = process.cwd()) {
  const problems = [];
  const headingCache = new Map();
  for (const file of files) {
    const source = markdownSourceWithoutCode(fs.readFileSync(file, "utf8"));
    const links = [
      ...source.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g),
      ...source.matchAll(/^\s*\[[^\]]+\]:\s+(\S+)/gm),
    ];
    for (const match of links.sort((left, right) => left.index - right.index)) {
      const target = localTarget(match[1]);
      if (!target) continue;
      const resolved = target.pathname ? path.resolve(path.dirname(file), target.pathname) : file;
      const relative = path.relative(root, resolved).replaceAll("\\", "/");
      if (relative.startsWith("../") || path.isAbsolute(relative)) {
        problems.push({ file, line: lineAt(source, match.index), message: `link escapes the repository: ${match[1]}` });
        continue;
      }
      if (!fs.existsSync(resolved)) {
        problems.push({ file, line: lineAt(source, match.index), message: `missing file ${relative}` });
        continue;
      }
      if (!target.anchor || path.extname(resolved).toLowerCase() !== ".md") continue;
      let headings = headingCache.get(resolved);
      if (!headings) {
        headings = markdownHeadingIds(fs.readFileSync(resolved, "utf8"));
        headingCache.set(resolved, headings);
      }
      if (!headings.has(target.anchor)) {
        problems.push({ file, line: lineAt(source, match.index), message: `missing anchor #${target.anchor} in ${relative}` });
      }
    }
  }
  return problems;
}

function main() {
  const root = process.cwd();
  const files = discoverDocumentationFiles(root);
  const problems = checkMarkdownFiles(files, root);
  if (problems.length) {
    for (const problem of problems) {
      const relative = path.relative(root, problem.file).replaceAll("\\", "/");
      console.error(`${relative}:${problem.line}: ${problem.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Checked ${files.length} Markdown documentation files; all local links and anchors resolve.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main();

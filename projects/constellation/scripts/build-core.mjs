import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "src");
const target = resolve(root, "packages/core");
const visited = new Set();
async function copyModule(path) {
  if (visited.has(path)) return;
  visited.add(path);
  const name = relative(source, path);
  if (name.startsWith(".."))
    throw new Error(`Core dependency escapes src: ${name}`);
  const destination = resolve(target, "src", name);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(path, destination);
  if (!/\.(mjs|js)$/.test(path)) return;
  const code = await readFile(path, "utf8");
  for (const match of code.matchAll(
    /(?:from\s*|import\s*\(|new URL\s*\()\s*['"](\.[^'"]+)['"]/g,
  )) {
    await copyModule(resolve(dirname(path), match[1]));
  }
}
await copyModule(resolve(source, "core-api.mjs"));
await copyModule(resolve(source, "browser-runtime.mjs"));
// The generated inline module contains the same WASM bytes and serves both
// regular Core initialization and single-file HTML exports. Do not ship a
// second raw copy in the package.
await rm(resolve(target, "src/wasm/constellation_core_bg.wasm"), { force: true });
const { version } = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const guides = [
  "temporal-stack",
  "scene-api",
  "layers",
  "data-pipeline",
  "layout-api",
  "interactive-html",
  "timeline",
  "hierarchical-scenes",
  "story-mode",
  "architecture",
  "architecture-baseline",
  "renderer-api",
  "migration-v3",
  "extension-authoring",
  "security-model",
  "accessibility",
  "scaling",
  "plugins",
  "readme-showcase",
  "developer-topology",
  "evidence-provenance",
  "semantic-groups",
  "project-constellations",
  "semantic-graph",
  "semantic-graph-import",
  "portable-embed",
  "portfolio-artifact",
  "semantic-markdown",
  "developer-atlas",
  "graph-quality",
  "story-candidates",
  "story-composition",
  "story-clarity",
  "evidence-navigation",
  "profile-story",
  "semantic-studio",
  "github-data-cache",
].map((name) => name + ".md");
await writeFile(
  resolve(target, "package.json"),
  JSON.stringify(
    {
      name: "@constellation/core",
      version,
      type: "module",
      description:
        "Compile project data into scenes, SVG and interactive visualizations with bundled Rust/WASM.",
      engines: { node: ">=22" },
      exports: {
        ".": "./src/core-api.mjs",
        "./browser-runtime": "./src/browser-runtime.mjs",
      },
      files: ["src", "README.md", ...guides],
      license: "UNLICENSED",
    },
    null,
    2,
  ) + "\n",
);
await copyFile(resolve(root, "docs/core-api.md"), resolve(target, "README.md"));
for (const guide of guides)
  await copyFile(resolve(root, "docs", guide), resolve(target, guide));
console.log(`Built @constellation/core ${version} (${visited.size} files).`);

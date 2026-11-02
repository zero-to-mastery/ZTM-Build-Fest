import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
const directory = new URL("../packages/web-component/", import.meta.url);
await mkdir(directory, { recursive: true });
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const component = await readFile(new URL("../src/web-component.mjs", import.meta.url), "utf8");
// Keep the published entry below its 24 KiB budget while preserving its source structure.
const compactComponent = component
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\r?\n[ \t]*/g, " ")
  .replace(/;\s+/g, ";")
  .replace(/;(?=\s*})/g, "")
  .replace(/\) \{/g, "){")
  .replace(/ =>/g, "=>")
  .replace(/=> \{/g, "=>{")
  .replace(/\b(if|for|while|catch|switch)\s+\(/g, "$1(");
await writeFile(new URL("index.mjs", directory), compactComponent);
await copyFile(
  new URL("../src/web-component-atlas.mjs", import.meta.url),
  new URL("web-component-atlas.mjs", directory),
);
await copyFile(
  new URL("../docs/web-component.md", import.meta.url),
  new URL("README.md", directory),
);
await copyFile(
  new URL("../docs/temporal-stack.md", import.meta.url),
  new URL("temporal-stack.md", directory),
);
await copyFile(
  new URL("../docs/developer-topology.md", import.meta.url),
  new URL("developer-topology.md", directory),
);
await copyFile(
  new URL("../docs/evidence-provenance.md", import.meta.url),
  new URL("evidence-provenance.md", directory),
);
await copyFile(
  new URL("../docs/semantic-groups.md", import.meta.url),
  new URL("semantic-groups.md", directory),
);
await copyFile(
  new URL("../docs/project-constellations.md", import.meta.url),
  new URL("project-constellations.md", directory),
);
await copyFile(
  new URL("../docs/portable-embed.md", import.meta.url),
  new URL("portable-embed.md", directory),
);
await writeFile(
  new URL("package.json", directory),
  JSON.stringify(
    {
      name: "@constellation/web-component",
      version,
      type: "module",
      exports: "./index.mjs",
      files: [
        "index.mjs",
        "web-component-atlas.mjs",
        "README.md",
        "temporal-stack.md",
        "developer-topology.md",
        "evidence-provenance.md",
        "semantic-groups.md",
        "project-constellations.md",
        "portable-embed.md",
      ],
      dependencies: { "@constellation/core": version },
      license: "UNLICENSED",
    },
    null,
    2,
  ) + "\n",
);

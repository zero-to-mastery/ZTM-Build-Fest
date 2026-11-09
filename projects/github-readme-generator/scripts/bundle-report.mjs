import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { gzipSync } from "node:zlib";
const files = [];
async function walk(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) await walk(path);
    else {
      const data = await readFile(path);
      files.push({
        file: path.replaceAll("\\", "/"),
        bytes: data.length,
        gzip: gzipSync(data).length,
        type: extname(path),
      });
    }
  }
}
await walk("dist");
const totals = {};
for (const f of files) {
  const group = (totals[f.type] ||= { bytes: 0, gzip: 0, count: 0 });
  group.bytes += f.bytes;
  group.gzip += f.gzip;
  group.count++;
}
const main = files.find((f) => /\/index-[^/]+\.js$/.test(f.file));
if (!main || main.bytes > 550000)
  throw Error(
    "Main JS exceeds the 550 kB release budget or is missing. Investigate bundle growth.",
  );
const version = JSON.parse(await readFile("package.json", "utf8")).version;
console.log(
  JSON.stringify(
    {
      version,
      projectSchema: 1,
      main,
      totals,
      files: files.filter((f) => [".js", ".wasm", ".css"].includes(f.type)),
    },
    null,
    2,
  ),
);

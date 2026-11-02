import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
const result = spawnSync(
  "wasm-pack",
  [
    "build",
    "rust/readme-core",
    "--target",
    "web",
    "--out-dir",
    "../../src/analysis/wasm",
    "--no-pack",
    "--no-typescript",
    "--locked",
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
rmSync("src/analysis/wasm/.gitignore", { force: true });
